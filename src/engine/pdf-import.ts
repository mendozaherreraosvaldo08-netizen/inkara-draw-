import type { ImageAsset } from './document';
import { apply, multiply, type Matrix } from './matrix';
import { createPath } from './path';
import type { PathNode, Subpath } from './path-geom';
import { newShapeId, shapeBounds, unionBounds, type ImageShape, type PathShape, type Rect, type Shape, type TextAlign, type TextShape } from './shapes';
import { layoutText, lineOffset, relayoutText } from './text';
import type { Point } from './viewport';

/**
 * Abrir un PDF (por ejemplo, exportado de CorelDRAW) como diseño editable.
 *
 * Recorre los comandos de dibujo de cada página (que entrega pdf.js) y los
 * convierte en objetos de Trazo:
 *  - trazados → curvas con su relleno y contorno (par-impar o no-cero);
 *  - texto → textos editables con su fuente, tamaño, color y alineación (las
 *    líneas de un mismo bloque se juntan en un solo texto);
 *  - imágenes → imágenes; si van recortadas por un trazado, PowerClip.
 *
 * El motor no depende de pdf.js: recibe la lista de comandos y unas funciones
 * para leer fuentes e imágenes.
 */

/** Números de los comandos de pdf.js (OPS) que se usan aquí. */
export interface PdfOpCodes {
  save: number;
  restore: number;
  transform: number;
  setGState: number;
  setLineWidth: number;
  setFillRGBColor: number;
  setStrokeRGBColor: number;
  constructPath: number;
  fill: number;
  eoFill: number;
  stroke: number;
  closeStroke: number;
  fillStroke: number;
  eoFillStroke: number;
  closeFillStroke: number;
  closeEOFillStroke: number;
  endPath: number;
  clip: number;
  eoClip: number;
  beginText: number;
  endText: number;
  setTextMatrix: number;
  moveText: number;
  setLeadingMoveText: number;
  nextLine: number;
  setLeading: number;
  setCharSpacing: number;
  setWordSpacing: number;
  setHScale: number;
  setTextRise: number;
  setTextRenderingMode: number;
  setFont: number;
  showText: number;
  showSpacedText: number;
  nextLineShowText: number;
  nextLineSetSpacingShowText: number;
  paintImageXObject: number;
}

export interface PdfPageInput {
  /** [x0, y0, x1, y1] en puntos (1/72 in). */
  view: number[];
  fnArray: number[];
  argsArray: unknown[];
  /** Nombre PostScript de la fuente (p. ej. "ABCDEF+CalistoMT-Bold"). */
  fontName(id: string): string | null;
  /** La imagen ya como asset del documento (o null si no se pudo leer). */
  image(objId: string): Promise<ImageAsset | null>;
}

export interface PdfImportHooks {
  /** Familia a usar para un nombre PostScript sin estilo (p. ej. "CalistoMT" → "Calisto MT"). */
  resolveFamily?(postscriptBase: string): string;
  /** Distancia de la línea media a la línea base, en "em" (la mide el lienzo con la fuente real). */
  baselineOffset?(family: string, bold: boolean, italic: boolean): number;
}

const PT = 25.4 / 72;
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** Producto en el orden de PDF (fila): primero `a`, luego `b`. */
const pdfMul = (a: Matrix, b: Matrix): Matrix => multiply(b, a);

/** Familias conocidas cuyo nombre PostScript no se separa bien solo. */
const KNOWN_FAMILIES: Record<string, string> = {
  ArialMT: 'Arial',
  'Arial-BoldMT': 'Arial',
  TimesNewRomanPSMT: 'Times New Roman',
  TimesNewRomanPS: 'Times New Roman',
  CourierNewPSMT: 'Courier New',
  ChopinScript: 'ChopinScript',
  MS: 'MS Gothic',
  SegoeUI: 'Segoe UI',
};

/** "ABCDEF+CalistoMT-BoldItalic" → familia "Calisto MT", negrita, cursiva. */
export function parseFontName(raw: string, resolve?: (base: string) => string): { family: string; bold: boolean; italic: boolean } {
  const name = raw.replace(/^[A-Z]{6}\+/, '');
  const dash = name.indexOf('-');
  const base = dash > 0 ? name.slice(0, dash) : name;
  const style = dash > 0 ? name.slice(dash + 1) : '';
  const bold = /bold|black|heavy|semibold|demi/i.test(style) || /bold/i.test(base.replace(/^.*?(Bold)$/, '$1'));
  const italic = /italic|oblique|cursiva/i.test(style);
  const cleanBase = base.replace(/(Bold|Italic|Oblique|Regular)+$/i, '') || base;
  const split = KNOWN_FAMILIES[cleanBase] ?? cleanBase.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  return { family: resolve ? resolve(cleanBase) || split : split, bold, italic };
}

const hexOf = (v: unknown, fallback: string): string => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v.toUpperCase() : fallback);

interface GState {
  ctm: Matrix;
  fill: string;
  stroke: string;
  lineWidth: number;
  fillAlpha: number;
  clip: Subpath[] | null;
  // Texto
  font: string | null;
  fontSize: number;
  charSpacing: number;
  wordSpacing: number;
  hscale: number;
  leading: number;
  rise: number;
  render: number;
}

/** Un tramo de texto dibujado (un Tj/TJ), ya en mm de la página. */
interface TextRun {
  text: string;
  font: string;
  /** Tamaño de letra en pt (en la página). */
  sizePt: number;
  /** Estiramiento horizontal (1 = normal). */
  stretch: number;
  /** Inicio y fin sobre la línea base, en mm. */
  start: Point;
  end: Point;
  fill: string | null;
  stroke: string | null;
  strokeWidthMm: number;
  alpha: number;
}

export interface ImportedPage {
  shapes: Shape[];
  assets: ImageAsset[];
}

/** Convierte una página. Las coordenadas salen en mm, con el origen arriba a la izquierda. */
export async function importPdfPage(input: PdfPageInput, OPS: PdfOpCodes, hooks: PdfImportHooks = {}): Promise<ImportedPage> {
  const [x0, y0, , y1] = input.view as [number, number, number, number];
  // De puntos de PDF (y hacia arriba) a mm de la página (y hacia abajo).
  const toMm: Matrix = [PT, 0, 0, -PT, -x0 * PT, y1 * PT];
  const pageHeight = (y1 - y0) * PT;
  const pageWidth = ((input.view[2] ?? 0) - x0) * PT;
  let gs: GState = { ctm: IDENTITY, fill: '#000000', stroke: '#000000', lineWidth: 1, fillAlpha: 1, clip: null, font: null, fontSize: 12, charSpacing: 0, wordSpacing: 0, hscale: 1, leading: 0, rise: 0, render: 0 };
  const stack: GState[] = [];
  const shapes: Shape[] = [];
  const assets: ImageAsset[] = [];
  const fontNames = new Map<string, ReturnType<typeof parseFontName>>();
  const fontOf = (id: string) => {
    let f = fontNames.get(id);
    if (!f) {
      f = parseFontName(input.fontName(id) ?? 'Arial', hooks.resolveFamily);
      fontNames.set(id, f);
    }
    return f;
  };
  const scaleOf = (m: Matrix) => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
  const pageMatrix = () => pdfMul(gs.ctm, toMm);

  // Texto
  let tm: Matrix = IDENTITY;
  let tlm: Matrix = IDENTITY;
  let blockRuns: TextRun[] = [];

  /** Trazado de pdf.js → subtrayectos en mm. */
  const readPath = (buffer: ArrayLike<number>, close: boolean): Subpath[] => {
    const m = pageMatrix();
    // Milésimas de mm: invisible a cualquier tamaño y el archivo pesa mucho menos.
    const r = (v: number) => Math.round(v * 1000) / 1000;
    const p = (x: number, y: number) => {
      const q = apply(m, { x, y });
      return { x: r(q.x), y: r(q.y) };
    };
    const subs: Subpath[] = [];
    let nodes: PathNode[] = [];
    let closed = false;
    let last: Point = { x: 0, y: 0 };
    const flush = () => {
      if (nodes.length >= 2) {
        // Si termina donde empezó, el último nodo se fusiona con el primero.
        const a = nodes[0]!;
        const b = nodes[nodes.length - 1]!;
        if (nodes.length > 2 && Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6) {
          a.in = b.in;
          nodes.pop();
          closed = true;
        }
        subs.push({ closed: closed || close, nodes });
      }
      nodes = [];
      closed = false;
    };
    for (let i = 0; i < buffer.length; ) {
      const op = buffer[i++]!;
      if (op === 0) {
        flush();
        last = p(buffer[i]!, buffer[i + 1]!);
        nodes.push({ ...last, in: null, out: null, type: 'cusp' });
        i += 2;
      } else if (op === 1) {
        last = p(buffer[i]!, buffer[i + 1]!);
        nodes.push({ ...last, in: null, out: null, type: 'cusp' });
        i += 2;
      } else if (op === 2) {
        const c1 = p(buffer[i]!, buffer[i + 1]!);
        const c2 = p(buffer[i + 2]!, buffer[i + 3]!);
        last = p(buffer[i + 4]!, buffer[i + 5]!);
        const prev = nodes[nodes.length - 1];
        if (prev) prev.out = c1;
        nodes.push({ ...last, in: c2, out: null, type: 'cusp' });
        i += 6;
      } else if (op === 3) {
        // Cuadrática → cúbica
        const c = p(buffer[i]!, buffer[i + 1]!);
        const end = p(buffer[i + 2]!, buffer[i + 3]!);
        const prev = nodes[nodes.length - 1];
        if (prev) prev.out = { x: last.x + (2 / 3) * (c.x - last.x), y: last.y + (2 / 3) * (c.y - last.y) };
        nodes.push({ ...end, in: { x: end.x + (2 / 3) * (c.x - end.x), y: end.y + (2 / 3) * (c.y - end.y) }, out: null, type: 'cusp' });
        last = end;
        i += 4;
      } else if (op === 4) {
        closed = true;
        flush();
      } else break;
    }
    flush();
    return subs;
  };

  let pendingClip = false;
  let pendingEvenOdd = true;

  const emitPath = (subpaths: Subpath[], paint: number) => {
    const isFill = [OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke].includes(paint);
    const isStroke = [OPS.stroke, OPS.closeStroke, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke].includes(paint);
    const evenOdd = [OPS.eoFill, OPS.eoFillStroke, OPS.closeEOFillStroke].includes(paint);
    if (!isFill && !isStroke) return;
    // Rellenar cierra los subtrayectos (como en PDF).
    const subs = isFill ? subpaths.map((s) => ({ ...s, closed: true })) : subpaths;
    if (subs.length === 0) return;
    const path: PathShape = createPath(subs, { fill: isFill ? gs.fill : null, stroke: isStroke ? gs.stroke : null, strokeWidth: isStroke ? gs.lineWidth * scaleOf(gs.ctm) * PT : 0.2 });
    if (!evenOdd) path.fillRule = 'nonzero';
    if (gs.fillAlpha < 1) path.opacity = gs.fillAlpha;
    shapes.push(path);
  };

  const showGlyphs = (glyphs: unknown[]) => {
    if (!gs.font || gs.render === 3 || gs.render === 7) {
      advance(glyphs);
      return;
    }
    const font = gs.font;
    const startM = pdfMul(pdfMul([gs.hscale, 0, 0, 1, 0, gs.rise], tm), pageMatrix());
    let text = '';
    for (const g of glyphs) if (g && typeof g === 'object' && 'unicode' in g) text += String((g as { unicode: string }).unicode ?? '');
    const start = apply(startM, { x: 0, y: 0 });
    advance(glyphs);
    const endM = pdfMul(pdfMul([gs.hscale, 0, 0, 1, 0, gs.rise], tm), pageMatrix());
    const end = apply(endM, { x: 0, y: 0 });
    // Tamaño: el de la dirección vertical del texto en la página.
    const ys = Math.hypot(startM[2], startM[3]);
    const xs = Math.hypot(startM[0], startM[1]);
    const sizeMm = gs.fontSize * ys;
    const mode = gs.render % 4;
    blockRuns.push({
      text,
      font,
      sizePt: sizeMm / PT,
      stretch: ys > 0 ? xs / ys : 1,
      start,
      end,
      fill: mode === 0 || mode === 2 ? gs.fill : null,
      stroke: mode === 1 || mode === 2 ? gs.stroke : null,
      strokeWidthMm: (gs.lineWidth * scaleOf(pdfMul(tm, gs.ctm)) * PT) / 2,
      alpha: gs.fillAlpha,
    });
  };

  /** Avanza la matriz de texto por los glifos (y los espacios de TJ). */
  const advance = (glyphs: unknown[]) => {
    for (const g of glyphs) {
      let tx: number;
      if (typeof g === 'number') tx = (-g / 1000) * gs.fontSize * gs.hscale;
      else if (g && typeof g === 'object') {
        const glyph = g as { width?: number; isSpace?: boolean };
        tx = (((glyph.width ?? 0) / 1000) * gs.fontSize + gs.charSpacing + (glyph.isSpace ? gs.wordSpacing : 0)) * gs.hscale;
      } else continue;
      tm = pdfMul([1, 0, 0, 1, tx, 0], tm);
    }
  };

  const flushText = () => {
    if (blockRuns.length) shapes.push(...textShapes(blockRuns, fontOf, hooks));
    blockRuns = [];
  };

  for (let i = 0; i < input.fnArray.length; i++) {
    const fn = input.fnArray[i]!;
    const args = input.argsArray[i] as unknown[] | null;
    switch (fn) {
      case OPS.save:
        stack.push({ ...gs });
        break;
      case OPS.restore:
        gs = stack.pop() ?? gs;
        break;
      case OPS.transform:
        gs.ctm = pdfMul(args as unknown as Matrix, gs.ctm);
        break;
      case OPS.setGState:
        for (const [key, value] of (args?.[0] as Array<[string, unknown]>) ?? []) if (key === 'ca' && typeof value === 'number') gs.fillAlpha = value;
        break;
      case OPS.setLineWidth:
        gs.lineWidth = Number(args?.[0]) || 0;
        break;
      case OPS.setFillRGBColor:
        gs.fill = hexOf(args?.[0], gs.fill);
        break;
      case OPS.setStrokeRGBColor:
        gs.stroke = hexOf(args?.[0], gs.stroke);
        break;
      case OPS.clip:
      case OPS.eoClip:
        pendingClip = true;
        pendingEvenOdd = fn === OPS.eoClip;
        break;
      case OPS.constructPath: {
        const [paint, data] = args as [number, Array<ArrayLike<number>>];
        const buffer = data?.[0];
        if (!buffer) break;
        const closeFirst = paint === OPS.closeStroke || paint === OPS.closeFillStroke || paint === OPS.closeEOFillStroke;
        const subs = readPath(buffer, closeFirst);
        if (pendingClip) {
          gs.clip = subs.map((s) => ({ ...s, closed: true }));
          void pendingEvenOdd;
          pendingClip = false;
        }
        emitPath(subs, paint);
        break;
      }
      case OPS.beginText:
        tm = IDENTITY;
        tlm = IDENTITY;
        blockRuns = [];
        break;
      case OPS.endText:
        flushText();
        break;
      case OPS.setTextMatrix: {
        const m = (Array.isArray(args?.[0]) || ArrayBuffer.isView(args?.[0]) ? args![0] : args) as ArrayLike<number>;
        tm = [m[0]!, m[1]!, m[2]!, m[3]!, m[4]!, m[5]!];
        tlm = tm;
        break;
      }
      case OPS.moveText:
      case OPS.setLeadingMoveText: {
        const [tx, ty] = args as [number, number];
        if (fn === OPS.setLeadingMoveText) gs.leading = -ty;
        tlm = pdfMul([1, 0, 0, 1, tx, ty], tlm);
        tm = tlm;
        break;
      }
      case OPS.nextLine:
        tlm = pdfMul([1, 0, 0, 1, 0, -gs.leading], tlm);
        tm = tlm;
        break;
      case OPS.setLeading:
        gs.leading = Number(args?.[0]) || 0;
        break;
      case OPS.setCharSpacing:
        gs.charSpacing = Number(args?.[0]) || 0;
        break;
      case OPS.setWordSpacing:
        gs.wordSpacing = Number(args?.[0]) || 0;
        break;
      case OPS.setHScale:
        gs.hscale = (Number(args?.[0]) || 100) / 100;
        break;
      case OPS.setTextRise:
        gs.rise = Number(args?.[0]) || 0;
        break;
      case OPS.setTextRenderingMode:
        gs.render = Number(args?.[0]) || 0;
        break;
      case OPS.setFont:
        gs.font = String(args?.[0] ?? '');
        gs.fontSize = Number(args?.[1]) || 12;
        break;
      case OPS.nextLineShowText:
      case OPS.nextLineSetSpacingShowText:
        tlm = pdfMul([1, 0, 0, 1, 0, -gs.leading], tlm);
        tm = tlm;
        if (fn === OPS.nextLineSetSpacingShowText) {
          gs.wordSpacing = Number(args?.[0]) || 0;
          gs.charSpacing = Number(args?.[1]) || 0;
          showGlyphs((args?.[2] as unknown[]) ?? []);
        } else showGlyphs((args?.[0] as unknown[]) ?? []);
        break;
      case OPS.showText:
      case OPS.showSpacedText:
        showGlyphs((args?.[0] as unknown[]) ?? []);
        break;
      case OPS.paintImageXObject: {
        const asset = await input.image(String(args?.[0] ?? ''));
        if (!asset) break;
        if (!assets.some((a) => a.id === asset.id)) assets.push(asset);
        // La imagen ocupa el cuadrado unidad de su matriz (la fila de arriba en y = 1).
        const m = pageMatrix();
        const w = Math.hypot(m[0], m[1]);
        const h = Math.hypot(m[2], m[3]);
        if (w < 1e-6 || h < 1e-6) break;
        const transform = multiply(m, [1 / w, 0, 0, -1 / h, 0, 1]);
        const image: ImageShape = { id: newShapeId(), kind: 'image', assetId: asset.id, width: w, height: h, transform, fill: null, stroke: null, strokeWidth: 0.2 };
        const clip = gs.clip;
        if (clip && !sameBox(clip, shapeBounds(image))) {
          // Imagen recortada por un trazado: PowerClip (contenedor sin relleno ni contorno).
          const container = createPath(clip, { fill: null, stroke: null, strokeWidth: 0.2 });
          shapes.push(container, { ...image, clipId: container.id });
        } else shapes.push(image);
        break;
      }
      default:
        break;
    }
  }
  flushText();
  return { shapes: groupLogos(alignToFrames(shapes, pageWidth, pageHeight), pageWidth * pageHeight), assets };
}

/** ¿El recorte es solo el borde de la imagen? (entonces no hace falta PowerClip). */
function sameBox(clip: Subpath[], box: Rect): boolean {
  const pts = clip.flatMap((s) => s.nodes);
  if (pts.length === 0) return true;
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const tol = 0.5;
  return Math.abs(Math.min(...xs) - box.x) < tol && Math.abs(Math.min(...ys) - box.y) < tol && Math.abs(Math.max(...xs) - (box.x + box.width)) < tol && Math.abs(Math.max(...ys) - (box.y + box.height)) < tol && pts.length <= 5;
}

/** Marca de alineación provisional que `alignToFrames` resuelve con los marcos de la página. */
const AUTO_ALIGN = Symbol('autoAlign');
type PendingText = TextShape & { [AUTO_ALIGN]?: { start: Point; center: Point; localY: number } };

/**
 * Bloque de texto → textos de Trazo. Las líneas de un bloque con el mismo
 * estilo van en un solo texto (con su interlineado y su alineación).
 */
function textShapes(runs: TextRun[], fontOf: (id: string) => ReturnType<typeof parseFontName>, hooks: PdfImportHooks): TextShape[] {
  // 1. Tramos → líneas (misma línea base, uno tras otro).
  interface Line {
    runs: TextRun[];
    text: string;
    start: Point;
    end: Point;
  }
  const lines: Line[] = [];
  for (const run of runs) {
    if (!run.text) continue;
    const prev = lines[lines.length - 1];
    const sameStyle = (a: TextRun, b: TextRun) => a.font === b.font && Math.abs(a.sizePt - b.sizePt) < 0.05 && a.fill === b.fill && a.stroke === b.stroke;
    if (prev) {
      const last = prev.runs[prev.runs.length - 1]!;
      const dir = unit(sub(last.end, last.start), { x: 1, y: 0 });
      const off = sub(run.start, last.end);
      const along = dot(off, dir);
      const across = Math.abs(cross(dir, off));
      const em = (run.sizePt * PT);
      if (sameStyle(last, run) && across < em * 0.25 && along > -em * 0.5 && along < em * 3) {
        const gap = along > em * 0.2 && !/\s$/.test(prev.text) && !/^\s/.test(run.text) ? ' ' : '';
        prev.text += gap + run.text;
        prev.runs.push(run);
        prev.end = run.end;
        continue;
      }
    }
    lines.push({ runs: [run], text: run.text, start: run.start, end: run.end });
  }
  // 2. Líneas seguidas con el mismo estilo → un texto.
  const out: TextShape[] = [];
  let group: Line[] = [];
  const style = (l: Line) => {
    const r = l.runs[0]!;
    return `${r.font}|${r.sizePt.toFixed(2)}|${r.fill}|${r.stroke}|${r.stretch.toFixed(3)}`;
  };
  const flush = () => {
    if (group.length) out.push(makeText(group, fontOf, hooks));
    group = [];
  };
  for (const line of lines) {
    if (!line.text.trim()) continue;
    const prev = group[group.length - 1];
    if (prev && style(prev) === style(line)) {
      const r = line.runs[0]!;
      const dir = unit(sub(prev.end, prev.start), { x: 1, y: 0 });
      const step = cross(dir, sub(line.start, prev.start));
      const em = r.sizePt * PT;
      // Línea de abajo, a una distancia razonable (0.8 a 2.5 veces el tamaño).
      if (step > em * 0.8 && step < em * 2.5) {
        group.push(line);
        continue;
      }
    }
    flush();
    group.push(line);
  }
  flush();
  return out;

  function makeText(group: Line[], fontOf: (id: string) => ReturnType<typeof parseFontName>, hooks: PdfImportHooks): PendingText {
    const r = group[0]!.runs[0]!;
    const font = fontOf(r.font);
    const dir = unit(sub(group[0]!.end, group[0]!.start), { x: 1, y: 0 });
    const normal = { x: -dir.y, y: dir.x }; // hacia abajo de la línea
    const origin = group[0]!.start;
    const along = (p: Point) => dot(sub(p, origin), dir);
    const starts = group.map((l) => along(l.start));
    const ends = group.map((l) => along(l.end));
    const centers = group.map((_, i) => (starts[i]! + ends[i]!) / 2);
    const widest = Math.max(...group.map((_, i) => ends[i]! - starts[i]!));
    const tol = Math.max(0.4, widest * 0.02);
    const spread = (v: number[]) => Math.max(...v) - Math.min(...v);
    let align: TextAlign = 'left';
    let auto = false;
    if (group.length > 1) {
      if (spread(centers) <= tol) align = 'center';
      else if (spread(starts) <= tol) align = 'left';
      else if (spread(ends) <= tol) align = 'right';
      else align = 'center';
    } else {
      // Una sola línea: se decide después (centrada si lo está en su placa).
      auto = true;
      align = 'center';
    }
    const sizeMm = r.sizePt * PT;
    const steps = group.slice(1).map((l, i) => cross(dir, sub(l.start, group[i]!.start)));
    const lineSpacing = steps.length ? steps.reduce((a, b) => a + b, 0) / steps.length / sizeMm : undefined;
    let shape: TextShape = {
      id: newShapeId(),
      kind: 'text',
      text: group.map((l) => l.text.replace(/\s+$/, '')).join('\n'),
      fontFamily: font.family,
      fontSizePt: r.sizePt,
      bold: font.bold,
      italic: font.italic,
      align,
      width: 1,
      height: 1,
      transform: [1, 0, 0, 1, 0, 0],
      fill: r.fill,
      stroke: r.stroke,
      strokeWidth: r.stroke ? Math.max(0.01, r.strokeWidthMm) : 0.2,
      ...(lineSpacing && Math.abs(lineSpacing - 1.2) > 0.02 ? { lineSpacing: Math.round(lineSpacing * 1000) / 1000 } : {}),
      ...(r.alpha < 1 ? { opacity: r.alpha } : {}),
    };
    shape = relayoutText(shape);
    const layout = layoutText(shape);
    const base = (hooks.baselineOffset?.(font.family, font.bold, font.italic) ?? 0.3) * layout.size;
    // Punto de anclaje (izquierda, centro o derecha de la primera línea, sobre su línea base).
    const anchorAlong = align === 'left' ? Math.min(...starts) : align === 'right' ? Math.max(...ends) : centers.reduce((a, b) => a + b, 0) / centers.length;
    const anchor = { x: origin.x + dir.x * anchorAlong, y: origin.y + dir.y * anchorAlong };
    const localX = align === 'left' ? 0 : align === 'right' ? layout.width : layout.width / 2;
    const localY = layout.lineHeight / 2 + base;
    const stretch = r.stretch;
    // Matriz local → página: giro según la línea, estiramiento horizontal.
    const a = dir.x * stretch;
    const b = dir.y * stretch;
    const c = normal.x;
    const d = normal.y;
    shape = { ...shape, align, transform: [a, b, c, d, anchor.x - (a * localX + c * localY), anchor.y - (b * localX + d * localY)] };
    const pending = shape as PendingText;
    if (auto) pending[AUTO_ALIGN] = { start: { x: origin.x + dir.x * starts[0]!, y: origin.y + dir.y * starts[0]! }, center: anchor, localY };
    return pending;
  }
}

/**
 * Textos de una sola línea: si quedan centrados en el marco o fondo que los
 * contiene (la placa), se dejan "centrados", así al cambiar el nombre sigue al centro.
 */
function alignToFrames(shapes: Shape[], pageW: number, pageH: number): Shape[] {
  const frames = shapes.filter((s) => s.kind === 'path' && (s.fill || s.stroke)).map((s) => shapeBounds(s)).filter((b) => b.width * b.height > pageW * pageH * 0.04);
  return shapes.map((s) => {
    const info = (s as PendingText)[AUTO_ALIGN];
    if (!info || s.kind !== 'text') return s;
    const text = { ...(s as TextShape) };
    delete (text as PendingText)[AUTO_ALIGN];
    const { center, start, localY } = info;
    const inside = frames.filter((f) => center.x > f.x && center.x < f.x + f.width && center.y > f.y && center.y < f.y + f.height).sort((p, q) => p.width * p.height - q.width * q.height);
    const frame = inside[0];
    if (frame && Math.abs(center.x - (frame.x + frame.width / 2)) <= frame.width * 0.03) return text;
    // No está centrado en su placa: alineado a la izquierda, desde donde empieza en el PDF.
    const [a, b, c, d] = text.transform;
    return { ...text, align: 'left', transform: [a, b, c, d, start.x - c * localY, start.y - d * localY] };
  });
}


/**
 * Logos y adornos: los trazados seguidos que juntos ocupan poco de la página
 * se agrupan (se mueven juntos; Ctrl+clic toma una pieza). Los fondos grandes
 * quedan sueltos.
 */
function groupLogos(shapes: Shape[], pageArea: number): Shape[] {
  const out: Shape[] = [];
  let run: Shape[] = [];
  const small = (s: Shape) => {
    const b = shapeBounds(s);
    return b.width * b.height < pageArea * 0.12;
  };
  const flush = () => {
    if (run.length >= 2) {
      const box = unionBounds(run.map((s) => shapeBounds(s)))!;
      if (box.width * box.height < pageArea * 0.25) {
        const groupId = `g${newShapeId()}`;
        out.push(...run.map((s) => ({ ...s, groupId })));
        run = [];
        return;
      }
    }
    out.push(...run);
    run = [];
  };
  for (const s of shapes) {
    if (s.kind === 'path' && !s.clipId && (s.fill || s.stroke) && small(s)) {
      // Un trazado lejos del grupo actual empieza otro grupo.
      if (run.length) {
        const box = unionBounds(run.map((x) => shapeBounds(x)))!;
        const b = shapeBounds(s);
        const gap = Math.max(b.x - (box.x + box.width), box.x - (b.x + b.width), b.y - (box.y + box.height), box.y - (b.y + b.height));
        if (gap > 15) flush();
      }
      run.push(s);
    } else {
      flush();
      out.push(s);
    }
  }
  flush();
  return out;
}

const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });
const dot = (a: Point, b: Point) => a.x * b.x + a.y * b.y;
const cross = (a: Point, b: Point) => a.x * b.y - a.y * b.x;
function unit(v: Point, fallback: Point): Point {
  const l = Math.hypot(v.x, v.y);
  return l < 1e-9 ? fallback : { x: v.x / l, y: v.y / l };
}

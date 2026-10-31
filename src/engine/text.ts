import { apply, multiply, translate } from './matrix';
import type { TextAlign, TextShape } from './shapes';
import { newShapeId } from './shapes';
import type { Point } from './viewport';

/**
 * Motor de texto: reparte el texto en líneas, mide cada línea con la fuente real
 * y calcula la caja del objeto. La medición la pone la interfaz (Canvas); en
 * pruebas sin navegador se usa una aproximación.
 */

/** 1 punto tipográfico = 1/72 de pulgada. */
export const PT_TO_MM = 25.4 / 72;
/** Interlineado: 1.2 veces el tamaño de la letra. */
export const LINE_HEIGHT = 1.2;

export interface FontSpec {
  family: string;
  bold: boolean;
  italic: boolean;
}

/** Devuelve el ancho del texto en "em" (múltiplos del tamaño de letra). */
export type TextMeasurer = (text: string, font: FontSpec) => number;

let measurer: TextMeasurer = (text) => text.length * 0.55;

export function setTextMeasurer(fn: TextMeasurer): void {
  measurer = fn;
}

/** Cadena `font` de Canvas para dibujar a `px` píxeles (con fuentes de respaldo). */
export function cssFont(font: FontSpec, px: number): string {
  const family = font.family.replace(/["\\]/g, '');
  return `${font.italic ? 'italic ' : ''}${font.bold ? 'bold ' : ''}${px}px "${family}", "Segoe UI", Arial, sans-serif`;
}

/** Una letra de un texto en arco: centro (en la línea media), giro y ancho, en mm locales. */
export interface ArcGlyph {
  ch: string;
  x: number;
  y: number;
  /** Giro en radianes (positivo = horario). */
  rotation: number;
  width: number;
  line: number;
}

export interface TextLayout {
  /** Líneas tal como se ven (en el texto de párrafo, ya cortadas para caber). */
  lines: string[];
  /** Dónde empieza cada línea dentro del texto (para poner el cursor). */
  starts: number[];
  /** Ancho de cada línea (mm, geometría local). */
  widths: number[];
  width: number;
  height: number;
  lineHeight: number;
  /** Tamaño de la letra en mm. */
  size: number;
  /** Texto en arco: cada letra en su lugar. */
  glyphs?: ArcGlyph[];
}

type LayoutInput = Pick<TextShape, 'text' | 'fontFamily' | 'fontSizePt' | 'bold' | 'italic' | 'maxWidthMm' | 'frameWidth' | 'arc' | 'align' | 'lineSpacing'>;

/**
 * Corta una línea en pedazos que quepan en `maxEm` (ancho en "em"), entre
 * palabras; una palabra más larga que el marco se corta por letras. Los
 * pedazos juntos son exactamente la línea original (los espacios se quedan al
 * final de cada pedazo), así el cursor sabe dónde está cada letra.
 */
export function wrapLine(line: string, maxEm: number, font: FontSpec): string[] {
  if (measurer(line.trimEnd(), font) <= maxEm) return [line];
  const out: string[] = [];
  let rest = line;
  while (rest && measurer(rest.trimEnd(), font) > maxEm) {
    let cut = -1;
    for (let i = 1; i < rest.length; i++) {
      if (rest[i - 1] === ' ' && rest[i] !== ' ') {
        if (measurer(rest.slice(0, i).trimEnd(), font) <= maxEm) cut = i;
        else break;
      }
    }
    if (cut <= 0) {
      // Ninguna palabra cabe completa: se corta por letras (al menos una).
      cut = 1;
      while (cut < rest.length && measurer(rest.slice(0, cut + 1), font) <= maxEm) cut++;
      // No dejar un par sustituto (emoji) partido.
      if (/[\uD800-\uDBFF]/.test(rest[cut - 1] ?? '')) cut++;
    }
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) out.push(rest);
  return out;
}

export function layoutText(shape: LayoutInput): TextLayout {
  let size = shape.fontSizePt * PT_TO_MM;
  const font = { family: shape.fontFamily, bold: shape.bold, italic: shape.italic };
  const frame = shape.frameWidth && shape.frameWidth > 0 ? shape.frameWidth : null;
  const lines: string[] = [];
  const starts: number[] = [];
  let offset = 0;
  for (const hard of shape.text.split('\n')) {
    const pieces = frame ? wrapLine(hard, frame / size, font) : [hard];
    let o = offset;
    for (const piece of pieces) {
      lines.push(piece);
      starts.push(o);
      o += piece.length;
    }
    offset += hard.length + 1;
  }
  // En el párrafo, los espacios del final de una línea cortada no cuentan para alinear.
  let widths = lines.map((line) => measurer(frame ? line.trimEnd() : line, font) * size);
  // Ancho máximo: si no cabe, se achica la letra (todo el texto por igual).
  const widest = Math.max(0, ...widths);
  if (!frame && shape.maxWidthMm && shape.maxWidthMm > 0 && widest > shape.maxWidthMm) {
    const k = shape.maxWidthMm / widest;
    size *= k;
    widths = widths.map((w) => w * k);
  }
  const lineHeight = size * (shape.lineSpacing && shape.lineSpacing > 0 ? shape.lineSpacing : LINE_HEIGHT);
  // Una caja mínima para que un texto vacío se vea (y tenga dónde poner el cursor).
  const width = frame ?? Math.max(size * 0.3, ...widths);
  const layout: TextLayout = { lines, starts, widths, width, height: lineHeight * lines.length, lineHeight, size };
  if (!frame && shape.arc && Math.abs(shape.arc) >= 1 && widest > 0) return bend(layout, shape.arc, shape.align ?? 'left', font);
  return layout;
}

/**
 * Texto en arco: cada letra se coloca sobre un círculo, girada para seguirlo.
 * La primera línea abarca `degrees` grados; las demás van en círculos
 * concéntricos (más adentro o más afuera), alineadas con la primera.
 */
function bend(layout: TextLayout, degrees: number, align: TextAlign, font: FontSpec): TextLayout {
  const { lines, widths, lineHeight, size } = layout;
  const W = layout.width;
  const angle = (Math.max(-359, Math.min(359, degrees)) * Math.PI) / 180;
  const s = Math.sign(angle);
  const R = Math.max(...widths, size) / Math.abs(angle);
  const y0 = lineHeight / 2;
  const cx = W / 2;
  const cy = y0 + s * R;
  const glyphs: ArcGlyph[] = [];
  lines.forEach((line, i) => {
    const y = i * lineHeight + lineHeight / 2;
    const r = Math.max(size * 0.2, R - s * (y - y0));
    const left = lineOffset(align, W, widths[i]!);
    let index = 0;
    for (const ch of line) {
      const x0 = left + measurer(line.slice(0, index), font) * size;
      const x1 = left + measurer(line.slice(0, index + ch.length), font) * size;
      index += ch.length;
      if (!ch.trim()) continue;
      const phi = ((x0 + x1) / 2 - cx) / R;
      glyphs.push({ ch, x: cx + r * Math.sin(phi), y: cy - s * r * Math.cos(phi), rotation: s * phi, width: x1 - x0, line: i });
    }
  });
  if (glyphs.length === 0) return layout;
  // Caja de todas las letras giradas.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const g of glyphs) {
    const c = Math.cos(g.rotation), n = Math.sin(g.rotation);
    for (const [dx, dy] of [[-g.width / 2, -lineHeight / 2], [g.width / 2, -lineHeight / 2], [g.width / 2, lineHeight / 2], [-g.width / 2, lineHeight / 2]] as const) {
      const x = g.x + dx * c - dy * n;
      const y = g.y + dx * n + dy * c;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  return {
    ...layout,
    width: maxX - minX,
    height: maxY - minY,
    glyphs: glyphs.map((g) => ({ ...g, x: g.x - minX, y: g.y - minY })),
  };
}

/** Desplazamiento de una línea dentro de la caja según la alineación. */
export function lineOffset(align: TextAlign, boxWidth: number, lineWidth: number): number {
  return align === 'center' ? (boxWidth - lineWidth) / 2 : align === 'right' ? boxWidth - lineWidth : 0;
}

const alignFactor = (align: TextAlign) => (align === 'center' ? 0.5 : align === 'right' ? 1 : 0);

/**
 * Recalcula la caja tras cambiar el texto o la fuente. El punto de anclaje no se
 * mueve: el borde izquierdo (alineado a la izquierda), el centro o el borde derecho.
 * Si nada cambia devuelve el mismo objeto (así el historial no ve cambios falsos).
 */
export function relayoutText(shape: TextShape): TextShape {
  const { width, height } = layoutText(shape);
  if (Math.abs(width - shape.width) < 1e-9 && Math.abs(height - shape.height) < 1e-9) return shape;
  const dw = width - shape.width;
  return { ...shape, width, height, transform: multiply(shape.transform, translate(-dw * alignFactor(shape.align), 0)) };
}

/** Cambia la alineación sin mover el texto en pantalla (cambia el ancla, no la caja). */
export function realignText(shape: TextShape, align: TextAlign): TextShape {
  if (align === shape.align) return shape;
  return relayoutText({ ...shape, align });
}

export interface TextStyle {
  fill: string | null;
  stroke: string | null;
  strokeWidth: number;
  fontFamily: string;
  fontSizePt: number;
  bold: boolean;
  italic: boolean;
  align: TextAlign;
}

/**
 * Crea un texto en `point` (mm). El punto queda en la línea base aproximada de la
 * primera línea, a la izquierda, al centro o a la derecha según la alineación.
 */
export function createText(point: Point, style: TextStyle, text = ''): TextShape {
  const draft: TextShape = { id: newShapeId(), kind: 'text', text, width: 0, height: 0, transform: [1, 0, 0, 1, 0, 0], ...style };
  const layout = layoutText(draft);
  const x = point.x - layout.width * alignFactor(style.align);
  const y = point.y - layout.lineHeight * 0.75;
  return { ...draft, width: layout.width, height: layout.height, transform: [1, 0, 0, 1, x, y] };
}

/** Línea y columna de un índice del texto. */
export function lineAndColumn(text: string, index: number): { line: number; column: number } {
  const before = text.slice(0, Math.max(0, Math.min(index, text.length))).split('\n');
  return { line: before.length - 1, column: before[before.length - 1]!.length };
}

/** Línea (de las que se ven) y columna de un índice del texto. */
function lineAt(layout: TextLayout, index: number): { line: number; column: number } {
  let line = 0;
  for (let i = 0; i < layout.starts.length; i++) if (layout.starts[i]! <= index) line = i;
  const column = Math.max(0, Math.min(index - layout.starts[line]!, layout.lines[line]!.length));
  return { line, column };
}

/** Segmento del cursor en coordenadas de página (arriba y abajo de la línea). */
export function caretSegment(shape: TextShape, index: number): { top: Point; bottom: Point } {
  const layout = layoutText(shape);
  const { line, column } = lineAt(layout, index);
  const lineText = layout.lines[line] ?? '';
  const font = { family: shape.fontFamily, bold: shape.bold, italic: shape.italic };
  const x = lineOffset(shape.align, shape.width, layout.widths[line] ?? 0) + measurer(lineText.slice(0, column), font) * layout.size;
  const y = line * layout.lineHeight;
  return { top: apply(shape.transform, { x, y: y + layout.lineHeight * 0.08 }), bottom: apply(shape.transform, { x, y: y + layout.lineHeight * 0.92 }) };
}

/** Rectángulos (como 4 esquinas en la página) que cubren el texto seleccionado entre `start` y `end`. */
export function selectionQuads(shape: TextShape, start: number, end: number): Point[][] {
  if (start === end) return [];
  const [a, b] = start < end ? [start, end] : [end, start];
  const layout = layoutText(shape);
  const font = { family: shape.fontFamily, bold: shape.bold, italic: shape.italic };
  const from = lineAt(layout, a);
  const to = lineAt(layout, b);
  const quads: Point[][] = [];
  for (let line = from.line; line <= to.line; line++) {
    const text = layout.lines[line] ?? '';
    const c0 = line === from.line ? from.column : 0;
    const c1 = line === to.line ? to.column : text.length;
    const offset = lineOffset(shape.align, shape.width, layout.widths[line] ?? 0);
    const x0 = offset + measurer(text.slice(0, c0), font) * layout.size;
    // Un salto de línea seleccionado se ve como un trocito al final de la línea.
    const x1 = offset + measurer(text.slice(0, c1), font) * layout.size + (line < to.line ? layout.size * 0.25 : 0);
    const y0 = line * layout.lineHeight;
    const y1 = y0 + layout.lineHeight;
    quads.push([{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }].map((p) => apply(shape.transform, p)));
  }
  return quads;
}

/** Índice del texto más cercano a un punto local (para poner el cursor con un clic). */
export function indexAtLocalPoint(shape: TextShape, local: Point): number {
  const layout = layoutText(shape);
  const font = { family: shape.fontFamily, bold: shape.bold, italic: shape.italic };
  const line = Math.max(0, Math.min(layout.lines.length - 1, Math.floor(local.y / layout.lineHeight)));
  const text = layout.lines[line]!;
  const offset = lineOffset(shape.align, shape.width, layout.widths[line]!);
  // En una línea cortada (párrafo) el cursor no va después del espacio final: ese es el inicio de la siguiente.
  const last = line < layout.lines.length - 1 && layout.starts[line + 1] === layout.starts[line]! + text.length ? text.length - 1 : text.length;
  let best = 0;
  let bestDistance = Infinity;
  for (let column = 0; column <= Math.max(0, last); column++) {
    const x = offset + measurer(text.slice(0, column), font) * layout.size;
    const distance = Math.abs(x - local.x);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = column;
    }
  }
  return layout.starts[line]! + best;
}

/** Escala uniforme aproximada del objeto (para mostrar el tamaño de letra que se ve). */
export function visualScale(shape: TextShape): number {
  const [a, b, c, d] = shape.transform;
  return Math.sqrt(Math.abs(a * d - b * c)) || 1;
}

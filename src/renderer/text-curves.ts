import { parseFont, type Font, type OutlineCommand } from '../engine/font';
import { normalizePath } from '../engine/path';
import type { PathNode, Subpath } from '../engine/path-geom';
import { contour } from '../engine/shape-ops';
import { extrasOf, type PathShape, type TextShape } from '../engine/shapes';
import { cssFont, layoutText, lineOffset } from '../engine/text';

/**
 * Texto → curvas. Las letras salen del archivo de la fuente (contornos reales),
 * colocadas exactamente donde el lienzo dibuja el texto: mismo ancho de línea,
 * misma alineación y misma línea base. Así nada "salta" al convertir.
 *
 * Si la fuente no tiene la variante negrita o cursiva, se simula como lo hace
 * el navegador: cursiva inclinando y negrita engrosando el contorno.
 */

const fontCache = new Map<string, Promise<{ font: Font; bold: boolean; italic: boolean }>>();

async function loadFont(family: string, bold: boolean, italic: boolean) {
  const key = `${family.toLowerCase()}|${bold}|${italic}`;
  let job = fontCache.get(key);
  if (!job) {
    job = (async () => {
      const api = window.trazo?.fonts;
      if (!api?.fontFile) throw new Error('Convertir texto a curvas solo funciona en la app de escritorio.');
      const result = await api.fontFile({ family, bold, italic });
      if (!result.ok) throw new Error(result.error);
      return { font: parseFont(result.value.bytes, { family, bold, italic }), bold: result.value.bold, italic: result.value.italic };
    })();
    fontCache.set(key, job);
    job.catch(() => fontCache.delete(key)); // si falló, se puede reintentar
  }
  return job;
}

const measureCtx = document.createElement('canvas').getContext('2d')!;

/** Distancia (en "em") de la línea media del lienzo (textBaseline = middle) a la línea base. */
function middleToBaseline(shape: TextShape, sample: string): number {
  measureCtx.font = cssFont({ family: shape.fontFamily, bold: shape.bold, italic: shape.italic }, 100);
  measureCtx.textBaseline = 'alphabetic';
  const alphabetic = measureCtx.measureText(sample).actualBoundingBoxAscent;
  measureCtx.textBaseline = 'middle';
  const middle = measureCtx.measureText(sample).actualBoundingBoxAscent;
  return (alphabetic - middle) / 100;
}

/** Comandos de una letra → nodos, con una transformación de unidades de fuente a mm locales. */
function glyphSubpaths(commands: OutlineCommand[], t: (x: number, y: number) => { x: number; y: number }): Subpath[] {
  const subs: Subpath[] = [];
  let nodes: PathNode[] = [];
  const finish = (closed: boolean) => {
    if (nodes.length >= 2) {
      // Si el último punto repite el primero, se fusionan (la manija de entrada pasa al primero).
      const first = nodes[0]!;
      const last = nodes[nodes.length - 1]!;
      if (closed && Math.abs(first.x - last.x) < 1e-9 && Math.abs(first.y - last.y) < 1e-9) {
        first.in = last.in;
        nodes.pop();
      }
      if (nodes.length >= 2) subs.push({ closed: closed && nodes.length >= 2, nodes });
    }
    nodes = [];
  };
  for (const c of commands) {
    if (c.type === 'M') {
      finish(true);
      nodes.push({ ...t(c.x, c.y), in: null, out: null, type: 'cusp' });
    } else if (c.type === 'L') {
      nodes.push({ ...t(c.x, c.y), in: null, out: null, type: 'cusp' });
    } else if (c.type === 'Q') {
      // Cuadrática → cúbica (exacta): los controles a 2/3 del camino hacia el control.
      const prev = nodes[nodes.length - 1];
      if (!prev) continue;
      const p0 = { x: prev.x, y: prev.y };
      const ctl = t(c.cx, c.cy);
      const p1 = t(c.x, c.y);
      prev.out = { x: p0.x + (2 / 3) * (ctl.x - p0.x), y: p0.y + (2 / 3) * (ctl.y - p0.y) };
      nodes.push({ ...p1, in: { x: p1.x + (2 / 3) * (ctl.x - p1.x), y: p1.y + (2 / 3) * (ctl.y - p1.y) }, out: null, type: 'cusp' });
    } else if (c.type === 'C') {
      const prev = nodes[nodes.length - 1];
      if (!prev) continue;
      prev.out = t(c.c1x, c.c1y);
      nodes.push({ ...t(c.x, c.y), in: t(c.c2x, c.c2y), out: null, type: 'cusp' });
    } else {
      finish(true);
    }
  }
  finish(true);
  // Nodos con manijas alineadas: suaves (para editarlos cómodamente con Forma).
  for (const s of subs) {
    for (const n of s.nodes) {
      if (n.in && n.out) {
        const a = { x: n.x - n.in.x, y: n.y - n.in.y };
        const b = { x: n.out.x - n.x, y: n.out.y - n.y };
        const cross = a.x * b.y - a.y * b.x;
        if (Math.abs(cross) < 1e-6 * Math.hypot(a.x, a.y) * Math.hypot(b.x, b.y) + 1e-12) n.type = 'smooth';
      }
    }
  }
  return subs;
}

export interface TextToCurvesResult {
  path: PathShape;
  /** Letras que la fuente no tiene (se omiten). */
  missing: string[];
  simulated: string[];
}

export async function textToPath(shape: TextShape): Promise<TextToCurvesResult> {
  const { font, bold: fileBold, italic: fileItalic } = await loadFont(shape.fontFamily, shape.bold, shape.italic);
  const layout = layoutText(shape);
  const k = layout.size / font.unitsPerEm; // unidades de fuente → mm
  const skew = shape.italic && !fileItalic ? 0.25 : 0; // cursiva simulada (como el navegador)
  const subpaths: Subpath[] = [];
  const missing = new Set<string>();

  if (layout.glyphs) {
    // Texto en arco: cada letra centrada en su punto del círculo y girada.
    const mid = middleToBaseline(shape, layout.lines.join(''));
    for (const g of layout.glyphs) {
      const gi = font.glyphIndex(g.ch.codePointAt(0)!);
      if (gi === 0) {
        missing.add(g.ch);
        continue;
      }
      const adv = font.advance(gi) * k;
      const c = Math.cos(g.rotation);
      const n = Math.sin(g.rotation);
      const t = (fx: number, fy: number) => {
        const lx = -adv / 2 + (fx + fy * skew) * k;
        const ly = mid * layout.size - fy * k;
        return { x: g.x + lx * c - ly * n, y: g.y + lx * n + ly * c };
      };
      subpaths.push(...glyphSubpaths(font.outline(gi), t));
    }
  }
  layout.lines.forEach((rawLine, i) => {
    if (layout.glyphs) return;
    // En el párrafo, los espacios del final de una línea cortada no cuentan.
    const line = shape.frameWidth ? rawLine.trimEnd() : rawLine;
    if (!line) return;
    const chars = [...line];
    const glyphs = chars.map((ch) => font.glyphIndex(ch.codePointAt(0)!));
    // Avances con interletrado de la fuente
    const xs: number[] = [];
    let x = 0;
    glyphs.forEach((g, j) => {
      if (j > 0) x += font.kerning(glyphs[j - 1]!, g);
      xs.push(x);
      x += font.advance(g);
    });
    // Se ajusta al ancho que mide el lienzo (incluye el interletrado que aplica el navegador).
    const fit = x > 0 ? layout.widths[i]! / (x * k) : 1;
    const left = lineOffset(shape.align, shape.width, layout.widths[i]!);
    const baseline = i * layout.lineHeight + layout.lineHeight / 2 + middleToBaseline(shape, line) * layout.size;
    glyphs.forEach((g, j) => {
      if (g === 0) {
        if (chars[j]!.trim()) missing.add(chars[j]!);
        return;
      }
      const ox = left + xs[j]! * k * fit;
      const t = (fx: number, fy: number) => ({ x: ox + (fx + fy * skew) * k, y: baseline - fy * k });
      subpaths.push(...glyphSubpaths(font.outline(g), t));
    });
  });

  if (subpaths.length === 0) throw new Error('El texto no tiene letras visibles para convertir.');
  let path: PathShape = normalizePath({
    id: shape.id,
    kind: 'path',
    width: shape.width,
    height: shape.height,
    transform: shape.transform,
    fill: shape.fill,
    stroke: shape.stroke,
    strokeWidth: shape.strokeWidth,
    subpaths,
    fillRule: 'nonzero',
    ...extrasOf(shape),
  });
  const simulated: string[] = [];
  if (skew) simulated.push('cursiva');
  if (shape.bold && !fileBold) {
    // Negrita simulada: el contorno se engruesa 1/64 del tamaño (como hace el navegador).
    const thick = contour([path], (layout.size / 64) * Math.sqrt(Math.abs(shape.transform[0] * shape.transform[3] - shape.transform[1] * shape.transform[2])), 'outside', shape.fill);
    if (thick) path = { ...thick, id: shape.id, stroke: shape.stroke, strokeWidth: shape.strokeWidth, ...extrasOf(shape) };
    simulated.push('negrita');
  }
  return { path, missing: [...missing], simulated };
}

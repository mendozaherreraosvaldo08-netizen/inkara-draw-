import type { PageData } from './document';
import { translate } from './matrix';
import { createShape, shapeBounds, transformShape, unionBounds, type Rect, type Shape } from './shapes';

/**
 * Dividir en placas: un PDF de Corel suele traer 2 placas por hoja (lado a
 * lado). Cada página se parte en `columns` columnas iguales del ancho de lo
 * dibujado; cada objeto va a la columna de su centro (el contenido de un
 * PowerClip, con su contenedor). Cada placa queda en su propia página, al
 * centro, y la hoja toma el tamaño de la placa más grande.
 */
export function splitIntoPlates(pages: PageData[], columns: number | 'auto'): { pages: PageData[]; size: { w: number; h: number } } | null {
  const out: Array<{ name: string; shapes: Shape[]; box: Rect }> = [];
  for (const page of pages) {
    const visible = page.shapes.filter((s) => !s.hidden && !s.clipId);
    const all = unionBounds(visible.map(shapeBounds).filter((b) => b.width > 0 || b.height > 0));
    if (!all) continue;
    const byId = new Map(page.shapes.map((s) => [s.id, s]));
    const centerOf = (s: Shape) => {
      const b = shapeBounds(s.clipId ? (byId.get(s.clipId) ?? s) : s);
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    };
    // Las placas: las figuras grandes (fondo o marco de cada placa), o columnas iguales.
    let plates: Rect[] = columns === 'auto' ? detectPlates(visible, all) : [];
    if (plates.length === 0) {
      const n = columns === 'auto' ? 1 : Math.max(1, Math.min(8, Math.round(columns)));
      plates = Array.from({ length: n }, (_, k) => ({ x: all.x + (all.width / n) * k, y: all.y, width: all.width / n, height: all.height }));
    }
    const groups: Shape[][] = plates.map(() => []);
    for (const s of page.shapes) {
      const c = centerOf(s);
      let best = 0;
      let bestD = Infinity;
      plates.forEach((p, k) => {
        const inside = c.x >= p.x && c.x <= p.x + p.width && c.y >= p.y && c.y <= p.y + p.height;
        const d = inside ? -1 : Math.hypot(c.x - (p.x + p.width / 2), c.y - (p.y + p.height / 2));
        if (d < bestD) {
          bestD = d;
          best = k;
        }
      });
      groups[best]!.push(s);
    }
    groups.forEach((shapes, k) => {
      const box = unionBounds(shapes.filter((s) => !s.hidden && !s.clipId).map(shapeBounds)); // lo recortado no cuenta
      if (!box || shapes.length === 0) return;
      out.push({ name: plates.length === 1 ? page.name : `${page.name} · placa ${k + 1}`, shapes, box });
    });
  }
  if (out.length === 0) return null;
  const size = { w: Math.max(...out.map((o) => o.box.width)), h: Math.max(...out.map((o) => o.box.height)) };
  const stamp = Date.now().toString(36);
  return {
    size,
    pages: out.map((o, i) => {
      const x0 = (size.w - o.box.width) / 2;
      const y0 = (size.h - o.box.height) / 2;
      const m = translate(-o.box.x + x0, -o.box.y + y0);
      const shapes = o.shapes.map((s) => transformShape(s, m));
      return { id: `placa-${stamp}-${i}`, name: o.name, shapes: withBackground(shapes, { x: x0, y: y0, w: o.box.width, h: o.box.height }) };
    }),
  };
}

/**
 * Busca las placas de una hoja: figuras grandes (el fondo, la textura o el
 * marco de cada placa) que no se enciman entre sí. Si no cubren casi todo lo
 * dibujado, no se adivina (lista vacía).
 */
export function detectPlates(shapes: Shape[], all: Rect): Rect[] {
  const area = all.width * all.height;
  const big = shapes
    .filter((s) => s.kind !== 'text')
    .map(shapeBounds)
    .filter((b) => b.width * b.height >= area * 0.12 && b.width >= all.width * 0.2 && b.height >= all.height * 0.3)
    .sort((a, b) => b.width * b.height - a.width * a.height);
  const overlap = (a: Rect, b: Rect) => {
    const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
    const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
    return w > 0 && h > 0 ? (w * h) / Math.min(a.width * a.height, b.width * b.height) : 0;
  };
  const picked: Rect[] = [];
  for (const b of big) if (picked.every((p) => overlap(p, b) < 0.2)) picked.push(b);
  const covered = picked.reduce((t, p) => t + p.width * p.height, 0);
  if (picked.length === 0 || covered < area * 0.55) return [];
  // De izquierda a derecha, de arriba abajo.
  return picked.sort((a, b) => (Math.abs(a.y - b.y) > Math.min(a.height, b.height) / 2 ? a.y - b.y : a.x - b.x));
}

/**
 * Una placa blanca de Corel no trae fondo (es el papel). Para que los acabados
 * (negro, bronce…) tengan qué pintar, se le pone un rectángulo blanco al fondo
 * si lo de más abajo no cubre ya toda la placa.
 */
export function withBackground(shapes: Shape[], area: { x?: number; y?: number; w: number; h: number }): Shape[] {
  const x = area.x ?? 0;
  const y = area.y ?? 0;
  const covers = (s: Shape) => {
    if (s.hidden || s.clipId) return false;
    const b = shapeBounds(s);
    return b.x <= x + 0.5 && b.y <= y + 0.5 && b.x + b.width >= x + area.w - 0.5 && b.y + b.height >= y + area.h - 0.5;
  };
  const first = shapes.find((s) => !s.hidden && !s.clipId);
  if (first && covers(first) && (first.fill || first.kind === 'image' || first.gradient)) return shapes;
  const bg = { ...createShape('rectangle', { x, y, width: area.w, height: area.h }, { fill: '#FFFFFF', stroke: null, strokeWidth: 0 }), name: 'Fondo' };
  return [bg, ...shapes];
}

/** La placa de una página, sola y a su tamaño (sin el margen de la hoja): para guardarla como plantilla. */
export function fitToContent(shapes: Shape[]): { shapes: Shape[]; size: { w: number; h: number } } | null {
  const box = unionBounds(shapes.filter((s) => !s.hidden && !s.clipId).map(shapeBounds));
  if (!box || box.width <= 0 || box.height <= 0) return null;
  const m = translate(-box.x, -box.y);
  return { shapes: shapes.map((s) => transformShape(s, m)), size: { w: box.width, h: box.height } };
}

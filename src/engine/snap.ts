import type { TrazoDocument } from './document';
import { shapeBounds, unionBounds, type Rect, type Shape } from './shapes';
import type { Point } from './viewport';

/**
 * Ajuste ("imán"): al mover, dibujar o escalar, los bordes y centros se pegan a
 * guías, a los bordes y el centro de la página y a los bordes y centros de los
 * demás objetos, cuando quedan a menos de unos píxeles.
 */

export interface SnapOptions {
  guides: boolean;
  objects: boolean;
  page: boolean;
}

export interface SnapTarget {
  pos: number;
  /** Qué es (para el aviso): guía, página u objeto. */
  source: 'guide' | 'page' | 'object';
}

export interface SnapTargets {
  x: SnapTarget[];
  y: SnapTarget[];
}

/** Línea que se dibuja mientras algo está pegado (vertical si axis = 'x'). */
export interface SnapLine {
  axis: 'x' | 'y';
  pos: number;
  source: SnapTarget['source'];
}

/** Dónde puede pegarse algo. `exclude`: lo que se está moviendo (no se pega a sí mismo). */
export function snapTargets(doc: TrazoDocument, exclude: Set<string>, options: SnapOptions): SnapTargets {
  const x: SnapTarget[] = [];
  const y: SnapTarget[] = [];
  if (options.guides) {
    for (const g of doc.guides ?? []) (g.axis === 'x' ? x : y).push({ pos: g.pos, source: 'guide' });
  }
  if (options.page) {
    const { widthMm: w, heightMm: h, bleedMm: b } = doc.page;
    x.push(...[0, w / 2, w].map((pos) => ({ pos, source: 'page' as const })));
    y.push(...[0, h / 2, h].map((pos) => ({ pos, source: 'page' as const })));
    // Línea de sangrado: los fondos se estiran hasta ahí.
    if (b > 0) {
      x.push({ pos: -b, source: 'page' }, { pos: w + b, source: 'page' });
      y.push({ pos: -b, source: 'page' }, { pos: h + b, source: 'page' });
    }
  }
  if (options.objects) {
    for (const box of objectBoxes(doc.shapes, exclude)) {
      x.push(...[box.x, box.x + box.width / 2, box.x + box.width].map((pos) => ({ pos, source: 'object' as const })));
      y.push(...[box.y, box.y + box.height / 2, box.y + box.height].map((pos) => ({ pos, source: 'object' as const })));
    }
  }
  return { x, y };
}

/** Cajas de lo visible: cada grupo y cada PowerClip cuenta como una sola caja. */
function objectBoxes(shapes: Shape[], exclude: Set<string>): Rect[] {
  const ids = new Set(shapes.map((s) => s.id));
  const units = new Map<string, Rect[]>();
  for (const s of shapes) {
    if (exclude.has(s.id) || s.hidden) continue;
    if (s.clipId && ids.has(s.clipId)) continue; // el contenido no se ve fuera del marco
    const key = s.groupId ? `g:${s.groupId}` : s.id;
    units.set(key, [...(units.get(key) ?? []), shapeBounds(s)]);
  }
  return [...units.values()].map((boxes) => unionBounds(boxes)!).filter(Boolean);
}

/** El objetivo más cercano a alguno de `values`, si está a menos de `threshold`. */
function nearest(values: number[], targets: SnapTarget[], threshold: number): { delta: number; target: SnapTarget } | null {
  let best: { delta: number; target: SnapTarget } | null = null;
  for (const v of values) {
    for (const t of targets) {
      const delta = t.pos - v;
      // A igual distancia ganan las guías (las puso el usuario a propósito).
      const better = !best || Math.abs(delta) < Math.abs(best.delta) - 1e-9 || (Math.abs(Math.abs(delta) - Math.abs(best.delta)) <= 1e-9 && t.source === 'guide' && best.target.source !== 'guide');
      if (Math.abs(delta) <= threshold && better) best = { delta, target: t };
    }
  }
  return best;
}

/** Ajuste de una caja que se mueve: cuánto desplazarla para que un borde o el centro se pegue. */
export function snapRect(rect: Rect, targets: SnapTargets, threshold: number, axes = { x: true, y: true }): { dx: number; dy: number; lines: SnapLine[] } {
  const lines: SnapLine[] = [];
  const nx = axes.x ? nearest([rect.x, rect.x + rect.width / 2, rect.x + rect.width], targets.x, threshold) : null;
  const ny = axes.y ? nearest([rect.y, rect.y + rect.height / 2, rect.y + rect.height], targets.y, threshold) : null;
  if (nx) lines.push({ axis: 'x', pos: nx.target.pos, source: nx.target.source });
  if (ny) lines.push({ axis: 'y', pos: ny.target.pos, source: ny.target.source });
  return { dx: nx?.delta ?? 0, dy: ny?.delta ?? 0, lines };
}

/** Ajuste de un punto (esquina de una figura que se dibuja, tirador que se arrastra). */
export function snapPoint(p: Point, targets: SnapTargets, threshold: number, axes = { x: true, y: true }): { point: Point; lines: SnapLine[] } {
  const lines: SnapLine[] = [];
  const nx = axes.x ? nearest([p.x], targets.x, threshold) : null;
  const ny = axes.y ? nearest([p.y], targets.y, threshold) : null;
  if (nx) lines.push({ axis: 'x', pos: nx.target.pos, source: nx.target.source });
  if (ny) lines.push({ axis: 'y', pos: ny.target.pos, source: ny.target.source });
  return { point: { x: p.x + (nx?.delta ?? 0), y: p.y + (ny?.delta ?? 0) }, lines };
}

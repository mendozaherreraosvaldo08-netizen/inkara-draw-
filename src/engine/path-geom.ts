import { apply, type Matrix } from './matrix';
import type { Point } from './viewport';

/**
 * Geometría de curvas Bézier (sin interfaz). Una curva es una lista de
 * subtrayectos; cada uno, una lista de nodos. Cada nodo tiene su punto y,
 * opcionalmente, dos manijas (de entrada y de salida). Entre dos nodos hay un
 * segmento: recto si ninguno de los dos tiene manija hacia el otro; si no, curvo.
 *
 * Coordenadas locales en mm; la matriz del objeto las lleva a la página.
 */

/** Cúspide: manijas independientes (esquina). Suave: alineadas. Simétrico: alineadas y del mismo largo. */
export type NodeType = 'cusp' | 'smooth' | 'symmetric';

export interface PathNode {
  x: number;
  y: number;
  /** Manija de entrada (hacia el nodo anterior) o null. */
  in: Point | null;
  /** Manija de salida (hacia el nodo siguiente) o null. */
  out: Point | null;
  type: NodeType;
}

export interface Subpath {
  nodes: PathNode[];
  closed: boolean;
}

export interface Segment {
  p0: Point;
  c1: Point;
  c2: Point;
  p1: Point;
  /** true si es recto (sin manijas). */
  line: boolean;
}

/** Segmentos de un subtrayecto (el de cierre incluido si está cerrado). */
export function segments(sub: Subpath): Segment[] {
  const out: Segment[] = [];
  const n = sub.nodes.length;
  const count = sub.closed ? n : n - 1;
  for (let i = 0; i < count; i++) {
    const a = sub.nodes[i]!;
    const b = sub.nodes[(i + 1) % n]!;
    out.push({ p0: { x: a.x, y: a.y }, c1: a.out ?? { x: a.x, y: a.y }, c2: b.in ?? { x: b.x, y: b.y }, p1: { x: b.x, y: b.y }, line: !a.out && !b.in });
  }
  return out;
}

/** Traza los subtrayectos (todos, o solo los cerrados para rellenar). */
export function traceSubpaths(ctx: CanvasRenderingContext2D | Path2D, subpaths: Subpath[], onlyClosed = false): void {
  for (const sub of subpaths) {
    if (sub.nodes.length === 0 || (onlyClosed && !sub.closed)) continue;
    const first = sub.nodes[0]!;
    ctx.moveTo(first.x, first.y);
    for (const s of segments(sub)) {
      if (s.line) ctx.lineTo(s.p1.x, s.p1.y);
      else ctx.bezierCurveTo(s.c1.x, s.c1.y, s.c2.x, s.c2.y, s.p1.x, s.p1.y);
    }
    if (sub.closed) ctx.closePath();
  }
}

export function bezierPoint(s: Segment, t: number): Point {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return { x: a * s.p0.x + b * s.c1.x + c * s.c2.x + d * s.p1.x, y: a * s.p0.y + b * s.c1.y + c * s.c2.y + d * s.p1.y };
}

/** Valores de t (0..1) donde la curva tiene un máximo o mínimo en un eje. */
function extremaT(p0: number, c1: number, c2: number, p1: number): number[] {
  // Derivada: 3[(c1-p0)(1-t)² + 2(c2-c1)(1-t)t + (p1-c2)t²] = at² + bt + c
  const a = -p0 + 3 * c1 - 3 * c2 + p1;
  const b = 2 * (p0 - 2 * c1 + c2);
  const c = c1 - p0;
  const ts: number[] = [];
  if (Math.abs(a) < 1e-12) {
    if (Math.abs(b) > 1e-12) ts.push(-c / b);
  } else {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const r = Math.sqrt(disc);
      ts.push((-b + r) / (2 * a), (-b - r) / (2 * a));
    }
  }
  return ts.filter((t) => t > 0 && t < 1);
}

/** Puntos extremos de una curva llevada a la página (caja exacta, no la de las manijas). */
export function worldExtremes(subpaths: Subpath[], m: Matrix): Point[] {
  const pts: Point[] = [];
  for (const sub of subpaths) {
    if (sub.nodes.length === 1) pts.push(apply(m, sub.nodes[0]!));
    for (const s of segments(sub)) {
      // Una Bézier transformada sigue siendo una Bézier: se transforman sus 4 puntos.
      const w: Segment = { p0: apply(m, s.p0), c1: apply(m, s.c1), c2: apply(m, s.c2), p1: apply(m, s.p1), line: s.line };
      pts.push(w.p0, w.p1);
      if (!s.line) for (const t of [...extremaT(w.p0.x, w.c1.x, w.c2.x, w.p1.x), ...extremaT(w.p0.y, w.c1.y, w.c2.y, w.p1.y)]) pts.push(bezierPoint(w, t));
    }
  }
  return pts;
}

/** Polilínea aproximada de un subtrayecto (en la página), para medir distancias y saber si un punto está dentro. */
export function flatten(sub: Subpath, m: Matrix, steps = 16): Point[] {
  if (sub.nodes.length === 0) return [];
  const pts: Point[] = [apply(m, sub.nodes[0]!)];
  for (const s of segments(sub)) {
    if (s.line) pts.push(apply(m, s.p1));
    else for (let i = 1; i <= steps; i++) pts.push(apply(m, bezierPoint(s, i / steps)));
  }
  return pts;
}

export function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Regla par-impar: los huecos (una letra O, un marco) quedan vacíos. */
export function insideEvenOdd(p: Point, polygons: Point[][]): boolean {
  let inside = false;
  for (const poly of polygons) {
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i]!;
      const b = poly[j]!;
      if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
  }
  return inside;
}

/** Número de vueltas (regla distinto de cero). */
export function windingNumber(p: Point, polygons: Point[][]): number {
  let w = 0;
  for (const poly of polygons) {
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]!;
      const b = poly[(i + 1) % poly.length]!;
      if (a.y <= p.y) {
        if (b.y > p.y && (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y) > 0) w++;
      } else if (b.y <= p.y && (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y) < 0) w--;
    }
  }
  return w;
}

/** ¿El punto (página) toca la curva? Relleno (solo subtrayectos cerrados) o cerca del trazo. */
export function hitSubpaths(subpaths: Subpath[], m: Matrix, p: Point, reach: number, filled: boolean, rule: 'evenodd' | 'nonzero' = 'evenodd'): boolean {
  const polys = subpaths.map((sub) => ({ sub, pts: flatten(sub, m) }));
  const closed = polys.filter((x) => x.sub.closed).map((x) => x.pts);
  if (filled && (rule === 'evenodd' ? insideEvenOdd(p, closed) : windingNumber(p, closed) !== 0)) return true;
  return polys.some(({ sub, pts }) => {
    const n = sub.closed ? pts.length : pts.length - 1;
    for (let i = 0; i < n; i++) if (distanceToSegment(p, pts[i]!, pts[(i + 1) % pts.length]!) <= reach) return true;
    return pts.length === 1 && Math.hypot(p.x - pts[0]!.x, p.y - pts[0]!.y) <= reach;
  });
}

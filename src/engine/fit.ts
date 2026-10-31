import type { PathNode, Subpath } from './path-geom';
import { simplify } from './path';
import type { Point } from './viewport';

/**
 * Ajuste de curvas (algoritmo de Philip J. Schneider, "Graphics Gems", 1990):
 * convierte una polilínea de muchos puntos en pocas curvas Bézier que pasan a
 * menos de `tolerance` mm de todos los puntos. Las esquinas marcadas se
 * conservan como cúspides; los tramos rectos quedan como líneas.
 */

type Bezier = [Point, Point, Point, Point];

const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a: Point, b: Point): Point => ({ x: a.x + b.x, y: a.y + b.y });
const mul = (a: Point, k: number): Point => ({ x: a.x * k, y: a.y * k });
const dot = (a: Point, b: Point) => a.x * b.x + a.y * b.y;
const len = (a: Point) => Math.hypot(a.x, a.y);
const unit = (a: Point): Point => {
  const l = len(a);
  return l > 1e-12 ? mul(a, 1 / l) : { x: 0, y: 0 };
};

function q(b: Bezier, t: number): Point {
  const u = 1 - t;
  return add(add(mul(b[0], u * u * u), mul(b[1], 3 * u * u * t)), add(mul(b[2], 3 * u * t * t), mul(b[3], t * t * t)));
}
function qPrime(b: Bezier, t: number): Point {
  const u = 1 - t;
  return add(add(mul(sub(b[1], b[0]), 3 * u * u), mul(sub(b[2], b[1]), 6 * u * t)), mul(sub(b[3], b[2]), 3 * t * t));
}
function qSecond(b: Bezier, t: number): Point {
  return add(mul(add(sub(b[2], mul(b[1], 2)), b[0]), 6 * (1 - t)), mul(add(sub(b[3], mul(b[2], 2)), b[1]), 6 * t));
}

function chordParams(points: Point[]): number[] {
  const u = [0];
  for (let i = 1; i < points.length; i++) u.push(u[i - 1]! + len(sub(points[i]!, points[i - 1]!)));
  const total = u[u.length - 1]! || 1;
  return u.map((v) => v / total);
}

function generate(points: Point[], u: number[], t1: Point, t2: Point): Bezier {
  const first = points[0]!;
  const last = points[points.length - 1]!;
  let c00 = 0;
  let c01 = 0;
  let c11 = 0;
  let x0 = 0;
  let x1 = 0;
  for (let i = 0; i < points.length; i++) {
    const t = u[i]!;
    const v = 1 - t;
    const a1 = mul(t1, 3 * v * v * t);
    const a2 = mul(t2, 3 * v * t * t);
    c00 += dot(a1, a1);
    c01 += dot(a1, a2);
    c11 += dot(a2, a2);
    const tmp = sub(points[i]!, add(mul(first, v * v * v + 3 * v * v * t), mul(last, 3 * v * t * t + t * t * t)));
    x0 += dot(a1, tmp);
    x1 += dot(a2, tmp);
  }
  const det = c00 * c11 - c01 * c01;
  let alpha1 = det !== 0 ? (x0 * c11 - x1 * c01) / det : 0;
  let alpha2 = det !== 0 ? (c00 * x1 - c01 * x0) / det : 0;
  const segLen = len(sub(last, first));
  const eps = 1e-6 * segLen;
  if (alpha1 < eps || alpha2 < eps) alpha1 = alpha2 = segLen / 3; // estimación de respaldo
  return [first, add(first, mul(t1, alpha1)), add(last, mul(t2, alpha2)), last];
}

function maxError(points: Point[], b: Bezier, u: number[]): { error: number; index: number } {
  let error = 0;
  let index = Math.floor(points.length / 2);
  for (let i = 1; i < points.length - 1; i++) {
    const d = len(sub(q(b, u[i]!), points[i]!));
    if (d > error) {
      error = d;
      index = i;
    }
  }
  return { error, index };
}

function reparameterize(b: Bezier, points: Point[], u: number[]): number[] {
  return u.map((t, i) => {
    const d = sub(q(b, t), points[i]!);
    const p1 = qPrime(b, t);
    const p2 = qSecond(b, t);
    const den = dot(p1, p1) + dot(d, p2);
    return den === 0 ? t : Math.min(1, Math.max(0, t - dot(d, p1) / den));
  });
}

function fitCubic(points: Point[], t1: Point, t2: Point, tolerance: number, out: Bezier[], depth = 0): void {
  if (points.length === 2) {
    const d = len(sub(points[1]!, points[0]!)) / 3;
    out.push([points[0]!, add(points[0]!, mul(t1, d)), add(points[1]!, mul(t2, d)), points[1]!]);
    return;
  }
  let u = chordParams(points);
  let b = generate(points, u, t1, t2);
  let { error, index } = maxError(points, b, u);
  if (error <= tolerance) {
    out.push(b);
    return;
  }
  if (error <= tolerance * 4) {
    for (let k = 0; k < 20; k++) {
      u = reparameterize(b, points, u);
      b = generate(points, u, t1, t2);
      ({ error, index } = maxError(points, b, u));
      if (error <= tolerance) {
        out.push(b);
        return;
      }
    }
  }
  if (depth > 40) {
    out.push(b);
    return;
  }
  // Se parte en el punto de mayor error, con la misma tangente a ambos lados (unión suave).
  const center = unit(sub(points[index - 1]!, points[index + 1]!));
  fitCubic(points.slice(0, index + 1), t1, center, tolerance, out, depth + 1);
  fitCubic(points.slice(index), mul(center, -1), t2, tolerance, out, depth + 1);
}

const CORNER = Math.cos((35 * Math.PI) / 180); // giro de más de 35° = esquina

/** Polilínea cerrada (anillo) → subtrayecto con curvas. */
export function fitRing(ring: Point[], tolerance: number): Subpath {
  // Quita puntos repetidos y los casi alineados.
  let pts = ring.filter((p, i) => len(sub(p, ring[(i + ring.length - 1) % ring.length]!)) > 1e-9);
  if (pts.length < 3) return { closed: true, nodes: pts.map((p) => ({ x: p.x, y: p.y, in: null, out: null, type: 'cusp' })) };
  const closedPts = simplify([...pts, pts[0]!], tolerance * 0.25);
  pts = closedPts.slice(0, -1);
  const n = pts.length;
  if (n < 3) return { closed: true, nodes: pts.map((p) => ({ x: p.x, y: p.y, in: null, out: null, type: 'cusp' })) };

  // Esquinas: donde la dirección cambia bruscamente, o donde un tramo es mucho más largo
  // que sus vecinos (lados rectos de una figura junto a una curva).
  const lengths = pts.map((p, i) => len(sub(pts[(i + 1) % n]!, p)));
  const isCorner = pts.map((p, i) => {
    const a = unit(sub(p, pts[(i - 1 + n) % n]!));
    const b = unit(sub(pts[(i + 1) % n]!, p));
    if (dot(a, b) < CORNER) return true;
    const before = lengths[(i - 1 + n) % n]!;
    const after = lengths[i]!;
    return Math.max(before, after) > 8 * Math.max(Math.min(before, after), tolerance);
  });

  let start = isCorner.indexOf(true);
  const smoothLoop = start < 0;
  if (smoothLoop) start = 0;
  // Recorridos de esquina a esquina (o la vuelta entera si no hay esquinas).
  const order = [...pts.slice(start), ...pts.slice(0, start), pts[start]!];
  const cornerAt = [...isCorner.slice(start), ...isCorner.slice(0, start), true];
  const runs: Point[][] = [];
  let run: Point[] = [order[0]!];
  for (let i = 1; i < order.length; i++) {
    run.push(order[i]!);
    if (cornerAt[i] || i === order.length - 1) {
      runs.push(run);
      run = [order[i]!];
    }
  }

  // Tramos alrededor del anillo: rectos o curvos; `smoothStart` = la unión con el anterior es suave.
  const segs: Array<{ from: Point; c1: Point | null; c2: Point | null; smoothStart: boolean }> = [];
  for (const r of runs) {
    if (r.length === 2) {
      segs.push({ from: r[0]!, c1: null, c2: null, smoothStart: false });
      continue;
    }
    // En una vuelta sin esquinas, la tangente del inicio sale de sus vecinos (unión suave).
    const t1 = smoothLoop ? unit(sub(order[1]!, order[order.length - 2]!)) : unit(sub(r[1]!, r[0]!));
    const t2 = smoothLoop ? mul(t1, -1) : unit(sub(r[r.length - 2]!, r[r.length - 1]!));
    const beziers: Bezier[] = [];
    fitCubic(r, t1, t2, tolerance, beziers);
    beziers.forEach((b, k) => segs.push({ from: b[0], c1: b[1], c2: b[2], smoothStart: k > 0 || smoothLoop }));
  }
  const nodes: PathNode[] = segs.map((seg, i) => {
    const prev = segs[(i - 1 + segs.length) % segs.length]!;
    return { x: seg.from.x, y: seg.from.y, in: prev.c2, out: seg.c1, type: seg.smoothStart ? 'smooth' : 'cusp' };
  });
  return { closed: true, nodes };
}

import { apply, invert, multiply, translate, type Matrix } from './matrix';
import { bezierPoint, distanceToSegment, flatten, segments, type NodeType, type PathNode, type Segment, type Subpath } from './path-geom';
import { boundsOfPoints, extrasOf, newShapeId, polygonPoints, type PathShape, type Shape } from './shapes';
import type { Point } from './viewport';

/**
 * Edición de curvas: nodos, manijas, segmentos, convertir figuras a curvas y
 * suavizar el trazo a mano alzada. Todo devuelve objetos nuevos (para deshacer).
 */

/** Un nodo concreto: subtrayecto e índice. */
export interface NodeRef {
  sub: number;
  node: number;
}

export const refKey = (r: NodeRef) => `${r.sub}:${r.node}`;
export const parseRef = (key: string): NodeRef => {
  const [sub, node] = key.split(':').map(Number);
  return { sub: sub ?? 0, node: node ?? 0 };
};

const cloneSub = (s: Subpath): Subpath => ({ closed: s.closed, nodes: s.nodes.map((n) => ({ ...n, in: n.in && { ...n.in }, out: n.out && { ...n.out } })) });
const add = (a: Point, b: Point): Point => ({ x: a.x + b.x, y: a.y + b.y });
const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });
const scale = (a: Point, k: number): Point => ({ x: a.x * k, y: a.y * k });
const len = (a: Point) => Math.hypot(a.x, a.y);
const lerp = (a: Point, b: Point, t: number): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

export function node(x: number, y: number, type: NodeType = 'cusp', inH: Point | null = null, outH: Point | null = null): PathNode {
  return { x, y, in: inH, out: outH, type };
}

/** Recalcula la caja local y mueve el origen a su esquina (números más limpios, la misma figura en la página). */
export function normalizePath(shape: PathShape): PathShape {
  const pts = shape.subpaths.flatMap((s) => s.nodes.flatMap((n) => [{ x: n.x, y: n.y }, ...(n.in ? [n.in] : []), ...(n.out ? [n.out] : [])]));
  if (pts.length === 0) return shape;
  const box = boundsOfPoints(pts);
  const shift = (p: Point) => ({ x: p.x - box.x, y: p.y - box.y });
  return {
    ...shape,
    width: Math.max(box.width, 0.001),
    height: Math.max(box.height, 0.001),
    transform: multiply(shape.transform, translate(box.x, box.y)),
    subpaths: shape.subpaths.map((s) => ({ closed: s.closed, nodes: s.nodes.map((n) => ({ ...n, ...shift(n), in: n.in && shift(n.in), out: n.out && shift(n.out) })) })),
  };
}

export function createPath(subpaths: Subpath[], style: { fill: string | null; stroke: string | null; strokeWidth: number }, transform: Matrix = [1, 0, 0, 1, 0, 0]): PathShape {
  return normalizePath({ id: newShapeId(), kind: 'path', width: 1, height: 1, transform, subpaths, ...style });
}

// ---- Convertir figuras a curvas ----

const KAPPA = 0.5522847498; // manija para aproximar un cuarto de círculo con una Bézier

function ellipseSub(cx: number, cy: number, rx: number, ry: number): Subpath {
  const kx = rx * KAPPA;
  const ky = ry * KAPPA;
  return {
    closed: true,
    nodes: [
      node(cx, cy - ry, 'symmetric', { x: cx - kx, y: cy - ry }, { x: cx + kx, y: cy - ry }),
      node(cx + rx, cy, 'symmetric', { x: cx + rx, y: cy - ky }, { x: cx + rx, y: cy + ky }),
      node(cx, cy + ry, 'symmetric', { x: cx + kx, y: cy + ry }, { x: cx - kx, y: cy + ry }),
      node(cx - rx, cy, 'symmetric', { x: cx - rx, y: cy + ky }, { x: cx - rx, y: cy - ky }),
    ],
  };
}

function roundRectSub(w: number, h: number, radius: number): Subpath {
  const r = Math.min(radius, w / 2, h / 2);
  if (r <= 0) return { closed: true, nodes: [node(0, 0), node(w, 0), node(w, h), node(0, h)] };
  const k = r * KAPPA;
  return {
    closed: true,
    nodes: [
      node(r, 0, 'smooth', { x: r - k, y: 0 }, null),
      node(w - r, 0, 'smooth', null, { x: w - r + k, y: 0 }),
      node(w, r, 'smooth', { x: w, y: r - k }, null),
      node(w, h - r, 'smooth', null, { x: w, y: h - r + k }),
      node(w - r, h, 'smooth', { x: w - r + k, y: h }, null),
      node(r, h, 'smooth', null, { x: r - k, y: h }),
      node(0, h - r, 'smooth', { x: 0, y: h - r + k }, null),
      node(0, r, 'smooth', null, { x: 0, y: r - k }),
    ],
  };
}

/** ¿Se puede convertir a curvas? (Texto e imágenes, no por ahora.) */
export const canConvertToPath = (shape: Shape) => shape.kind === 'rectangle' || shape.kind === 'ellipse' || shape.kind === 'polygon';

/** Rectángulo, elipse o polígono → curva con los mismos nodos visibles; misma posición y estilo. */
export function toPath(shape: Shape): PathShape | null {
  let subpath: Subpath;
  if (shape.kind === 'rectangle') subpath = roundRectSub(shape.width, shape.height, shape.cornerRadius);
  else if (shape.kind === 'ellipse') subpath = ellipseSub(shape.width / 2, shape.height / 2, shape.width / 2, shape.height / 2);
  else if (shape.kind === 'polygon') subpath = { closed: true, nodes: polygonPoints(shape).map((p) => node(p.x, p.y)) };
  else return null;
  const { id, transform, fill, stroke, strokeWidth } = shape;
  return normalizePath({ id, kind: 'path', width: shape.width, height: shape.height, transform, fill, stroke, strokeWidth, subpaths: [subpath], ...extrasOf(shape) });
}

// ---- Nodos ----

function update(shape: PathShape, fn: (subpaths: Subpath[]) => void): PathShape {
  const subpaths = shape.subpaths.map(cloneSub);
  fn(subpaths);
  return normalizePath({ ...shape, subpaths: subpaths.filter((s) => s.nodes.length > 0) });
}

/** Lleva un desplazamiento de la página (mm) a coordenadas locales del objeto. */
export function localDelta(shape: Shape, d: Point): Point {
  const [a, b, c, dd] = invert(shape.transform);
  return { x: a * d.x + c * d.y, y: b * d.x + dd * d.y };
}

export function toLocal(shape: Shape, p: Point): Point {
  return apply(invert(shape.transform), p);
}

/** Mueve nodos (con sus manijas) un desplazamiento en coordenadas locales. Sin normalizar: la figura no "salta" al arrastrar. */
export function moveNodes(shape: PathShape, refs: NodeRef[], d: Point): PathShape {
  const keys = new Set(refs.map(refKey));
  return {
    ...shape,
    subpaths: shape.subpaths.map((s, si) => ({
      closed: s.closed,
      nodes: s.nodes.map((n, ni) => (keys.has(`${si}:${ni}`) ? { ...n, x: n.x + d.x, y: n.y + d.y, in: n.in && add(n.in, d), out: n.out && add(n.out, d) } : n)),
    })),
  };
}

/**
 * Mueve una manija a `p` (local). En un nodo suave la opuesta gira para seguir
 * alineada (con su largo); en uno simétrico además copia el largo.
 */
export function moveHandle(shape: PathShape, ref: NodeRef, which: 'in' | 'out', p: Point): PathShape {
  return {
    ...shape,
    subpaths: shape.subpaths.map((s, si) => {
      if (si !== ref.sub) return s;
      return {
        closed: s.closed,
        nodes: s.nodes.map((n, ni) => {
          if (ni !== ref.node) return n;
          const other = which === 'in' ? 'out' : 'in';
          const next: PathNode = { ...n, [which]: { ...p } };
          const v = sub(p, n);
          if (n.type !== 'cusp' && len(v) > 1e-9) {
            const otherLen = n.type === 'symmetric' ? len(v) : n[other] ? len(sub(n[other]!, n)) : 0;
            if (otherLen > 1e-9) next[other] = sub(n, scale(v, otherLen / len(v)));
          }
          return next;
        }),
      };
    }),
  };
}

/** Vecinos de un nodo (para crearle manijas). */
function neighbors(s: Subpath, i: number): { prev: PathNode | null; next: PathNode | null } {
  const n = s.nodes.length;
  return { prev: i > 0 ? s.nodes[i - 1]! : s.closed ? s.nodes[n - 1]! : null, next: i < n - 1 ? s.nodes[i + 1]! : s.closed ? s.nodes[0]! : null };
}

/** Cambia el tipo de nodo. Suave/simétrico alinea las manijas (y las crea si no había). */
export function setNodeType(shape: PathShape, refs: NodeRef[], type: NodeType): PathShape {
  return update(shape, (subs) => {
    for (const r of refs) {
      const s = subs[r.sub];
      const n = s?.nodes[r.node];
      if (!s || !n) continue;
      n.type = type;
      if (type === 'cusp') continue;
      const { prev, next } = neighbors(s, r.node);
      // Dirección de la tangente: de la manija de entrada a la de salida, o de vecino a vecino.
      const from = n.in ?? prev ?? n;
      const to = n.out ?? next ?? n;
      let dir = sub(to, from);
      if (len(dir) < 1e-9) dir = { x: 1, y: 0 };
      const unit = scale(dir, 1 / len(dir));
      const inLen = n.in ? len(sub(n.in, n)) : prev ? len(sub(prev, n)) / 3 : 0;
      const outLen = n.out ? len(sub(n.out, n)) : next ? len(sub(next, n)) / 3 : 0;
      const [li, lo] = type === 'symmetric' ? [(inLen + outLen) / 2, (inLen + outLen) / 2] : [inLen, outLen];
      n.in = li > 0 ? sub(n, scale(unit, li)) : null;
      n.out = lo > 0 ? add(n, scale(unit, lo)) : null;
    }
  });
}

/** Segmentos que salen de los nodos elegidos → rectos o curvos. */
export function setSegmentKind(shape: PathShape, refs: NodeRef[], kind: 'line' | 'curve'): PathShape {
  return update(shape, (subs) => {
    for (const r of refs) {
      const s = subs[r.sub];
      if (!s) continue;
      const n = s.nodes.length;
      const a = s.nodes[r.node];
      const bIndex = (r.node + 1) % n;
      if (!a || (!s.closed && r.node === n - 1)) continue;
      const b = s.nodes[bIndex]!;
      if (kind === 'line') {
        a.out = null;
        b.in = null;
      } else if (!a.out && !b.in) {
        a.out = lerp(a, b, 1 / 3);
        b.in = lerp(a, b, 2 / 3);
      }
    }
  });
}

/** Divide un segmento en t con De Casteljau: la figura no cambia, solo aparece un nodo. */
function splitInto(s: Subpath, index: number, t: number): void {
  const n = s.nodes.length;
  const a = s.nodes[index]!;
  const b = s.nodes[(index + 1) % n]!;
  const seg = segments(s)[index]!;
  let newNode: PathNode;
  if (seg.line) {
    newNode = node(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
  } else {
    const p01 = lerp(seg.p0, seg.c1, t);
    const p12 = lerp(seg.c1, seg.c2, t);
    const p23 = lerp(seg.c2, seg.p1, t);
    const p012 = lerp(p01, p12, t);
    const p123 = lerp(p12, p23, t);
    const mid = lerp(p012, p123, t);
    a.out = p01;
    b.in = p23;
    newNode = node(mid.x, mid.y, 'smooth', p012, p123);
  }
  s.nodes.splice(index + 1, 0, newNode);
}

/** Añade un nodo en medio del segmento que sale de cada nodo elegido. */
export function addNodesAfter(shape: PathShape, refs: NodeRef[]): PathShape {
  // De atrás hacia adelante para que los índices no se muevan.
  const sorted = [...refs].sort((a, b) => b.sub - a.sub || b.node - a.node);
  return update(shape, (subs) => {
    for (const r of sorted) {
      const s = subs[r.sub];
      if (s && (s.closed || r.node < s.nodes.length - 1)) splitInto(s, r.node, 0.5);
    }
  });
}

/** Segmento más cercano a un punto de la página (para añadir un nodo con doble clic). */
export function segmentAt(shape: PathShape, p: Point, reach: number): { sub: number; index: number; t: number } | null {
  let best: { sub: number; index: number; t: number } | null = null;
  let bestDistance = reach;
  for (const [si, s] of shape.subpaths.entries()) {
    for (const [index, seg] of segments(s).entries()) {
      const steps = seg.line ? 1 : 32;
      let prev = apply(shape.transform, seg.p0);
      for (let i = 1; i <= steps; i++) {
        const cur = apply(shape.transform, seg.line ? seg.p1 : bezierPoint(seg, i / steps));
        const d = distanceToSegment(p, prev, cur);
        if (d <= bestDistance) {
          // t aproximado: dónde cae el punto dentro del tramo más cercano.
          const dx = cur.x - prev.x;
          const dy = cur.y - prev.y;
          const k = Math.max(0, Math.min(1, ((p.x - prev.x) * dx + (p.y - prev.y) * dy) / (dx * dx + dy * dy || 1)));
          bestDistance = d;
          best = { sub: si, index, t: Math.min(0.98, Math.max(0.02, (i - 1 + k) / steps)) };
        }
        prev = cur;
      }
    }
  }
  return best;
}

export function addNodeAt(shape: PathShape, at: { sub: number; index: number; t: number }): { shape: PathShape; ref: NodeRef } {
  const subpaths = shape.subpaths.map(cloneSub);
  splitInto(subpaths[at.sub]!, at.index, at.t);
  // Sin normalizar: los índices de los demás nodos se mantienen y nada se mueve.
  return { shape: { ...shape, subpaths }, ref: { sub: at.sub, node: at.index + 1 } };
}

/** Borra nodos. Un subtrayecto con menos de 2 nodos desaparece; si no queda nada, devuelve null. */
export function deleteNodes(shape: PathShape, refs: NodeRef[]): PathShape | null {
  const keys = new Set(refs.map(refKey));
  const subpaths = shape.subpaths
    .map((s, si) => ({ closed: s.closed, nodes: s.nodes.filter((_, ni) => !keys.has(`${si}:${ni}`)) }))
    .filter((s) => s.nodes.length >= 2)
    .map((s) => ({ ...s, closed: s.closed && s.nodes.length >= 3 }));
  return subpaths.length ? normalizePath({ ...shape, subpaths }) : null;
}

/** Cierra los subtrayectos abiertos de los nodos elegidos (une el último con el primero). */
export function closeSubpaths(shape: PathShape, refs: NodeRef[]): PathShape {
  const subs = new Set(refs.map((r) => r.sub));
  return update(shape, (list) => list.forEach((s, i) => (subs.has(i) && s.nodes.length >= 2 ? (s.closed = true) : null)));
}

/**
 * Separa la curva en un nodo: si estaba cerrada queda abierta empezando ahí;
 * si estaba abierta se parte en dos subtrayectos.
 */
export function breakAt(shape: PathShape, ref: NodeRef): PathShape {
  return update(shape, (list) => {
    const s = list[ref.sub];
    if (!s) return;
    const at = s.nodes[ref.node]!;
    if (s.closed) {
      // Abre: el nodo se duplica (uno al final y otro al inicio).
      const rotated = [...s.nodes.slice(ref.node), ...s.nodes.slice(0, ref.node)];
      const copy = { ...at, in: at.in && { ...at.in }, out: null };
      rotated[0] = { ...rotated[0]!, in: null };
      list[ref.sub] = { closed: false, nodes: [...rotated, copy] };
    } else if (ref.node > 0 && ref.node < s.nodes.length - 1) {
      const first = { closed: false, nodes: [...s.nodes.slice(0, ref.node), { ...at, out: null }] };
      const second = { closed: false, nodes: [{ ...at, in: null }, ...s.nodes.slice(ref.node + 1)] };
      list.splice(ref.sub, 1, first, second);
    }
  });
}

/** Todos los nodos (para seleccionar todos con Ctrl+A en la herramienta Forma). */
export function allRefs(shape: PathShape): NodeRef[] {
  return shape.subpaths.flatMap((s, si) => s.nodes.map((_, ni) => ({ sub: si, node: ni })));
}

export function nodeCount(shape: PathShape): number {
  return shape.subpaths.reduce((n, s) => n + s.nodes.length, 0);
}

// ---- Mano alzada ----

/** Ramer–Douglas–Peucker: quita puntos que casi no cambian la forma. */
export function simplify(points: Point[], tolerance: number): Point[] {
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop()!;
    let index = -1;
    let max = tolerance;
    for (let i = first + 1; i < last; i++) {
      const d = distanceToSegment(points[i]!, points[first]!, points[last]!);
      if (d > max) {
        max = d;
        index = i;
      }
    }
    if (index !== -1) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/**
 * Trazo a mano alzada → curva suave con pocos nodos. Se simplifica y luego se
 * pasa una spline (Catmull-Rom) por los puntos; donde el trazo hace una esquina
 * marcada se deja una cúspide.
 */
export function fitFreehand(raw: Point[], tolerance: number, closed: boolean): Subpath {
  // Quita puntos repetidos (el ratón quieto).
  const pts = raw.filter((p, i) => i === 0 || len(sub(p, raw[i - 1]!)) > tolerance * 0.1);
  // Al cerrar, el trazo suele pasarse un poco del inicio: se recorta lo que sobra
  // (puntos finales muy cerca del primero) para que no quede una muesca.
  if (closed && pts.length > 8) {
    // Se corta en el punto del último tramo más cercano al inicio (lo que sigue es sobrante).
    const start = pts[0]!;
    let best = pts.length - 1;
    for (let i = Math.floor(pts.length * 0.75); i < pts.length; i++) {
      if (len(sub(pts[i]!, start)) < len(sub(pts[best]!, start))) best = i;
    }
    // Y si ese punto casi coincide con el inicio, también sobra (el cierre lo une).
    const spacing = len(sub(pts[1]!, start));
    pts.length = len(sub(pts[best]!, start)) < Math.max(tolerance * 2, spacing * 0.75) ? best : best + 1;
  }
  const simple = simplify(pts, tolerance);
  if (closed && simple.length > 4) {
    // Último nodo casi encima del primero: sobra (el cierre los une).
    const avg = simple.slice(1).reduce((t, p, i) => t + len(sub(p, simple[i]!)), 0) / (simple.length - 1);
    if (len(sub(simple[simple.length - 1]!, simple[0]!)) < avg * 0.5) simple.pop();
  }
  const n = simple.length;
  if (n < 2) return { closed: false, nodes: simple.map((p) => node(p.x, p.y)) };
  const at = (i: number) => simple[closed ? (i + n) % n : Math.max(0, Math.min(n - 1, i))]!;
  const nodes = simple.map((p, i) => {
    const prev = at(i - 1);
    const next = at(i + 1);
    const a = sub(p, prev);
    const b = sub(next, p);
    const cos = len(a) && len(b) ? (a.x * b.x + a.y * b.y) / (len(a) * len(b)) : 1;
    const isEnd = !closed && (i === 0 || i === n - 1);
    // Esquina marcada (más de ~65°): cúspide sin manijas.
    if (cos < 0.42 && !isEnd) return node(p.x, p.y, 'cusp');
    const tangent = scale(sub(next, prev), 1 / 6);
    // Cada manija mide como mucho un tercio de su tramo: así una curva no "se pasa"
    // del nodo siguiente cuando los nodos quedan muy juntos.
    const t = len(tangent) || 1;
    const inH = scale(tangent, Math.min(1, len(a) / 3 / t));
    const outH = scale(tangent, Math.min(1, len(b) / 3 / t));
    return node(p.x, p.y, isEnd ? 'cusp' : 'smooth', i === 0 && !closed ? null : sub(p, inH), i === n - 1 && !closed ? null : add(p, outH));
  });
  return { closed, nodes };
}

/** Datos de trayectoria SVG ("d") en coordenadas locales. */
export function pathData(subpaths: Subpath[], fmt: (v: number) => string): string {
  return subpaths
    .map((s) => {
      if (!s.nodes.length) return '';
      const first = s.nodes[0]!;
      const parts = [`M${fmt(first.x)} ${fmt(first.y)}`];
      for (const seg of segments(s)) parts.push(seg.line ? `L${fmt(seg.p1.x)} ${fmt(seg.p1.y)}` : `C${fmt(seg.c1.x)} ${fmt(seg.c1.y)} ${fmt(seg.c2.x)} ${fmt(seg.c2.y)} ${fmt(seg.p1.x)} ${fmt(seg.p1.y)}`);
      if (s.closed) parts.push('Z');
      return parts.join(' ');
    })
    .join(' ');
}

/** Para dibujar la curva en edición: polilínea en la página. */
export { flatten };
export type { NodeType, PathNode, Segment, Subpath };

import { booleanOp, offsetRegion, type Predicate, type Region, type Ring } from './boolean';
import { fitRing } from './fit';
import { apply, type Matrix } from './matrix';
import { createPath, toPath } from './path';
import { segments, type Segment, type Subpath } from './path-geom';
import { extrasOf, type PathShape, type Shape } from './shapes';
import type { Point } from './viewport';

/**
 * Soldar, recortar, intersectar y contorno sobre figuras de Trazo.
 * Las figuras se pasan a regiones (polígonos finos en mm de la página), se
 * operan con boolean.ts y el resultado se vuelve a convertir en curvas suaves.
 * El texto llega ya convertido a curvas (lo hace la interfaz, que tiene las fuentes).
 */

/** Precisión al aplanar curvas (mm) y al reajustarlas. Muy por debajo de lo que se ve impreso. */
const FLATTEN = 0.01;
const FIT = 0.02;

/** Aplana una Bézier en tramos rectos hasta que se separa menos de `tol` de la curva. */
function flattenSegment(s: Segment, out: Point[], tol: number, depth = 0): void {
  if (s.line) {
    out.push(s.p1);
    return;
  }
  // Distancia de los puntos de control a la cuerda: si es pequeña, ya es casi recta.
  const dx = s.p1.x - s.p0.x;
  const dy = s.p1.y - s.p0.y;
  const d = Math.hypot(dx, dy) || 1;
  const d1 = Math.abs((s.c1.x - s.p0.x) * dy - (s.c1.y - s.p0.y) * dx) / d;
  const d2 = Math.abs((s.c2.x - s.p0.x) * dy - (s.c2.y - s.p0.y) * dx) / d;
  if (Math.max(d1, d2) * 0.75 <= tol || depth > 16) {
    out.push(s.p1);
    return;
  }
  const mid = (a: Point, b: Point) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const p01 = mid(s.p0, s.c1);
  const p12 = mid(s.c1, s.c2);
  const p23 = mid(s.c2, s.p1);
  const p012 = mid(p01, p12);
  const p123 = mid(p12, p23);
  const m = mid(p012, p123);
  flattenSegment({ p0: s.p0, c1: p01, c2: p012, p1: m, line: false }, out, tol, depth + 1);
  flattenSegment({ p0: m, c1: p123, c2: p23, p1: s.p1, line: false }, out, tol, depth + 1);
}

/** Subtrayecto cerrado → anillo en mm de la página. */
export function subpathToRing(sub: Subpath, m: Matrix, tol = FLATTEN): Ring {
  const ring: Point[] = [];
  if (sub.nodes.length === 0) return ring;
  ring.push(apply(m, sub.nodes[0]!));
  for (const s of segments(sub)) {
    const w: Segment = { p0: apply(m, s.p0), c1: apply(m, s.c1), c2: apply(m, s.c2), p1: apply(m, s.p1), line: s.line };
    flattenSegment(w, ring, tol);
  }
  ring.pop(); // el último coincide con el primero (cerrado)
  return ring;
}

/** Figura → región. null si no tiene áreas cerradas (líneas abiertas, imágenes, texto sin convertir). */
export function shapeRegion(shape: Shape): Region | null {
  const path = shape.kind === 'path' ? shape : toPath(shape);
  if (!path) return null;
  const rings = path.subpaths.filter((s) => s.closed && s.nodes.length >= 3).map((s) => subpathToRing(s, path.transform));
  return rings.length ? { rings, rule: path.fillRule ?? 'evenodd' } : null;
}

/** Anillos del resultado → curva con pocos nodos (o null si no quedó nada). */
export function ringsToPath(rings: Ring[], style: Pick<Shape, 'fill' | 'stroke' | 'strokeWidth'>, id?: string): PathShape | null {
  const subpaths = rings.filter((r) => r.length >= 3).map((r) => fitRing(r, FIT)).filter((s) => s.nodes.length >= 2);
  if (subpaths.length === 0) return null;
  const path = createPath(subpaths, { fill: style.fill, stroke: style.stroke, strokeWidth: style.strokeWidth });
  return id ? { ...path, id } : path;
}

/** Predicado para N regiones: alguna (soldar), todas (intersectar) o la primera menos las demás (recortar). */
function predicate(kind: 'union' | 'intersection' | 'difference', count: number): Predicate {
  if (kind === 'union') return (inside) => {
    for (let i = 0; i < count; i++) if (inside(i)) return true;
    return false;
  };
  if (kind === 'intersection') return (inside) => {
    for (let i = 0; i < count; i++) if (!inside(i)) return false;
    return true;
  };
  return (inside) => {
    if (!inside(0)) return false;
    for (let i = 1; i < count; i++) if (inside(i)) return false;
    return true;
  };
}
export class ShapeOpError extends Error {}

function regionsOf(shapes: Shape[]): Region[] {
  return shapes.map((s) => {
    const r = shapeRegion(s);
    if (!r) throw new ShapeOpError(s.kind === 'image' ? 'Las imágenes no se pueden soldar ni recortar.' : 'Las líneas abiertas no tienen área: ciérralas primero (herramienta Forma).');
    return r;
  });
}

/** Soldar: todas en una sola figura, con el estilo de la de más atrás. */
export function weld(shapes: Shape[]): PathShape | null {
  if (shapes.length < 2) throw new ShapeOpError('Selecciona dos o más objetos para soldar.');
  const rings = booleanOp(regionsOf(shapes), predicate('union', shapes.length));
  return ringsToPath(rings, shapes[0]!);
}

/** Intersectar: solo lo que tienen en común todas. Figura nueva con el estilo de la de más atrás. */
export function intersect(shapes: Shape[]): PathShape | null {
  if (shapes.length < 2) throw new ShapeOpError('Selecciona dos o más objetos para intersectar.');
  const rings = booleanOp(regionsOf(shapes), predicate('intersection', shapes.length));
  return ringsToPath(rings, shapes[0]!);
}

/** Recortar: a la de más atrás se le quita la forma de las de delante (que se conservan). */
export function trim(shapes: Shape[]): PathShape | null {
  if (shapes.length < 2) throw new ShapeOpError('Selecciona dos o más objetos: el de atrás se recorta con los de delante.');
  const rings = booleanOp(regionsOf(shapes), predicate('difference', shapes.length));
  const result = ringsToPath(rings, shapes[0]!, shapes[0]!.id);
  return result && { ...result, ...extrasOf(shapes[0]!) };
}

/** Contorno de todas las figuras juntas, a `distance` mm hacia afuera o hacia adentro. */
export function contour(shapes: Shape[], distance: number, direction: 'outside' | 'inside', fill: string | null): PathShape | null {
  if (shapes.length === 0) throw new ShapeOpError('Selecciona uno o más objetos.');
  if (!(distance > 0)) throw new ShapeOpError('La distancia debe ser mayor que cero.');
  const regions = regionsOf(shapes);
  // Varias figuras: primero se unen (el contorno rodea al conjunto).
  const base: Region = regions.length === 1 ? regions[0]! : { rings: booleanOp(regions, predicate('union', regions.length)), rule: 'evenodd' };
  const rings = offsetRegion(base, distance, direction);
  return ringsToPath(rings, { fill, stroke: null, strokeWidth: shapes[0]!.strokeWidth });
}

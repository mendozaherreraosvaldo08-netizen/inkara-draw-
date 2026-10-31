import type { Point } from './viewport';

/**
 * Matriz afín 2D [a b c d e f], como en Canvas y SVG:
 *   x' = a·x + c·y + e
 *   y' = b·x + d·y + f
 * Cada objeto guarda su geometría local (en mm) y una matriz que la lleva a la
 * página. Mover, escalar, rotar, reflejar e inclinar es solo multiplicar matrices,
 * así que se pueden encadenar sin perder precisión ni deformar el contorno.
 */
export type Matrix = readonly [number, number, number, number, number, number];

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** m1 · m2: primero se aplica m2 y luego m1. */
export function multiply(m1: Matrix, m2: Matrix): Matrix {
  const [a1, b1, c1, d1, e1, f1] = m1;
  const [a2, b2, c2, d2, e2, f2] = m2;
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ];
}

export function invert(m: Matrix): Matrix {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-12) throw new Error('Matriz no invertible (objeto sin ancho o sin alto)');
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

export function apply(m: Matrix, p: Point): Point {
  return { x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] };
}

export const translate = (tx: number, ty: number): Matrix => [1, 0, 0, 1, tx, ty];

/** Escala alrededor de un punto fijo (el ancla: el tirador opuesto o el centro). */
export function scaleAbout(sx: number, sy: number, anchor: Point): Matrix {
  return [sx, 0, 0, sy, anchor.x - sx * anchor.x, anchor.y - sy * anchor.y];
}

/** Rotación en grados (sentido horario en pantalla, porque Y crece hacia abajo) alrededor de un punto. */
export function rotateAbout(degrees: number, center: Point): Matrix {
  const r = (degrees * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  return [cos, sin, -sin, cos, center.x - cos * center.x + sin * center.y, center.y - sin * center.x - cos * center.y];
}

/** Ángulo de rotación de la matriz en grados (−180, 180]. */
export function rotationOf(m: Matrix): number {
  const degrees = (Math.atan2(m[1], m[0]) * 180) / Math.PI;
  return Math.abs(degrees) < 1e-9 ? 0 : degrees;
}

/** ¿La matriz está reflejada (espejo)? */
export const isMirrored = (m: Matrix): boolean => m[0] * m[3] - m[1] * m[2] < 0;

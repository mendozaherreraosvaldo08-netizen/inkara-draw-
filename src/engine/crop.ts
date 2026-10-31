import { apply, invert, multiply, translate } from './matrix';
import type { ImageShape, Rect } from './shapes';

/**
 * Recortar fotos: se elige un rectángulo sobre la página y la foto queda solo con
 * esa parte. No se pierde nada: el recorte se guarda como la fracción visible de
 * la imagen, así "Quitar recorte" devuelve la foto completa.
 */

const FULL = { x: 0, y: 0, width: 1, height: 1 };

/**
 * Recorta una imagen al rectángulo `area` (mm de la página). Si la imagen está
 * rotada, se usa la caja del rectángulo en las coordenadas de la imagen.
 * Devuelve null si el rectángulo no toca la imagen.
 */
export function cropImage(shape: ImageShape, area: Rect): ImageShape | null {
  const inv = invert(shape.transform);
  const corners = [
    { x: area.x, y: area.y },
    { x: area.x + area.width, y: area.y },
    { x: area.x, y: area.y + area.height },
    { x: area.x + area.width, y: area.y + area.height },
  ].map((p) => apply(inv, p));
  const x0 = Math.max(0, Math.min(...corners.map((p) => p.x)));
  const y0 = Math.max(0, Math.min(...corners.map((p) => p.y)));
  const x1 = Math.min(shape.width, Math.max(...corners.map((p) => p.x)));
  const y1 = Math.min(shape.height, Math.max(...corners.map((p) => p.y)));
  if (x1 - x0 < 1e-6 || y1 - y0 < 1e-6) return null;
  const c = shape.crop ?? FULL;
  const crop = {
    x: c.x + (x0 / shape.width) * c.width,
    y: c.y + (y0 / shape.height) * c.height,
    width: ((x1 - x0) / shape.width) * c.width,
    height: ((y1 - y0) / shape.height) * c.height,
  };
  return { ...shape, width: x1 - x0, height: y1 - y0, transform: multiply(shape.transform, translate(x0, y0)), crop };
}

/** Quita el recorte: la foto completa, a la misma escala y en el mismo lugar. */
export function uncropImage(shape: ImageShape): ImageShape {
  const c = shape.crop;
  if (!c) return shape;
  const width = shape.width / c.width;
  const height = shape.height / c.height;
  const { crop: _drop, ...rest } = shape;
  void _drop;
  return { ...rest, width, height, transform: multiply(shape.transform, translate(-c.x * width, -c.y * height)) };
}

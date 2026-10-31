import { apply, invert, multiply, type Matrix } from './matrix';
import { hitSubpaths, traceSubpaths, worldExtremes, type Subpath } from './path-geom';
import type { Point } from './viewport';

export type ShapeKind = 'rectangle' | 'ellipse' | 'polygon' | 'text' | 'image' | 'path';

/** Rectángulo alineado con los ejes (en mm). */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface BaseShape {
  id: string;
  kind: ShapeKind;
  /** Tamaño de la geometría local: va de (0, 0) a (width, height) en mm. */
  width: number;
  height: number;
  /** Lleva la geometría local a la página (posición, escala, rotación, espejo). */
  transform: Matrix;
  /** Color de relleno (#RRGGBB) o null = sin relleno. */
  fill: string | null;
  /** Color del contorno o null = sin contorno. */
  stroke: string | null;
  /** Grosor del contorno en mm. No cambia al escalar el objeto (como en los editores vectoriales). */
  strokeWidth: number;
  /** Grupo (Ctrl+G): los objetos con el mismo id se seleccionan y mueven juntos. */
  groupId?: string;
  /** PowerClip: este objeto está dentro del contenedor con este id (recortado a su forma). */
  clipId?: string;
  /** Relleno degradado (si está, reemplaza al color de relleno). */
  gradient?: Gradient;
  /** Transparencia uniforme: 1 = opaco, 0 = invisible. */
  opacity?: number;
  /** Transparencia degradada (desvanecer): opacidad `from` → `to` en la dirección `angle`. */
  fade?: { angle: number; from: number; to: number };
  /** Oculto (ojo cerrado en el administrador de objetos): no se ve ni se imprime. */
  hidden?: boolean;
  /** Bloqueado (candado): no se puede elegir con el ratón ni moverse. */
  locked?: boolean;
  /** Nombre que le dio el usuario en el administrador de objetos. */
  name?: string;
  /** Sombra paralela (en mm de la página; no gira ni se escala con el objeto). */
  shadow?: Shadow;
  /**
   * Placas en serie: el objeto solo sale si la columna contiene ese valor
   * (p. ej. el logo de Ingeniería si Carrera dice "Industrial"). Varios valores con "|".
   */
  showWhen?: { column: string; value: string };
}

export interface Shadow {
  /** Desplazamiento en mm (x a la derecha, y hacia abajo). */
  dx: number;
  dy: number;
  /** Difuminado en mm (0 = sombra dura). */
  blur: number;
  color: string;
  /** 0–1 */
  opacity: number;
}

/** Degradado lineal (con ángulo: 0° = de izquierda a derecha, 90° = de abajo hacia arriba) o radial (del centro hacia afuera). */
export interface Gradient {
  type: 'linear' | 'radial';
  angle: number;
  stops: Array<{ offset: number; color: string }>;
}

/**
 * Inicio y fin de un degradado lineal que cubre la caja local (0, 0)–(w, h) en el
 * ángulo pedido (en pantalla Y crece hacia abajo, por eso el signo).
 */
export function gradientLine(w: number, h: number, angle: number): { x0: number; y0: number; x1: number; y1: number } {
  const r = (angle * Math.PI) / 180;
  const dx = Math.cos(r);
  const dy = -Math.sin(r);
  const half = Math.abs((w / 2) * dx) + Math.abs((h / 2) * dy);
  return { x0: w / 2 - dx * half, y0: h / 2 - dy * half, x1: w / 2 + dx * half, y1: h / 2 + dy * half };
}

/** Propiedades que se conservan al convertir un objeto en otro (a curvas, recortar…). */
export type ShapeExtras = Partial<Pick<Shape, 'groupId' | 'clipId' | 'gradient' | 'opacity' | 'fade' | 'hidden' | 'locked' | 'name' | 'shadow' | 'showWhen'>>;

export function extrasOf(shape: Shape): ShapeExtras {
  const out: ShapeExtras = {};
  if (shape.hidden) out.hidden = true;
  if (shape.locked) out.locked = true;
  if (shape.name) out.name = shape.name;
  if (shape.shadow) out.shadow = shape.shadow;
  if (shape.showWhen) out.showWhen = shape.showWhen;
  if (shape.groupId) out.groupId = shape.groupId;
  if (shape.clipId) out.clipId = shape.clipId;
  if (shape.gradient) out.gradient = shape.gradient;
  if (shape.opacity !== undefined) out.opacity = shape.opacity;
  if (shape.fade) out.fade = shape.fade;
  return out;
}

/** ¿Puede ser contenedor de PowerClip? Figuras cerradas (el texto, convertido a curvas). */
export function canBeContainer(shape: { kind: string; subpaths?: Array<{ closed: boolean }> }): boolean {
  if (shape.kind === 'rectangle' || shape.kind === 'ellipse' || shape.kind === 'polygon') return true;
  return shape.kind === 'path' && (shape.subpaths ?? []).some((s) => s.closed);
}

export interface RectangleShape extends BaseShape {
  kind: 'rectangle';
  /** Radio de las esquinas en mm (geometría local). */
  cornerRadius: number;
}

export interface EllipseShape extends BaseShape {
  kind: 'ellipse';
}

export interface PolygonShape extends BaseShape {
  kind: 'polygon';
  sides: number;
}

export type TextAlign = 'left' | 'center' | 'right';

/**
 * Texto artístico (una o varias líneas). `width`/`height` los calcula el motor de
 * texto a partir de la fuente (ver text.ts); el tamaño en puntos es el de la
 * geometría local: si se escala el objeto, la letra se ve más grande.
 */
export interface TextShape extends BaseShape {
  kind: 'text';
  text: string;
  fontFamily: string;
  fontSizePt: number;
  bold: boolean;
  italic: boolean;
  align: TextAlign;
  /**
   * Ancho máximo (mm, geometría local): si el texto queda más ancho, la letra se
   * achica sola para caber. Útil para nombres de distinto largo en placas en serie.
   */
  maxWidthMm?: number;
  /**
   * Texto de párrafo: ancho del marco (mm, geometría local). Las líneas se cortan
   * solas entre palabras para caber. Sin esto es texto artístico (una línea por Enter).
   */
  frameWidth?: number;
  /**
   * Texto en arco: grados que abarca la primera línea sobre un círculo.
   * Positivo = arco hacia arriba (∩, como el nombre de la escuela arriba de un
   * escudo); negativo = hacia abajo (∪). No aplica al texto de párrafo.
   */
  arc?: number;
  /** Interlineado (múltiplo del tamaño de letra); sin esto, 1.2. */
  lineSpacing?: number;
}

/**
 * Imagen (foto, logo). Los píxeles van en `document.assets[assetId]`, una sola vez
 * aunque la imagen se duplique. `width`/`height` es su tamaño en la página (mm).
 */
export interface ImageShape extends BaseShape {
  kind: 'image';
  assetId: string;
  /** Parte de la imagen que se muestra (fracciones 0–1); sin recorte = toda. */
  crop?: { x: number; y: number; width: number; height: number };
  /** Placas en serie: columna de los datos con la foto de cada placa. */
  field?: string;
}

/**
 * Curva libre (pluma, mano alzada o figura convertida a curvas). Los nodos están
 * en coordenadas locales; `width`/`height` es la caja local (informativa).
 */
export interface PathShape extends BaseShape {
  kind: 'path';
  subpaths: Subpath[];
  /**
   * Regla de relleno: par-impar (por defecto: los huecos quedan vacíos) o distinto
   * de cero (la de las letras: contornos que se enciman no hacen hueco).
   */
  fillRule?: 'nonzero';
}

export type Shape = RectangleShape | EllipseShape | PolygonShape | TextShape | ImageShape | PathShape;

export const KIND_LABELS: Record<ShapeKind, string> = {
  rectangle: 'Rectángulo',
  ellipse: 'Elipse',
  polygon: 'Polígono',
  text: 'Texto',
  image: 'Imagen',
  path: 'Curva',
};

let counter = 0;
export const newShapeId = (): string => `s${Date.now().toString(36)}${(counter++).toString(36)}`;

export interface ShapeStyle {
  fill: string | null;
  stroke: string | null;
  strokeWidth: number;
}

/** Crea una figura que ocupa `rect` en la página, sin rotación. */
/** Figuras geométricas (el texto se crea con createText, en text.ts). */
export type GeometricKind = Exclude<ShapeKind, 'text' | 'image' | 'path'>;

export function createShape(kind: GeometricKind, rect: Rect, style: ShapeStyle, extra: { cornerRadius?: number; sides?: number } = {}): Shape {
  const base = {
    id: newShapeId(),
    width: Math.max(rect.width, 0.01),
    height: Math.max(rect.height, 0.01),
    transform: [1, 0, 0, 1, rect.x, rect.y] as Matrix,
    ...style,
  };
  if (kind === 'rectangle') return { ...base, kind, cornerRadius: extra.cornerRadius ?? 0 };
  if (kind === 'polygon') return { ...base, kind, sides: Math.max(3, Math.round(extra.sides ?? 5)) };
  return { ...base, kind };
}

/** Vértices de un polígono regular inscrito en la caja local (empieza arriba). */
export function polygonPoints(shape: PolygonShape): Point[] {
  const cx = shape.width / 2;
  const cy = shape.height / 2;
  return Array.from({ length: shape.sides }, (_, i) => {
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / shape.sides;
    return { x: cx + cx * Math.cos(angle), y: cy + cy * Math.sin(angle) };
  });
}

/** Traza la geometría local en un contexto ya transformado. */
export function traceLocalPath(ctx: CanvasRenderingContext2D | Path2D, shape: Shape): void {
  if (shape.kind === 'path') {
    traceSubpaths(ctx, shape.subpaths);
  } else if (shape.kind === 'text' || shape.kind === 'image') {
    ctx.rect(0, 0, shape.width, shape.height);
  } else if (shape.kind === 'rectangle') {
    const r = Math.min(shape.cornerRadius, shape.width / 2, shape.height / 2);
    if (r > 0) ctx.roundRect(0, 0, shape.width, shape.height, r);
    else ctx.rect(0, 0, shape.width, shape.height);
  } else if (shape.kind === 'ellipse') {
    ctx.ellipse(shape.width / 2, shape.height / 2, shape.width / 2, shape.height / 2, 0, 0, Math.PI * 2);
  } else {
    const points = polygonPoints(shape);
    points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.closePath();
  }
}

/** Esquinas de la caja local llevadas a la página (en orden: sup-izq, sup-der, inf-der, inf-izq). */
export function worldCorners(shape: Shape): Point[] {
  const m = shape.transform;
  return [
    apply(m, { x: 0, y: 0 }),
    apply(m, { x: shape.width, y: 0 }),
    apply(m, { x: shape.width, y: shape.height }),
    apply(m, { x: 0, y: shape.height }),
  ];
}

export function boundsOfPoints(points: Point[]): Rect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * Caja envolvente en la página. Para la elipse se calcula exacta (no la de su caja
 * local), así al rotarla los tiradores quedan pegados a la curva.
 */
export function shapeBounds(shape: Shape): Rect {
  if (shape.kind === 'ellipse') {
    const [a, b, c, d, e, f] = shape.transform;
    const rx = shape.width / 2;
    const ry = shape.height / 2;
    const center = { x: a * rx + c * ry + e, y: b * rx + d * ry + f };
    const halfW = Math.hypot(a * rx, c * ry);
    const halfH = Math.hypot(b * rx, d * ry);
    return { x: center.x - halfW, y: center.y - halfH, width: halfW * 2, height: halfH * 2 };
  }
  if (shape.kind === 'polygon') return boundsOfPoints(polygonPoints(shape).map((p) => apply(shape.transform, p)));
  if (shape.kind === 'path') {
    const pts = worldExtremes(shape.subpaths, shape.transform);
    return pts.length ? boundsOfPoints(pts) : { x: shape.transform[4], y: shape.transform[5], width: 0, height: 0 };
  }
  return boundsOfPoints(worldCorners(shape));
}

export function unionBounds(rects: Rect[]): Rect | null {
  if (rects.length === 0) return null;
  return boundsOfPoints(rects.flatMap((r) => [{ x: r.x, y: r.y }, { x: r.x + r.width, y: r.y + r.height }]));
}

/** Aplica una transformación de página (mover, escalar, rotar…) a una figura. */
export function transformShape<T extends Shape>(shape: T, m: Matrix): T {
  return { ...shape, transform: multiply(m, shape.transform) };
}

function pointInPolygon(p: Point, points: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i]!;
    const b = points[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Contorno aproximado en la página (polilínea), para medir distancias al borde. */
function worldOutline(shape: Shape): Point[] {
  if (shape.kind === 'polygon') return polygonPoints(shape).map((p) => apply(shape.transform, p));
  if (shape.kind === 'ellipse') {
    const rx = shape.width / 2;
    const ry = shape.height / 2;
    return Array.from({ length: 48 }, (_, i) => {
      const t = (i / 48) * Math.PI * 2;
      return apply(shape.transform, { x: rx + rx * Math.cos(t), y: ry + ry * Math.sin(t) });
    });
  }
  return worldCorners(shape);
}

/**
 * ¿El punto (mm, en la página) toca la figura? Sobre el relleno, o cerca del
 * contorno (`toleranceMm`, para poder elegir figuras sin relleno por su borde).
 */
export function hitTest(shape: Shape, p: Point, toleranceMm: number): boolean {
  if (shape.kind === 'path') return hitSubpaths(shape.subpaths, shape.transform, p, toleranceMm + (shape.stroke ? shape.strokeWidth / 2 : 0), !!shape.fill, shape.fillRule ?? 'evenodd');
  let local: Point;
  try {
    local = apply(invert(shape.transform), p);
  } catch {
    return false;
  }
  if (shape.kind === 'text' || shape.kind === 'image') {
    // Texto e imágenes se eligen por su caja, no solo por las letras (como en los editores vectoriales).
    const t = toleranceMm;
    const m = shape.transform;
    const sx = Math.hypot(m[0], m[1]) || 1;
    const sy = Math.hypot(m[2], m[3]) || 1;
    return local.x >= -t / sx && local.y >= -t / sy && local.x <= shape.width + t / sx && local.y <= shape.height + t / sy;
  }
  if (shape.fill) {
    const { width: w, height: h } = shape;
    if (shape.kind === 'rectangle' && local.x >= 0 && local.y >= 0 && local.x <= w && local.y <= h) return true;
    if (shape.kind === 'ellipse') {
      const nx = (local.x - w / 2) / (w / 2);
      const ny = (local.y - h / 2) / (h / 2);
      if (nx * nx + ny * ny <= 1) return true;
    }
    if (shape.kind === 'polygon' && pointInPolygon(local, polygonPoints(shape))) return true;
  }
  const outline = worldOutline(shape);
  const reach = toleranceMm + (shape.stroke ? shape.strokeWidth / 2 : 0);
  return outline.some((a, i) => distanceToSegment(p, a, outline[(i + 1) % outline.length]!) <= reach);
}

/** ¿La figura queda entera dentro del rectángulo? (selección con marco) */
export function insideRect(shape: Shape, rect: Rect): boolean {
  const b = shapeBounds(shape);
  return b.x >= rect.x && b.y >= rect.y && b.x + b.width <= rect.x + rect.width && b.y + b.height <= rect.y + rect.height;
}

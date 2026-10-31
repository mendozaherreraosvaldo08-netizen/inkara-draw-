import { fitRing } from './fit';
import type { Subpath } from './path-geom';
import type { Point } from './viewport';

/**
 * Vectorizar (trazar mapa de bits): convierte un logo o dibujo en curvas.
 *
 *  1. Cada píxel se asigna a un color: blanco y negro con un umbral, o los N
 *     colores principales (k-medias). El blanco del fondo se puede ignorar.
 *  2. Por cada color se toma su máscara "apilada" (ese color y los que van
 *     encima), así las capas se enciman sin dejar rendijas entre colores.
 *  3. Se quitan las motas y los huequitos más chicos que el detalle mínimo.
 *  4. Se sigue el borde de cada mancha (entre píxeles), se suaviza la
 *     escalera de los píxeles y se ajustan curvas Bézier.
 *
 * Todo en unidades de píxel; quien lo usa lo escala al tamaño de la imagen.
 */

export interface RasterImage {
  width: number;
  height: number;
  /** RGBA, 4 bytes por píxel. */
  data: Uint8ClampedArray | Uint8Array;
}

export interface TraceOptions {
  /** 1 = blanco y negro; 2 a 8 = colores. */
  colors: number;
  /** Blanco y negro: lo más oscuro que este valor (0–255) es tinta. */
  threshold: number;
  /** Tolerancia de las curvas en píxeles (más = más suave y con menos nodos). */
  smoothing: number;
  /** Manchas y huecos más chicos que esto (píxeles) se eliminan. */
  minArea: number;
  /** No vectorizar el fondo blanco. */
  ignoreWhite: boolean;
}

export const DEFAULT_TRACE: TraceOptions = { colors: 1, threshold: 128, smoothing: 1, minArea: 8, ignoreWhite: true };

export interface TraceLayer {
  color: string;
  subpaths: Subpath[];
  /** Píxeles de ese color (para ordenar y para avisos). */
  pixels: number;
}

const hex = (r: number, g: number, b: number) => `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase()}`;

/** Color de un píxel sobre fondo blanco (las transparencias cuentan como blanco). */
function over(data: RasterImage['data'], i: number): [number, number, number, number] {
  const a = data[i + 3]! / 255;
  return [data[i]! * a + 255 * (1 - a), data[i + 1]! * a + 255 * (1 - a), data[i + 2]! * a + 255 * (1 - a), data[i + 3]!];
}

const isWhitish = (r: number, g: number, b: number) => Math.min(r, g, b) > 235 && Math.max(r, g, b) - Math.min(r, g, b) < 18;

/** Etiqueta de color de cada píxel (-1 = fondo) y el color de cada etiqueta. */
function classify(img: RasterImage, o: TraceOptions): { labels: Int16Array; palette: Array<[number, number, number]> } {
  const n = img.width * img.height;
  const labels = new Int16Array(n).fill(-1);
  if (o.colors <= 1) {
    for (let p = 0; p < n; p++) {
      const [r, g, b] = over(img.data, p * 4);
      if (0.299 * r + 0.587 * g + 0.114 * b < o.threshold) labels[p] = 0;
    }
    return { labels, palette: [[0, 0, 0]] };
  }
  // K-medias sobre los píxeles visibles (con una muestra para que sea rápido).
  const k = Math.max(2, Math.min(8, Math.round(o.colors)));
  const opaque: number[] = [];
  for (let p = 0; p < n; p++) if (img.data[p * 4 + 3]! >= 128) opaque.push(p);
  if (opaque.length === 0) return { labels, palette: [] };
  const step = Math.max(1, Math.floor(opaque.length / 20000));
  const sample: Array<[number, number, number]> = [];
  for (let i = 0; i < opaque.length; i += step) {
    const [r, g, b] = over(img.data, opaque[i]! * 4);
    sample.push([r, g, b]);
  }
  const d2 = (a: readonly number[], b: readonly number[]) => (a[0]! - b[0]!) ** 2 + (a[1]! - b[1]!) ** 2 + (a[2]! - b[2]!) ** 2;
  // Inicio determinista: el primero y luego, cada vez, el más lejano de los ya elegidos.
  const centers: Array<[number, number, number]> = [sample[0]!];
  while (centers.length < k) {
    let best = 0;
    let bestD = -1;
    for (let i = 0; i < sample.length; i++) {
      const d = Math.min(...centers.map((c) => d2(sample[i]!, c)));
      if (d > bestD) {
        bestD = d;
        best = i;
      }
    }
    if (bestD <= 0) break;
    centers.push([...sample[best]!]);
  }
  for (let iter = 0; iter < 12; iter++) {
    const sums = centers.map(() => [0, 0, 0, 0]);
    for (const s of sample) {
      let best = 0;
      for (let c = 1; c < centers.length; c++) if (d2(s, centers[c]!) < d2(s, centers[best]!)) best = c;
      const acc = sums[best]!;
      acc[0]! += s[0];
      acc[1]! += s[1];
      acc[2]! += s[2];
      acc[3]! += 1;
    }
    sums.forEach((acc, c) => {
      if (acc[3]) centers[c] = [acc[0]! / acc[3]!, acc[1]! / acc[3]!, acc[2]! / acc[3]!];
    });
  }
  for (const p of opaque) {
    const [r, g, b] = over(img.data, p * 4);
    const px = [r, g, b];
    let best = 0;
    for (let c = 1; c < centers.length; c++) if (d2(px, centers[c]!) < d2(px, centers[best]!)) best = c;
    labels[p] = best;
  }
  // El blanco del fondo no se vectoriza.
  if (o.ignoreWhite) {
    const white = new Set(centers.map((c, i) => (isWhitish(c[0], c[1], c[2]) ? i : -1)).filter((i) => i >= 0));
    if (white.size) for (let p = 0; p < n; p++) if (white.has(labels[p]!)) labels[p] = -1;
  }
  return { labels, palette: centers };
}

/** Quita manchas (y rellena huecos) de menos de `minArea` píxeles, 4-vecindad. */
export function despeckle(mask: Uint8Array, width: number, height: number, minArea: number): void {
  if (minArea <= 1) return;
  const seen = new Uint8Array(mask.length);
  const stack: number[] = [];
  const region: number[] = [];
  for (const value of [1, 0]) {
    seen.fill(0);
    for (let start = 0; start < mask.length; start++) {
      if (seen[start] || mask[start] !== value) continue;
      region.length = 0;
      stack.push(start);
      seen[start] = 1;
      let touchesEdge = false;
      while (stack.length) {
        const p = stack.pop()!;
        region.push(p);
        const x = p % width;
        const y = (p - x) / width;
        if (x === 0 || y === 0 || x === width - 1 || y === height - 1) touchesEdge = true;
        if (x > 0 && !seen[p - 1] && mask[p - 1] === value) (seen[p - 1] = 1), stack.push(p - 1);
        if (x < width - 1 && !seen[p + 1] && mask[p + 1] === value) (seen[p + 1] = 1), stack.push(p + 1);
        if (y > 0 && !seen[p - width] && mask[p - width] === value) (seen[p - width] = 1), stack.push(p - width);
        if (y < height - 1 && !seen[p + width] && mask[p + width] === value) (seen[p + width] = 1), stack.push(p + width);
      }
      // Los huecos que tocan el borde son el fondo: no se rellenan.
      if (region.length < minArea && !(value === 0 && touchesEdge)) for (const p of region) mask[p] = value ? 0 : 1;
    }
  }
}

/**
 * Bordes de las manchas de una máscara: anillos cerrados de puntos (en el
 * medio de cada lado de píxel, lo que ya convierte la escalera en diagonales).
 */
export function traceMask(mask: Uint8Array, width: number, height: number): Point[][] {
  const W = width + 1;
  const at = (x: number, y: number) => x >= 0 && y >= 0 && x < width && y < height && mask[y * width + x] === 1;
  // Lados entre un píxel lleno y uno vacío, dirigidos (lo lleno a la derecha, en pantalla).
  const from: number[] = [];
  const to: number[] = [];
  const out = new Map<number, number[]>();
  const add = (x0: number, y0: number, x1: number, y1: number) => {
    const a = y0 * W + x0;
    from.push(a);
    to.push(y1 * W + x1);
    const list = out.get(a);
    if (list) list.push(from.length - 1);
    else out.set(a, [from.length - 1]);
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!at(x, y)) continue;
      if (!at(x, y - 1)) add(x, y, x + 1, y);
      if (!at(x + 1, y)) add(x + 1, y, x + 1, y + 1);
      if (!at(x, y + 1)) add(x + 1, y + 1, x, y + 1);
      if (!at(x - 1, y)) add(x, y + 1, x, y);
    }
  }
  const used = new Uint8Array(from.length);
  const rings: Point[][] = [];
  const dir = (e: number) => {
    const a = from[e]!;
    const b = to[e]!;
    return { dx: (b % W) - (a % W), dy: Math.floor(b / W) - Math.floor(a / W) };
  };
  for (let e0 = 0; e0 < from.length; e0++) {
    if (used[e0]) continue;
    const ring: Point[] = [];
    let e = e0;
    while (!used[e]) {
      used[e] = 1;
      const a = from[e]!;
      const b = to[e]!;
      ring.push({ x: ((a % W) + (b % W)) / 2, y: (Math.floor(a / W) + Math.floor(b / W)) / 2 });
      const options = (out.get(b) ?? []).filter((c) => !used[c]);
      if (options.length === 0) break;
      if (options.length === 1) e = options[0]!;
      else {
        // Esquina en diagonal (dos manchas que se tocan por un vértice): siempre se gira
        // hacia lo lleno, así cada mancha queda en su propio anillo.
        const d = dir(e);
        const right = options.find((c) => {
          const n = dir(c);
          return n.dx === -d.dy && n.dy === d.dx;
        });
        e = right ?? options[0]!;
      }
    }
    if (ring.length >= 3) rings.push(ring);
  }
  return rings;
}

/** Suaviza un anillo (promedio con los vecinos) para quitar el rastro de los píxeles. */
function smoothRing(ring: Point[], passes: number): Point[] {
  let pts = ring;
  for (let k = 0; k < passes; k++) {
    const n = pts.length;
    pts = pts.map((p, i) => {
      const a = pts[(i - 1 + n) % n]!;
      const b = pts[(i + 1) % n]!;
      return { x: (a.x + 2 * p.x + b.x) / 4, y: (a.y + 2 * p.y + b.y) / 4 };
    });
  }
  return pts;
}

/** Vectoriza una imagen. Las capas van de abajo (la de más área) hacia arriba. */
export function traceImage(img: RasterImage, options: Partial<TraceOptions> = {}): TraceLayer[] {
  const o = { ...DEFAULT_TRACE, ...options };
  const { width, height } = img;
  const { labels, palette } = classify(img, o);
  const counts = palette.map(() => 0);
  for (const l of labels) if (l >= 0) counts[l]!++;
  const order = palette.map((_, i) => i).filter((i) => counts[i]! > 0).sort((a, b) => counts[b]! - counts[a]!);
  const layers: TraceLayer[] = [];
  order.forEach((label, k) => {
    // Máscara apilada: este color y todos los que van encima.
    const above = new Set(order.slice(k));
    const mask = new Uint8Array(width * height);
    for (let p = 0; p < mask.length; p++) if (above.has(labels[p]!)) mask[p] = 1;
    despeckle(mask, width, height, o.minArea);
    const subpaths = traceMask(mask, width, height)
      .filter((ring) => Math.abs(ringArea(ring)) >= Math.max(1, o.minArea / 2))
      .map((ring) => fitRing(smoothRing(ring, 2), Math.max(0.2, o.smoothing)));
    if (subpaths.length) {
      const [r, g, b] = palette[label]!;
      layers.push({ color: o.colors <= 1 ? '#000000' : hex(r, g, b), subpaths, pixels: counts[label]! });
    }
  });
  return layers;
}

function ringArea(ring: Point[]): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i]!;
    const q = ring[(i + 1) % ring.length]!;
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

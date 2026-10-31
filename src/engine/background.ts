import type { RasterImage } from './trace';

/**
 * Quitar fondo (sin internet): el color del fondo se toma de la orilla de la
 * imagen y se borra todo lo parecido que está conectado con la orilla (o, si
 * se pide, también los huecos de ese color, como el centro de una "O").
 * La orilla del dibujo queda suavizada para que no se vea dentada.
 */

export interface BackgroundOptions {
  /** 0–100: qué tan distinto puede ser un color y seguir contando como fondo. */
  tolerance: number;
  /** true = también los huecos de ese color dentro del dibujo. */
  holes: boolean;
  /** Borde suave en píxeles (0–3). */
  feather: number;
}

export const DEFAULT_BACKGROUND: BackgroundOptions = { tolerance: 18, holes: true, feather: 1 };

/** El color más común de la orilla (agrupado), o null si la orilla ya es transparente. */
export function edgeColor(img: RasterImage): [number, number, number] | null {
  const { width: w, height: h, data } = img;
  const buckets = new Map<number, { n: number; r: number; g: number; b: number }>();
  const add = (x: number, y: number) => {
    const i = (y * w + x) * 4;
    if (data[i + 3]! < 128) return;
    const key = ((data[i]! >> 4) << 8) | ((data[i + 1]! >> 4) << 4) | (data[i + 2]! >> 4);
    const b = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    b.n++;
    b.r += data[i]!;
    b.g += data[i + 1]!;
    b.b += data[i + 2]!;
    buckets.set(key, b);
  };
  for (let x = 0; x < w; x++) {
    add(x, 0);
    add(x, h - 1);
  }
  for (let y = 0; y < h; y++) {
    add(0, y);
    add(w - 1, y);
  }
  const best = [...buckets.values()].sort((a, b) => b.n - a.n)[0];
  return best ? [best.r / best.n, best.g / best.n, best.b / best.n] : null;
}

/** Nueva imagen RGBA sin el fondo. */
export function removeBackground(img: RasterImage, options: Partial<BackgroundOptions> = {}): { data: Uint8ClampedArray; removed: number; color: [number, number, number] | null } {
  const o = { ...DEFAULT_BACKGROUND, ...options };
  const { width: w, height: h } = img;
  const out = new Uint8ClampedArray(img.data);
  const color = edgeColor(img);
  if (!color) return { data: out, removed: 0, color };
  const limit = (o.tolerance / 100) * 441.7; // distancia máxima en RGB
  const dist = (p: number) => {
    const i = p * 4;
    return Math.hypot(img.data[i]! - color[0], img.data[i + 1]! - color[1], img.data[i + 2]! - color[2]);
  };
  const n = w * h;
  const isBg = new Uint8Array(n);
  if (o.holes) {
    for (let p = 0; p < n; p++) if (img.data[p * 4 + 3]! < 16 || dist(p) <= limit) isBg[p] = 1;
  } else {
    // Solo lo conectado con la orilla (relleno desde los bordes).
    const stack: number[] = [];
    const push = (p: number) => {
      if (isBg[p]) return;
      if (img.data[p * 4 + 3]! < 16 || dist(p) <= limit) {
        isBg[p] = 1;
        stack.push(p);
      }
    };
    for (let x = 0; x < w; x++) {
      push(x);
      push((h - 1) * w + x);
    }
    for (let y = 0; y < h; y++) {
      push(y * w);
      push(y * w + w - 1);
    }
    while (stack.length) {
      const p = stack.pop()!;
      const x = p % w;
      if (x > 0) push(p - 1);
      if (x < w - 1) push(p + 1);
      if (p >= w) push(p - w);
      if (p < n - w) push(p + w);
    }
  }
  let removed = 0;
  for (let p = 0; p < n; p++) {
    if (isBg[p]) {
      out[p * 4 + 3] = 0;
      removed++;
    }
  }
  // Borde suave: los píxeles del dibujo junto al fondo quedan medio transparentes
  // según qué tanto se parecen al color del fondo.
  if (o.feather > 0) {
    const soft = limit * (1 + o.feather);
    for (let p = 0; p < n; p++) {
      if (isBg[p]) continue;
      const x = p % w;
      const near = (x > 0 && isBg[p - 1]) || (x < w - 1 && isBg[p + 1]) || (p >= w && isBg[p - w]) || (p < n - w && isBg[p + w]);
      if (!near) continue;
      const d = dist(p);
      if (d < soft) out[p * 4 + 3] = Math.round(out[p * 4 + 3]! * Math.max(0.15, (d - limit) / Math.max(1, soft - limit)));
    }
  }
  return { data: out, removed, color };
}

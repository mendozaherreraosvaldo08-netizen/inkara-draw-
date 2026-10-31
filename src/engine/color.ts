/**
 * Conversión de colores para el selector: CMYK, RGB y hexadecimal.
 *
 * Trazo guarda los colores en RGB (#RRGGBB), que es lo que reciben las
 * impresoras de sublimación (el controlador convierte a sus tintas). El CMYK
 * aquí es la conversión estándar sin perfil de color: sirve para escribir los
 * valores que da un manual de marca o un cliente, no para una prueba de color.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** C, M, Y, K de 0 a 100. */
export interface Cmyk {
  c: number;
  m: number;
  y: number;
  k: number;
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, Number.isFinite(v) ? v : min));

/** "#abc", "abc", "#AABBCC" → {r,g,b}; null si no es un color válido. */
export function parseHex(text: string): Rgb | null {
  let hex = text.trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(hex)) hex = [...hex].map((c) => c + c).join('');
  if (!/^[0-9a-f]{6}$/i.test(hex)) return null;
  const n = parseInt(hex, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function toHex({ r, g, b }: Rgb): string {
  return `#${[r, g, b].map((v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

export function cmykToRgb({ c, m, y, k }: Cmyk): Rgb {
  const K = clamp(k, 0, 100) / 100;
  const f = (v: number) => Math.round(255 * (1 - clamp(v, 0, 100) / 100) * (1 - K));
  return { r: f(c), g: f(m), b: f(y) };
}

/** RGB → CMYK con todo el negro posible en K (como lo hacen los programas de diseño sin perfil). */
export function rgbToCmyk({ r, g, b }: Rgb): Cmyk {
  const R = clamp(r, 0, 255) / 255;
  const G = clamp(g, 0, 255) / 255;
  const B = clamp(b, 0, 255) / 255;
  const k = 1 - Math.max(R, G, B);
  if (k >= 1 - 1e-9) return { c: 0, m: 0, y: 0, k: 100 };
  const f = (v: number) => Math.round(((1 - v - k) / (1 - k)) * 100);
  return { c: f(R), m: f(G), y: f(B), k: Math.round(k * 100) };
}

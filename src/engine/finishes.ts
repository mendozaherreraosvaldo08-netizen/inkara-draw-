import type { TrazoDocument } from './document';
import { coverCrop } from './merge';
import { canBeContainer, type ImageShape, type Shape } from './shapes';

/**
 * Acabados: el mismo diseño en blanco, negro, bronce… Un acabado cambia unos
 * colores por otros y puede cubrir las figuras de cierto color con una imagen
 * de textura (metal cepillado). En placas en serie, la columna "Acabado" de
 * cada fila dice cuál usar.
 */

export interface Finish {
  name: string;
  /** Color de la muestra (si no hay textura). */
  swatch: string;
  /** Cambios de color, de → a (#RRGGBB). */
  colors: Array<{ from: string; to: string }>;
  /** Las figuras con estos colores de relleno se cubren con la imagen. */
  texture?: { assetId: string; colors: string[] };
}

const up = (c: string) => c.trim().toUpperCase();
export const norm = (s: string) => s.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Luminosidad 0–255 de un color #RRGGBB. */
export function luma(hex: string): number {
  const v = parseInt(hex.replace('#', '').slice(0, 6), 16);
  if (!Number.isFinite(v)) return 128;
  return 0.299 * ((v >> 16) & 255) + 0.587 * ((v >> 8) & 255) + 0.114 * (v & 255);
}

/** ¿Es gris (blanco, negro o gris), sin color? */
export function neutral(hex: string): boolean {
  const v = parseInt(hex.replace('#', '').slice(0, 6), 16);
  if (!Number.isFinite(v)) return false;
  const r = (v >> 16) & 255, g = (v >> 8) & 255, b = v & 255;
  return Math.max(r, g, b) - Math.min(r, g, b) <= 40;
}

/** Colores que usa el diseño (relleno, contorno, degradados), con cuánta área los usa (aprox.). */
export function documentColors(doc: TrazoDocument): Array<{ color: string; weight: number }> {
  const w = new Map<string, number>();
  const add = (c: string | null | undefined, k: number) => {
    if (!c || !/^#[0-9a-f]{6}$/i.test(c)) return;
    w.set(up(c), (w.get(up(c)) ?? 0) + k);
  };
  for (const s of doc.shapes) {
    if (s.kind === 'image' || s.hidden) continue;
    const area = Math.abs(s.width * s.height * (s.transform[0] * s.transform[3] - s.transform[1] * s.transform[2])) || 1;
    if (s.gradient) for (const st of s.gradient.stops) add(st.color, area / s.gradient.stops.length);
    else add(s.fill, s.kind === 'text' ? Math.max(1, area / 4) : area);
    if (s.stroke && s.strokeWidth > 0) add(s.stroke, Math.max(1, Math.sqrt(area) * s.strokeWidth * 4));
  }
  return [...w.entries()].map(([color, weight]) => ({ color, weight })).sort((a, b) => b.weight - a.weight);
}

/** El diseño con un acabado puesto. `newId` da ids para las imágenes de textura. */
export function applyFinish(doc: TrazoDocument, finish: Finish | null | undefined, newId: () => string): TrazoDocument {
  if (!finish || (finish.colors.length === 0 && !finish.texture)) return doc;
  const map = new Map(finish.colors.map((m) => [up(m.from), m.to]));
  const swap = <T extends string | null | undefined>(c: T): T => (c ? ((map.get(up(c)) ?? c) as T) : c);
  const textured = new Set((finish.texture?.colors ?? []).map(up));
  const asset = finish.texture ? doc.assets[finish.texture.assetId] : undefined;
  const out: Shape[] = [];
  for (const s of doc.shapes) {
    const next = { ...s, fill: swap(s.fill), stroke: swap(s.stroke) } as Shape;
    if (s.gradient) next.gradient = { ...s.gradient, stops: s.gradient.stops.map((st) => ({ ...st, color: swap(st.color) })) };
    if (s.shadow) next.shadow = { ...s.shadow, color: swap(s.shadow.color) };
    out.push(next);
    if (asset && s.fill && !s.gradient && textured.has(up(s.fill)) && canBeContainer(s as never) && !s.hidden) {
      // La textura va dentro de la figura (PowerClip), del tamaño de la figura.
      const image: ImageShape = {
        id: newId(),
        kind: 'image',
        assetId: asset.id,
        width: s.width,
        height: s.height,
        transform: s.transform,
        fill: null,
        stroke: null,
        strokeWidth: 0,
        clipId: s.id,
        name: `Textura ${finish.name}`,
      };
      image.crop = coverCrop(image, asset);
      if (s.opacity !== undefined) image.opacity = s.opacity;
      out.push(image);
    }
  }
  return { ...doc, shapes: out };
}

const SYNONYMS: Record<string, string> = { oro: 'dorado', dorada: 'dorado', plateado: 'plata', plateada: 'plata', negra: 'negro', blanca: 'blanco', cafe: 'bronce', bronceado: 'bronce', cobrizo: 'cobre' };

/** El acabado que pide una celda ("Plateado" → Plata, "negra" → Negro). */
export function matchFinish(finishes: Finish[], value: string): Finish | null {
  const v = norm(value);
  if (!v) return null;
  const want = SYNONYMS[v] ?? v;
  return finishes.find((f) => norm(f.name) === want) ?? finishes.find((f) => norm(f.name).length >= 4 && want.length >= 4 && (want.startsWith(norm(f.name).slice(0, 4)) || norm(f.name).startsWith(want.slice(0, 4)))) ?? null;
}

const FINISH_COLUMNS = ['acabado', 'acabados', 'color', 'colores', 'fondo', 'color de placa', 'tipo de placa'];

/** La columna de la tabla que dice el acabado (si la hay). */
export function findFinishColumn(columns: string[]): string | null {
  return columns.find((c) => FINISH_COLUMNS.includes(norm(c))) ?? null;
}

/**
 * Acabados de inicio para un diseño de placa: el color claro de fondo y el
 * oscuro de las letras. Negro: se invierten. Bronce: el fondo se cubre con la
 * textura y las letras quedan blancas.
 */
export function suggestFinishes(doc: TrazoDocument, textures: { bronce?: string }): Finish[] {
  const colors = documentColors(doc);
  // Solo grises (sin color): el rojo de un logo se queda rojo en todos los acabados.
  const light = colors.filter((c) => neutral(c.color) && luma(c.color) >= 200).map((c) => c.color);
  const dark = colors.filter((c) => neutral(c.color) && luma(c.color) <= 140).map((c) => c.color);
  const darkBase = (colors[0] && neutral(colors[0].color) && luma(colors[0].color) <= 70) || false;
  const bg = darkBase ? dark : light;
  const ink = darkBase ? light : dark;
  const list: Finish[] = [
    { name: 'Blanco', swatch: '#FFFFFF', colors: darkBase ? [...bg.map((c) => ({ from: c, to: '#FFFFFF' })), ...ink.map((c) => ({ from: c, to: '#000000' }))] : [] },
    { name: 'Negro', swatch: '#111111', colors: darkBase ? [] : [...bg.map((c) => ({ from: c, to: '#000000' })), ...ink.map((c) => ({ from: c, to: '#FFFFFF' }))] },
  ];
  list.push({
    name: 'Bronce',
    swatch: '#7A5A30',
    colors: [...bg.map((c) => ({ from: c, to: '#7A5A30' })), ...ink.map((c) => ({ from: c, to: '#FFFFFF' }))],
    ...(textures.bronce && bg.length ? { texture: { assetId: textures.bronce, colors: bg } } : {}),
  });
  return list;
}

/** Ids de imágenes que usan los acabados (para no borrarlas al guardar). */
export const finishAssetIds = (finishes: Finish[] | undefined) => (finishes ?? []).flatMap((f) => (f.texture ? [f.texture.assetId] : []));

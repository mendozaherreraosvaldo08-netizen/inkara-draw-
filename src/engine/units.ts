/**
 * Unidades. Internamente TODO el documento se mide en milímetros (lo natural
 * para placas e impresión); la interfaz muestra la unidad que elija el usuario.
 */
export type Unit = 'mm' | 'cm' | 'in' | 'px';

export const UNIT_LABELS: Record<Unit, string> = {
  mm: 'milímetros',
  cm: 'centímetros',
  in: 'pulgadas',
  px: 'píxeles',
};

/** Milímetros por unidad. "px" es un píxel de pantalla a 96 ppp (zoom 100 % = tamaño real). */
const MM_PER_UNIT: Record<Unit, number> = { mm: 1, cm: 10, in: 25.4, px: 25.4 / 96 };

export const toMm = (value: number, unit: Unit): number => value * MM_PER_UNIT[unit];
export const fromMm = (mm: number, unit: Unit): number => mm / MM_PER_UNIT[unit];

/** Píxeles de pantalla por milímetro con zoom 100 % (96 ppp, como Windows a escala 100 %). */
export const SCREEN_PX_PER_MM = 96 / 25.4;

/** Decimales razonables al mostrar cada unidad. */
export function formatLength(mm: number, unit: Unit): string {
  const value = fromMm(mm, unit);
  const decimals = unit === 'mm' || unit === 'px' ? 1 : unit === 'cm' ? 2 : 3;
  return value.toFixed(decimals).replace(/\.?0+$/, '') || '0';
}

/** Píxeles necesarios para imprimir `mm` a `dpi` (la sublimación suele pedir 300 ppp). */
export const pixelsAtDpi = (mm: number, dpi: number): number => Math.round((mm / 25.4) * dpi);

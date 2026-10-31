/**
 * Acomodo en hoja: cuántas placas caben en el papel de sublimación y dónde va
 * cada una. Prueba el papel vertical y horizontal, y la placa derecha y
 * acostada, y se queda con lo que más aprovecha el papel.
 */

export type Paper = 'carta' | 'a4' | 'tabloide' | 'rollo';

export const PAPERS: Record<Exclude<Paper, 'rollo'>, { w: number; h: number; label: string }> = {
  carta: { w: 215.9, h: 279.4, label: 'Carta' },
  a4: { w: 210, h: 297, label: 'A4' },
  tabloide: { w: 279.4, h: 431.8, label: 'Tabloide' },
};

export interface SheetOptions {
  paper: Paper;
  /** Rollo: ancho del papel en mm. */
  rollWidthMm: number;
  /** Rollo: largo máximo de cada tramo (una página del PDF). */
  rollMaxMm: number;
  /** Separación entre placas (mm). */
  gapMm: number;
  /** Orilla sin imprimir alrededor del papel (mm). */
  marginMm: number;
}

export const DEFAULT_SHEET: SheetOptions = { paper: 'a4', rollWidthMm: 610, rollMaxMm: 1500, gapMm: 0, marginMm: 5 };

export interface SheetPlan {
  /** Tamaño de cada hoja (mm). */
  width: number;
  height: number;
  /** Placas acostadas (giradas 90°). */
  rotated: boolean;
  cols: number;
  rows: number;
  perSheet: number;
  /** Esquina superior izquierda de cada lugar en la hoja (mm), en orden de lectura. */
  slots: Array<{ x: number; y: number }>;
  /** Tamaño de cada placa ya en la hoja (mm). */
  cell: { w: number; h: number };
}

const fit = (room: number, size: number, gap: number) => (room + 1e-6 < size ? 0 : Math.floor((room - size + 1e-6) / (size + gap)) + 1);

function plan(width: number, height: number, w: number, h: number, rotated: boolean, o: SheetOptions): SheetPlan {
  const cols = fit(width - 2 * o.marginMm, w, o.gapMm);
  const rows = fit(height - 2 * o.marginMm, h, o.gapMm);
  // El bloque de placas va centrado en el papel.
  const blockW = cols * w + Math.max(0, cols - 1) * o.gapMm;
  const blockH = rows * h + Math.max(0, rows - 1) * o.gapMm;
  const x0 = (width - blockW) / 2;
  const y0 = (height - blockH) / 2;
  const slots: SheetPlan['slots'] = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) slots.push({ x: x0 + c * (w + o.gapMm), y: y0 + r * (h + o.gapMm) });
  return { width, height, rotated, cols, rows, perSheet: cols * rows, slots, cell: { w, h } };
}

/** El mejor acomodo para placas de `plate` mm (null si no cabe ni una). */
export function planSheet(plate: { w: number; h: number }, o: SheetOptions, count = Infinity): SheetPlan | null {
  const candidates: SheetPlan[] = [];
  for (const rotated of [false, true]) {
    const w = rotated ? plate.h : plate.w;
    const h = rotated ? plate.w : plate.h;
    if (o.paper === 'rollo') {
      const width = o.rollWidthMm;
      const cols = fit(width - 2 * o.marginMm, w, o.gapMm);
      if (cols === 0) continue;
      // Largo: lo que pidan las placas, sin pasar del tramo máximo.
      const maxRows = Math.max(1, fit(o.rollMaxMm - 2 * o.marginMm, h, o.gapMm));
      const rows = Math.min(maxRows, Math.max(1, Math.ceil(Math.min(count, cols * maxRows) / cols)));
      const height = rows * h + (rows - 1) * o.gapMm + 2 * o.marginMm;
      candidates.push(plan(width, height, w, h, rotated, o));
    } else {
      const p = PAPERS[o.paper];
      for (const [W, H] of [[p.w, p.h], [p.h, p.w]] as const) candidates.push(plan(W, H, w, h, rotated, o));
    }
  }
  const best = candidates.filter((c) => c.perSheet > 0).sort((a, b) => b.perSheet - a.perSheet || Number(a.rotated) - Number(b.rotated) || a.height - b.height)[0];
  return best ?? null;
}

/** Marcas de corte: líneas cortas en la orilla del papel, a la altura de cada borde de placa. */
export function cropMarks(p: SheetPlan, length = 4): Array<{ x1: number; y1: number; x2: number; y2: number }> {
  if (p.slots.length === 0) return [];
  const xs = new Set<number>();
  const ys = new Set<number>();
  for (const s of p.slots) {
    xs.add(s.x);
    xs.add(s.x + p.cell.w);
    ys.add(s.y);
    ys.add(s.y + p.cell.h);
  }
  const top = Math.min(...p.slots.map((s) => s.y));
  const bottom = Math.max(...p.slots.map((s) => s.y + p.cell.h));
  const left = Math.min(...p.slots.map((s) => s.x));
  const right = Math.max(...p.slots.map((s) => s.x + p.cell.w));
  const out: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];
  const lenTop = Math.min(length, top - 0.5);
  const lenBottom = Math.min(length, p.height - bottom - 0.5);
  const lenLeft = Math.min(length, left - 0.5);
  const lenRight = Math.min(length, p.width - right - 0.5);
  for (const x of xs) {
    if (lenTop > 0.5) out.push({ x1: x, y1: top - 0.5 - lenTop, x2: x, y2: top - 0.5 });
    if (lenBottom > 0.5) out.push({ x1: x, y1: bottom + 0.5, x2: x, y2: bottom + 0.5 + lenBottom });
  }
  for (const y of ys) {
    if (lenLeft > 0.5) out.push({ x1: left - 0.5 - lenLeft, y1: y, x2: left - 0.5, y2: y });
    if (lenRight > 0.5) out.push({ x1: right + 0.5, y1: y, x2: right + 0.5 + lenRight, y2: y });
  }
  return out;
}

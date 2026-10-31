import type { TrazoDocument } from './document';
import { drawShapes } from './draw';
import type { Matrix } from './matrix';

/**
 * Exportación a imagen para imprimir y sublimar.
 *
 *  ┌─────────────── marcas de corte (opcional) ───────────────┐
 *  │   ┌──────────── sangrado (lo que se imprime de más) ──┐   │
 *  │   │   ┌──── página = medida final de la placa ────┐   │   │
 *  │   │   │                                           │   │   │
 *
 * Espejo: la imagen sale al revés, como se necesita para el papel de
 * transferencia (al planchar sobre la placa queda al derecho).
 */
export interface ExportOptions {
  /** Puntos por pulgada (sublimación: 300). */
  dpi: number;
  /** Incluir el sangrado alrededor de la página. */
  bleed: boolean;
  /** Imagen en espejo (para papel de transferencia). */
  mirror: boolean;
  /** Marcas de corte en las esquinas, fuera del sangrado. */
  cropMarks: boolean;
  /** Fondo blanco o transparente (solo PNG). */
  background: 'white' | 'transparent';
}

export const DEFAULT_EXPORT: ExportOptions = { dpi: 300, bleed: true, mirror: true, cropMarks: false, background: 'white' };

/** Límites de Canvas en Chromium: lados de hasta 32 767 px y unos 268 millones de píxeles. */
const MAX_SIDE = 32_000;
const MAX_PIXELS = 250_000_000;

export interface ExportLayout {
  /** Tamaño total de la imagen (mm), con sangrado y margen de marcas si los hay. */
  widthMm: number;
  heightMm: number;
  widthPx: number;
  heightPx: number;
  /** Dónde queda la esquina de la página dentro de la imagen (mm). */
  offsetMm: number;
  /** Sangrado efectivo incluido (mm). */
  bleedMm: number;
  pxPerMm: number;
}

export function exportLayout(doc: TrazoDocument, options: ExportOptions): ExportLayout {
  const bleedMm = options.bleed ? doc.page.bleedMm : 0;
  // Las marcas van fuera del sangrado, con 6 mm de espacio para que se vean.
  const offsetMm = bleedMm + (options.cropMarks ? 6 : 0);
  const widthMm = doc.page.widthMm + offsetMm * 2;
  const heightMm = doc.page.heightMm + offsetMm * 2;
  const pxPerMm = options.dpi / 25.4;
  return { widthMm, heightMm, widthPx: Math.max(1, Math.round(widthMm * pxPerMm)), heightPx: Math.max(1, Math.round(heightMm * pxPerMm)), offsetMm, bleedMm, pxPerMm };
}

/** Mensaje si la imagen sería demasiado grande para generarla; null si cabe. */
export function exportTooLarge(layout: ExportLayout): string | null {
  if (layout.widthPx > MAX_SIDE || layout.heightPx > MAX_SIDE || layout.widthPx * layout.heightPx > MAX_PIXELS) {
    return `A esta resolución la imagen mediría ${layout.widthPx} × ${layout.heightPx} px: es demasiado grande. Baja los ppp.`;
  }
  return null;
}

/**
 * Dibuja la exportación en un canvas de `layout.widthPx × layout.heightPx`.
 * `scale` permite dibujar una vista previa más chica con el mismo resultado.
 */
export function renderExport(
  ctx: CanvasRenderingContext2D,
  doc: TrazoDocument,
  options: ExportOptions,
  resolveImage: (assetId: string) => CanvasImageSource | null,
  scale = 1,
): ExportLayout {
  const layout = exportLayout(doc, options);
  const s = layout.pxPerMm * scale;
  const W = layout.widthPx * scale;
  const H = layout.heightPx * scale;
  const o = layout.offsetMm;

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, W, H);
  if (options.background === 'white') {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);
  }

  // mm de la página → píxeles; con espejo, X se invierte sobre todo el ancho.
  const base: Matrix = options.mirror ? [-s, 0, 0, s, W - o * s, o * s] : [s, 0, 0, s, o * s, o * s];

  // Lo que pasa del sangrado (o del borde, sin sangrado) no se imprime.
  const b = layout.bleedMm;
  ctx.setTransform(base[0], base[1], base[2], base[3], base[4], base[5]);
  ctx.beginPath();
  ctx.rect(-b, -b, doc.page.widthMm + b * 2, doc.page.heightMm + b * 2);
  ctx.clip();
  const target = { ctx, base, pxPerMm: s, minLineWidth: 0, resolveImage };
  drawShapes(target, doc.shapes);
  ctx.restore();

  if (options.cropMarks) drawCropMarks(ctx, doc, layout, base);
  return layout;
}

/**
 * Marcas de corte: líneas finas en las 4 esquinas, a la altura del corte
 * (borde de la página), que empiezan 1 mm fuera del sangrado.
 */
function drawCropMarks(ctx: CanvasRenderingContext2D, doc: TrazoDocument, layout: ExportLayout, base: Matrix): void {
  const { widthMm: w, heightMm: h } = doc.page;
  const start = layout.bleedMm + 1; // distancia desde el borde de la página
  const end = layout.offsetMm; // hasta el borde de la imagen
  ctx.save();
  ctx.setTransform(base[0], base[1], base[2], base[3], base[4], base[5]);
  ctx.beginPath();
  for (const x of [0, w]) {
    ctx.moveTo(x, -start);
    ctx.lineTo(x, -end);
    ctx.moveTo(x, h + start);
    ctx.lineTo(x, h + end);
  }
  for (const y of [0, h]) {
    ctx.moveTo(-start, y);
    ctx.lineTo(-end, y);
    ctx.moveTo(w + start, y);
    ctx.lineTo(w + end, y);
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.lineWidth = Math.max(1, 0.25 * Math.abs(base[0])); // 0.25 mm
  ctx.strokeStyle = '#000000';
  ctx.stroke();
  ctx.restore();
}

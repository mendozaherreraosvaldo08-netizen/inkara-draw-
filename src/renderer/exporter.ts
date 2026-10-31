import type { TrazoDocument } from '../engine/document';
import { exportLayout, exportTooLarge, renderExport, type ExportLayout, type ExportOptions } from '../engine/export';
import { buildPdf, buildPdfPages, type PdfPage } from '../engine/pdf';
import { setJpegDpi, setPngDpi } from '../engine/raster-meta';
import { decodedImage } from './images';

/**
 * Genera los archivos para imprimir: PNG, JPG o PDF, con la resolución escrita
 * dentro del archivo (así la placa sale a su medida en cualquier programa).
 */

export type ExportFormat = 'png' | 'jpg' | 'pdf';

/** Decodifica todas las imágenes del documento antes de dibujar. */
async function prepareImages(doc: TrazoDocument): Promise<Map<string, CanvasImageSource>> {
  const used = new Set(doc.shapes.flatMap((s) => (s.kind === 'image' ? [s.assetId] : [])));
  const images = new Map<string, CanvasImageSource>();
  await Promise.all(
    [...used].map(async (id) => {
      const asset = doc.assets[id];
      const image = asset ? await decodedImage(asset) : null;
      if (image) images.set(id, image);
    }),
  );
  // Y las fuentes: que no salga un texto con la letra de respaldo.
  await document.fonts.ready;
  return images;
}

export async function renderToCanvas(doc: TrazoDocument, options: ExportOptions): Promise<{ canvas: HTMLCanvasElement; layout: ExportLayout }> {
  const layout = exportLayout(doc, options);
  const tooLarge = exportTooLarge(layout);
  if (tooLarge) throw new Error(tooLarge);
  const images = await prepareImages(doc);
  const canvas = document.createElement('canvas');
  canvas.width = layout.widthPx;
  canvas.height = layout.heightPx;
  const ctx = canvas.getContext('2d', { alpha: options.background === 'transparent' });
  if (!ctx) throw new Error('No hay memoria suficiente para generar la imagen. Baja los ppp.');
  renderExport(ctx, doc, options, (id) => images.get(id) ?? null);
  return { canvas, layout };
}

/** Vista previa (chica) con el mismo resultado que la exportación. */
export async function renderPreview(canvas: HTMLCanvasElement, doc: TrazoDocument, options: ExportOptions, maxWidth: number, maxHeight: number): Promise<void> {
  const layout = exportLayout(doc, options);
  const scale = Math.min(maxWidth / layout.widthPx, maxHeight / layout.heightPx);
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(layout.widthPx * scale * dpr));
  canvas.height = Math.max(1, Math.round(layout.heightPx * scale * dpr));
  canvas.style.width = `${Math.round(layout.widthPx * scale)}px`;
  canvas.style.height = `${Math.round(layout.heightPx * scale)}px`;
  const images = await prepareImages(doc);
  const ctx = canvas.getContext('2d');
  if (ctx) renderExport(ctx, doc, options, (id) => images.get(id) ?? null, scale * dpr);
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('No se pudo generar la imagen (¿falta memoria?). Baja los ppp.'))), type, quality));
}

const bytesOf = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer());

export async function encode(format: ExportFormat, doc: TrazoDocument, options: ExportOptions): Promise<Uint8Array<ArrayBuffer>> {
  // JPG y PDF no tienen transparencia: siempre fondo blanco.
  const opts = format === 'png' ? options : { ...options, background: 'white' as const };
  const { canvas, layout } = await renderToCanvas(doc, opts);
  try {
    if (format === 'png') return setPngDpi(await bytesOf(await toBlob(canvas, 'image/png')), opts.dpi);
    if (format === 'jpg') return setJpegDpi(await bytesOf(await toBlob(canvas, 'image/jpeg', 0.95)), opts.dpi);
    return buildPdf({ title: doc.name, widthMm: layout.widthMm, heightMm: layout.heightMm, imageWidth: canvas.width, imageHeight: canvas.height, deflatedRgb: await deflateRgb(canvas) });
  } finally {
    // Libera la memoria del canvas grande enseguida.
    canvas.width = 0;
    canvas.height = 0;
  }
}

/** Píxeles RGB comprimidos con zlib, por franjas (no duplica en memoria una foto enorme). */
async function deflateRgb(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const ctx = canvas.getContext('2d')!;
  const stream = new CompressionStream('deflate');
  const writer = stream.writable.getWriter();
  const result = new Response(stream.readable).arrayBuffer();
  const band = Math.max(1, Math.floor(4_000_000 / canvas.width));
  for (let y = 0; y < canvas.height; y += band) {
    const h = Math.min(band, canvas.height - y);
    const rgba = ctx.getImageData(0, y, canvas.width, h).data;
    const rgb = new Uint8Array((rgba.length / 4) * 3);
    for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
      rgb[j] = rgba[i]!;
      rgb[j + 1] = rgba[i + 1]!;
      rgb[j + 2] = rgba[i + 2]!;
    }
    await writer.write(rgb);
  }
  await writer.close();
  return new Uint8Array(await result);
}

/** PNG listo para imprimir y su tamaño en mm. */
export async function printable(doc: TrazoDocument, options: ExportOptions): Promise<{ png: Uint8Array<ArrayBuffer>; widthMm: number; heightMm: number }> {
  const layout = exportLayout(doc, options);
  const png = await encode('png', doc, { ...options, background: 'white' });
  return { png, widthMm: layout.widthMm, heightMm: layout.heightMm };
}

/** Una página JPG (para el PDF con todas las placas): bytes y tamaño. */
export async function renderJpegPage(doc: TrazoDocument, options: ExportOptions): Promise<{ jpeg: Uint8Array; widthPx: number; heightPx: number; widthMm: number; heightMm: number }> {
  const { canvas, layout } = await renderToCanvas(doc, { ...options, background: 'white' });
  try {
    const jpeg = await bytesOf(await toBlob(canvas, 'image/jpeg', 0.92));
    return { jpeg, widthPx: canvas.width, heightPx: canvas.height, widthMm: layout.widthMm, heightMm: layout.heightMm };
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

/** Un PDF con varias páginas (una por página del diseño), sin pérdida de calidad. */
export async function encodePdfPages(title: string, docs: TrazoDocument[], options: ExportOptions, onProgress?: (done: number) => void): Promise<Uint8Array<ArrayBuffer>> {
  const pages: PdfPage[] = [];
  for (const doc of docs) {
    const { canvas, layout } = await renderToCanvas(doc, { ...options, background: 'white' });
    try {
      pages.push({ widthMm: layout.widthMm, heightMm: layout.heightMm, imageWidth: canvas.width, imageHeight: canvas.height, data: await deflateRgb(canvas), filter: 'FlateDecode' });
    } finally {
      canvas.width = 0;
      canvas.height = 0;
    }
    onProgress?.(pages.length);
  }
  return buildPdfPages(title, pages);
}

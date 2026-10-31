import * as pdfjs from 'pdfjs-dist';
import { createDocument, withPages, type ImageAsset, type PageData, type TrazoDocument } from '../engine/document';
import { importPdfPage, type PdfOpCodes } from '../engine/pdf-import';
import { cssFont } from '../engine/text';
import { isAvailable } from './fonts';
import { createAsset } from './images';

/**
 * Abrir un PDF (exportado de CorelDRAW, Illustrator…) como diseño editable de
 * Trazo: una página del diseño por cada página del PDF, con sus curvas,
 * textos, fuentes e imágenes. pdf.js solo se usa para leer los comandos de
 * dibujo; la conversión la hace el motor (engine/pdf-import.ts).
 */

let workerReady = false;
function setupWorker(): void {
  if (workerReady) return;
  // El "worker" de pdf.js va junto a la interfaz (lo copia scripts/build.mjs).
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('./pdf.worker.min.mjs', window.location.href).toString();
  workerReady = true;
}

const measure = document.createElement('canvas').getContext('2d')!;

/** Línea media → línea base (en "em"), medida con la fuente real como la dibuja el lienzo. */
function baselineOffset(family: string, bold: boolean, italic: boolean): number {
  measure.font = cssFont({ family, bold, italic }, 100);
  measure.textBaseline = 'alphabetic';
  const alphabetic = measure.measureText('Hxgá').actualBoundingBoxAscent;
  measure.textBaseline = 'middle';
  const middle = measure.measureText('Hxgá').actualBoundingBoxAscent;
  const v = (alphabetic - middle) / 100;
  return Number.isFinite(v) && v > 0 && v < 1 ? v : 0.3;
}

/** "CalistoMT" → "Calisto MT" si esa fuente está en el equipo; si no, el nombre tal cual si existe. */
function resolveFamily(base: string): string {
  const split = base.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  for (const candidate of [split, base]) if (isAvailable(candidate)) return candidate;
  return '';
}

export interface PdfOpenProgress {
  page: number;
  total: number;
}

/** Imagen de pdf.js (mapa de bits o píxeles) → PNG o JPG del documento. */
async function toAsset(img: { width: number; height: number; bitmap?: ImageBitmap; data?: Uint8ClampedArray | Uint8Array; kind?: number }, name: string): Promise<ImageAsset | null> {
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  let opaque = true;
  if (img.bitmap) ctx.drawImage(img.bitmap, 0, 0);
  else if (img.data) {
    const rgba = new Uint8ClampedArray(img.width * img.height * 4);
    const src = img.data;
    const channels = img.kind === 3 ? 4 : img.kind === 2 ? 3 : 1;
    for (let i = 0, j = 0; j < rgba.length; i += channels, j += 4) {
      if (channels === 1) {
        // Blanco y negro empaquetado (1 bit): poco común en diseños; se lee como gris.
        rgba[j] = rgba[j + 1] = rgba[j + 2] = src[i] ?? 0;
        rgba[j + 3] = 255;
      } else {
        rgba[j] = src[i]!;
        rgba[j + 1] = src[i + 1]!;
        rgba[j + 2] = src[i + 2]!;
        rgba[j + 3] = channels === 4 ? src[i + 3]! : 255;
      }
    }
    ctx.putImageData(new ImageData(rgba, img.width, img.height), 0, 0);
  } else return null;
  // ¿Tiene transparencia? Entonces PNG; si no, JPG (mucho más ligero para fotos y texturas).
  const sample = ctx.getImageData(0, 0, img.width, img.height).data;
  for (let i = 3; i < sample.length; i += 4 * 7) if (sample[i]! < 250) {
    opaque = false;
    break;
  }
  const mime = opaque ? 'image/jpeg' : 'image/png';
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mime, 0.92));
  canvas.width = 0;
  return blob ? createAsset(name, mime, new Uint8Array(await blob.arrayBuffer())) : null;
}

/** Huella rápida de una imagen (para no guardar dos veces la misma). */
function fingerprint(img: { width: number; height: number; data?: ArrayLike<number> }): string {
  let h = 2166136261;
  const d = img.data;
  if (d) for (let i = 0; i < d.length; i += Math.max(1, Math.floor(d.length / 4096))) h = Math.imul(h ^ d[i]!, 16777619);
  return `${img.width}x${img.height}:${h >>> 0}`;
}

/**
 * PDF → diseño de Trazo. Con `pageNumbers` (1, 2, 3…) solo esas páginas.
 * (pdf.js se queda con los bytes que recibe: se le pasa una copia para poder volver a leerlo.)
 */
export async function pdfToDocument(bytes: Uint8Array<ArrayBuffer>, name: string, progress?: (p: PdfOpenProgress) => void, pageNumbers?: number[]): Promise<{ document: TrazoDocument; warnings: string[] }> {
  setupWorker();
  const task = pdfjs.getDocument({ data: bytes.slice(), disableFontFace: true, fontExtraProperties: true, useSystemFonts: false });
  const pdf = await task.promise;
  const warnings: string[] = [];
  const pages: PageData[] = [];
  const assets: Record<string, ImageAsset> = {};
  const byPrint = new Map<string, ImageAsset>();
  const OPS = pdfjs.OPS as unknown as PdfOpCodes;
  let firstView: number[] | null = null;
  try {
    const wanted = (pageNumbers?.length ? pageNumbers : Array.from({ length: pdf.numPages }, (_, i) => i + 1)).filter((n) => n >= 1 && n <= pdf.numPages);
    for (const [k, n] of wanted.entries()) {
      progress?.({ page: k + 1, total: wanted.length });
      const page = await pdf.getPage(n);
      const view = page.view;
      firstView ??= view;
      const list = await page.getOperatorList();
      const cache = new Map<string, Promise<ImageAsset | null>>();
      const result = await importPdfPage(
        {
          view,
          fnArray: list.fnArray,
          argsArray: list.argsArray,
          fontName: (id) => {
            try {
              return (page.commonObjs.get(id) as { name?: string } | null)?.name ?? null;
            } catch {
              return null;
            }
          },
          image: (objId) => {
            let job = cache.get(objId);
            if (!job) {
              job = new Promise<unknown>((resolve) => {
                try {
                  page.objs.get(objId, resolve);
                } catch {
                  resolve(null);
                }
              }).then(async (img) => {
                if (!img || typeof img !== 'object') return null;
                const image = img as { width: number; height: number; bitmap?: ImageBitmap; data?: Uint8ClampedArray };
                const key = fingerprint(image);
                const known = byPrint.get(key);
                if (known) return known;
                const asset = await toAsset(image, `${name} imagen ${byPrint.size + 1}`);
                if (asset) byPrint.set(key, asset);
                return asset;
              });
              cache.set(objId, job);
            }
            return job;
          },
        },
        OPS,
        { resolveFamily, baselineOffset },
      );
      for (const a of result.assets) assets[a.id] = a;
      pages.push({ id: `pdf-${Date.now().toString(36)}-${n}`, name: `Página ${n}`, shapes: result.shapes });
      page.cleanup();
    }
  } finally {
    void task.destroy();
  }
  const [x0, y0, x1, y1] = (firstView ?? [0, 0, 595, 842]) as [number, number, number, number];
  const pt = 25.4 / 72;
  const missing = [...new Set(pages.flatMap((p) => p.shapes.flatMap((s) => (s.kind === 'text' && !isAvailable(s.fontFamily) ? [s.fontFamily] : []))))];
  if (missing.length) warnings.push(`Fuentes que no están en este equipo (se ve otra parecida hasta instalarlas): ${missing.join(', ')}.`);
  let document: TrazoDocument = { ...createDocument(name), assets };
  // Sin sangrado ni margen: el PDF ya trae la hoja como se imprime.
  document.page = { widthMm: (x1 - x0) * pt, heightMm: (y1 - y0) * pt, bleedMm: 0, safeMarginMm: 0 };
  document = withPages(document, pages.length ? pages : [{ id: 'p1', name: 'Página 1', shapes: [] }], 0);
  return { document, warnings };
}

/** Miniaturas de las páginas de un PDF (dibujadas por pdf.js, con sus fuentes). */
export async function pdfThumbnails(bytes: Uint8Array<ArrayBuffer>, maxSide: number, onPage: (n: number, total: number, canvas: HTMLCanvasElement) => void, signal: { canceled: boolean }): Promise<number> {
  setupWorker();
  const task = pdfjs.getDocument({ data: bytes.slice(), useSystemFonts: false });
  const pdf = await task.promise;
  try {
    for (let n = 1; n <= pdf.numPages; n++) {
      if (signal.canceled) break;
      const page = await pdf.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: maxSide / Math.max(base.width, base.height) });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      await page.render({ canvas, viewport, background: '#ffffff' }).promise;
      onPage(n, pdf.numPages, canvas);
      page.cleanup();
    }
    return pdf.numPages;
  } finally {
    void task.destroy();
  }
}

/** Número de páginas de un PDF. */
export async function pdfPageCount(bytes: Uint8Array<ArrayBuffer>): Promise<number> {
  setupWorker();
  const task = pdfjs.getDocument({ data: bytes.slice() });
  try {
    return (await task.promise).numPages;
  } finally {
    void task.destroy();
  }
}

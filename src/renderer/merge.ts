import { allPages, type ImageAsset, type MergeData, type PageData, type TrazoDocument } from '../engine/document';
import { applyFinish, matchFinish, type Finish } from '../engine/finishes';
import { newShapeId } from '../engine/shapes';
import { cropMarks, DEFAULT_SHEET, planSheet, type SheetOptions, type SheetPlan } from '../engine/sheet';
import * as editor from './editor';
import type { ExportOptions } from '../engine/export';
import { applyRow, fieldsInDocument, fileNameFor, matchPhoto, parseTable } from '../engine/merge';
import { buildPdfPages, type PdfPage } from '../engine/pdf';
import { encode, renderJpegPage, renderToCanvas } from './exporter';
import { createAsset, forgetImage } from './images';
import { store } from './state';

/**
 * Placas en serie en la interfaz: datos, fotos, vista previa y generación.
 * Las fotos se eligen como una carpeta (se leen ahí mismo, sin copiarlas al
 * diseño) y se buscan por el nombre que trae cada fila.
 */

// ---- Datos ----

export function setTable(text: string): { ok: boolean; message: string } {
  const { columns, rows } = parseTable(text);
  if (columns.length === 0 || rows.length === 0) return { ok: false, message: 'No se encontraron datos. Copia la tabla con sus títulos (primera fila) desde Excel o Google Sheets.' };
  const doc = store.get().document;
  const fileName = doc.merge?.fileName && columns.length ? doc.merge.fileName : `{{${columns[0]}}}`;
  setMerge({ columns, rows, fileName });
  return { ok: true, message: `${rows.length} ${rows.length === 1 ? 'placa' : 'placas'} · columnas: ${columns.join(', ')}` };
}

export function setMerge(merge: MergeData | undefined): void {
  const doc = store.get().document;
  const next = { ...doc };
  if (merge) next.merge = merge;
  else delete next.merge;
  store.set({ document: next, dirty: true, mergePreview: null });
}

// ---- Fotos ----

const photoFiles = new Map<string, File>();
/** Fotos ya convertidas a asset (solo unas pocas, para la vista previa). */
const photoCache = new Map<string, ImageAsset>();
const listeners = new Set<() => void>();
export function onPhotosChanged(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export const photoCount = () => photoFiles.size;
export const photoNames = () => [...photoFiles.keys()];

/** Elige la carpeta de fotos (todas las imágenes que tenga, también en subcarpetas). */
export function choosePhotoFolder(): Promise<number> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = 'image/png,image/jpeg,image/webp';
    input.setAttribute('webkitdirectory', '');
    input.addEventListener('change', () => {
      photoFiles.clear();
      photoCache.clear();
      for (const f of input.files ?? []) if (/^image\/(png|jpeg|webp)$/.test(f.type)) photoFiles.set(f.name, f);
      listeners.forEach((fn) => fn());
      resolve(photoFiles.size);
    });
    input.click();
  });
}

/** Para pruebas o para soltar fotos: agrega archivos sueltos. */
export function addPhotoFiles(files: File[]): void {
  for (const f of files) photoFiles.set(f.name, f);
  listeners.forEach((fn) => fn());
}

async function photoAsset(value: string): Promise<ImageAsset | null> {
  const name = matchPhoto(value, [...photoFiles.keys()]);
  if (!name) return null;
  const cached = photoCache.get(name);
  if (cached) return cached;
  const file = photoFiles.get(name)!;
  try {
    const asset = await createAsset(file.name, file.type, new Uint8Array(await file.arrayBuffer()));
    photoCache.set(name, asset);
    // Solo se guardan unas pocas (la vista previa va y viene entre filas cercanas).
    while (photoCache.size > 6) {
      const [oldest, a] = photoCache.entries().next().value as [string, ImageAsset];
      photoCache.delete(oldest);
      forgetImage(a.id);
    }
    return asset;
  } catch {
    return null;
  }
}

/** El acabado que pide una fila (columna "Acabado"), o null. */
export function finishOfRow(doc: TrazoDocument, index: number): Finish | null {
  const m = doc.merge;
  if (!m?.finishColumn || !doc.finishes?.length) return null;
  const i = m.columns.indexOf(m.finishColumn);
  return i < 0 ? null : matchFinish(doc.finishes, m.rows[index]?.[i] ?? '');
}

/** Convierte las fotos de una fila y devuelve el documento de esa placa (con su acabado, o con `finish` si se da). */
export async function rowDocument(doc: TrazoDocument, index: number, finish?: Finish | null): Promise<{ doc: TrazoDocument; missingPhotos: string[]; photoIds: string[] }> {
  const merge = doc.merge!;
  const row = merge.rows[index]!;
  const { photos } = fieldsInDocument(doc);
  const ready = new Map<string, ImageAsset>();
  for (const field of photos) {
    const i = merge.columns.findIndex((c) => c.toLowerCase() === field.toLowerCase());
    const value = i >= 0 ? row[i] : undefined;
    if (value && !ready.has(value)) {
      const asset = await photoAsset(value);
      if (asset) ready.set(value, asset);
    }
  }
  const result = applyRow(doc, row, (v) => ready.get(v) ?? null);
  const finished = applyFinish(result.doc, finish === undefined ? finishOfRow(doc, index) : finish, newShapeId);
  return { ...result, doc: finished, photoIds: [...ready.values()].map((a) => a.id) };
}

// ---- Vista previa en el lienzo ----

let previewCache: { source: TrazoDocument; row: number; doc: TrazoDocument } | null = null;
let rerender: () => void = () => undefined;

export function onPreviewReady(fn: () => void): void {
  rerender = fn;
}

/** El documento que se ve en el lienzo: el diseño, o la placa de la fila elegida. */
export function displayedDocument(): TrazoDocument {
  const { document: doc, mergePreview } = store.get();
  if (mergePreview === null || !doc.merge || !doc.merge.rows[mergePreview]) return doc;
  if (previewCache && previewCache.source === doc && previewCache.row === mergePreview) return previewCache.doc;
  // Primero sin fotos (inmediato); las fotos llegan enseguida.
  const quick = applyFinish(applyRow(doc, doc.merge.rows[mergePreview]!).doc, finishOfRow(doc, mergePreview), newShapeId);
  previewCache = { source: doc, row: mergePreview, doc: quick };
  void rowDocument(doc, mergePreview).then((full) => {
    if (previewCache?.source === doc && previewCache.row === mergePreview) {
      previewCache = { source: doc, row: mergePreview, doc: full.doc };
      rerender();
    }
  });
  return quick;
}

export function previewRow(index: number | null): void {
  const merge = store.get().document.merge;
  if (index === null || !merge || merge.rows.length === 0) {
    store.set({ mergePreview: null });
    return;
  }
  const i = ((index % merge.rows.length) + merge.rows.length) % merge.rows.length;
  store.set({ mergePreview: i, selection: [], hint: `Vista previa: placa ${i + 1} de ${merge.rows.length}` });
}

// ---- Generar ----

export type MergeOutput = 'png' | 'jpg' | 'pdf' | 'pdf-all' | 'pdf-pairs' | 'pdf-sheet';

export interface GenerateProgress {
  done: number;
  total: number;
  current: string;
}

export interface GenerateResult {
  written: number;
  where: string;
  missingPhotos: string[];
  canceled: boolean;
}

/**
 * Genera todas las placas. `signal` permite cancelar; `progress` informa el
 * avance. PNG/JPG/PDF: un archivo por placa en una carpeta. "pdf-all": un PDF
 * con una placa por página (más fácil de mandar a imprimir).
 */
export async function generateAll(output: MergeOutput, options: ExportOptions, progress: (p: GenerateProgress) => void, signal: { canceled: boolean }, sheet: SheetOptions & { marks?: boolean } = DEFAULT_SHEET): Promise<GenerateResult> {
  const doc = store.get().document;
  const merge = doc.merge;
  if (!merge || merge.rows.length === 0) throw new Error('Primero agrega los datos (pega la tabla de Excel).');
  const files = window.trazo?.files;
  let token: string | null = null;
  let where = '';
  const onePdf = output === 'pdf-all' || output === 'pdf-pairs' || output === 'pdf-sheet';
  let composer: SheetComposer | null = null;
  if (!onePdf && files) {
    const folder = await files.chooseFolder('Carpeta para guardar las placas');
    if (!folder.ok) return { written: 0, where: '', missingPhotos: [], canceled: true };
    token = folder.value.token;
    where = folder.value.path;
  }
  const missing = new Set<string>();
  const pages: PdfPage[] = [];
  let pending: HTMLCanvasElement | null = null;
  let pendingMm = { w: 0, h: 0 };
  let written = 0;
  for (let i = 0; i < merge.rows.length; i++) {
    if (signal.canceled) break;
    const name = fileNameFor(merge, merge.rows[i]!, i);
    progress({ done: i, total: merge.rows.length, current: name });
    const row = await rowDocument(doc, i);
    row.missingPhotos.forEach((m) => missing.add(m));
    try {
      if (output === 'pdf-sheet') {
        const { canvas, layout } = await renderToCanvas(row.doc, { ...options, background: 'white' });
        const mm = { w: (layout.widthPx / options.dpi) * 25.4, h: (layout.heightPx / options.dpi) * 25.4 };
        composer ??= new SheetComposer(mm, sheet, options, merge.rows.length);
        const page = await composer.add(canvas, merge.rows.length - i - 1);
        if (page) pages.push(page);
        canvas.width = 0;
      } else if (output === 'pdf-pairs') {
        // De dos en dos: se juntan en una hoja (la segunda espera a su pareja).
        const { canvas, layout } = await renderToCanvas(row.doc, { ...options, background: 'white' });
        const mm = { w: (layout.widthPx / options.dpi) * 25.4, h: (layout.heightPx / options.dpi) * 25.4 };
        if (!pending) {
          pending = canvas;
          pendingMm = mm;
        } else {
          pages.push(await pairPage(pending, canvas, pendingMm, mm, options));
          pending = null;
        }
      } else if (output === 'pdf-all') {
        const page = await renderJpegPage(row.doc, options);
        pages.push({ widthMm: page.widthMm, heightMm: page.heightMm, imageWidth: page.widthPx, imageHeight: page.heightPx, data: page.jpeg, filter: 'DCTDecode' });
      } else {
        const bytes = await encode(output, row.doc, options);
        const fileName = `${name}.${output}`;
        if (files && token) {
          const r = await files.writeToFolder(token, fileName, bytes);
          if (!r.ok) throw new Error(r.error);
        } else downloadInBrowser(bytes, fileName);
        written++;
      }
    } finally {
      // La foto de esta placa ya no se necesita: se libera la memoria.
      for (const id of row.photoIds) if (![...photoCache.values()].some((a) => a.id === id)) forgetImage(id);
    }
    // Deja respirar a la interfaz (barra de progreso, botón Cancelar).
    await new Promise((r) => setTimeout(r, 0));
  }
  if (pending && !signal.canceled) pages.push(await pairPage(pending, null, pendingMm, pendingMm, options));
  if (composer && !signal.canceled) {
    const last = await composer.flush();
    if (last) pages.push(last);
  }
  if (onePdf && pages.length && !signal.canceled) {
    progress({ done: merge.rows.length, total: merge.rows.length, current: 'Armando el PDF…' });
    const pdf = buildPdfPages(doc.name, pages);
    if (files) {
      const r = await files.exportFile({ content: pdf, suggestedName: output === 'pdf-pairs' || output === 'pdf-sheet' ? `${doc.name} (${merge.rows.length} placas, ${pages.length} hojas)` : `${doc.name} (${pages.length} placas)`, extension: 'pdf' });
      if (!r.ok) return { written: 0, where: '', missingPhotos: [...missing], canceled: !!r.canceled };
      where = r.value;
    } else downloadInBrowser(pdf, `${doc.name}.pdf`);
    written = output === 'pdf-pairs' || output === 'pdf-sheet' ? merge.rows.length : pages.length;
  }
  progress({ done: merge.rows.length, total: merge.rows.length, current: '' });
  return { written, where, missingPhotos: [...missing], canceled: signal.canceled };
}

/**
 * Acomodo en hoja: va poniendo las placas en los lugares del papel y entrega
 * una página del PDF cada vez que se llena una hoja (o un tramo del rollo).
 */
class SheetComposer {
  private plan: SheetPlan | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private used = 0;
  constructor(
    private readonly plate: { w: number; h: number },
    private readonly o: SheetOptions & { marks?: boolean },
    private readonly options: ExportOptions,
    total: number,
  ) {
    if (!planSheet(plate, o, total)) throw new Error(`La placa (${Math.round(plate.w)} × ${Math.round(plate.h)} mm) no cabe en ese papel. Elige un papel más grande o el rollo.`);
  }
  private px = (mm: number) => Math.round((mm / 25.4) * this.options.dpi);

  private start(remaining: number) {
    this.plan = planSheet(this.plate, this.o, remaining + 1)!;
    const c = document.createElement('canvas');
    c.width = this.px(this.plan.width);
    c.height = this.px(this.plan.height);
    const ctx = c.getContext('2d');
    if (!ctx) throw new Error('No hay memoria suficiente para armar la hoja. Baja los ppp.');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, c.width, c.height);
    this.canvas = c;
    this.ctx = ctx;
    this.used = 0;
  }

  /** Pone una placa; si con ella se llena la hoja, devuelve la página. `remaining` = placas que faltan después de esta. */
  async add(plate: HTMLCanvasElement, remaining: number): Promise<PdfPage | null> {
    if (!this.plan || this.used >= this.plan.perSheet) this.start(remaining);
    const plan = this.plan!;
    const ctx = this.ctx!;
    const slot = plan.slots[this.used]!;
    // En espejo, la hoja completa se voltea: el orden va de derecha a izquierda.
    const x = this.options.mirror ? plan.width - slot.x - plan.cell.w : slot.x;
    const w = this.px(plan.cell.w);
    const h = this.px(plan.cell.h);
    ctx.save();
    ctx.translate(this.px(x), this.px(slot.y));
    if (plan.rotated) {
      ctx.translate(w, 0);
      ctx.rotate(Math.PI / 2);
      ctx.drawImage(plate, 0, 0, h, w);
    } else ctx.drawImage(plate, 0, 0, w, h);
    ctx.restore();
    this.used++;
    return this.used >= plan.perSheet ? this.flush() : null;
  }

  async flush(): Promise<PdfPage | null> {
    if (!this.plan || !this.canvas || !this.ctx || this.used === 0) return null;
    const { plan, canvas, ctx } = this;
    if (this.o.marks) {
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = Math.max(1, this.px(0.25));
      ctx.beginPath();
      for (const m of cropMarks(plan)) {
        ctx.moveTo(this.px(m.x1), this.px(m.y1));
        ctx.lineTo(this.px(m.x2), this.px(m.y2));
      }
      ctx.stroke();
    }
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.95));
    if (!blob) throw new Error('No se pudo armar la hoja (¿falta memoria?). Baja los ppp.');
    const page: PdfPage = { widthMm: plan.width, heightMm: plan.height, imageWidth: canvas.width, imageHeight: canvas.height, data: new Uint8Array(await blob.arrayBuffer()), filter: 'DCTDecode' };
    canvas.width = 0;
    this.plan = null;
    this.canvas = null;
    this.ctx = null;
    this.used = 0;
    return page;
  }
}

/** A4 horizontal (o lo que haga falta si no caben): dos placas juntas al centro. */
const A4 = { w: 297, h: 210 };
async function pairPage(first: HTMLCanvasElement, second: HTMLCanvasElement | null, a: { w: number; h: number }, b: { w: number; h: number }, options: ExportOptions): Promise<PdfPage> {
  const needW = a.w + (second ? b.w : 0);
  const needH = Math.max(a.h, second ? b.h : 0);
  const fits = needW <= A4.w && needH <= A4.h;
  const sheet = fits ? A4 : { w: Math.max(needW, A4.w), h: Math.max(needH, A4.h) };
  const px = (mm: number) => Math.round((mm / 25.4) * options.dpi);
  const canvas = document.createElement('canvas');
  canvas.width = px(sheet.w);
  canvas.height = px(sheet.h);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('No hay memoria suficiente para armar la hoja. Baja los ppp.');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  // En espejo, la hoja completa se voltea: la primera placa queda a la derecha.
  const order = options.mirror && second ? [second, first] : [first, second];
  const widths = options.mirror && second ? [b.w, a.w] : [a.w, b.w];
  let x = px((sheet.w - needW) / 2);
  order.forEach((c, k) => {
    if (!c) return;
    const h = c.height;
    ctx.drawImage(c, x, Math.round((canvas.height - h) / 2));
    x += px(widths[k]!);
  });
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.95));
  if (!blob) throw new Error('No se pudo armar la hoja (¿falta memoria?). Baja los ppp.');
  const data = new Uint8Array(await blob.arrayBuffer());
  const out: PdfPage = { widthMm: sheet.w, heightMm: sheet.h, imageWidth: canvas.width, imageHeight: canvas.height, data, filter: 'DCTDecode' };
  canvas.width = 0;
  return out;
}

function downloadInBrowser(bytes: Uint8Array<ArrayBuffer>, name: string): void {
  const url = URL.createObjectURL(new Blob([bytes]));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Una página por placa: cada fila de la tabla se vuelve una página del diseño
 * (con su nombre y su foto ya puestos). Así se revisan todas en la vista de
 * páginas y se corrige solo la que salió mal, sin tocar las demás. Las páginas
 * se agregan después de las que ya hay; la plantilla queda como estaba.
 */
export async function createPlatePages(progress: (done: number, total: number) => void, signal: { canceled: boolean }): Promise<{ created: number; missingPhotos: string[] }> {
  const doc = store.get().document;
  const merge = doc.merge;
  if (!merge || merge.rows.length === 0) throw new Error('Primero agrega los datos (pega la tabla de Excel).');
  const missing = new Set<string>();
  const assets: Record<string, ImageAsset> = {};
  const pages: PageData[] = [];
  for (let i = 0; i < merge.rows.length; i++) {
    if (signal.canceled) break;
    progress(i, merge.rows.length);
    const row = await rowDocument(doc, i);
    row.missingPhotos.forEach((m) => missing.add(m));
    for (const id of row.photoIds) if (row.doc.assets[id]) assets[id] = row.doc.assets[id]!;
    pages.push({ id: `placa-${Date.now().toString(36)}-${i}`, name: fileNameFor(merge, merge.rows[i]!, i).slice(0, 100) || `Placa ${i + 1}`, shapes: row.doc.shapes });
  }
  if (signal.canceled || pages.length === 0) return { created: 0, missingPhotos: [] };
  const existing = allPages(store.get().document);
  const first = existing.length === 1 && existing[0]!.name === 'Página 1' ? [{ ...existing[0]!, name: 'Plantilla' }] : existing;
  editor.replacePages(`Crear ${pages.length} placas`, [...first, ...pages], first.length, assets);
  previewRow(null);
  return { created: pages.length, missingPhotos: [...missing] };
}

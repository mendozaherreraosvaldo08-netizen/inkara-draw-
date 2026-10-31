import { pdfPageCount, pdfToDocument } from './pdf-open';
import { openPdfPicker } from './ui/pdf-dialog';
import { createDocument, type ImageAsset, type TrazoDocument } from '../engine/document';
import { FileFormatError, IMAGE_MIME_TYPES, parseDocument, serializeDocument } from '../engine/file-format';
import { newShapeId, type ImageShape } from '../engine/shapes';
import { relayoutText } from '../engine/text';
import type { Point } from '../engine/viewport';
import * as editor from './editor';
import { createAsset, naturalSizeMm } from './images';
import { store } from './state';
import { stopTextEditing } from './text-edit';

/**
 * El documento como archivo: nuevo, abrir, guardar, importar y exportar.
 * También lleva la cuenta de "cambios sin guardar", el autoguardado cada minuto
 * y la recuperación si Trazo se cerró de golpe.
 */

const APP_VERSION = '1.8.0';
const AUTOSAVE_MS = 60_000;

let fitPage: () => void = () => undefined;
/** Para que el autoguardado no escriba lo mismo dos veces. */
let lastAutosaved: TrazoDocument | null = null;
/** Mientras se pone un documento nuevo o abierto, los cambios no cuentan como "sin guardar". */
let loading = false;

const api = () => window.trazo;
const hint = (text: string) => store.set({ hint: text });

export function initSession(options: { fitPage: () => void }): void {
  fitPage = options.fitPage;

  // Cambios sin guardar: cualquier paso del historial, o cambiar la página o las unidades.
  // (Volver a medir textos al llegar una fuente no cuenta como cambio.)
  store.subscribe((state, previous) => {
    if (!loading && !state.dirty) {
      const edited = state.history !== previous.history;
      const pageChanged = state.document.page !== previous.document.page || state.document.unit !== previous.document.unit;
      if (edited || pageChanged) store.set({ dirty: true });
    }
    if (state.dirty !== previous.dirty || state.document.name !== previous.document.name) report();
  });
  report();

  const files = api()?.files;
  const doc = api()?.document;
  if (files && doc) {
    files.onOpenRequest((path) => void openPath(path));
    doc.onSaveThenClose(() => {
      void save().then((saved) => {
        if (saved) doc.closeWindow();
      });
    });
    // Autoguardado: una copia aparte (no pisa tu archivo) por si se va la luz.
    window.setInterval(() => {
      const state = store.get();
      if (!state.dirty || state.document === lastAutosaved) return;
      lastAutosaved = state.document;
      void files.autosave(serialize());
    }, AUTOSAVE_MS);
    void files.takeRecovery().then((content) => {
      if (content) load(content, null, 'Recuperado');
      if (content) store.set({ dirty: true, hint: 'Se recuperó el trabajo sin guardar. Guárdalo con Ctrl+S.' });
    });
  }

  // Pegar: imágenes copiadas (captura de pantalla, foto del navegador) o los objetos copiados en Trazo.
  document.addEventListener('paste', (event) => {
    const target = event.target as HTMLElement | null;
    if (target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return;
    event.preventDefault();
    const images = [...(event.clipboardData?.files ?? [])].filter((f) => (IMAGE_MIME_TYPES as readonly string[]).includes(f.type));
    if (images.length > 0) void importBrowserFiles(images);
    else editor.paste();
  });
}

function report(): void {
  const state = store.get();
  api()?.document?.reportState({ dirty: state.dirty, name: state.document.name });
}

const serialize = () => serializeDocument(store.get().document, APP_VERSION);

/** Si hay cambios sin guardar, pregunta. Devuelve false si el usuario canceló. */
async function confirmDiscard(): Promise<boolean> {
  stopTextEditing();
  const state = store.get();
  if (!state.dirty) return true;
  const docApi = api()?.document;
  if (!docApi) return window.confirm(`Hay cambios sin guardar en “${state.document.name}”. ¿Descartarlos?`);
  const choice = await docApi.confirmUnsaved(state.document.name);
  if (choice === 'cancel') return false;
  if (choice === 'save') return save();
  return true;
}

/** Pone un documento en la app (nuevo o abierto). */
function setDocument(document: TrazoDocument, filePath: string | null): void {
  loading = true;
  try {
    editor.resetHistory();
    lastAutosaved = null;
    store.set({ document, filePath, dirty: false, selection: [], transformMode: 'scale' });
    fitPage();
  } finally {
    loading = false;
  }
}

export async function newDocument(): Promise<void> {
  if (!(await confirmDiscard())) return;
  setDocument(createDocument('Sin título'), null);
  void api()?.files.autosave(null);
  hint('Documento nuevo');
}

export async function openDialog(): Promise<void> {
  if (!(await confirmDiscard())) return;
  const files = api()?.files;
  if (!files) {
    hint('Abrir archivos solo funciona en la app de escritorio (o arrastra el diseño .ink aquí).');
    return;
  }
  const result = await files.openDialog();
  if (!result.ok) {
    if (!result.canceled) hint(result.error);
    return;
  }
  load(result.value.content, result.value.path, result.value.name);
}

export async function openPath(path: string): Promise<void> {
  if (!(await confirmDiscard())) return;
  const result = await api()?.files.openPath(path);
  if (!result) return;
  if (!result.ok) {
    hint(result.error);
    return;
  }
  load(result.value.content, result.value.path, result.value.name);
}

/** Lee el contenido de un .trz. */
function load(content: string, path: string | null, name: string): boolean {
  try {
    const { document, warnings } = parseDocument(content, name);
    // Los textos se vuelven a medir con las fuentes de este equipo.
    const shapes = document.shapes.map((s) => (s.kind === 'text' ? relayoutText(s) : s));
    const shown = path ? name : document.name;
    setDocument({ ...document, name: shown, shapes }, path);
    hint(warnings.length ? `Abierto con avisos: ${warnings.join(' ')}` : `Abierto: ${path ?? shown}`);
    return true;
  } catch (error) {
    hint(error instanceof FileFormatError ? error.message : 'No se pudo abrir el archivo.');
    return false;
  }
}

/** Guarda (Ctrl+S) o "Guardar como" (Ctrl+Mayús+S). Devuelve true si se guardó. */
export async function save(saveAs = false): Promise<boolean> {
  stopTextEditing();
  const state = store.get();
  const files = api()?.files;
  if (!files) {
    // Sin la app de escritorio (vista previa en navegador): se descarga el archivo.
    download(`${state.document.name}.ink`, serialize(), 'application/json');
    store.set({ dirty: false, hint: 'Diseño descargado' });
    return true;
  }
  const result = await files.save({ content: serialize(), path: state.filePath, suggestedName: state.document.name, saveAs });
  if (!result.ok) {
    if (!result.canceled) hint(result.error);
    return false;
  }
  const doc = store.get().document;
  store.set({ document: { ...doc, name: result.value.name }, filePath: result.value.path, dirty: false, hint: `Guardado: ${result.value.path}` });
  lastAutosaved = null;
  return true;
}

function download(name: string, content: string, type: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---- Importar imágenes ----

export async function importDialog(): Promise<void> {
  stopTextEditing();
  const files = api()?.files;
  if (!files) {
    hint('Arrastra las imágenes al lienzo o pégalas con Ctrl+V.');
    return;
  }
  const result = await files.importDialog();
  if (!result.ok) {
    if (!result.canceled) hint(result.error);
    return;
  }
  const pdfs = result.value.filter((f) => f.mime === 'application/pdf');
  if (pdfs.length) {
    await openPdfs(pdfs.map((f) => ({ name: f.name, bytes: f.bytes })));
    return;
  }
  await addImages(result.value);
}

/**
 * PDF soltados o elegidos: uno de una sola página se abre directo; si son
 * varias páginas o varios archivos, se eligen en una ventana con miniaturas
 * (abrir algunas, o guardarlas como plantillas).
 */
export async function openPdfs(files: Array<{ name: string; bytes: Uint8Array<ArrayBuffer> }>): Promise<void> {
  if (files.length === 1) {
    let pages = 0;
    try {
      pages = await pdfPageCount(files[0]!.bytes);
    } catch (error) {
      hint(`No se pudo abrir el PDF: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (pages <= 1) {
      await openPdf(files[0]!.bytes, files[0]!.name);
      return;
    }
  }
  openPdfPicker(files);
}

/** Abre un PDF (p. ej. exportado de CorelDRAW) como diseño nuevo, editable, con todas sus páginas. */
export async function openPdf(bytes: Uint8Array<ArrayBuffer>, fileName: string): Promise<boolean> {
  if (!(await confirmDiscard())) return false;
  const name = fileName.replace(/\.pdf$/i, '').replace(/\.cdr$/i, '') || 'Diseño';
  hint(`Abriendo “${fileName}”…`);
  try {
    const { document, warnings } = await pdfToDocument(bytes, name, (p) => hint(`Abriendo PDF: página ${p.page} de ${p.total}…`));
    setDocument({ ...document, shapes: document.shapes.map((s) => (s.kind === 'text' ? relayoutText(s) : s)) }, null);
    const count = document.pages?.length ?? 1;
    hint(`Abierto: ${fileName} (${count} ${count === 1 ? 'página' : 'páginas'}), todo editable. Guárdalo como .ink o como plantilla.${warnings.length ? ` ⚠ ${warnings.join(' ')}` : ''}`);
    return true;
  } catch (error) {
    hint(`No se pudo abrir el PDF: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

/** Archivos soltados o pegados: imágenes se importan; un .trz o un PDF se abren. */
/** Lista de Excel / CSV soltada: la abre la ventana de placas en serie (se registra al arrancar). */
let listHandler: ((file: File) => void) | null = null;
export function onListFile(fn: (file: File) => void): void {
  listHandler = fn;
}

/** Paquete de plantillas soltado (.inkpack): lo importa la biblioteca (se registra al arrancar). */
let packHandler: ((file: File) => void) | null = null;
export function onPackFile(fn: (file: File) => void): void {
  packHandler = fn;
}

export async function importBrowserFiles(files: File[], at?: Point): Promise<void> {
  const pack = files.find((f) => /\.inkpack$/i.test(f.name));
  if (pack && packHandler) {
    packHandler(pack);
    return;
  }
  const list = files.find((f) => /\.(xlsx|xls|csv|tsv)$/i.test(f.name));
  if (list && listHandler) {
    listHandler(list);
    return;
  }
  const pdfs = files.filter((f) => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'));
  if (pdfs.length) {
    await openPdfs(await Promise.all(pdfs.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) }))));
    return;
  }
  if (files.some((f) => f.name.toLowerCase().endsWith('.cdr'))) {
    hint('Los .cdr de CorelDRAW 2024 no se pueden leer directo. En Corel: Archivo › Publicar en PDF (sin "texto como curvas") y arrastra aquí ese PDF: se abre igual y editable.');
    return;
  }
  const design = files.find((f) => /\.(ink|trz)$/i.test(f.name));
  if (design) {
    if (!(await confirmDiscard())) return;
    load(await design.text(), null, design.name.replace(/\.(ink|trz)$/i, ''));
    return;
  }
  const images = files.filter((f) => (IMAGE_MIME_TYPES as readonly string[]).includes(f.type));
  if (images.length === 0) {
    hint('Solo se pueden importar imágenes PNG, JPG, WebP, GIF y SVG, o abrir diseños .ink y PDF.');
    return;
  }
  await addImages(await Promise.all(images.map(async (f) => ({ name: f.name || 'imagen pegada', mime: f.type, bytes: new Uint8Array(await f.arrayBuffer()) }))), at);
}

/**
 * Pone imágenes en la página: a su tamaño real (fotos a 300 ppp), o más chicas
 * si no caben dentro del margen seguro. Centradas, o donde se soltaron.
 */
export async function addImages(files: Array<{ name: string; mime: string; bytes: Uint8Array<ArrayBuffer> }>, at?: Point): Promise<void> {
  stopTextEditing();
  hint(files.length === 1 ? `Importando “${files[0]!.name}”…` : `Importando ${files.length} imágenes…`);
  const assets: ImageAsset[] = [];
  const errors: string[] = [];
  for (const file of files) {
    try {
      assets.push(await createAsset(file.name, file.mime, file.bytes));
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (assets.length === 0) {
    hint(errors.join(' ') || 'No se pudo importar.');
    return;
  }
  const state = store.get();
  const { page } = state.document;
  const maxW = page.widthMm - page.safeMarginMm * 2;
  const maxH = page.heightMm - page.safeMarginMm * 2;
  const shapes: ImageShape[] = assets.map((asset, i) => {
    let { width, height } = naturalSizeMm(asset);
    const fit = Math.min(1, maxW / width, maxH / height);
    width *= fit;
    height *= fit;
    const center = at ?? { x: page.widthMm / 2, y: page.heightMm / 2 };
    const offset = i * 5; // varias a la vez: un poco desplazadas, como un abanico
    return { id: newShapeId(), kind: 'image', assetId: asset.id, width, height, transform: [1, 0, 0, 1, center.x - width / 2 + offset, center.y - height / 2 + offset], fill: null, stroke: null, strokeWidth: state.strokeWidth };
  });
  // Los assets no forman parte del historial: quedan en el documento (se limpian al guardar).
  const doc = store.get().document;
  store.set({ document: { ...doc, assets: { ...doc.assets, ...Object.fromEntries(assets.map((a) => [a.id, a])) } } });
  editor.commit(assets.length === 1 ? 'Importar imagen' : `Importar ${assets.length} imágenes`, [...store.get().document.shapes, ...shapes], shapes.map((s) => s.id));
  if (errors.length) hint(`Importado con avisos: ${errors.join(' ')}`);
  store.set({ tool: 'select' });
}

/** Abre una plantilla de la biblioteca como diseño nuevo (sin archivo: al guardar pregunta dónde). */
export async function openTemplate(content: string, name: string): Promise<boolean> {
  if (!(await confirmDiscard())) return false;
  const ok = load(content, null, name);
  if (ok) {
    store.set({ document: { ...store.get().document, name }, dirty: false });
    hint(`Nuevo diseño desde la plantilla “${name}”. Al guardar te pregunta dónde (la plantilla no se modifica).`);
  }
  return ok;
}

/** El diseño actual como texto .trz (para guardarlo como plantilla). */
export const currentContent = (): string => serialize();

/** Un diseño cualquiera como texto .trz (p. ej., una página de un PDF para guardarla como plantilla). */
export const serializeDesign = (doc: TrazoDocument): string => serializeDocument(doc, APP_VERSION);

/** Pone en la app un diseño ya armado (sin archivo: al guardar pregunta dónde). */
export async function openBuiltDocument(doc: TrazoDocument, message: string): Promise<boolean> {
  if (!(await confirmDiscard())) return false;
  setDocument({ ...doc, shapes: doc.shapes.map((s) => (s.kind === 'text' ? relayoutText(s) : s)) }, null);
  hint(message);
  return true;
}

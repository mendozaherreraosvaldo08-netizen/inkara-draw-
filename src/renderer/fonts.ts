import type { CatalogFamily, DownloadedFamily } from '../shared/api';
import { cssFont, relayoutText, setTextMeasurer } from '../engine/text';
import { store } from './state';

/**
 * Fuentes disponibles para el texto:
 *  1. Las instaladas en Windows.
 *  2. Las que Trazo ya descargó de Google Fonts (se cargan al abrir).
 *  3. Si un texto usa una fuente que no está (elegida en el buscador, escrita a
 *     mano o de un archivo que viene de otra PC), se busca en Google Fonts, se
 *     descarga y se pone sola. Las fuentes de Google son libres, también para
 *     trabajos que se venden.
 */

/** Fuentes comunes de Windows, para detectarlas si no se puede leer la lista del sistema. */
const COMMON_FAMILIES = [
  'Arial', 'Arial Black', 'Bahnschrift', 'Calibri', 'Cambria', 'Candara', 'Comic Sans MS', 'Consolas', 'Constantia', 'Corbel', 'Courier New',
  'Ebrima', 'Franklin Gothic Medium', 'Gabriola', 'Gadugi', 'Georgia', 'Impact', 'Ink Free', 'Lucida Console', 'Lucida Sans Unicode',
  'Monotype Corsiva', 'Edwardian Script ITC', 'Old English Text MT', 'Palatino Linotype', 'Segoe Print', 'Segoe Script', 'Segoe UI',
  'Sitka Text', 'Sylfaen', 'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana', 'Brush Script MT', 'Lucida Handwriting', 'Bodoni MT',
  'Garamond', 'Book Antiqua', 'Century Gothic', 'Copperplate Gothic Bold', 'Algerian', 'Castellar', 'Engravers MT', 'Felix Titling',
  'Harrington', 'Kunstler Script', 'Vivaldi', 'Vladimir Script', 'DejaVu Sans', 'DejaVu Serif', 'Liberation Sans', 'Liberation Serif',
];

const system = new Set<string>();
const downloaded = new Map<string, DownloadedFamily>();
let catalog: CatalogFamily[] | null = null;
let catalogError: string | null = null;
/** Familias que ya se intentó conseguir (para no repetir la búsqueda en cada cambio). */
const attempted = new Map<string, Promise<boolean>>();
const listeners = new Set<() => void>();

const key = (family: string) => family.trim().toLowerCase();
const notify = () => listeners.forEach((fn) => fn());

/** Avisa cuando cambian las fuentes disponibles (para repintar el selector). */
export function onFontsChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// ---- Medición: Canvas con la fuente real ----

const measureCtx = document.createElement('canvas').getContext('2d')!;
setTextMeasurer((text, font) => {
  measureCtx.font = cssFont(font, 100);
  return measureCtx.measureText(text).width / 100;
});

/**
 * ¿Está la fuente? Se compara el ancho de un texto con la fuente pedida y con
 * fuentes genéricas: si siempre coincide con la genérica, la fuente no existe.
 */
function detect(family: string): boolean {
  const sample = 'mmmmmmmmmmlli WQ@ 0123 áñ';
  const name = family.replace(/["\\]/g, '');
  return ['monospace', 'serif', 'sans-serif'].some((generic) => {
    measureCtx.font = `72px ${generic}`;
    const base = measureCtx.measureText(sample).width;
    measureCtx.font = `72px "${name}", ${generic}`;
    return Math.abs(measureCtx.measureText(sample).width - base) > 0.5;
  });
}

export function isAvailable(family: string): boolean {
  const k = key(family);
  if (downloaded.has(k)) return true;
  for (const name of system) if (key(name) === k) return true;
  return detect(family);
}

// ---- Arranque ----

export async function initFonts(): Promise<void> {
  const api = window.trazo?.fonts;
  // 1) Lista exacta del sistema (API de fuentes locales de Chromium); 2) registro de Windows; 3) detección.
  let families: string[] = [];
  try {
    const query = (window as unknown as { queryLocalFonts?: () => Promise<Array<{ family: string }>> }).queryLocalFonts;
    if (query) families = [...new Set((await query()).map((f) => f.family))];
  } catch {
    // Permiso negado o no disponible.
  }
  if (families.length === 0 && api) families = await api.listSystem().catch(() => []);
  if (families.length === 0) families = COMMON_FAMILIES.filter(detect);
  families.forEach((f) => system.add(f));

  if (api) {
    for (const family of await api.listDownloaded().catch(() => [])) await register(family);
  }
  notify();
  ensureDocumentFonts();
  store.subscribe((state, previous) => {
    if (state.document.shapes !== previous.document.shapes) ensureDocumentFonts();
  });
  document.fonts.addEventListener('loadingdone', () => relayout());
}

/** Carga los archivos descargados en el navegador de la app (FontFace). */
async function register(family: DownloadedFamily): Promise<void> {
  const api = window.trazo?.fonts;
  if (!api) return;
  for (const file of family.files) {
    const bytes = await api.read(file.path);
    const face = new FontFace(family.family, new Uint8Array(bytes), { weight: String(file.weight), style: file.style });
    await face.load();
    document.fonts.add(face);
  }
  downloaded.set(key(family.family), family);
  relayout(family.family);
}

/** Vuelve a medir los textos (al llegar una fuente cambian sus anchos). */
function relayout(family?: string): void {
  const doc = store.get().document;
  let changed = false;
  const shapes = doc.shapes.map((s) => {
    if (s.kind !== 'text' || (family && key(s.fontFamily) !== key(family))) return s;
    const next = relayoutText(s);
    if (next !== s) changed = true;
    return next;
  });
  if (changed) store.set({ document: { ...doc, shapes } });
}

// ---- Catálogo y búsqueda ----

export async function loadCatalog(): Promise<CatalogFamily[]> {
  if (catalog) return catalog;
  const api = window.trazo?.fonts;
  if (!api) {
    catalogError = 'Google Fonts solo está disponible en la app de escritorio.';
    return [];
  }
  const result = await api.catalog();
  if (!result.ok) {
    catalogError = result.error;
    return [];
  }
  catalogError = null;
  catalog = [...result.value].sort((a, b) => a.popularity - b.popularity);
  notify();
  return catalog;
}

export const lastCatalogError = () => catalogError;

export interface FontSearchResult {
  installed: string[];
  google: CatalogFamily[];
}

/** Busca por nombre en las instaladas, las descargadas y el catálogo de Google. */
export function searchFonts(query: string, limit = 80): FontSearchResult {
  const q = key(query);
  const local = [...new Set([...system, ...[...downloaded.values()].map((f) => f.family)])].sort((a, b) => a.localeCompare(b));
  const installed = (q ? local.filter((f) => key(f).includes(q)) : local).slice(0, 400);
  const localKeys = new Set(local.map(key));
  const google = (catalog ?? []).filter((f) => !localKeys.has(key(f.family)) && (!q || key(f.family).includes(q))).slice(0, limit);
  return { installed, google };
}

export const isDownloaded = (family: string) => downloaded.has(key(family));
export const downloadedInfo = (family: string) => downloaded.get(key(family)) ?? null;

/**
 * Consigue la fuente si falta: la busca en Google Fonts y la descarga. Devuelve
 * true si al final está disponible. Avisa en la barra de estado.
 */
export function ensureFont(family: string): Promise<boolean> {
  if (!family.trim() || isAvailable(family)) return Promise.resolve(true);
  const k = key(family);
  const pending = attempted.get(k);
  if (pending) return pending;
  const job = (async () => {
    const api = window.trazo?.fonts;
    if (!api) {
      store.set({ hint: `La fuente “${family}” no está instalada; se usa una parecida.` });
      return false;
    }
    store.set({ hint: `Buscando “${family}” en Google Fonts…` });
    await loadCatalog();
    const match = catalog?.find((f) => key(f.family) === k);
    if (!match) {
      store.set({ hint: catalogError ?? `“${family}” no está en tu equipo ni en Google Fonts. Revisa el nombre, o instálala en Windows y vuelve a abrir Inkara Draw (mientras, los textos con esa fuente se ven con una parecida).` });
      return false;
    }
    store.set({ hint: `Descargando “${match.family}” de Google Fonts…` });
    const result = await api.download(match.family);
    if (!result.ok) {
      store.set({ hint: result.error });
      attempted.delete(k); // se puede reintentar (p. ej. al volver la conexión)
      return false;
    }
    await register(result.value);
    notify();
    store.set({ hint: `Fuente “${match.family}” descargada de Google Fonts y lista para usar.` });
    return true;
  })();
  attempted.set(k, job);
  return job;
}

/** Revisa las fuentes de todos los textos del documento y consigue las que falten. */
function ensureDocumentFonts(): void {
  const families = new Set(store.get().document.shapes.flatMap((s) => (s.kind === 'text' ? [s.fontFamily] : [])));
  for (const family of families) if (!attempted.has(key(family))) void ensureFont(family);
}

/** Instala una fuente descargada en Windows, para usarla también en otros programas. */
export async function installInWindows(family: string): Promise<void> {
  const api = window.trazo?.fonts;
  if (!api) return;
  const result = await api.install(family);
  if (!result.ok) {
    store.set({ hint: result.error });
    return;
  }
  downloaded.set(key(family), result.value);
  system.add(result.value.family);
  notify();
  store.set({ hint: `“${family}” quedó instalada en Windows. Reinicia los otros programas para verla.` });
}

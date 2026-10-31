import examplesPack from '../plantillas-ejemplo.json';
import { DEFAULT_EXPORT } from '../../engine/export';
import { allPages, pageDocument, withPages, type TrazoDocument } from '../../engine/document';
import type { TemplateInfo } from '../../shared/api';
import { renderPreview } from '../exporter';
import { currentContent, openTemplate, serializeDesign } from '../session';
import { store } from '../state';
import { stopTextEditing } from '../text-edit';
import { h } from './dom';

/**
 * Biblioteca de plantillas: guardar el diseño actual como plantilla (con
 * miniatura) y empezar uno nuevo a partir de una. Se guardan en la carpeta de
 * datos de Trazo, así están siempre a mano sin buscarlas en el disco.
 */

const api = () => window.trazo?.templates;

/** Categorías de siempre (y las que agregue el usuario). */
export const DEFAULT_CATEGORIES = ['Graduación', 'Diplomas', 'Panorámicas', 'Agradecimientos', 'Reconocimientos'];
export const NO_CATEGORY = 'Sin categoría';

/** Campo de categoría con sugerencias (las de siempre y las ya usadas). */
export function categoryInput(value: string, used: string[]): HTMLInputElement {
  const id = `cats-${Math.random().toString(36).slice(2)}`;
  const list = h('datalist', { id }, ...[...new Set([...DEFAULT_CATEGORIES, ...used.filter(Boolean)])].map((c) => h('option', { value: c })));
  const input = h('input', { class: 'input', value, maxlength: 40, list: id, placeholder: 'Ej. Graduación', 'aria-label': 'Categoría' });
  queueMicrotask(() => input.after(list));
  return input;
}

/** Pestañas por categoría para una lista de plantillas. */
export function categoriesOf(list: TemplateInfo[]): string[] {
  const used = [...new Set(list.map((t) => t.category || NO_CATEGORY))];
  const order = [...DEFAULT_CATEGORIES, NO_CATEGORY];
  return used.sort((a, b) => (order.indexOf(a) < 0 ? 99 : order.indexOf(a)) - (order.indexOf(b) < 0 ? 99 : order.indexOf(b)) || a.localeCompare(b, 'es'));
}

export async function thumbnailPng(doc: TrazoDocument = store.get().document): Promise<Uint8Array<ArrayBuffer> | null> {
  try {
    const canvas = document.createElement('canvas');
    await renderPreview(canvas, doc, { ...DEFAULT_EXPORT, bleed: false, mirror: false, cropMarks: false, background: 'white' }, 220, 280);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
  } catch {
    return null;
  }
}

function modal(title: string, body: HTMLElement[], foot: HTMLElement[], className: string): { close: () => void; root: HTMLElement } {
  const dialog = h('div', { class: `modal ${className}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, h('header', { class: 'modal-head' }, h('h2', {}, title)), ...body, h('footer', { class: 'modal-foot' }, ...foot));
  const backdrop = h('div', { class: 'modal-backdrop' }, dialog);
  document.body.append(backdrop);
  const close = () => backdrop.remove();
  backdrop.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key === 'Escape') close();
  });
  backdrop.addEventListener('pointerdown', (event) => {
    if (event.target === backdrop) close();
  });
  return { close, root: dialog };
}

/** Archivo › Guardar como plantilla… */
export async function openSaveTemplate(): Promise<void> {
  stopTextEditing();
  const templates = api();
  if (!templates) {
    store.set({ hint: 'La biblioteca de plantillas funciona en la app de escritorio.' });
    return;
  }
  const all = await templates.list();
  const existing = new Set(all.map((t) => t.name.toLowerCase()));
  const category = categoryInput(all.find((t) => t.name.toLowerCase() === store.get().document.name.toLowerCase())?.category ?? '', all.map((t) => t.category));
  const name = h('input', { class: 'input', value: store.get().document.name, maxlength: 80, 'aria-label': 'Nombre de la plantilla' });
  const multi = allPages(store.get().document).length > 1;
  const onlyThis = h('input', { type: 'checkbox', checked: multi, 'aria-label': 'Solo esta página' });
  const onlyRow = h('label', { class: 'check' }, onlyThis, h('span', {}, `Solo esta página (${(store.get().document.pageIndex ?? 0) + 1} de ${allPages(store.get().document).length})`, h('small', {}, 'Desmarca para guardar todas las páginas en una sola plantilla.')));
  const status = h('span', { class: 'export-status' });
  const save = h('button', { type: 'button', class: 'button primary', onclick: () => void submit() }, 'Guardar plantilla');
  const { close, root } = modal(
    'Guardar como plantilla',
    [h('div', { class: 'contour-body' }, h('label', { class: 'field-row' }, h('span', { class: 'field-label' }, 'Nombre'), name), h('label', { class: 'field-row' }, h('span', { class: 'field-label' }, 'Categoría'), category), ...(multi ? [onlyRow] : []), h('p', { class: 'export-note' }, 'Se guarda tal cual, con sus campos {{Nombre}}, fotos de ejemplo y páginas. Para usarla: Archivo › Nuevo desde plantilla.'))],
    [status, h('button', { type: 'button', class: 'button', onclick: () => close() }, 'Cancelar'), save],
    'template-save-dialog',
  );
  root.addEventListener('keydown', (e) => e.key === 'Enter' && void submit());
  name.focus();
  name.select();
  async function submit() {
    const value = name.value.trim();
    if (!value) {
      status.textContent = 'Escribe un nombre.';
      return;
    }
    if (existing.has(value.toLowerCase()) && save.dataset.confirm !== value) {
      save.dataset.confirm = value;
      save.textContent = 'Reemplazar';
      status.textContent = 'Ya hay una plantilla con ese nombre. Pulsa "Reemplazar" para sobrescribirla.';
      return;
    }
    save.disabled = true;
    status.textContent = 'Guardando…';
    const single = multi && onlyThis.checked;
    const doc = single ? currentPageOnly() : store.get().document;
    const result = await templates!.save(value, single ? serializeDesign({ ...doc, name: value }) : currentContent(), await thumbnailPng(single ? doc : undefined), category.value.trim());
    if (result.ok) {
      store.set({ hint: `Plantilla guardada: ${result.value}` });
      close();
    } else {
      status.textContent = result.error;
      save.disabled = false;
    }
  }
}

/** Archivo › Nuevo desde plantilla… */
export async function openTemplatesLibrary(): Promise<void> {
  stopTextEditing();
  const templates = api();
  if (!templates) {
    store.set({ hint: 'La biblioteca de plantillas funciona en la app de escritorio.' });
    return;
  }
  const grid = h('div', { class: 'pages-grid templates-grid', role: 'list' });
  const tabs = h('div', { class: 'cat-tabs', role: 'tablist' });
  const status = h('span', { class: 'export-status' });
  const { close } = modal('Nuevo desde plantilla', [tabs, grid], [status, h('button', { type: 'button', class: 'button', onclick: () => close() }, 'Cerrar')], 'pages-dialog');
  let current = '';

  const paint = async () => {
    const all: TemplateInfo[] = await templates.list();
    const cats = categoriesOf(all);
    if (!cats.includes(current)) current = cats[0] ?? '';
    tabs.replaceChildren(
      ...(cats.length > 1 || (cats[0] && cats[0] !== NO_CATEGORY)
        ? cats.map((c) => h('button', { type: 'button', role: 'tab', class: 'cat-tab', 'aria-selected': String(c === current), onclick: () => ((current = c), void paint()) }, c, h('em', {}, String(all.filter((t) => (t.category || NO_CATEGORY) === c).length))))
        : []),
    );
    const list = all.filter((t) => (t.category || NO_CATEGORY) === current);
    if (list.length === 0) {
      grid.replaceChildren(h('p', { class: 'export-note' }, 'Aún no hay plantillas. Abre o diseña una placa y usa Archivo › Guardar como plantilla.'));
      return;
    }
    grid.replaceChildren(
      ...list.map((t) => {
        const thumb = t.thumbnail ? h('img', { class: 'page-thumb', alt: '', src: `data:image/png;base64,${t.thumbnail}` }) : h('div', { class: 'page-thumb template-empty' }, 'Sin vista');
        const remove = h('button', { type: 'button', class: 'template-remove', title: 'Borrar esta plantilla', 'aria-label': `Borrar ${t.name}` }, '×');
        remove.addEventListener('click', async (event) => {
          event.stopPropagation();
          if (remove.dataset.confirm !== '1') {
            remove.dataset.confirm = '1';
            remove.textContent = '¿Borrar?';
            return;
          }
          await templates.remove(t.name);
          void paint();
        });
        return h(
          'div',
          { class: 'page-card', role: 'listitem', tabindex: 0, title: `Empezar un diseño nuevo con “${t.name}”`, onclick: () => void use(t.name), onkeydown: ((e: KeyboardEvent) => e.key === 'Enter' && void use(t.name)) as EventListener },
          h('div', { class: 'page-thumb-wrap' }, thumb, remove),
          h('span', { class: 'page-card-name' }, t.name),
          h('span', { class: 'template-date' }, new Date(t.modified).toLocaleDateString('es-MX', { day: 'numeric', month: 'short', year: 'numeric' })),
        );
      }),
    );
  };

  async function use(name: string) {
    status.textContent = 'Abriendo…';
    const result = await templates!.read(name);
    if (!result.ok) {
      status.textContent = result.error;
      return;
    }
    close();
    await openTemplate(result.value, name);
  }

  await paint();
}

/** Guarda un diseño como plantilla sin abrirlo (p. ej., cada página de un PDF). */
export async function saveTemplateFrom(doc: TrazoDocument, name: string, overwrite = false, category?: string): Promise<{ ok: boolean; name: string; error?: string }> {
  const templates = api();
  if (!templates) return { ok: false, name, error: 'La biblioteca de plantillas funciona en la app de escritorio.' };
  let finalName = name.trim() || 'Plantilla';
  if (!overwrite) {
    const existing = new Set((await templates.list()).map((t) => t.name.toLowerCase()));
    for (let i = 2; existing.has(finalName.toLowerCase()); i++) finalName = `${name.trim()} (${i})`;
  }
  const result = await templates.save(finalName, serializeDesign({ ...doc, name: finalName }), await thumbnailPng(doc), category);
  return result.ok ? { ok: true, name: result.value } : { ok: false, name: finalName, error: result.error };
}

/** La página que se ve, sola (para "Guardar como plantilla › Solo esta página"). */
function currentPageOnly(): TrazoDocument {
  const doc = store.get().document;
  const i = doc.pageIndex ?? 0;
  const page = allPages(doc)[i]!;
  return withPages(pageDocument(doc, i), [{ ...page, name: 'Página 1' }], 0);
}

// ---- Paquetes de plantillas (.inkpack): para respaldar, pasarlas a otra computadora o compartirlas ----

const PACK_FORMAT = 'inkara-plantillas';
const EXAMPLES_SEEDED = 'inkara.ejemplos.cargados';

/**
 * La primera vez que se abre la app (sin plantillas), carga las plantillas de ejemplo
 * ("Universidad de Ejemplo": graduación, diplomas y agradecimientos en blanco y negro)
 * para poder probar las placas en serie desde el inicio. Solo una vez por computadora.
 */
export async function seedExampleTemplates(): Promise<void> {
  const templates = api();
  if (!templates) return;
  try {
    if (localStorage.getItem(EXAMPLES_SEEDED) === '1') return;
    localStorage.setItem(EXAMPLES_SEEDED, '1');
  } catch {
    return;
  }
  if ((await templates.list()).length > 0) return;
  for (const e of readPack(JSON.stringify(examplesPack))) {
    const thumb = e.thumbnail ? Uint8Array.from(atob(e.thumbnail), (c) => c.charCodeAt(0)) : null;
    await templates.save(e.name, e.content, thumb, e.category);
  }
}

interface PackEntry {
  name: string;
  category: string;
  content: string;
  thumbnail: string | null;
}

/** Archivo › Exportar paquete de plantillas… (todas, o las de una categoría). */
export async function exportTemplatePack(): Promise<void> {
  const templates = api();
  if (!templates) {
    store.set({ hint: 'La biblioteca de plantillas funciona en la app de escritorio.' });
    return;
  }
  const all = await templates.list();
  if (all.length === 0) {
    store.set({ hint: 'Aún no hay plantillas que exportar.' });
    return;
  }
  const entries: PackEntry[] = [];
  for (const t of all) {
    const r = await templates.read(t.name);
    if (r.ok) entries.push({ name: t.name, category: t.category, content: r.value, thumbnail: t.thumbnail });
  }
  const json = JSON.stringify({ format: PACK_FORMAT, version: 1, created: new Date().toISOString(), templates: entries });
  const name = `Plantillas Inkara (${entries.length})`;
  const files = window.trazo?.files;
  if (files) {
    const r = await files.exportFile({ content: json, suggestedName: name, extension: 'inkpack' });
    if (r.ok) store.set({ hint: `Paquete guardado: ${r.value}` });
    else if (!r.canceled) store.set({ hint: r.error });
  } else {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    a.download = `${name}.inkpack`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
}

function readPack(text: string): PackEntry[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('El archivo no es un paquete de plantillas de Inkara.');
  }
  const r = raw as { format?: unknown; templates?: unknown };
  if (!r || r.format !== PACK_FORMAT || !Array.isArray(r.templates)) throw new Error('El archivo no es un paquete de plantillas de Inkara.');
  return r.templates
    .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object')
    .map((t) => ({ name: String(t.name ?? '').slice(0, 80), category: String(t.category ?? '').slice(0, 40), content: String(t.content ?? ''), thumbnail: typeof t.thumbnail === 'string' && /^[A-Za-z0-9+/=]+$/.test(t.thumbnail) ? t.thumbnail : null }))
    .filter((t) => t.name && t.content.startsWith('{'))
    .slice(0, 2000);
}

/** Archivo › Importar paquete de plantillas… (o soltar un .inkpack en la app). */
export async function importTemplatePack(file?: File): Promise<void> {
  const templates = api();
  if (!templates) {
    store.set({ hint: 'La biblioteca de plantillas funciona en la app de escritorio.' });
    return;
  }
  if (!file) {
    const input = h('input', { type: 'file', accept: '.inkpack' });
    input.addEventListener('change', () => input.files?.[0] && void importTemplatePack(input.files[0]));
    input.click();
    return;
  }
  let entries: PackEntry[];
  try {
    entries = readPack(await file.text());
  } catch (error) {
    store.set({ hint: error instanceof Error ? error.message : String(error) });
    return;
  }
  const existing = new Set((await templates.list()).map((t) => t.name.toLowerCase()));
  const repeated = entries.filter((e) => existing.has(e.name.toLowerCase())).length;
  const cats = [...new Set(entries.map((e) => e.category || NO_CATEGORY))];
  const replace = h('input', { type: 'checkbox', checked: true });
  const status = h('span', { class: 'export-status' });
  const go = h('button', { type: 'button', class: 'button primary' }, `Importar ${entries.length}`);
  const { close } = modal(
    'Importar plantillas',
    [
      h(
        'div',
        { class: 'contour-body' },
        h('p', {}, `${entries.length} ${entries.length === 1 ? 'plantilla' : 'plantillas'} en ${cats.join(', ')}.`),
        h('div', { class: 'pack-thumbs' }, ...entries.slice(0, 12).map((e) => (e.thumbnail ? h('img', { alt: e.name, title: e.name, src: `data:image/png;base64,${e.thumbnail}` }) : h('span', { class: 'pack-nothumb' }, e.name)))),
        repeated ? h('label', { class: 'check' }, replace, h('span', {}, `Reemplazar las ${repeated} que ya tienes con el mismo nombre`, h('small', {}, 'Si lo quitas, esas se saltan.'))) : null,
      ),
    ],
    [status, h('button', { type: 'button', class: 'button', onclick: () => close() }, 'Cancelar'), go],
    'template-save-dialog',
  );
  go.addEventListener('click', async () => {
    go.disabled = true;
    let done = 0;
    let skipped = 0;
    for (const e of entries) {
      if (existing.has(e.name.toLowerCase()) && !replace.checked) {
        skipped++;
        continue;
      }
      status.textContent = `Importando ${done + 1} de ${entries.length}…`;
      const thumb = e.thumbnail ? Uint8Array.from(atob(e.thumbnail), (c) => c.charCodeAt(0)) : null;
      const r = await templates.save(e.name, e.content, thumb, e.category);
      if (r.ok) done++;
    }
    store.set({ hint: `${done} plantillas importadas${skipped ? ` (${skipped} ya las tenías)` : ''}. Están en Archivo › Nuevo desde plantilla y en Placas en serie.` });
    close();
  });
}

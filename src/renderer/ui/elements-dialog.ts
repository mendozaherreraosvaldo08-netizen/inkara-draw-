import { createDocument, type TrazoDocument } from '../../engine/document';
import { parseDocument } from '../../engine/file-format';
import { translate } from '../../engine/matrix';
import { newShapeId, shapeBounds, transformShape, unionBounds, type Shape } from '../../engine/shapes';
import type { TemplateInfo } from '../../shared/api';
import * as editor from '../editor';
import { serializeDesign } from '../session';
import { store } from '../state';
import { stopTextEditing } from '../text-edit';
import { h } from './dom';
import { thumbnailPng } from './templates-dialog';

/**
 * Biblioteca de elementos: logos de escuelas, escudos, marcos y adornos que
 * se usan seguido. Se guardan una vez (Objeto › Guardar como elemento) y se
 * ponen en cualquier diseño con un clic (Ventana › Biblioteca de elementos).
 */

export const ELEMENT_CATEGORIES = ['Logos', 'Escudos', 'Marcos', 'Adornos', 'Textos'];
const api = () => window.trazo?.elements;

function modal(title: string, body: Node[], foot: HTMLElement[], cls = ''): { close: () => void; root: HTMLElement } {
  const dialog = h('div', { class: `modal ${cls}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, h('header', { class: 'modal-head' }, h('h2', {}, title)), ...body, h('footer', { class: 'modal-foot' }, ...foot));
  const backdrop = h('div', { class: 'modal-backdrop' }, dialog);
  document.body.append(backdrop);
  backdrop.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') backdrop.remove();
  });
  backdrop.addEventListener('pointerdown', (e) => e.target === backdrop && backdrop.remove());
  return { close: () => backdrop.remove(), root: dialog };
}

/** Lo elegido, con lo que va dentro de sus PowerClip. */
function selectionWithContents(): Shape[] {
  const doc = store.get().document;
  const ids = new Set(editor.selectedShapes().map((s) => s.id));
  return doc.shapes.filter((s) => ids.has(s.id) || (s.clipId && ids.has(s.clipId)));
}

/** Objeto › Guardar como elemento… */
export async function openSaveElement(): Promise<void> {
  stopTextEditing();
  const lib = api();
  if (!lib) {
    store.set({ hint: 'La biblioteca de elementos funciona en la app de escritorio.' });
    return;
  }
  const shapes = selectionWithContents();
  const box = unionBounds(shapes.filter((s) => !s.clipId).map(shapeBounds));
  if (!box || shapes.length === 0) {
    store.set({ hint: 'Selecciona el logo, escudo o marco que quieres guardar.' });
    return;
  }
  const name = h('input', { class: 'input', value: shapes.find((s) => s.name)?.name ?? '', maxlength: 80, placeholder: 'Ej. Logo de la escuela', 'aria-label': 'Nombre del elemento' });
  const cat = h('select', { class: 'input', 'aria-label': 'Categoría' }, ...ELEMENT_CATEGORIES.map((c) => h('option', { value: c }, c)));
  const status = h('span', { class: 'export-status' });
  const { close } = modal(
    'Guardar como elemento',
    [h('div', { class: 'contour-body' }, h('label', { class: 'field-row' }, h('span', { class: 'field-label' }, 'Nombre'), name), h('label', { class: 'field-row' }, h('span', { class: 'field-label' }, 'Categoría'), cat), h('p', { class: 'export-note' }, `${shapes.length} ${shapes.length === 1 ? 'objeto' : 'objetos'} de ${(box.width / 25.4).toFixed(2)} × ${(box.height / 25.4).toFixed(2)} pulgadas. Después lo pones con Ventana › Biblioteca de elementos.`))],
    [
      status,
      h('button', { type: 'button', class: 'button', onclick: () => close() }, 'Cancelar'),
      h(
        'button',
        {
          type: 'button',
          class: 'button primary',
          onclick: async () => {
            const n = name.value.trim();
            if (!n) {
              status.textContent = 'Escribe un nombre.';
              return;
            }
            const m = translate(-box.x, -box.y);
            const doc: TrazoDocument = { ...createDocument(n), page: { widthMm: Math.max(1, box.width), heightMm: Math.max(1, box.height), bleedMm: 0, safeMarginMm: 0 }, shapes: shapes.map((s) => transformShape(s, m)), assets: store.get().document.assets };
            const r = await lib.save(n, serializeDesign(doc), await thumbnailPng(doc), cat.value);
            if (!r.ok) {
              status.textContent = r.error;
              return;
            }
            store.set({ hint: `Elemento guardado: ${r.value} (${cat.value}).` });
            close();
          },
        },
        'Guardar',
      ),
    ],
    'template-save-dialog',
  );
  name.focus();
}

/** Ventana › Biblioteca de elementos… */
export async function openElementsLibrary(): Promise<void> {
  stopTextEditing();
  const lib = api();
  if (!lib) {
    store.set({ hint: 'La biblioteca de elementos funciona en la app de escritorio.' });
    return;
  }
  const tabs = h('div', { class: 'cat-tabs', role: 'tablist' });
  const grid = h('div', { class: 'pages-grid templates-grid', role: 'list' });
  const status = h('span', { class: 'export-status' });
  const { close } = modal('Biblioteca de elementos', [tabs, grid], [status, h('button', { type: 'button', class: 'button', onclick: () => close() }, 'Cerrar')], 'pages-dialog');
  let current = '';
  const paint = async () => {
    const all: TemplateInfo[] = await lib.list();
    const cats = [...new Set([...ELEMENT_CATEGORIES.filter((c) => all.some((t) => t.category === c)), ...all.map((t) => t.category || 'Otros')])];
    if (!cats.includes(current)) current = cats[0] ?? '';
    tabs.replaceChildren(...cats.map((c) => h('button', { type: 'button', role: 'tab', class: 'cat-tab', 'aria-selected': String(c === current), onclick: () => ((current = c), void paint()) }, c, h('em', {}, String(all.filter((t) => (t.category || 'Otros') === c).length)))));
    const list = all.filter((t) => (t.category || 'Otros') === current);
    if (list.length === 0) {
      grid.replaceChildren(h('p', { class: 'export-note' }, 'Aún no hay elementos. Selecciona un logo, escudo o marco y usa Objeto › Guardar como elemento.'));
      return;
    }
    grid.replaceChildren(
      ...list.map((t) => {
        const remove = h('button', { type: 'button', class: 'template-remove', title: 'Borrar este elemento', 'aria-label': `Borrar ${t.name}` }, '×');
        remove.addEventListener('click', async (e) => {
          e.stopPropagation();
          if (remove.dataset.confirm !== '1') {
            remove.dataset.confirm = '1';
            remove.textContent = '¿Borrar?';
            return;
          }
          await lib.remove(t.name);
          void paint();
        });
        return h(
          'div',
          { class: 'page-card', role: 'listitem', tabindex: 0, title: `Poner “${t.name}” en el diseño`, onclick: () => void insert(t.name), onkeydown: ((e: KeyboardEvent) => e.key === 'Enter' && void insert(t.name)) as EventListener },
          h('div', { class: 'page-thumb-wrap' }, t.thumbnail ? h('img', { class: 'page-thumb', alt: '', src: `data:image/png;base64,${t.thumbnail}` }) : h('div', { class: 'page-thumb template-empty' }, 'Sin vista'), remove),
          h('span', { class: 'page-card-name' }, t.name),
        );
      }),
    );
  };

  async function insert(name: string) {
    const r = await lib!.read(name);
    if (!r.ok) {
      status.textContent = r.error;
      return;
    }
    let el: TrazoDocument;
    try {
      el = parseDocument(r.value, name).document;
    } catch {
      status.textContent = 'El elemento está dañado.';
      return;
    }
    // Ids nuevos (se puede poner varias veces) y al centro de la página.
    const ids = new Map(el.shapes.map((s) => [s.id, newShapeId()]));
    const groups = new Map<string, string>();
    const page = store.get().document.page;
    const m = translate((page.widthMm - el.page.widthMm) / 2, (page.heightMm - el.page.heightMm) / 2);
    const many = el.shapes.filter((s) => !s.clipId).length > 1;
    const group = many ? `g${newShapeId()}` : undefined;
    const shapes = el.shapes.map((s): Shape => {
      const next = transformShape({ ...s, id: ids.get(s.id)! }, m);
      if (s.clipId) next.clipId = ids.get(s.clipId) ?? s.clipId;
      if (s.groupId) next.groupId = groups.get(s.groupId) ?? (groups.set(s.groupId, `g${newShapeId()}`), groups.get(s.groupId)!);
      else if (group && !s.clipId) next.groupId = group;
      return next;
    });
    const doc = store.get().document;
    store.set({ document: { ...doc, assets: { ...doc.assets, ...el.assets } } });
    editor.commit(`Poner ${name}`, [...store.get().document.shapes, ...shapes], shapes.filter((s) => !s.clipId).map((s) => s.id));
    store.set({ hint: `“${name}” puesto en el diseño.`, tool: 'select' });
    close();
  }
  await paint();
}

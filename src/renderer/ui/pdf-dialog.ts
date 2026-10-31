import { allPages, withPages, type ImageAsset, type PageData, type TrazoDocument } from '../../engine/document';
import { pdfThumbnails, pdfToDocument } from '../pdf-open';
import { openBuiltDocument } from '../session';
import { store } from '../state';
import { h } from './dom';
import { categoryInput, DEFAULT_CATEGORIES, saveTemplateFrom } from './templates-dialog';

/**
 * Ventana para PDF de varias páginas (o varios PDF a la vez): miniaturas de
 * todas las páginas para elegir cuáles abrir o guardar como plantillas, cada
 * una con su nombre. Así de un PDF de Corel con 32 placas se sacan las
 * plantillas que hagan falta, sin abrir todo.
 */

export interface PdfFile {
  name: string;
  bytes: Uint8Array<ArrayBuffer>;
}

interface Item {
  file: PdfFile;
  page: number;
  check: HTMLInputElement;
  name: HTMLInputElement;
  card: HTMLElement;
}

const baseName = (file: string) => file.replace(/\.pdf$/i, '').replace(/\.cdr$/i, '').replace(/_/g, ' ').trim() || 'Diseño';

export function openPdfPicker(files: PdfFile[]): void {
  const grid = h('div', { class: 'pages-grid pdf-grid', role: 'list' });
  const status = h('span', { class: 'export-status', role: 'status' });
  const count = h('span', { class: 'export-note' });
  const items: Item[] = [];
  const signal = { canceled: false };

  const openButton = h('button', { type: 'button', class: 'button', onclick: () => void openSelected() }, 'Abrir las seleccionadas');
  const templatesButton = h('button', { type: 'button', class: 'button primary', onclick: () => void saveSelected() }, 'Guardar como plantillas');
  const allButton = h('button', { type: 'button', class: 'button', onclick: () => setAll(true) }, 'Todas');
  const noneButton = h('button', { type: 'button', class: 'button', onclick: () => setAll(false) }, 'Ninguna');
  const category = categoryInput('', []);
  void window.trazo?.templates?.list().then((all) => category.list?.append(...[...new Set(all.map((t) => t.category).filter((c) => c && !DEFAULT_CATEGORIES.includes(c)))].map((c) => h('option', { value: c }))));

  const dialog = h(
    'div',
    { class: 'modal pages-dialog pdf-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'pdf-title' },
    h('header', { class: 'modal-head' }, h('h2', { id: 'pdf-title' }, files.length === 1 ? `Abrir ${files[0]!.name}` : `Abrir ${files.length} PDF`), count),
    h('div', { class: 'pages-tools' }, allButton, noneButton, h('label', { class: 'pdf-cat' }, h('span', { class: 'field-label' }, 'Categoría'), category), h('span', { class: 'export-note' }, 'Marca las páginas que quieres. Cada una se puede guardar como plantilla con su propio nombre.')),
    grid,
    h('footer', { class: 'modal-foot' }, status, h('button', { type: 'button', class: 'button', onclick: () => close() }, 'Cancelar'), openButton, templatesButton),
  );
  const backdrop = h('div', { class: 'modal-backdrop' }, dialog);
  document.body.append(backdrop);
  backdrop.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key === 'Escape' && !busy) close();
  });
  let busy = false;
  function close() {
    signal.canceled = true;
    backdrop.remove();
  }
  const paintCount = () => {
    const n = items.filter((i) => i.check.checked).length;
    count.textContent = `${n} de ${items.length} ${items.length === 1 ? 'página' : 'páginas'} seleccionadas`;
    openButton.disabled = busy || n === 0;
    templatesButton.disabled = busy || n === 0 || !window.trazo?.templates;
    if (!window.trazo?.templates) templatesButton.title = 'La biblioteca de plantillas funciona en la app de escritorio.';
  };
  function setAll(value: boolean) {
    for (const i of items) {
      i.check.checked = value;
      i.card.classList.toggle('is-selected', value);
    }
    paintCount();
  }

  // Miniaturas (las dibuja pdf.js con sus fuentes), archivo por archivo.
  void (async () => {
    status.textContent = 'Leyendo páginas…';
    for (const file of files) {
      try {
        await pdfThumbnails(
          file.bytes,
          170,
          (page, total, canvas) => {
            canvas.className = 'page-thumb';
            const label = files.length > 1 ? (total > 1 ? `${baseName(file.name)} · ${page}` : baseName(file.name)) : total > 1 ? `${baseName(file.name)} ${page}` : baseName(file.name);
            // Un solo PDF de varias páginas: empiezan sin marcar (se elige lo que se quiere).
            const startChecked = files.length > 1 || total === 1;
            const check = h('input', { type: 'checkbox', checked: startChecked, 'aria-label': `Usar ${label}` });
            const name = h('input', { class: 'input pdf-name', value: label, maxlength: 80, 'aria-label': `Nombre de la plantilla de ${label}`, title: 'Nombre de la plantilla' });
            const caption = h('span', { class: 'page-card-name' }, files.length > 1 ? `${baseName(file.name)} · página ${page}` : `Página ${page}`);
            const card = h('div', { class: `page-card${startChecked ? ' is-selected' : ''}`, role: 'listitem' }, h('label', { class: 'page-thumb-wrap' }, canvas, h('span', { class: 'pdf-check' }, check)), caption, name);
            check.addEventListener('change', () => {
              card.classList.toggle('is-selected', check.checked);
              paintCount();
            });
            items.push({ file, page, check, name, card });
            grid.append(card);
            paintCount();
          },
          signal,
        );
      } catch (error) {
        status.textContent = `No se pudo leer ${file.name}: ${error instanceof Error ? error.message : String(error)}`;
        return;
      }
    }
    status.textContent = '';
  })();
  paintCount();

  const selected = () => items.filter((i) => i.check.checked);
  const setBusy = (value: boolean, text = '') => {
    busy = value;
    status.textContent = text;
    paintCount();
  };

  /** Convierte las páginas elegidas de cada archivo (un PDF se lee una sola vez). */
  async function convert(list: Item[], each?: (item: Item, doc: TrazoDocument) => Promise<void>): Promise<TrazoDocument | null> {
    let merged: TrazoDocument | null = null;
    const pages: PageData[] = [];
    let assets: Record<string, ImageAsset> = {};
    let done = 0;
    for (const file of files) {
      const mine = list.filter((i) => i.file === file);
      if (mine.length === 0) continue;
      const { document: doc } = await pdfToDocument(file.bytes, baseName(file.name), (p) => setBusy(true, `Convirtiendo ${done + p.page} de ${list.length}…`), mine.map((i) => i.page));
      const docPages = allPages(doc);
      merged ??= doc;
      assets = { ...assets, ...doc.assets };
      for (const [k, item] of mine.entries()) {
        const page = { ...docPages[k]!, name: item.name.value.trim() || docPages[k]!.name };
        pages.push(page);
        if (each) await each(item, withPages({ ...doc, name: page.name }, [{ ...page, name: 'Página 1' }], 0));
      }
      done += mine.length;
    }
    return merged ? withPages({ ...merged, assets }, pages, 0) : null;
  }

  async function openSelected() {
    const list = selected();
    setBusy(true, 'Convirtiendo…');
    try {
      const doc = await convert(list);
      if (!doc) return setBusy(false, 'No hay páginas seleccionadas.');
      const name = files.length === 1 ? baseName(files[0]!.name) : 'Diseño de PDF';
      close();
      await openBuiltDocument({ ...doc, name }, `Abierto: ${list.length} ${list.length === 1 ? 'página' : 'páginas'}, todo editable.`);
    } catch (error) {
      setBusy(false, `No se pudo abrir: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function saveSelected() {
    const list = selected();
    const saved: string[] = [];
    setBusy(true, 'Guardando plantillas…');
    try {
      await convert(list, async (item, doc) => {
        const r = await saveTemplateFrom(doc, item.name.value, false, category.value.trim());
        if (!r.ok) throw new Error(r.error);
        saved.push(r.name);
        item.card.classList.add('is-saved');
        setBusy(true, `Plantilla ${saved.length} de ${list.length}: ${r.name}`);
      });
      setBusy(false, `Listo: ${saved.length} plantillas guardadas. Están en Archivo › Nuevo desde plantilla.`);
      store.set({ hint: `${saved.length} plantillas guardadas desde PDF.` });
    } catch (error) {
      setBusy(false, `${saved.length ? `Se guardaron ${saved.length}. ` : ''}No se pudo terminar: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

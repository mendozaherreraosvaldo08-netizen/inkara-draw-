import { fieldsInDocument, matchPhoto, unknownFields } from '../../engine/merge';
import { createText } from '../../engine/text';
import * as editor from '../editor';
import { choosePhotoFolder, createPlatePages, generateAll, onPhotosChanged, photoCount, photoNames, previewRow, setMerge, setTable, type MergeOutput } from '../merge';
import { store } from '../state';
import { DEFAULT_SHEET, type Paper } from '../../engine/sheet';
import { openPagesOverview } from './pages-overview';
import { stopTextEditing } from '../text-edit';
import { h } from './dom';

/**
 * Ventana "Placas en serie":
 *  1. Datos: pegar la tabla de Excel / Google Sheets o abrir un CSV.
 *  2. Campos: {{Columna}} en los textos y la columna de la foto.
 *  3. Generar: todas las placas, con espejo, sangrado y ppp.
 */

export const STORAGE_KEY = 'trazo.merge.v1';
export interface Saved {
  output: MergeOutput;
  dpi: number;
  mirror: boolean;
  bleed: boolean;
  /** Acomodo en hoja. */
  paper: Paper;
  gapMm: number;
  rollWidthMm: number;
  marks: boolean;
}

const PAPER_IDS: Paper[] = ['carta', 'a4', 'tabloide', 'rollo'];
const sheetDefaults = { paper: 'a4' as Paper, gapMm: 0, rollWidthMm: 610, marks: true };

export function loadOutputSettings(): Saved {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<Saved> | null;
    if (raw) return { output: (['png', 'jpg', 'pdf', 'pdf-all', 'pdf-pairs', 'pdf-sheet'] as const).includes(raw.output as MergeOutput) ? raw.output! : 'png', dpi: typeof raw.dpi === 'number' ? raw.dpi : 300, mirror: raw.mirror ?? true, bleed: raw.bleed ?? true, paper: PAPER_IDS.includes(raw.paper as Paper) ? raw.paper! : sheetDefaults.paper, gapMm: typeof raw.gapMm === 'number' && raw.gapMm >= 0 && raw.gapMm <= 50 ? raw.gapMm : sheetDefaults.gapMm, rollWidthMm: typeof raw.rollWidthMm === 'number' && raw.rollWidthMm >= 100 && raw.rollWidthMm <= 3000 ? raw.rollWidthMm : sheetDefaults.rollWidthMm, marks: raw.marks ?? sheetDefaults.marks };
  } catch {
    // valores por defecto
  }
  return { output: 'png', dpi: 300, mirror: true, bleed: true, ...sheetDefaults };
}

export const OUTPUTS: Array<{ id: MergeOutput; label: string; hint: string }> = [
  { id: 'png', label: 'PNG', hint: 'Un PNG por placa (recomendado para sublimar).' },
  { id: 'jpg', label: 'JPG', hint: 'Un JPG por placa (archivos más ligeros).' },
  { id: 'pdf', label: 'PDF', hint: 'Un PDF por placa.' },
  { id: 'pdf-all', label: 'Un PDF', hint: 'Un solo PDF con una placa por página: fácil de mandar a imprimir.' },
  { id: 'pdf-pairs', label: '2 por hoja', hint: 'Un PDF con dos placas por hoja (A4 horizontal), como se suben a la plancha.' },
  { id: 'pdf-sheet', label: 'Acomodo en hoja', hint: 'Un PDF con todas las placas que quepan en tu papel (carta, A4, tabloide o rollo), con marcas de corte.' },
];

let isOpen = false;

export function openMergeDialog(): void {
  if (isOpen) return;
  isOpen = true;
  stopTextEditing();
  store.set({ mergePreview: null });
  const options = loadOutputSettings();
  let busy = false;
  const signal = { canceled: false };

  // ---- 1. Datos ----
  const dataStatus = h('div', { class: 'export-note' });
  const table = h('div', { class: 'merge-table' });
  const paste = h('textarea', { class: 'input merge-paste', rows: 6, spellcheck: 'false', placeholder: 'Pega aquí la tabla (Ctrl+V). La primera fila deben ser los títulos: Nombre, Generación, Foto…', hidden: true });
  const usePaste = h('button', { type: 'button', class: 'button primary', hidden: true, onclick: () => applyText(paste.value) }, 'Usar estos datos');
  const csvInput = h('input', { type: 'file', accept: '.csv,.tsv,.txt,text/csv,text/plain', hidden: true });
  csvInput.addEventListener('change', async () => {
    const file = csvInput.files?.[0];
    if (file) applyText(await file.text());
  });
  const applyText = (text: string) => {
    const r = setTable(text);
    dataStatus.textContent = r.message;
    dataStatus.classList.toggle('is-error', !r.ok);
    if (r.ok) {
      paste.hidden = true;
      usePaste.hidden = true;
      paint();
    }
  };

  // ---- 2. Campos ----
  const chips = h('div', { class: 'merge-chips' });
  const fieldStatus = h('div', { class: 'export-note' });
  const photoStatus = h('div', { class: 'export-note' });

  // ---- 3. Generar ----
  const outButtons = OUTPUTS.map((o) => h('button', { type: 'button', class: 'segment', title: o.hint, onclick: () => update({ output: o.id }) }, o.label));
  const outHint = h('div', { class: 'export-note' });
  const nameInput = h('input', { class: 'input merge-name', type: 'text', spellcheck: 'false', 'aria-label': 'Nombre de cada archivo' });
  nameInput.addEventListener('change', () => {
    const merge = store.get().document.merge;
    if (merge) setMerge({ ...merge, fileName: nameInput.value.trim() || `{{${merge.columns[0]}}}` });
    paint();
  });
  const dpi = h('select', { class: 'input', 'aria-label': 'Resolución', onchange: ((e: Event) => update({ dpi: Number((e.target as HTMLSelectElement).value) })) as EventListener }, ...[150, 200, 300, 600].map((v) => h('option', { value: v }, `${v} ppp`)));
  const mirror = h('input', { type: 'checkbox', onchange: ((e: Event) => update({ mirror: (e.target as HTMLInputElement).checked })) as EventListener });
  const bleed = h('input', { type: 'checkbox', onchange: ((e: Event) => update({ bleed: (e.target as HTMLInputElement).checked })) as EventListener });
  const progressBar = h('div', { class: 'merge-progress-bar' });
  const progress = h('div', { class: 'merge-progress', hidden: true }, progressBar);
  const status = h('div', { class: 'export-status', role: 'status' });
  const previewButton = h('button', { type: 'button', class: 'button', onclick: () => preview() }, 'Vista previa');
  const generateButton = h('button', { type: 'button', class: 'button primary', onclick: () => void generate() }, 'Generar placas…');
  // Revisar antes de imprimir: una página por placa, para corregir la que salga mal.
  const pagesButton = h('button', { type: 'button', class: 'button', title: 'Crea una página por cada fila (con su nombre y foto). Las revisas todas juntas y corriges solo la que salga mal; luego exportas el PDF o una imagen por página.', onclick: () => void makePages() }, 'Una página por placa');
  const closeButton = h('button', { type: 'button', class: 'button', onclick: () => (busy ? (signal.canceled = true) : close()) }, 'Cerrar');

  const section = (title: string, ...children: Node[]) => h('section', { class: 'merge-section' }, h('h3', {}, title), ...children);
  const dialog = h(
    'div',
    { class: 'modal merge-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'merge-title' },
    h('header', { class: 'modal-head' }, h('h2', { id: 'merge-title' }, 'Placas en serie'), h('span', { class: 'modal-sub' }, 'Un diseño, una placa por cada graduado')),
    h(
      'div',
      { class: 'merge-body' },
      section(
        '1. Datos',
        h(
          'div',
          { class: 'merge-actions' },
          h('button', { type: 'button', class: 'button', onclick: () => ((paste.hidden = false), (usePaste.hidden = false), paste.focus()) }, 'Pegar tabla de Excel'),
          h('button', { type: 'button', class: 'button', onclick: () => csvInput.click() }, 'Abrir CSV…'),
          h('button', { type: 'button', class: 'button', onclick: () => (setMerge(undefined), paint()) }, 'Quitar datos'),
          csvInput,
        ),
        paste,
        usePaste,
        dataStatus,
        table,
      ),
      section(
        '2. Campos',
        h('div', { class: 'export-note' }, 'Escribe ', h('code', {}, '{{Nombre}}'), ' dentro de cualquier texto, o haz clic en una columna para agregar un texto con ese campo. Para nombres largos, ponle al texto un “Ancho máx.” en la barra de propiedades.'),
        chips,
        fieldStatus,
        h('div', { class: 'export-note' }, 'Foto de cada placa: importa una foto de ejemplo, selecciónala y elige su columna en “Foto de” (barra de propiedades). La foto llena el marco sin deformarse.'),
        h('div', { class: 'merge-actions' }, h('button', { type: 'button', class: 'button', onclick: () => void choosePhotoFolder().then(paint) }, 'Elegir carpeta de fotos…'), photoStatus),
      ),
      section(
        '3. Generar',
        h('div', { class: 'segments' }, ...outButtons),
        outHint,
        h('label', { class: 'field-row' }, h('span', { class: 'field-label' }, 'Nombre de cada archivo'), nameInput),
        h('div', { class: 'merge-options' }, h('label', { class: 'field-row' }, h('span', { class: 'field-label' }, 'Resolución'), dpi), h('label', { class: 'check' }, mirror, h('span', {}, 'Espejo')), h('label', { class: 'check' }, bleed, h('span', {}, 'Sangrado'))),
        progress,
      ),
    ),
    h('footer', { class: 'modal-foot' }, status, closeButton, previewButton, pagesButton, generateButton),
  );
  const backdrop = h('div', { class: 'modal-backdrop' }, dialog);
  document.body.append(backdrop);
  backdrop.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key === 'Escape' && !busy) close();
  });
  const stopPhotos = onPhotosChanged(paint);

  function close(): void {
    stopPhotos();
    backdrop.remove();
    isOpen = false;
  }

  function update(patch: Partial<Saved>): void {
    Object.assign(options, patch);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(options));
    } catch {
      // no se recuerda, no pasa nada
    }
    paint();
  }

  /** Texto nuevo con un campo, centrado en la página. */
  function addField(column: string): void {
    const state = store.get();
    const page = state.document.page;
    const shape = createText({ x: page.widthMm / 2, y: page.heightMm / 2 }, { fill: state.fill?.hex ?? '#000000', stroke: null, strokeWidth: state.strokeWidth, ...state.text, align: 'center' }, `{{${column}}}`);
    editor.commit(`Campo ${column}`, [...state.document.shapes, shape], [shape.id]);
    status.textContent = `Se agregó {{${column}}} al centro de la página: muévelo, cambia su letra y tamaño.`;
    paint();
  }

  function paint(): void {
    const doc = store.get().document;
    const merge = doc.merge;
    // Datos
    table.replaceChildren();
    chips.replaceChildren();
    if (merge) {
      dataStatus.textContent ||= `${merge.rows.length} placas · columnas: ${merge.columns.join(', ')}`;
      table.append(
        h(
          'table',
          {},
          h('thead', {}, h('tr', {}, h('th', {}, '#'), ...merge.columns.map((c) => h('th', {}, c)))),
          h('tbody', {}, ...merge.rows.slice(0, 50).map((r, i) => h('tr', { onclick: () => preview(i), title: 'Ver esta placa' }, h('td', {}, String(i + 1)), ...merge.columns.map((_, k) => h('td', {}, r[k] ?? ''))))),
        ),
      );
      if (merge.rows.length > 50) table.append(h('div', { class: 'export-note' }, `… y ${merge.rows.length - 50} más`));
      chips.append(...merge.columns.map((c) => h('button', { type: 'button', class: 'chip', title: `Agregar un texto con {{${c}}}`, onclick: () => addField(c) }, `{{${c}}}`)));
      if (document.activeElement !== nameInput) nameInput.value = merge.fileName;
    } else {
      dataStatus.textContent = 'Todavía no hay datos.';
      nameInput.value = '';
    }
    // Campos usados
    const used = fieldsInDocument(doc);
    const unknown = unknownFields(doc);
    fieldStatus.textContent = used.text.length || used.photos.length ? `En el diseño: ${[...used.text.map((f) => `{{${f}}}`), ...used.photos.map((f) => `foto: ${f}`)].join(', ')}${unknown.length ? ` · ⚠ No existen en los datos: ${unknown.join(', ')}` : ''}` : 'El diseño aún no tiene campos.';
    fieldStatus.classList.toggle('is-error', unknown.length > 0);
    // Fotos
    if (used.photos.length && merge) {
      const col = merge.columns.findIndex((c) => c.toLowerCase() === used.photos[0]!.toLowerCase());
      const names = photoNames();
      const found = col < 0 ? 0 : merge.rows.filter((r) => r[col] && matchPhoto(r[col]!, names)).length;
      photoStatus.textContent = photoCount() ? `${found} de ${merge.rows.length} fotos encontradas en la carpeta` : 'Falta elegir la carpeta con las fotos.';
      photoStatus.classList.toggle('is-error', found < merge.rows.length);
    } else photoStatus.textContent = photoCount() ? `${photoCount()} fotos en la carpeta` : '';
    // Generar
    outButtons.forEach((b, i) => b.setAttribute('aria-pressed', String(OUTPUTS[i]!.id === options.output)));
    outHint.textContent = OUTPUTS.find((o) => o.id === options.output)!.hint;
    dpi.value = String(options.dpi);
    mirror.checked = options.mirror;
    bleed.checked = options.bleed;
    previewButton.disabled = busy || !merge;
    generateButton.disabled = busy || !merge;
    pagesButton.disabled = busy || !merge;
    closeButton.textContent = busy ? 'Cancelar' : 'Cerrar';
  }

  function preview(row = 0): void {
    close();
    previewRow(row);
  }

  async function makePages(): Promise<void> {
    busy = true;
    signal.canceled = false;
    progress.hidden = false;
    paint();
    try {
      const result = await createPlatePages((done, total) => {
        progressBar.style.width = `${Math.round((done / Math.max(1, total)) * 100)}%`;
        status.textContent = `Creando placa ${done + 1} de ${total}…`;
      }, signal);
      if (result.created === 0) status.textContent = 'Cancelado.';
      else {
        const miss = result.missingPhotos.length ? ` ⚠ Sin foto: ${result.missingPhotos.slice(0, 5).join(', ')}${result.missingPhotos.length > 5 ? '…' : ''}` : '';
        store.set({ hint: `Listo: ${result.created} placas, una por página.${miss}` });
        busy = false;
        close();
        openPagesOverview();
        return;
      }
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      busy = false;
      if (document.body.contains(progress)) paint();
    }
  }

  async function generate(): Promise<void> {
    busy = true;
    signal.canceled = false;
    progress.hidden = false;
    paint();
    try {
      const result = await generateAll(
        options.output,
        { dpi: options.dpi, mirror: options.mirror, bleed: options.bleed, cropMarks: false, background: 'white' },
        (p) => {
          progressBar.style.width = `${Math.round((p.done / Math.max(1, p.total)) * 100)}%`;
          status.textContent = p.current ? `Generando ${Math.min(p.done + 1, p.total)} de ${p.total}: ${p.current}` : '';
        },
        signal,
        { ...DEFAULT_SHEET, paper: options.paper, gapMm: options.gapMm, rollWidthMm: options.rollWidthMm, marks: options.marks },
      );
      if (result.canceled && result.written === 0) status.textContent = 'Cancelado.';
      else {
        const miss = result.missingPhotos.length ? ` ⚠ Sin foto (se usó la de ejemplo): ${result.missingPhotos.slice(0, 5).join(', ')}${result.missingPhotos.length > 5 ? '…' : ''}` : '';
        status.textContent = `${result.canceled ? 'Cancelado: ' : 'Listo: '}${result.written} placas${result.where ? ` en ${result.where}` : ''}.${miss}`;
        store.set({ hint: status.textContent });
      }
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      busy = false;
      paint();
    }
  }

  paint();
}

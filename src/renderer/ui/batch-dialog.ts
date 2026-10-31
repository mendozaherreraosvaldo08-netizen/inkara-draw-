import type { MergeData, TrazoDocument } from '../../engine/document';
import { DEFAULT_EXPORT, type ExportOptions } from '../../engine/export';
import { findFinishColumn, matchFinish, norm, type Finish } from '../../engine/finishes';
import { parseDocument } from '../../engine/file-format';
import { applyRow, FIELD_PATTERN, fieldsInDocument, fileNameFor, parseTable } from '../../engine/merge';
import { checkName, isNameColumn } from '../../engine/names';
import { shapeBounds } from '../../engine/shapes';
import { DEFAULT_SHEET, PAPERS, planSheet, type Paper } from '../../engine/sheet';
import type { TemplateInfo } from '../../shared/api';
import { renderPreview } from '../exporter';
import { isListFile, readListFile, type ListTable } from '../list-file';
import { createPlatePages, finishOfRow, generateAll, rowDocument, setMerge, type MergeOutput } from '../merge';
import { openTemplate } from '../session';
import { store } from '../state';
import { isAvailable } from '../fonts';
import { stopTextEditing } from '../text-edit';
import { h } from './dom';

/** Estilo puesto desde código (la política de seguridad no deja estilos en atributos). */
const css = <T extends HTMLElement>(el: T, text: string): T => ((el.style.cssText = text), el);
import { ensureFinishes, openFinishesDialog } from './finishes-dialog';
import { loadOutputSettings, OUTPUTS, STORAGE_KEY, type Saved } from './merge-dialog';
import { categoriesOf, NO_CATEGORY } from './templates-dialog';

/**
 * Placas en serie de un jalón (pantalla completa, "Estudio oscuro"):
 *  1. Lista: se suelta el Excel / CSV (o se pega la tabla).
 *  2. Plantilla: por categoría, con sus acabados.
 *  3. Revisar: de 2 en 2 como se imprimen, en cuadrícula o en lista; cada
 *     placa con su acabado, corrección de datos y aprobación.
 *  4. Imprimir: genera los archivos.
 */

type Step = 1 | 2 | 3 | 4;
type View = 'sheets' | 'grid' | 'list';
type Choice = { kind: 'current' } | { kind: 'template'; name: string };

/** Hijos sin los vacíos (para replaceChildren). */
const kids = (...xs: Array<Node | string | null | undefined | false>): Array<Node | string> => xs.filter((x): x is Node | string => !!x || x === '');

const PREVIEW: ExportOptions = { ...DEFAULT_EXPORT, bleed: false, mirror: false, cropMarks: false, background: 'white' };
const VIEW_KEY = 'inkara.batch.view';

let open = false;

export function openBatch(file?: File): void {
  if (open) {
    if (file) document.dispatchEvent(new CustomEvent('inkara-batch-file', { detail: file }));
    return;
  }
  open = true;
  stopTextEditing();
  store.set({ mergePreview: null });

  // ---- Estado ----
  let step: Step = 1;
  let table: ListTable | null = null;
  let finishColumn: string | null = null;
  let choice: Choice | null = null;
  let templates: TemplateInfo[] = [];
  let category = '';
  let view: View = (() => {
    try {
      const v = localStorage.getItem(VIEW_KEY);
      return v === 'grid' || v === 'list' ? v : 'sheets';
    } catch {
      return 'sheets';
    }
  })();
  let filter = 'all';
  let search = '';
  let selected = 0;
  const approved = new Set<number>();
  const output: Saved = loadOutputSettings();
  let busy = false;
  const signal = { canceled: false };

  // ---- Estructura ----
  const stepsEl = h('div', { class: 'bt-steps' });
  const sub = h('small', {}, '');
  const body = h('div', { class: 'bt-body' });
  const foot = h('div', { class: 'bt-foot' });
  const root = h(
    'div',
    { class: 'bt', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Placas en serie' },
    h('div', { class: 'bt-top' }, h('div', { class: 'bt-brand' }, h('img', { src: './brand/icon-64.png', alt: '' }), h('div', {}, h('b', {}, 'Placas en serie'), sub)), stepsEl, h('div', { class: 'bt-right' }, h('button', { type: 'button', class: 'bt-btn ghost', onclick: () => close() }, 'Cerrar'))),
    body,
    foot,
  );
  document.body.append(root);
  root.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape' && !busy && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) close();
    if (step === 3 && !(e.target instanceof HTMLInputElement) && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
      const list = visible();
      const at = list.indexOf(selected);
      const next = list[Math.max(0, Math.min(list.length - 1, at + (e.key === 'ArrowRight' ? 1 : -1)))];
      if (next !== undefined) select(next);
    }
  });
  const onFile = (e: Event) => void loadFile((e as CustomEvent<File>).detail);
  document.addEventListener('inkara-batch-file', onFile);
  root.tabIndex = -1;
  root.focus();

  function close() {
    if (busy) {
      signal.canceled = true;
      return;
    }
    thumbs.clear();
    root.remove();
    document.removeEventListener('inkara-batch-file', onFile);
    open = false;
  }

  const btn = (label: string, onclick: () => void, cls = '') => h('button', { type: 'button', class: `bt-btn ${cls}`, onclick }, label);

  function paintSteps() {
    const names = ['Lista', 'Plantilla', 'Revisar', 'Imprimir'];
    stepsEl.replaceChildren(
      ...names.flatMap((n, i) => {
        const k = (i + 1) as Step;
        const state = k < step ? 'done' : k === step ? 'now' : '';
        const canGo = k < step && !busy;
        const el = h('button', { type: 'button', class: `bt-st ${state}`, disabled: !canGo, onclick: () => goto(k) }, h('i', {}, k < step ? '✓' : String(k)), n);
        return i === 0 ? [el] : [h('span', { class: 'bt-sep' }), el];
      }),
    );
  }

  function goto(k: Step) {
    step = k;
    paint();
  }

  function paint() {
    paintSteps();
    sub.textContent = [table?.source, choice ? (choice.kind === 'current' ? 'Diseño abierto' : choice.name) : null].filter(Boolean).join(' · ') || 'Arrastra tu lista de Excel para empezar';
    if (step === 1) paintList();
    else if (step === 2) void paintTemplates();
    else if (step === 3) paintReview();
    else paintPrint();
  }

  // =====================================================================
  // 1. Lista
  // =====================================================================
  const fileInput = h('input', { type: 'file', accept: '.xlsx,.csv,.tsv,.txt', hidden: true });
  fileInput.addEventListener('change', () => {
    const f = fileInput.files?.[0];
    if (f) void loadFile(f);
    fileInput.value = '';
  });
  let listError = '';

  async function loadFile(f: File) {
    try {
      setTable(await readListFile(f));
    } catch (error) {
      listError = error instanceof Error ? error.message : String(error);
      step = 1;
      paint();
    }
  }
  function setTable(t: ListTable) {
    table = t;
    listError = '';
    finishColumn = findFinishColumn(t.columns);
    approved.clear();
    thumbs.clear();
    step = 1;
    paint();
  }

  function paintList() {
    const drop = h(
      'div',
      { class: `bt-drop${table ? ' has' : ''}`, tabindex: 0, role: 'button', 'aria-label': 'Elegir la lista de Excel', onclick: () => fileInput.click(), onkeydown: ((e: KeyboardEvent) => (e.key === 'Enter' || e.key === ' ') && fileInput.click()) as EventListener },
      h('div', { class: 'bt-file' }, 'XLSX'),
      h('b', {}, table ? 'Cambiar la lista' : 'Suelta tu lista aquí'),
      h('span', {}, 'Excel (.xlsx) o CSV de Google Sheets (Archivo › Descargar › CSV). También puedes hacer clic para buscarla.'),
    );
    for (const ev of ['dragenter', 'dragover'] as const)
      drop.addEventListener(ev, (e) => {
        e.preventDefault();
        drop.classList.add('over');
      });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      drop.classList.remove('over');
      const f = [...(e.dataTransfer?.files ?? [])][0];
      if (f) void loadFile(f);
    });

    const paste = h('textarea', { class: 'bt-paste', rows: 4, spellcheck: 'false', placeholder: 'O pega aquí la tabla copiada de Excel / Google Sheets (con los títulos en la primera fila)…' });
    paste.addEventListener('paste', () =>
      setTimeout(() => {
        const t = parseTable(paste.value);
        if (t.columns.length && t.rows.length) setTable({ ...t, source: 'Tabla pegada' });
      }, 0),
    );

    const parts: Node[] = [h('div', { class: 'bt-list-left' }, drop, paste, fileInput, listError ? h('p', { class: 'bt-error' }, listError) : null)];
    if (table) {
      const t = table;
      const cols = h(
        'div',
        { class: 'bt-cols' },
        ...t.columns.map((c) => h('span', { class: `bt-col${c === finishColumn ? ' fin' : ''}` }, c, c === finishColumn ? h('em', {}, 'acabado') : null)),
      );
      const finSelect = h('select', { class: 'bt-input', 'aria-label': 'Columna del acabado' }, h('option', { value: '' }, 'Ninguna (todas iguales)'), ...t.columns.map((c) => h('option', { value: c, selected: c === finishColumn }, c)));
      finSelect.addEventListener('change', () => {
        finishColumn = finSelect.value || null;
        paint();
      });
      const shown = t.rows.slice(0, 8);
      parts.push(
        h(
          'div',
          { class: 'bt-list-right' },
          h('div', { class: 'bt-kicker' }, `${t.rows.length} ${t.rows.length === 1 ? 'PLACA' : 'PLACAS'} · ${t.source.toUpperCase()}`),
          cols,
          h('label', { class: 'bt-field inline' }, h('span', {}, '¿Qué columna dice el acabado?'), finSelect),
          h('div', { class: 'bt-tablewrap' }, h('table', { class: 'bt-table' }, h('thead', {}, h('tr', {}, h('th', {}, '#'), ...t.columns.map((c) => h('th', {}, c)))), h('tbody', {}, ...shown.map((r, i) => h('tr', {}, h('td', {}, String(i + 1)), ...r.map((v) => h('td', {}, v))))))),
          t.rows.length > shown.length ? h('div', { class: 'bt-muted' }, `… y ${t.rows.length - shown.length} más`) : null,
        ),
      );
    } else {
      parts.push(
        h(
          'div',
          { class: 'bt-list-right empty' },
          h('div', { class: 'bt-kicker' }, 'ASÍ DEBE VERSE TU LISTA'),
          h('table', { class: 'bt-table' }, h('thead', {}, h('tr', {}, h('th', {}, 'Nombre'), h('th', {}, 'Carrera'), h('th', {}, 'Acabado'))), h('tbody', {}, h('tr', {}, h('td', {}, 'Ana López'), h('td', {}, 'Lic. en Contaduría'), h('td', {}, 'Blanco')), h('tr', {}, h('td', {}, 'Luis Pérez'), h('td', {}, 'Ing. Industrial'), h('td', {}, 'Negro')))),
          h('p', { class: 'bt-muted' }, 'La primera fila son los títulos. En tu plantilla, escribe {{Nombre}}, {{Carrera}}… donde va cada dato. La columna Acabado es opcional.'),
        ),
      );
    }
    body.className = 'bt-body bt-list';
    body.replaceChildren(...parts);
    foot.replaceChildren(h('div', { class: 'bt-stat' }, table ? `${table.rows.length} placas listas para acomodar` : 'Paso 1 de 4'), h('span', { class: 'bt-grow' }), btn('Siguiente: elegir plantilla →', () => goto(2), `p${table ? '' : ' disabled'}`));
    if (!table) (foot.lastElementChild as HTMLButtonElement).disabled = true;
  }

  // =====================================================================
  // 2. Plantilla
  // =====================================================================
  async function paintTemplates() {
    body.className = 'bt-body bt-tpl';
    body.replaceChildren(h('div', { class: 'bt-muted pad' }, 'Cargando plantillas…'));
    templates = (await window.trazo?.templates?.list()) ?? [];
    if (step !== 2) return;
    const cats = categoriesOf(templates);
    if (!category || (!cats.includes(category) && category !== '__current')) category = cats[0] ?? '__current';
    const doc = store.get().document;
    const currentHasFields = fieldsInDocument(doc).text.length > 0 || doc.shapes.length > 0;
    const tabs = h(
      'div',
      { class: 'bt-tabs' },
      ...(currentHasFields ? [h('button', { type: 'button', class: `bt-tab${category === '__current' ? ' on' : ''}`, onclick: () => ((category = '__current'), void paintTemplates()) }, 'Diseño abierto')] : []),
      ...cats.map((c) => h('button', { type: 'button', class: `bt-tab${category === c ? ' on' : ''}`, onclick: () => ((category = c), void paintTemplates()) }, c, h('em', {}, String(templates.filter((t) => (t.category || NO_CATEGORY) === c).length)))),
    );
    const cards: HTMLElement[] = [];
    if (category === '__current') {
      const canvas = h('canvas', { class: 'bt-tthumb' });
      void renderPreview(canvas, doc, PREVIEW, 170, 220).catch(() => undefined);
      cards.push(card(canvas, doc.name, 'Lo que tienes abierto ahora', choice?.kind === 'current', () => ((choice = { kind: 'current' }), paint())));
    } else {
      for (const t of templates.filter((x) => (x.category || NO_CATEGORY) === category)) {
        const img = t.thumbnail ? h('img', { class: 'bt-tthumb', alt: '', src: `data:image/png;base64,${t.thumbnail}` }) : h('div', { class: 'bt-tthumb empty' }, 'Sin vista');
        cards.push(card(img, t.name, new Date(t.modified).toLocaleDateString('es-MX', { day: 'numeric', month: 'short' }), choice?.kind === 'template' && choice.name === t.name, () => ((choice = { kind: 'template', name: t.name }), paint())));
      }
    }
    if (cards.length === 0) cards.push(h('p', { class: 'bt-muted pad' }, templates.length === 0 && !window.trazo ? 'Usa el diseño abierto (la biblioteca de plantillas funciona en la app de escritorio).' : 'No hay plantillas en esta categoría. Guárdalas con Archivo › Guardar como plantilla (o desde un PDF de Corel).'));

    // Campos de la plantilla elegida contra las columnas.
    const info = h('div', { class: 'bt-tinfo' });
    body.replaceChildren(tabs, h('div', { class: 'bt-tgrid' }, ...cards), info);
    await paintTemplateInfo(info);
    foot.replaceChildren(btn('← Lista', () => goto(1)), h('span', { class: 'bt-grow' }), btn('Siguiente: revisar placas →', () => void toReview(), `p${choice ? '' : ' disabled'}`));
    if (!choice) (foot.lastElementChild as HTMLButtonElement).disabled = true;
  }

  function card(thumb: HTMLElement, title: string, meta: string, on: boolean, pick: () => void): HTMLElement {
    return h('button', { type: 'button', class: `bt-tcard${on ? ' on' : ''}`, onclick: pick, ondblclick: () => void toReview() }, h('div', { class: 'bt-tthumbwrap' }, thumb), h('b', {}, title), h('span', {}, meta));
  }

  async function chosenDoc(): Promise<TrazoDocument | null> {
    if (!choice) return null;
    if (choice.kind === 'current') return store.get().document;
    const r = await window.trazo?.templates?.read(choice.name);
    if (!r?.ok) return null;
    try {
      return parseDocument(r.value, choice.name).document;
    } catch {
      return null;
    }
  }

  async function paintTemplateInfo(info: HTMLElement) {
    if (!choice || !table) {
      info.replaceChildren(h('p', { class: 'bt-muted' }, 'Elige una plantilla. Doble clic para seguir.'));
      return;
    }
    const doc = await chosenDoc();
    if (!doc) return;
    const fields = fieldsInDocument(doc).text;
    const has = (f: string) => table!.columns.some((c) => norm(c) === norm(f));
    const finishes = doc.finishes ?? [];
    info.replaceChildren(
      ...kids(
      h('div', { class: 'bt-kicker' }, 'CAMPOS DE LA PLANTILLA'),
      fields.length ? h('div', { class: 'bt-cols' }, ...fields.map((f) => h('span', { class: `bt-col ${has(f) ? 'ok' : 'bad'}` }, has(f) ? '✓ ' : '✕ ', `{{${f}}}`))) : h('p', { class: 'bt-warn' }, 'Esta plantilla no tiene campos {{…}}: todas las placas saldrían iguales. Escribe {{Nombre}} donde va el nombre.'),
      fields.some((f) => !has(f)) ? h('p', { class: 'bt-warn' }, `Tu lista no tiene: ${fields.filter((f) => !has(f)).join(', ')}. Esos textos saldrían tal cual.`) : null,
      css(h('div', { class: 'bt-kicker' }, 'ACABADOS'), 'margin-top:16px'),
      h('div', { class: 'bt-cols' }, ...(finishes.length ? finishes.map((f) => h('span', { class: 'bt-col' }, f.name)) : [h('span', { class: 'bt-muted' }, 'Se crean al seguir: Blanco, Negro y Bronce (los puedes cambiar).')])),
      ),
    );
  }

  async function toReview() {
    if (!choice || !table) return;
    if (choice.kind === 'template') {
      const r = await window.trazo?.templates?.read(choice.name);
      if (!r?.ok) return;
      if (!(await openTemplate(r.value, choice.name))) return;
    }
    // La lista va al diseño (se guarda con él).
    const doc = store.get().document;
    const fileName = doc.merge?.fileName && table.columns.some((c) => doc.merge!.fileName.includes(`{{${c}}}`)) ? doc.merge.fileName : `{{${table.columns[0]}}}`;
    const merge: MergeData = { columns: table.columns, rows: table.rows.map((r) => [...r]), fileName, ...(finishColumn ? { finishColumn } : {}) };
    setMerge(merge);
    await ensureFinishes();
    thumbs.clear();
    approved.clear();
    selected = 0;
    filter = 'all';
    goto(3);
  }

  // =====================================================================
  // 3. Revisar
  // =====================================================================
  const thumbs = new Map<string, string>();
  let thumbQueue: Array<() => Promise<void>> = [];
  let thumbRunning = false;
  const rowKey = (i: number, finish?: Finish | null) => {
    const m = store.get().document.merge!;
    return `${i}|${JSON.stringify(m.rows[i])}|${finish === undefined ? (finishOfRow(store.get().document, i)?.name ?? '') : (finish?.name ?? '-')}`;
  };

  /** Imagen de una placa (en cola, una a la vez para no trabar la interfaz). */
  function thumb(i: number, max: number, finish?: Finish | null): HTMLImageElement {
    const img = h('img', { class: 'bt-pimg loading', alt: '' });
    const key = `${rowKey(i, finish)}|${max}`;
    const done = thumbs.get(key);
    if (done) {
      img.src = done;
      img.classList.remove('loading');
      return img;
    }
    thumbQueue.push(async () => {
      if (!img.isConnected) return;
      const doc = store.get().document;
      if (!doc.merge?.rows[i]) return;
      const r = await rowDocument(doc, i, finish);
      const canvas = document.createElement('canvas');
      await renderPreview(canvas, r.doc, PREVIEW, max, max);
      const url = canvas.toDataURL('image/jpeg', 0.88);
      thumbs.set(key, url);
      img.src = url;
      img.classList.remove('loading');
    });
    void runQueue();
    return img;
  }
  async function runQueue() {
    if (thumbRunning) return;
    thumbRunning = true;
    // Espera a que las miniaturas recién creadas estén en la pantalla.
    await new Promise((r) => setTimeout(r, 0));
    while (thumbQueue.length) {
      const job = thumbQueue.shift()!;
      try {
        await job();
      } catch {
        // una miniatura que falla no detiene las demás
      }
      await new Promise((r) => setTimeout(r, 0));
    }
    thumbRunning = false;
  }

  const doc = () => store.get().document;
  const merge = () => doc().merge!;
  const finishIndex = () => (merge().finishColumn ? merge().columns.indexOf(merge().finishColumn!) : -1);
  const finishValue = (i: number) => (finishIndex() >= 0 ? (merge().rows[i]![finishIndex()] ?? '') : '');

  /** Textos con campos que se salen de la placa (o del margen seguro) en una fila. */
  const overflowCache = new Map<string, string[]>();
  const fitNotes = new Map<string, string[]>();
  /** Lo que la app acomodó sola en esa placa (para avisar, no es un error). */
  function adjusted(i: number): string[] {
    overflows(i);
    return fitNotes.get(`${JSON.stringify(doc().merge!.rows[i])}|${doc().page.widthMm}|${doc().shapes.length}`) ?? [];
  }
  function overflows(i: number): string[] {
    const d = doc();
    const key = `${JSON.stringify(d.merge!.rows[i])}|${d.page.widthMm}|${d.shapes.length}`;
    const hit = overflowCache.get(key);
    if (hit) return hit;
    const filled = applyRow(d, d.merge!.rows[i]!).doc;
    const m = d.page.safeMarginMm;
    const out: string[] = [];
    const notes: string[] = [];
    d.shapes.forEach((s, k) => {
      if (s.kind !== 'text' || !s.text.match(FIELD_PATTERN)) return;
      const f = filled.shapes[k]!;
      const field0 = [...s.text.matchAll(FIELD_PATTERN)][0]?.[1] ?? 'texto';
      if (f.kind === 'text') {
        if (f.text.includes('\n') && !s.text.includes('\n')) notes.push(`“${field0}” se acomodó en 2 líneas.`);
        if (f.fontSizePt < s.fontSizePt - 1e-6) notes.push(`“${field0}” va un poco más chico (${Math.round((f.fontSizePt / s.fontSizePt) * 100)} %).`);
      }
      const b = shapeBounds(f);
      if (b.x < m - 0.5 || b.x + b.width > d.page.widthMm - m + 0.5) {
        const field = [...s.text.matchAll(FIELD_PATTERN)][0]?.[1] ?? 'texto';
        out.push(`“${field}” no cabe ni en 2 líneas al 70 %: acórtalo o usa iniciales.`);
      }
    });
    overflowCache.set(key, out);
    fitNotes.set(key, notes);
    return out;
  }

  /** Lo que hay que revisar en una fila. */
  /** Nombres que parecen mal escritos (acentos, mayúsculas, espacios). */
  function nameFixes(i: number): Array<{ col: number; from: string; fixed: string; reasons: string[] }> {
    const m = merge();
    const out: Array<{ col: number; from: string; fixed: string; reasons: string[] }> = [];
    m.columns.forEach((c, k) => {
      if (!isNameColumn(c)) return;
      const value = m.rows[i]![k] ?? '';
      const r = checkName(value);
      if (r) out.push({ col: k, from: value, fixed: r.fixed, reasons: r.reasons });
    });
    return out;
  }

  function problems(i: number): string[] {
    const out: string[] = [...overflows(i), ...nameFixes(i).map((f) => `¿“${f.from.trim()}” → “${f.fixed}”? (${f.reasons.join(', ')})`)];
    const v = finishValue(i).trim();
    if (finishIndex() >= 0) {
      if (!v) out.push('No dice qué acabado lleva (sale como el diseño).');
      else if (!matchFinish(doc().finishes ?? [], v)) out.push(`El acabado “${v}” no existe en esta plantilla.`);
    }
    const fields = fieldsInDocument(doc()).text;
    for (const f of fields) {
      const c = merge().columns.findIndex((x) => norm(x) === norm(f));
      if (c >= 0 && !(merge().rows[i]![c] ?? '').trim()) out.push(`Falta “${merge().columns[c]}”.`);
    }
    return out;
  }

  function visible(): number[] {
    const rows = merge().rows;
    const q = norm(search);
    return rows
      .map((_, i) => i)
      .filter((i) => {
        if (q && !rows[i]!.some((c) => norm(c).includes(q))) return false;
        if (filter === 'all') return true;
        if (filter === 'review') return problems(i).length > 0;
        return finishOfRow(doc(), i)?.name === filter;
      });
  }

  function select(i: number) {
    selected = i;
    paintReview(true);
  }

  function setCell(i: number, col: number, value: string) {
    const m = merge();
    const rows = m.rows.map((r, k) => (k === i ? r.map((c, j) => (j === col ? value : c)) : r));
    setMerge({ ...m, rows });
    approved.delete(i);
  }

  let gridScroll = 0;
  function paintReview(keepScroll = false) {
    if (!doc().merge) return goto(1);
    thumbQueue = [];
    const m = merge();
    const finishes = doc().finishes ?? [];
    const rows = m.rows;
    const counts = new Map<string, number>();
    rows.forEach((_, i) => {
      const n = finishOfRow(doc(), i)?.name;
      if (n) counts.set(n, (counts.get(n) ?? 0) + 1);
    });
    const toReview = rows.map((_, i) => i).filter((i) => problems(i).length > 0);

    // Barra de herramientas
    const seg = h(
      'div',
      { class: 'bt-seg', role: 'tablist', 'aria-label': 'Vista' },
      ...(
        [
          ['sheets', '▤ Hojas'],
          ['grid', '▦ Cuadrícula'],
          ['list', '☰ Lista'],
        ] as const
      ).map(([v, label]) =>
        h(
          'button',
          {
            type: 'button',
            class: view === v ? 'on' : '',
            onclick: () => {
              view = v;
              try {
                localStorage.setItem(VIEW_KEY, v);
              } catch {
                // no se recuerda
              }
              paintReview();
            },
          },
          label,
        ),
      ),
    );
    const chip = (id: string, label: Array<Node | string>, n: number, cls = '') => h('button', { type: 'button', class: `bt-f${filter === id ? ' on' : ''} ${cls}`, onclick: () => ((filter = filter === id ? 'all' : id), paintReview()) }, ...label, h('em', {}, String(n)));
    const searchInput = h('input', { class: 'bt-search', type: 'search', placeholder: 'Buscar alumno…', value: search, 'aria-label': 'Buscar' });
    searchInput.addEventListener('input', () => {
      search = searchInput.value;
      paintContent();
    });
    const tools = h(
      'div',
      { class: 'bt-tools' },
      seg,
      h('span', { class: 'bt-vr' }),
      chip('all', ['Todas'], rows.length),
      ...finishes.filter((f) => counts.get(f.name)).map((f) => chip(f.name, [swatchEl(f), f.name], counts.get(f.name) ?? 0)),
      toReview.length ? chip('review', ['⚠ Revisar'], toReview.length, 'warn') : null,
      (() => {
        // Fuentes de la plantilla que no están en este equipo: saldrían con otra letra.
        const missing = [...new Set(doc().shapes.flatMap((sh) => (sh.kind === 'text' && !sh.hidden && !isAvailable(sh.fontFamily) ? [sh.fontFamily] : [])))];
        return missing.length ? h('span', { class: 'bt-f warn', title: `Instálalas en Windows o elígelas en Google Fonts antes de imprimir: ${missing.join(', ')}` }, `⚠ Falta la fuente ${missing.slice(0, 2).join(', ')}${missing.length > 2 ? '…' : ''}`) : null;
      })(),
      (() => {
        const all = rows.flatMap((_, i) => nameFixes(i).map((f) => ({ ...f, i })));
        if (all.length === 0) return null;
        return h(
          'button',
          {
            type: 'button',
            class: 'bt-f fix',
            title: all.map((f) => `${f.from} → ${f.fixed}`).join('\n'),
            onclick: () => {
              const m = merge();
              const next = m.rows.map((r) => [...r]);
              for (const f of all) next[f.i]![f.col] = f.fixed;
              setMerge({ ...m, rows: next });
              store.set({ hint: `${all.length} ${all.length === 1 ? 'nombre corregido' : 'nombres corregidos'} (acentos y mayúsculas).` });
              paintReview(true);
            },
          },
          `✓ Corregir ${all.length} ${all.length === 1 ? 'nombre' : 'nombres'}`,
        );
      })(),
      h('span', { class: 'bt-grow' }),
      searchInput,
    );

    const content = h('div', { class: 'bt-content' });
    const side = h('div', { class: 'bt-side' });
    const prevScroll = keepScroll ? (body.querySelector('.bt-content')?.scrollTop ?? gridScroll) : 0;
    body.className = 'bt-body bt-review';
    body.replaceChildren(tools, h('div', { class: 'bt-main' }, content, side));
    paintContent();
    content.scrollTop = prevScroll;
    content.addEventListener('scroll', () => (gridScroll = content.scrollTop));
    paintSide(side);
    paintFoot(toReview.length);

    function paintContent() {
      const list = visible();
      if (!list.includes(selected) && list.length) selected = list[0]!;
      const name = (i: number) => fileNameFor(m, rows[i]!, i);
      const plate = (i: number, size: number) => {
        const p = problems(i);
        return h(
          'button',
          { type: 'button', class: `bt-plate${i === selected ? ' sel' : ''}`, onclick: () => select(i), title: name(i) },
          thumb(i, size),
          h('span', { class: 'bt-num' }, String(i + 1)),
          p.length ? h('span', { class: 'bt-badge' }, '⚠') : approved.has(i) ? h('span', { class: 'bt-badge ok' }, '✓') : null,
        );
      };
      if (list.length === 0) {
        content.replaceChildren(h('p', { class: 'bt-muted pad' }, 'Nada coincide con el filtro o la búsqueda.'));
        return;
      }
      if (view === 'sheets') {
        const sheets: number[][] = [];
        for (let k = 0; k < list.length; k += 2) sheets.push(list.slice(k, k + 2));
        content.className = 'bt-content sheets';
        content.replaceChildren(
          ...sheets.map((pair) => {
            // Número de hoja según el orden de la lista completa.
            const sheetNo = Math.floor(pair[0]! / 2) + 1;
            const warn = pair.some((i) => problems(i).length);
            return h(
              'div',
              { class: `bt-sheet${pair.includes(selected) ? ' sel' : ''}` },
              h('div', { class: 'bt-paper' }, ...pair.map((i) => plate(i, 360))),
              h('div', { class: 'bt-meta' }, h('b', {}, filter === 'all' && !search ? `Hoja ${sheetNo}` : `Placas ${pair.map((i) => i + 1).join(' y ')}`), warn ? h('span', { class: 'wn' }, '⚠ por revisar') : h('span', {}, pair.map((i) => (name(i).split(' ')[0] ?? '')).join(' · '))),
            );
          }),
        );
      } else if (view === 'grid') {
        content.className = 'bt-content grid';
        content.replaceChildren(
          ...list.map((i) => {
            const f = finishOfRow(doc(), i);
            return h('div', { class: 'bt-cell' }, plate(i, 300), h('div', { class: 'bt-cname' }, name(i)), h('div', { class: 'bt-cfin' }, f ? swatchEl(f) : null, f?.name ?? (finishValue(i) || 'Sin acabado')));
          }),
        );
      } else {
        content.className = 'bt-content list';
        content.replaceChildren(
          h(
            'table',
            { class: 'bt-table big' },
            h('thead', {}, h('tr', {}, h('th', {}, '#'), h('th', {}, 'Placa'), ...m.columns.map((c) => h('th', {}, c)), h('th', {}, 'Estado'))),
            h(
              'tbody',
              {},
              ...list.map((i) => {
                const p = problems(i);
                const tr = h('tr', { class: i === selected ? 'sel' : '', onclick: () => select(i) }, h('td', { class: 'mut' }, String(i + 1)), h('td', {}, thumb(i, 120)), ...rows[i]!.map((v) => h('td', {}, v)), h('td', {}, p.length ? h('span', { class: 'wn' }, `⚠ ${p[0]}`) : h('span', { class: 'okc' }, approved.has(i) ? '✓ Aprobada' : '✓ Lista')));
                return tr;
              }),
            ),
          ),
        );
      }
    }
  }

  function swatchEl(f: Finish): HTMLElement {
    const a = f.texture ? doc().assets[f.texture.assetId] : undefined;
    return css(h('i', { class: 'bt-sw' }), a ? `background-image:url(data:${a.mime};base64,${a.data})` : `background:${f.swatch}`);
  }

  function paintSide(side: HTMLElement) {
    const m = merge();
    const i = Math.min(selected, m.rows.length - 1);
    const finishes = doc().finishes ?? [];
    const current = finishOfRow(doc(), i);
    const fields = fieldsInDocument(doc()).text;
    const editable = m.columns.map((c, k) => ({ c, k })).filter(({ c }) => fields.some((f) => norm(f) === norm(c)));
    const p = problems(i);
    const fi = finishIndex();
    side.replaceChildren(
      ...kids(
      h('div', { class: 'bt-kicker' }, `PLACA ${i + 1} DE ${m.rows.length} · HOJA ${Math.floor(i / 2) + 1}`),
      h('div', { class: 'bt-who' }, h('b', {}, fileNameFor(m, m.rows[i]!, i)), h('span', {}, editable.slice(1, 2).map(({ k }) => m.rows[i]![k]).join('') || '')),
      h('div', { class: 'bt-big' }, thumb(i, 520)),
      finishes.length
        ? h(
            'div',
            {},
            h('div', { class: 'bt-kicker' }, 'ACABADO', h('button', { type: 'button', class: 'bt-link', onclick: () => void openFinishesDialog(() => ((thumbs.clear(), paintReview(true)))) }, 'Editar acabados')),
            h(
              'div',
              { class: 'bt-three' },
              ...finishes.slice(0, 6).map((f) =>
                h(
                  'button',
                  {
                    type: 'button',
                    class: `bt-opt${current?.name === f.name ? ' on' : ''}`,
                    title: fi < 0 ? 'Agrega una columna "Acabado" a tu lista para elegirlo por placa' : `Cambiar esta placa a ${f.name}`,
                    onclick: () => {
                      if (fi < 0) {
                        // Sin columna de acabado: se crea una con el valor de esta fila.
                        const cols = [...m.columns, 'Acabado'];
                        setMerge({ ...m, columns: cols, rows: m.rows.map((r, k) => [...r, k === i ? f.name : '']), finishColumn: 'Acabado' });
                      } else setCell(i, fi, f.name);
                      paintReview(true);
                    },
                  },
                  thumb(i, 200, f),
                  h('span', {}, f.name, current?.name === f.name ? ' ✓' : ''),
                ),
              ),
            ),
          )
        : null,
      ...editable.map(({ c, k }) => {
        const input = h('input', { class: 'bt-input', value: m.rows[i]![k] ?? '', 'aria-label': c });
        input.addEventListener('change', () => {
          setCell(i, k, input.value);
          paintReview(true);
        });
        return h('label', { class: 'bt-field' }, h('span', {}, c.toUpperCase()), input);
      }),
      p.length ? h('div', { class: 'bt-note' }, '⚠', h('span', {}, ...p.flatMap((x, k) => (k ? [h('br'), x] : [x])))) : null,
      ...nameFixes(i).map((f) =>
        h(
          'div',
          { class: 'bt-note' },
          '✎',
          h('span', {}, `¿${f.from.trim()} → `, h('b', {}, f.fixed), '?', h('br'), h('small', {}, f.reasons.join(', '))),
          h('button', { type: 'button', class: 'bt-btn small', onclick: () => (setCell(i, f.col, f.fixed), paintReview(true)) }, 'Corregir'),
        ),
      ),
      adjusted(i).length ? h('div', { class: 'bt-note info' }, '✓', h('span', {}, ...adjusted(i).flatMap((x, k) => (k ? [h('br'), x] : [x])))) : null,
      h(
        'div',
        { class: 'bt-acts' },
        btn('‹ Anterior', () => {
          const list = visible();
          const at = list.indexOf(i);
          if (at > 0) select(list[at - 1]!);
        }),
        btn(
          'Aprobar y siguiente ›',
          () => {
            approved.add(i);
            const list = visible();
            const at = list.indexOf(i);
            select(list[Math.min(list.length - 1, at + 1)] ?? i);
          },
          'p',
        ),
      ),
      ),
    );
  }

  function paintFoot(reviewCount: number) {
    const m = merge();
    const outSel = h('select', { class: 'bt-input', 'aria-label': 'Cómo se generan' }, ...OUTPUTS.map((o) => h('option', { value: o.id, selected: o.id === output.output, title: o.hint }, o.label)));
    outSel.addEventListener('change', () => {
      output.output = outSel.value as MergeOutput;
      saveOutput();
      paintFoot(reviewCount);
    });
    const mirror = h('input', { type: 'checkbox', checked: output.mirror });
    mirror.addEventListener('change', () => ((output.mirror = mirror.checked), saveOutput()));
    const dpi = h('select', { class: 'bt-input', 'aria-label': 'Resolución' }, ...[150, 200, 300, 600].map((d) => h('option', { value: d, selected: d === output.dpi }, `${d} ppp`)));
    dpi.addEventListener('change', () => ((output.dpi = Number(dpi.value)), saveOutput()));
    const sheets = Math.ceil(m.rows.length / 2);
    // Acomodo en hoja: papel, separación, marcas y cuántas caben.
    const sheetCtl: Array<Node | null> = [];
    let sheetInfo = '';
    if (output.output === 'pdf-sheet') {
      const paper = h('select', { class: 'bt-input', 'aria-label': 'Papel' }, ...(['carta', 'a4', 'tabloide', 'rollo'] as const).map((id) => h('option', { value: id, selected: id === output.paper }, id === 'rollo' ? 'Rollo' : PAPERS[id].label)));
      paper.addEventListener('change', () => ((output.paper = paper.value as Paper), saveOutput(), paintFoot(reviewCount)));
      const roll = h('select', { class: 'bt-input', 'aria-label': 'Ancho del rollo' }, ...[17, 24, 36, 44, 64].map((inch) => h('option', { value: inch * 25.4, selected: Math.abs(inch * 25.4 - output.rollWidthMm) < 1 }, `${inch}″`)));
      roll.addEventListener('change', () => ((output.rollWidthMm = Number(roll.value)), saveOutput(), paintFoot(reviewCount)));
      const gap = h('select', { class: 'bt-input', 'aria-label': 'Separación entre placas' }, ...[0, 2, 3, 5, 10].map((g) => h('option', { value: g, selected: g === output.gapMm }, g === 0 ? 'Juntas' : `${g} mm`)));
      gap.addEventListener('change', () => ((output.gapMm = Number(gap.value)), saveOutput(), paintFoot(reviewCount)));
      const marks = h('input', { type: 'checkbox', checked: output.marks });
      marks.addEventListener('change', () => ((output.marks = marks.checked), saveOutput()));
      const page = doc().page;
      const extra = output.bleed ? 2 * page.bleedMm : 0;
      const plan = planSheet({ w: page.widthMm + extra, h: page.heightMm + extra }, { ...DEFAULT_SHEET, paper: output.paper, gapMm: output.gapMm, rollWidthMm: output.rollWidthMm }, m.rows.length);
      const n = plan ? Math.ceil(m.rows.length / plan.perSheet) : 0;
      sheetInfo = plan ? `${plan.perSheet} por ${output.paper === 'rollo' ? 'tramo' : 'hoja'} · ${n} ${output.paper === 'rollo' ? (n === 1 ? 'tramo' : 'tramos') : n === 1 ? 'hoja' : 'hojas'}${plan.rotated ? ' · acostadas' : ''}` : '⚠ La placa no cabe en ese papel';
      sheetCtl.push(h('label', { class: 'bt-out' }, paper), output.paper === 'rollo' ? h('label', { class: 'bt-out' }, roll) : null, h('label', { class: 'bt-out' }, gap), h('label', { class: 'bt-out chk', title: 'Marcas de corte en la orilla del papel' }, marks, 'Marcas'));
    }
    foot.replaceChildren(
      h('div', { class: 'bt-stat' }, h('span', {}, h('i', { class: 'dot ok' }), h('b', {}, String(m.rows.length - reviewCount)), ' listas'), reviewCount ? h('span', {}, h('i', { class: 'dot wn' }), h('b', {}, String(reviewCount)), ' por revisar') : null, h('span', { class: sheetInfo.startsWith('⚠') ? 'wn' : '' }, output.output === 'pdf-pairs' ? `${sheets} hojas · 2 por hoja` : output.output === 'pdf-sheet' ? sheetInfo : OUTPUTS.find((o) => o.id === output.output)?.label ?? '')),
      h('span', { class: 'bt-grow' }),
      btn('📦 Material', () => openMaterial(), 'ghost'),
      h('label', { class: 'bt-out' }, h('span', { class: 'bt-out-label' }, 'Salida'), outSel),
      ...sheetCtl.filter((x): x is Node => !!x),
      h('label', { class: 'bt-out' }, dpi),
      h('label', { class: 'bt-out chk' }, mirror, 'Espejo'),
      btn(`Generar ${m.rows.length} ${m.rows.length === 1 ? 'placa' : 'placas'} →`, () => goto(4), 'p'),
    );
  }

  /** Resumen de material del pedido: láminas por acabado y hojas de papel. */
  function materialText(): string {
    const m = merge();
    const page = doc().page;
    const inch = (mm: number) => (mm / 25.4).toFixed(2).replace(/\.?0+$/, '');
    const size = `${inch(page.widthMm)} × ${inch(page.heightMm)}″`;
    const counts = new Map<string, number>();
    m.rows.forEach((_, i) => {
      const n = finishOfRow(doc(), i)?.name ?? (finishValue(i).trim() || 'Sin acabado');
      counts.set(n, (counts.get(n) ?? 0) + 1);
    });
    const lines = [`Pedido: ${table?.source ?? doc().name}`, `Placas: ${m.rows.length} de ${size}`];
    for (const [n, c] of [...counts.entries()].sort((a, b) => b[1] - a[1])) lines.push(`  · ${n}: ${c} ${c === 1 ? 'lámina' : 'láminas'}`);
    const extra = output.bleed ? 2 * page.bleedMm : 0;
    if (output.output === 'pdf-pairs') lines.push(`Papel: ${Math.ceil(m.rows.length / 2)} hojas A4 (2 por hoja)`);
    else if (output.output === 'pdf-sheet') {
      const plan = planSheet({ w: page.widthMm + extra, h: page.heightMm + extra }, { ...DEFAULT_SHEET, paper: output.paper, gapMm: output.gapMm, rollWidthMm: output.rollWidthMm }, m.rows.length);
      if (plan) {
        const n = Math.ceil(m.rows.length / plan.perSheet);
        if (output.paper === 'rollo') {
          const rows = Math.ceil(m.rows.length / plan.cols);
          const length = rows * plan.cell.h + Math.max(0, rows - 1) * output.gapMm + 2 * DEFAULT_SHEET.marginMm;
          lines.push(`Papel: rollo de ${inch(output.rollWidthMm)}″, unos ${(length / 1000).toFixed(2)} m (${plan.cols} por fila)`);
        } else lines.push(`Papel: ${n} ${n === 1 ? 'hoja' : 'hojas'} ${PAPERS[output.paper].label} (${plan.perSheet} por hoja)`);
      }
    } else lines.push(`Papel: ${m.rows.length} ${m.rows.length === 1 ? 'hoja' : 'hojas'} (una por placa)`);
    return lines.join('\n');
  }

  function openMaterial() {
    const text = materialText();
    const pre = h('pre', { class: 'bt-material' }, text);
    const copy = btn('Copiar', () => {
      void navigator.clipboard?.writeText(text).then(() => (copy.textContent = '✓ Copiado'));
    });
    const box = h('div', { class: 'bt-pop', role: 'dialog', 'aria-label': 'Material del pedido' }, h('div', { class: 'bt-kicker' }, 'MATERIAL DEL PEDIDO'), pre, h('div', { class: 'bt-acts' }, copy, btn('Cerrar', () => box.remove(), 'p')));
    root.append(box);
  }

  function saveOutput() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(output));
    } catch {
      // no se recuerda
    }
  }

  // =====================================================================
  // 4. Imprimir
  // =====================================================================
  function paintPrint() {
    const m = merge();
    const bar = h('div', { class: 'bt-progress' }, h('i'));
    const msg = h('p', { class: 'bt-muted' }, 'Preparando…');
    const result = h('div', { class: 'bt-result' });
    body.className = 'bt-body bt-print';
    body.replaceChildren(h('div', { class: 'bt-printbox' }, h('h3', {}, `Generando ${m.rows.length} placas`), h('p', { class: 'bt-muted' }, `${OUTPUTS.find((o) => o.id === output.output)?.label} · ${output.dpi} ppp${output.mirror ? ' · espejo' : ''}`), bar, msg, result));
    const cancel = btn('Cancelar', () => (signal.canceled = true));
    foot.replaceChildren(h('span', { class: 'bt-grow' }), cancel);
    busy = true;
    signal.canceled = false;
    paintSteps();
    const options: ExportOptions = { ...DEFAULT_EXPORT, dpi: output.dpi, mirror: output.mirror, bleed: output.bleed, cropMarks: false, background: 'white' };
    void generateAll(output.output, options, (p) => {
      (bar.firstChild as HTMLElement).style.width = `${(p.done / Math.max(1, p.total)) * 100}%`;
      msg.textContent = p.current ? `${p.done + 1} de ${p.total}: ${p.current}` : '';
    }, signal, { ...DEFAULT_SHEET, paper: output.paper, gapMm: output.gapMm, rollWidthMm: output.rollWidthMm, marks: output.marks })
      .then((r) => {
        busy = false;
        paintSteps();
        if (r.canceled) {
          msg.textContent = 'Cancelado.';
        } else {
          (bar.firstChild as HTMLElement).style.width = '100%';
          msg.textContent = '';
          result.replaceChildren(...kids(h('div', { class: 'bt-done' }, '✓'), h('b', {}, `Listo: ${r.written} ${r.written === 1 ? 'placa' : 'placas'}`), r.where ? h('p', { class: 'bt-muted' }, r.where) : null, r.missingPhotos.length ? h('p', { class: 'bt-warn' }, `Fotos que no se encontraron: ${r.missingPhotos.slice(0, 8).join(', ')}`) : null));
          store.set({ hint: `Placas en serie: ${r.written} generadas.` });
        }
        foot.replaceChildren(
          btn('← Volver a revisar', () => goto(3)),
          btn('Crear una página por placa en el diseño', () => void pagesInDesign(), 'ghost'),
          h('span', { class: 'bt-grow' }),
          btn('Terminar', () => close(), 'p'),
        );
      })
      .catch((error) => {
        busy = false;
        paintSteps();
        msg.textContent = '';
        result.replaceChildren(h('p', { class: 'bt-error' }, `No se pudo terminar: ${error instanceof Error ? error.message : String(error)}`));
        foot.replaceChildren(btn('← Volver a revisar', () => goto(3)), h('span', { class: 'bt-grow' }), btn('Cerrar', () => close()));
      });
  }

  async function pagesInDesign() {
    busy = true;
    try {
      const r = await createPlatePages(() => undefined, { canceled: false });
      store.set({ hint: `${r.created} páginas creadas: cada placa se puede corregir a mano.` });
    } finally {
      busy = false;
    }
    close();
  }

  // Arranque
  if (file) void loadFile(file);
  else if (store.get().document.merge && store.get().document.merge!.rows.length) {
    // Ya hay lista en el diseño: se sigue donde se quedó.
    const m = store.get().document.merge!;
    table = { columns: m.columns, rows: m.rows, source: 'Lista guardada en el diseño' };
    finishColumn = m.finishColumn ?? findFinishColumn(m.columns);
    choice = { kind: 'current' };
    paint();
  } else paint();
}

/** Para "Abrir" desde otros lugares: ¿es una lista? */
export const isBatchFile = isListFile;

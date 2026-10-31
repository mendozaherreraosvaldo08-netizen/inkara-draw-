import { DEFAULT_EXPORT, exportLayout, exportTooLarge, type ExportOptions } from '../../engine/export';
import { preflight, type PreflightIssue } from '../../engine/preflight';
import { exportSvg } from '../../engine/svg-export';
import * as editor from '../editor';
import { encode, encodePdfPages, printable, renderPreview, type ExportFormat } from '../exporter';
import { allPages, pageDocument } from '../../engine/document';
import { fieldsInDocument } from '../../engine/merge';
import { store } from '../state';
import { stopTextEditing } from '../text-edit';
import { h } from './dom';

/**
 * Ventana "Exportar / Imprimir": vista previa exacta de lo que sale (con espejo,
 * sangrado y marcas), opciones, y una revisión previa que avisa de fotos
 * borrosas, textos que se pueden cortar o fondos que no llegan al sangrado.
 * Las opciones se recuerdan para la próxima vez.
 */

type Format = ExportFormat | 'svg';
interface Saved extends ExportOptions {
  format: Format;
}

const STORAGE_KEY = 'trazo.export.v1';
const DPI_CHOICES = [150, 200, 300, 600, 720];
const FORMATS: Array<{ id: Format; label: string; hint: string }> = [
  { id: 'png', label: 'PNG', hint: 'Sin pérdida de calidad. El más recomendado para sublimar.' },
  { id: 'jpg', label: 'JPG', hint: 'Archivo más ligero; pierde un poco de calidad.' },
  { id: 'pdf', label: 'PDF', hint: 'Para la imprenta o el programa de la impresora (RIP). Sin pérdida.' },
  { id: 'svg', label: 'SVG', hint: 'Vectorial: para seguir editando en Corel, Illustrator o Inkscape.' },
];

function loadSaved(): Saved {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<Saved> | null;
    if (raw && typeof raw === 'object') {
      return {
        format: FORMATS.some((f) => f.id === raw.format) ? raw.format! : 'png',
        dpi: typeof raw.dpi === 'number' && raw.dpi >= 72 && raw.dpi <= 2400 ? raw.dpi : DEFAULT_EXPORT.dpi,
        bleed: raw.bleed ?? DEFAULT_EXPORT.bleed,
        mirror: raw.mirror ?? DEFAULT_EXPORT.mirror,
        cropMarks: raw.cropMarks ?? DEFAULT_EXPORT.cropMarks,
        background: raw.background === 'transparent' ? 'transparent' : 'white',
      };
    }
  } catch {
    // Sin almacenamiento: valores por defecto.
  }
  return { format: 'png', ...DEFAULT_EXPORT };
}

function save(options: Saved): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(options));
  } catch {
    // No pasa nada si no se puede recordar.
  }
}

let openDialog: HTMLElement | null = null;

export function openExportDialog(focus: 'export' | 'print' = 'export'): void {
  if (openDialog) return;
  stopTextEditing();
  const doc = store.get().document;
  const options = loadSaved();
  // Para imprimir se usa una imagen: si el último formato fue SVG, se pasa a PNG.
  if (focus === 'print' && options.format === 'svg') options.format = 'png';
  let busy = false;

  // ---- Controles ----
  const preview = h('canvas', { class: 'export-canvas', 'aria-label': 'Vista previa de la impresión' });
  const previewCaption = h('div', { class: 'export-caption' });
  const formatButtons = FORMATS.map((f) =>
    h('button', { type: 'button', class: 'segment', 'aria-pressed': 'false', title: f.hint, onclick: () => update({ format: f.id }) }, f.label),
  );
  const formatHint = h('div', { class: 'export-note' });
  const dpi = h(
    'select',
    { class: 'input', 'aria-label': 'Resolución', onchange: ((e: Event) => update({ dpi: Number((e.target as HTMLSelectElement).value) })) as EventListener },
    ...DPI_CHOICES.map((v) => h('option', { value: v }, `${v} ppp${v === 300 ? ' (recomendado)' : ''}`)),
  );
  const check = (label: string, key: 'bleed' | 'mirror' | 'cropMarks', help: string) => {
    const input = h('input', { type: 'checkbox', onchange: ((e: Event) => update({ [key]: (e.target as HTMLInputElement).checked })) as EventListener });
    return { input, row: h('label', { class: 'check', title: help }, input, h('span', {}, label, h('small', {}, help))) };
  };
  const bleed = check(`Incluir sangrado (${doc.page.bleedMm} mm)`, 'bleed', 'Imprime un poco de más alrededor para que, al cortar, no quede filo blanco.');
  const mirror = check('Espejo (para papel de transferencia)', 'mirror', 'La imagen sale al revés; al planchar sobre la placa queda al derecho.');
  const marks = check('Marcas de corte', 'cropMarks', 'Líneas en las esquinas que indican por dónde cortar.');
  const transparent = h('input', { type: 'checkbox', onchange: ((e: Event) => update({ background: (e.target as HTMLInputElement).checked ? 'transparent' : 'white' })) as EventListener });
  const transparentRow = h('label', { class: 'check' }, transparent, h('span', {}, 'Fondo transparente', h('small', {}, 'Solo PNG: lo que no tiene dibujo queda sin color.')));
  const size = h('div', { class: 'export-size' });
  // Varias páginas: el PDF puede llevarlas todas; los demás formatos, la página que se ve.
  // Una página que aún tiene campos sin llenar ({{Nombre}}…) es la plantilla: no se exporta con las demás.
  const allOfThem = allPages(doc);
  const isTemplate = (i: number) => { const f = fieldsInDocument(pageDocument(doc, i)); return f.text.length > 0; };
  const exportable = allOfThem.map((_, i) => i).filter((i) => !isTemplate(i));
  const pages = allOfThem;
  const skipped = allOfThem.length - exportable.length;
  const allPagesInput = h('input', { type: 'checkbox', checked: true, onchange: () => paint() });
  const allPagesRow = h('label', { class: 'check' }, allPagesInput, h('span', {}, `Todas las páginas (${exportable.length}) en un PDF${skipped ? ' (sin la plantilla)' : ''}`, h('small', {}, 'Una placa por página, cada una a su tamaño real.')));
  const pageNote = h('div', { class: 'export-note' });
  const eachPageInput = h('input', { type: 'checkbox', checked: true, onchange: () => paint() });
  const eachPageRow = h('label', { class: 'check' }, eachPageInput, h('span', {}, `Una imagen por página (${exportable.length})${skipped ? ' (sin la plantilla)' : ''}`, h('small', {}, 'Eliges una carpeta y se guarda cada placa con el nombre de su página.')));
  const issuesBox = h('div', { class: 'preflight', role: 'list', 'aria-label': 'Revisión antes de imprimir' });
  const status = h('div', { class: 'export-status', role: 'status' });

  const cancelButton = h('button', { type: 'button', class: 'button', onclick: () => close() }, 'Cancelar');
  const printButton = h('button', { type: 'button', class: `button${focus === 'print' ? ' primary' : ''}`, onclick: () => void doPrint() }, 'Imprimir…');
  const exportButton = h('button', { type: 'button', class: `button${focus === 'export' ? ' primary' : ''}`, onclick: () => void doExport() }, 'Exportar…');

  const dialog = h(
    'div',
    { class: 'modal export-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'export-title' },
    h('header', { class: 'modal-head' }, h('h2', { id: 'export-title' }, focus === 'print' ? 'Imprimir' : 'Exportar para imprimir'), h('span', { class: 'modal-sub' }, doc.name)),
    h(
      'div',
      { class: 'export-body' },
      h('div', { class: 'export-preview' }, h('div', { class: 'export-canvas-wrap' }, preview), previewCaption),
      h(
        'div',
        { class: 'export-options' },
        h('div', { class: 'field-label' }, 'Formato'),
        h('div', { class: 'segments', role: 'group', 'aria-label': 'Formato' }, ...formatButtons),
        formatHint,
        h('label', { class: 'field-row' }, h('span', { class: 'field-label' }, 'Resolución'), dpi),
        bleed.row,
        mirror.row,
        marks.row,
        transparentRow,
        ...(pages.length > 1 ? [allPagesRow, eachPageRow, pageNote] : []),
        size,
        h('div', { class: 'field-label' }, 'Revisión antes de imprimir'),
        issuesBox,
      ),
    ),
    h('footer', { class: 'modal-foot' }, status, cancelButton, printButton, exportButton),
  );
  const backdrop = h('div', { class: 'modal-backdrop' }, dialog);
  openDialog = backdrop;
  document.body.append(backdrop);

  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && !busy) {
      event.preventDefault();
      close();
    }
    event.stopPropagation(); // los atajos del editor no aplican con la ventana abierta
  };
  backdrop.addEventListener('keydown', onKey);
  backdrop.addEventListener('pointerdown', (event) => {
    if (event.target === backdrop && !busy) close();
  });

  function close(): void {
    backdrop.remove();
    openDialog = null;
  }

  // ---- Revisión previa: clic en un aviso selecciona el objeto ----
  const issues = preflight(doc);
  const icon: Record<PreflightIssue['level'], string> = { error: '✕', warning: '!', info: 'i' };
  issuesBox.replaceChildren(
    ...(issues.length === 0
      ? [h('div', { class: 'issue issue-ok', role: 'listitem' }, h('span', { class: 'issue-icon' }, '✓'), 'Todo bien para imprimir.')]
      : issues.map((issue) =>
          h(
            'button',
            {
              type: 'button',
              class: `issue issue-${issue.level}`,
              role: 'listitem',
              title: issue.shapeId ? 'Clic para seleccionar el objeto y corregirlo' : '',
              onclick: () => {
                if (!issue.shapeId) return;
                close();
                store.set({ tool: 'select' });
                editor.select([issue.shapeId]);
              },
            },
            h('span', { class: 'issue-icon' }, icon[issue.level]),
            issue.message,
          ),
        )),
  );

  // ---- Estado ----
  let previewTimer = 0;
  function update(patch: Partial<Saved>): void {
    Object.assign(options, patch);
    save(options);
    paint();
  }

  function paint(): void {
    const isSvg = options.format === 'svg';
    formatButtons.forEach((b, i) => b.setAttribute('aria-pressed', String(FORMATS[i]!.id === options.format)));
    formatHint.textContent = FORMATS.find((f) => f.id === options.format)!.hint;
    dpi.value = String(options.dpi);
    if (dpi.value !== String(options.dpi)) {
      dpi.append(h('option', { value: options.dpi }, `${options.dpi} ppp`));
      dpi.value = String(options.dpi);
    }
    bleed.input.checked = options.bleed;
    mirror.input.checked = options.mirror && !isSvg;
    marks.input.checked = options.cropMarks && !isSvg;
    transparent.checked = options.background === 'transparent' && options.format === 'png';
    // El SVG es vectorial: sin ppp, espejo ni marcas.
    dpi.disabled = isSvg;
    mirror.input.disabled = isSvg;
    marks.input.disabled = isSvg;
    transparent.disabled = options.format !== 'png';
    allPagesRow.hidden = options.format !== 'pdf';
    eachPageRow.hidden = options.format !== 'png' && options.format !== 'jpg';
    const current = pages[Math.min(pages.length - 1, doc.pageIndex ?? 0)]!.name;
    const covered = (options.format === 'pdf' && allPagesInput.checked) || ((options.format === 'png' || options.format === 'jpg') && eachPageInput.checked);
    pageNote.textContent = covered ? '' : `Se exporta e imprime la página que estás viendo: ${current}.`;
    printButton.disabled = busy;
    exportButton.disabled = busy;

    const effective = effectiveOptions();
    const layout = exportLayout(doc, effective);
    const cm = (mm: number) => (mm / 10).toLocaleString('es-MX', { maximumFractionDigits: 2 });
    const tooLarge = isSvg ? null : exportTooLarge(layout);
    size.className = `export-size${tooLarge ? ' is-error' : ''}`;
    size.textContent = tooLarge ?? `${cm(layout.widthMm)} × ${cm(layout.heightMm)} cm${isSvg ? ' · vectorial' : ` · ${layout.widthPx.toLocaleString('es-MX')} × ${layout.heightPx.toLocaleString('es-MX')} px a ${effective.dpi} ppp`}`;
    previewCaption.textContent = effective.mirror ? 'Así se imprimirá: en espejo, para el papel de transferencia.' : 'Así se imprimirá.';

    window.clearTimeout(previewTimer);
    previewTimer = window.setTimeout(() => void renderPreview(preview, doc, effective, 360, 420), 30);
  }

  /** Las opciones que de verdad aplican al formato elegido. */
  function effectiveOptions(): ExportOptions {
    const isSvg = options.format === 'svg';
    return {
      dpi: options.dpi,
      bleed: options.bleed,
      mirror: options.mirror && !isSvg,
      cropMarks: options.cropMarks && !isSvg,
      background: options.format === 'png' && options.background === 'transparent' ? 'transparent' : 'white',
    };
  }

  function setBusy(value: boolean, text = ''): void {
    busy = value;
    status.textContent = text;
    dialog.classList.toggle('is-busy', value);
    paint();
  }

  const fileName = () => `${doc.name}${options.mirror && options.format !== 'svg' ? ' (espejo)' : ''}`;

  async function doExport(): Promise<void> {
    const files = window.trazo?.files;
    setBusy(true, 'Generando el archivo…');
    try {
      const format = options.format;
      if ((format === 'png' || format === 'jpg') && pages.length > 1 && eachPageInput.checked) {
        await exportEachPage(format);
        return;
      }
      const everyPage = format === 'pdf' && pages.length > 1 && allPagesInput.checked;
      const content =
        format === 'svg'
          ? exportSvg(doc, { withBleed: options.bleed })
          : everyPage
            ? await encodePdfPages(doc.name, exportable.map((i) => pageDocument(doc, i)), effectiveOptions(), (done) => (status.textContent = `Generando página ${Math.min(done + 1, exportable.length)} de ${exportable.length}…`))
            : await encode(format, doc, effectiveOptions());
      if (!files) {
        downloadInBrowser(content, `${fileName()}.${format}`);
        close();
        return;
      }
      setBusy(true, 'Guardando…');
      const result = await files.exportFile({ content, suggestedName: fileName(), extension: format });
      if (result.ok) {
        store.set({ hint: `Exportado: ${result.value}` });
        close();
      } else {
        setBusy(false, result.canceled ? '' : result.error);
      }
    } catch (error) {
      setBusy(false, error instanceof Error ? error.message : String(error));
    }
  }

  /** Una imagen por página, en la carpeta que se elija (nunca pisa archivos: añade "(2)"). */
  async function exportEachPage(format: 'png' | 'jpg'): Promise<void> {
    const files = window.trazo?.files;
    if (!files) {
      setBusy(false, 'Guardar una imagen por página solo funciona en la app de escritorio.');
      return;
    }
    const folder = await files.chooseFolder('Carpeta para guardar las placas');
    if (!folder.ok) {
      setBusy(false, folder.canceled ? '' : folder.error);
      return;
    }
    let written = 0;
    for (const i of exportable) {
      setBusy(true, `Guardando ${written + 1} de ${exportable.length}: ${pages[i]!.name}`);
      const bytes = await encode(format, pageDocument(doc, i), effectiveOptions());
      const safe = pages[i]!.name.replace(/[\\/:*?"<>|]/g, '-').trim() || `Página ${i + 1}`;
      const r = await files.writeToFolder(folder.value.token, `${safe}${options.mirror ? ' (espejo)' : ''}.${format}`, bytes);
      if (!r.ok) {
        setBusy(false, r.error);
        return;
      }
      written++;
    }
    store.set({ hint: `Listo: ${written} imágenes en ${folder.value.path}` });
    close();
  }

  async function doPrint(): Promise<void> {
    const files = window.trazo?.files;
    if (!files) {
      status.textContent = 'Imprimir directo solo funciona en la app de escritorio. Exporta un PNG y ábrelo para imprimir.';
      return;
    }
    setBusy(true, 'Preparando la impresión…');
    try {
      const page = await printable(doc, { ...effectiveOptions(), background: 'white' });
      setBusy(true, 'Elige la impresora. Escala: 100 % (tamaño real).');
      const result = await files.printImage({ ...page, title: fileName() });
      if (result.ok) {
        store.set({ hint: 'Enviado a la impresora' });
        close();
      } else {
        setBusy(false, result.canceled ? '' : result.error);
      }
    } catch (error) {
      setBusy(false, error instanceof Error ? error.message : String(error));
    }
  }

  paint();
  (focus === 'print' ? printButton : exportButton).focus();
}

function downloadInBrowser(content: string | Uint8Array<ArrayBuffer>, name: string): void {
  const url = URL.createObjectURL(new Blob([content]));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

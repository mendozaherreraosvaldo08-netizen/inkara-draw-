import * as editor from '../editor';
import * as session from '../session';
import { openExportDialog } from './export-dialog';
import { stopTextEditing } from '../text-edit';
import { store } from '../state';
import { h, icon, iconButton } from './dom';
import { toggleObjectManager, toggleSnap, toggleTheme } from './menu-bar';

export interface StandardBarActions {
  fitPage(): void;
  setZoom(zoom: number): void;
}

const ZOOM_LEVELS = [0.25, 0.5, 0.75, 1, 2, 4, 8];

/** Barra estándar: archivo, deshacer, importar/exportar, zoom y guías de impresión. */
export function createStandardBar(actions: StandardBarActions): HTMLElement {

  const zoomSelect = h(
    'select',
    {
      class: 'input zoom-select',
      'aria-label': 'Nivel de zoom',
      onchange: ((event: Event) => {
        const value = (event.target as HTMLSelectElement).value;
        if (value === 'fit') actions.fitPage();
        else actions.setZoom(Number(value));
      }) as EventListener,
    },
    h('option', { value: 'current' }, '100 %'),
    h('option', { value: 'fit' }, 'Ajustar a la página'),
    ...ZOOM_LEVELS.map((zoom) => h('option', { value: zoom }, `${Math.round(zoom * 100)} %`)),
  );

  const bleed = iconButton('bleed', 'Mostrar sangrado (3 mm fuera del corte)', () => store.set({ showBleed: !store.get().showBleed }), { class: 'icon-button toggle' });
  const safe = iconButton('safe', 'Mostrar margen seguro (zona para textos y logos)', () => store.set({ showSafeArea: !store.get().showSafeArea }), { class: 'icon-button toggle' });

  const guides = iconButton('guides', 'Mostrar guías (se arrastran desde las reglas)', () => store.set({ showGuides: !store.get().showGuides }), { class: 'icon-button toggle' });
  const magnet = iconButton('magnet', 'Imán: pegar a guías, objetos y página (Alt+Q). Elige a qué en el menú Ver', toggleSnap, { class: 'icon-button toggle' });
  const theme = iconButton('sun', 'Tema claro u oscuro', toggleTheme, { class: 'icon-button' });
  const objects = iconButton('layers', 'Administrador de objetos: ocultar, bloquear, nombrar y ordenar (Ctrl+F7)', toggleObjectManager, { class: 'icon-button toggle' });

  // Si se estaba escribiendo un texto, primero se termina (y queda como un paso).
  const undo = iconButton('undo', 'Deshacer (Ctrl+Z)', () => {
    stopTextEditing();
    editor.undo();
  });
  const redo = iconButton('redo', 'Rehacer (Ctrl+Y)', () => {
    stopTextEditing();
    editor.redo();
  });

  const paint = () => {
    const state = store.get();
    undo.disabled = !state.history.canUndo;
    redo.disabled = !state.history.canRedo;
    undo.title = state.history.undoLabel ? `Deshacer: ${state.history.undoLabel} (Ctrl+Z)` : 'Deshacer (Ctrl+Z)';
    redo.title = state.history.redoLabel ? `Rehacer: ${state.history.redoLabel} (Ctrl+Y)` : 'Rehacer (Ctrl+Y)';
    const current = zoomSelect.querySelector('option[value="current"]');
    if (current) current.textContent = `${Math.round(state.zoom * 100)} %`;
    zoomSelect.value = 'current';
    bleed.setAttribute('aria-pressed', String(state.showBleed));
    safe.setAttribute('aria-pressed', String(state.showSafeArea));
    guides.setAttribute('aria-pressed', String(state.showGuides));
    magnet.setAttribute('aria-pressed', String(state.snap.enabled));
    objects.setAttribute('aria-pressed', String(state.showObjectManager));
    theme.replaceChildren(icon(state.uiTheme === 'light' ? 'moon' : 'sun'));
    theme.title = state.uiTheme === 'light' ? 'Cambiar a tema oscuro' : 'Cambiar a tema claro (blanco)';
  };
  store.subscribe((state, previous) => {
    if (state.history !== previous.history || state.zoom !== previous.zoom || state.showBleed !== previous.showBleed || state.showSafeArea !== previous.showSafeArea || state.showGuides !== previous.showGuides || state.snap !== previous.snap || state.showObjectManager !== previous.showObjectManager || state.uiTheme !== previous.uiTheme) paint();
  });
  paint();

  return h(
    'div',
    { class: 'standard-bar', role: 'toolbar', 'aria-label': 'Barra estándar' },
    iconButton('new', 'Nuevo (Ctrl+N)', () => void session.newDocument()),
    iconButton('open', 'Abrir (Ctrl+O)', () => void session.openDialog()),
    iconButton('save', 'Guardar (Ctrl+S)', () => void session.save()),
    h('span', { class: 'bar-sep' }),
    undo,
    redo,
    h('span', { class: 'bar-sep' }),
    iconButton('import', 'Importar imágenes (Ctrl+I)', () => void session.importDialog()),
    iconButton('export', 'Exportar PNG, JPG, PDF o SVG (Ctrl+E)', () => openExportDialog('export')),
    iconButton('print', 'Imprimir (Ctrl+P)', () => openExportDialog('print')),
    h('span', { class: 'bar-sep' }),
    zoomSelect,
    iconButton('fitPage', 'Ajustar a la página (Mayús+F4)', actions.fitPage),
    h('span', { class: 'bar-sep' }),
    bleed,
    safe,
    guides,
    magnet,
    h('span', { class: 'bar-sep' }),
    objects,
    theme,
  );
}

import { replayIntro } from '../splash';
import * as editor from '../editor';
import * as session from '../session';
import { store } from '../state';
import { stopTextEditing } from '../text-edit';
import { h, icon } from './dom';
import { openExportDialog } from './export-dialog';
import { openMergeDialog } from './merge-dialog';
import { openBatch } from './batch-dialog';
import { openConditionDialog } from './condition-dialog';
import { openReportDialog } from './report-dialog';
import { openElementsLibrary, openSaveElement } from './elements-dialog';
import { openBackgroundDialog } from './background-dialog';
import { openFieldsDialog, openSavePagesDialog, openSplitDialog } from './plate-tools';
import { exportTemplatePack, importTemplatePack } from './templates-dialog';
import { openFinishesDialog } from './finishes-dialog';
import { convertSelectionToCurves } from '../node-edit';
import { intersectSelection, trimSelection, weldSelection } from '../shape-commands';
import { openContourDialog } from './contour-dialog';
import { openColorDialog } from './color-dialog';
import { openTraceDialog } from './trace-dialog';
import { openPagesOverview } from './pages-overview';
import { openSaveTemplate, openTemplatesLibrary } from './templates-dialog';

/**
 * Menús de la barra de título. Clic abre un menú; con uno abierto, pasar el
 * ratón por los demás los cambia (como en Windows). Esc o clic fuera cierra.
 */

interface MenuItem {
  label: string;
  shortcut?: string;
  action?: () => void;
  enabled?: () => boolean;
  /** Opción que se activa y desactiva (se ve con una palomita). */
  checked?: () => boolean;
}
type MenuEntry = MenuItem | 'separator' | { group: string } | (() => Promise<MenuEntry[]>);

const hasSelection = () => store.get().selection.length > 0;
const twoOrMore = () => store.get().selection.length > 1;
export const toggleSnap = (): void => {
  const enabled = !store.get().snap.enabled;
  store.set({ snap: { ...store.get().snap, enabled }, hint: enabled ? 'Imán activado: los objetos se pegan a guías, bordes y centros' : 'Imán desactivado' });
};
/** Tema claro (blanco) u oscuro de la interfaz; se recuerda para la próxima vez. */
export const toggleTheme = (): void => {
  const uiTheme = store.get().uiTheme === 'light' ? 'dark' : 'light';
  try {
    localStorage.setItem('trazo.theme', uiTheme);
  } catch {
    // no se recuerda
  }
  window.trazo?.setTheme?.(uiTheme);
  store.set({ uiTheme, hint: uiTheme === 'light' ? 'Tema claro' : 'Tema oscuro' });
};
export const toggleObjectManager = (): void => store.set({ showObjectManager: !store.get().showObjectManager });
const soon = (what: string): MenuEntry[] => [{ label: `${what}: llega en un paso siguiente`, enabled: () => false }];

/** Archivos recientes (se piden al abrir el menú Archivo). */
async function recentItems(): Promise<MenuEntry[]> {
  const recent = (await window.trazo?.files?.recent().catch(() => [])) ?? [];
  if (recent.length === 0) return [];
  return [{ group: 'Recientes' }, ...recent.map((r) => ({ label: r.name, shortcut: '', action: () => void session.openPath(r.path) })), 'separator'];
}

const MENUS: Array<{ name: string; items: MenuEntry[] }> = [
  {
    name: 'Archivo',
    items: [
      { label: 'Nuevo', shortcut: 'Ctrl+N', action: () => void session.newDocument() },
      { label: 'Abrir…', shortcut: 'Ctrl+O', action: () => void session.openDialog() },
      'separator',
      recentItems,
      { label: 'Guardar', shortcut: 'Ctrl+S', action: () => void session.save() },
      { label: 'Guardar como…', shortcut: 'Ctrl+Mayús+S', action: () => void session.save(true) },
      'separator',
      { label: 'Nuevo desde plantilla…', action: () => void openTemplatesLibrary() },
      { label: 'Guardar como plantilla…', action: () => void openSaveTemplate() },
      { label: 'Guardar páginas como plantillas…', action: () => void openSavePagesDialog(), enabled: () => editor.pageCount() > 1 },
      { label: 'Importar paquete de plantillas…', action: () => void importTemplatePack() },
      { label: 'Exportar paquete de plantillas…', action: () => void exportTemplatePack() },
      'separator',
      { label: 'Importar imágenes…', shortcut: 'Ctrl+I', action: () => void session.importDialog() },
      { label: 'Abrir PDF de CorelDRAW…', action: () => void session.importDialog() },
      { label: 'Exportar (PNG, JPG, PDF, SVG)…', shortcut: 'Ctrl+E', action: () => openExportDialog('export') },
      { label: 'Imprimir…', shortcut: 'Ctrl+P', action: () => openExportDialog('print') },
      'separator',
      { label: 'Placas en serie…', shortcut: 'Ctrl+M', action: () => openBatch() },
      { label: 'Combinar datos (avanzado)…', action: openMergeDialog },
      { label: 'Acabados de la plantilla…', action: () => void openFinishesDialog() },
      'separator',
      { label: 'Salir', shortcut: 'Alt+F4', action: () => window.close() },
    ],
  },
  {
    name: 'Editar',
    items: [
      { label: 'Deshacer', shortcut: 'Ctrl+Z', action: () => (stopTextEditing(), editor.undo()), enabled: () => store.get().history.canUndo },
      { label: 'Rehacer', shortcut: 'Ctrl+Y', action: () => (stopTextEditing(), editor.redo()), enabled: () => store.get().history.canRedo },
      'separator',
      { label: 'Cortar', shortcut: 'Ctrl+X', action: editor.cutSelection, enabled: hasSelection },
      { label: 'Copiar', shortcut: 'Ctrl+C', action: editor.copySelection, enabled: hasSelection },
      { label: 'Pegar', shortcut: 'Ctrl+V', action: editor.paste },
      { label: 'Duplicar', shortcut: 'Ctrl+D', action: editor.duplicateSelection, enabled: hasSelection },
      { label: 'Eliminar', shortcut: 'Supr', action: editor.deleteSelection, enabled: hasSelection },
      'separator',
      { label: 'Seleccionar todo', shortcut: 'Ctrl+A', action: editor.selectAll },
    ],
  },
  {
    name: 'Ver',
    items: [
      { group: 'Interfaz' },
      { label: 'Tema claro (blanco)', checked: () => store.get().uiTheme === 'light', action: toggleTheme },
      'separator',
      { group: 'Mostrar' },
      { label: 'Guías', checked: () => store.get().showGuides, action: () => store.set({ showGuides: !store.get().showGuides }) },
      { label: 'Sangrado (línea roja)', checked: () => store.get().showBleed, action: () => store.set({ showBleed: !store.get().showBleed }) },
      { label: 'Margen seguro (línea azul)', checked: () => store.get().showSafeArea, action: () => store.set({ showSafeArea: !store.get().showSafeArea }) },
      'separator',
      { group: 'Ajustar a (imán)' },
      { label: 'Imán activado', shortcut: 'Alt+Q', checked: () => store.get().snap.enabled, action: toggleSnap },
      { label: 'Guías', checked: () => store.get().snap.guides, action: () => store.set({ snap: { ...store.get().snap, guides: !store.get().snap.guides } }) },
      { label: 'Objetos (bordes y centros)', checked: () => store.get().snap.objects, action: () => store.set({ snap: { ...store.get().snap, objects: !store.get().snap.objects } }) },
      { label: 'Página (bordes, centro y sangrado)', checked: () => store.get().snap.page, action: () => store.set({ snap: { ...store.get().snap, page: !store.get().snap.page } }) },
      'separator',
      { label: 'Borrar todas las guías', action: editor.clearGuides, enabled: () => !!store.get().document.guides?.length },
    ],
  },
  {
    name: 'Diseño',
    items: [
      { label: 'Dividir en placas…', action: openSplitDialog },
      'separator',
      { group: 'Páginas' },
      { label: 'Ver todas las páginas…', action: () => openPagesOverview() },
      { label: 'Insertar página', action: () => editor.addPage() },
      { label: 'Duplicar página', action: () => editor.addPage(editor.pageIndex(), true) },
      { label: 'Eliminar página', action: () => editor.deletePage(), enabled: () => editor.pageCount() > 1 },
      { label: 'Página anterior', shortcut: 'RePág', action: () => editor.goToPage(editor.pageIndex() - 1), enabled: () => editor.pageIndex() > 0 },
      { label: 'Página siguiente', shortcut: 'AvPág', action: () => editor.goToPage(editor.pageIndex() + 1), enabled: () => editor.pageIndex() < editor.pageCount() - 1 },
      'separator',
      { label: 'Mover la selección a la página siguiente', action: () => editor.moveSelectionToPage(editor.pageIndex() + 1), enabled: () => hasSelection() && editor.pageIndex() < editor.pageCount() - 1 },
      { label: 'Mover la selección a la página anterior', action: () => editor.moveSelectionToPage(editor.pageIndex() - 1), enabled: () => hasSelection() && editor.pageIndex() > 0 },
    ],
  },
  {
    name: 'Objeto',
    items: [
      { label: 'Mostrar solo si… (placas en serie)', action: openConditionDialog, enabled: hasSelection },
      { label: 'Guardar como elemento…', action: () => void openSaveElement(), enabled: hasSelection },
      'separator',
      { group: 'Orden' },
      { label: 'Al frente', shortcut: 'Mayús+RePág', action: () => editor.reorder('front'), enabled: hasSelection },
      { label: 'Adelante uno', shortcut: 'Ctrl+RePág', action: () => editor.reorder('forward'), enabled: hasSelection },
      { label: 'Atrás uno', shortcut: 'Ctrl+AvPág', action: () => editor.reorder('backward'), enabled: hasSelection },
      { label: 'Al fondo', shortcut: 'Mayús+AvPág', action: () => editor.reorder('back'), enabled: hasSelection },
      'separator',
      { label: 'Reflejar horizontal', action: () => editor.mirror(true), enabled: hasSelection },
      { label: 'Reflejar vertical', action: () => editor.mirror(false), enabled: hasSelection },
      'separator',
      { label: 'Color de relleno… (CMYK, RGB)', action: () => openColorDialog('fill') },
      { label: 'Color de contorno… (CMYK, RGB)', action: () => openColorDialog('outline') },
      'separator',
      { label: 'Quitar recorte de la foto', action: editor.uncropSelection, enabled: () => editor.selectedShapes().some((s) => s.kind === 'image' && !!s.crop) },
      { label: 'Convertir a curvas (también texto)', shortcut: 'Ctrl+Q', action: () => void convertSelectionToCurves(), enabled: hasSelection },
      'separator',
      { group: 'Agrupar y PowerClip' },
      { label: 'Agrupar', shortcut: 'Ctrl+G', action: editor.groupSelection, enabled: twoOrMore },
      { label: 'Desagrupar', shortcut: 'Ctrl+U', action: editor.ungroupSelection, enabled: () => editor.selectionKind() === 'group' },
      { label: 'PowerClip: meter dentro de la figura de arriba', action: editor.powerClipSelection, enabled: twoOrMore },
      { label: 'Sacar contenido del PowerClip', action: editor.extractContents, enabled: () => editor.selectionKind() === 'powerclip' },
      'separator',
      { group: 'Alinear y distribuir' },
      { label: 'Alinear a la izquierda', shortcut: 'L', action: () => editor.align('left'), enabled: hasSelection },
      { label: 'Alinear a la derecha', shortcut: 'R', action: () => editor.align('right'), enabled: hasSelection },
      { label: 'Alinear arriba', shortcut: 'T', action: () => editor.align('top'), enabled: hasSelection },
      { label: 'Alinear abajo', shortcut: 'B', action: () => editor.align('bottom'), enabled: hasSelection },
      { label: 'Centrar en horizontal', shortcut: 'E', action: () => editor.align('center-x'), enabled: hasSelection },
      { label: 'Centrar en vertical', shortcut: 'C', action: () => editor.align('center-y'), enabled: hasSelection },
      { label: 'Centrar en la página', shortcut: 'P', action: () => editor.align('page-center'), enabled: hasSelection },
      { label: 'Distribuir en horizontal', shortcut: 'Mayús+H', action: () => editor.distribute('x'), enabled: hasSelection },
      { label: 'Distribuir en vertical', shortcut: 'Mayús+V', action: () => editor.distribute('y'), enabled: hasSelection },
      'separator',
      { group: 'Dar forma' },
      { label: 'Soldar', action: () => void weldSelection(), enabled: twoOrMore },
      { label: 'Recortar (el de atrás con los de delante)', action: () => void trimSelection(), enabled: twoOrMore },
      { label: 'Intersectar', action: () => void intersectSelection(), enabled: twoOrMore },
      { label: 'Contorno…', shortcut: 'Ctrl+F9', action: openContourDialog, enabled: hasSelection },
    ],
  },
  {
    name: 'Efectos',
    items: [
      { label: 'Sombra paralela', action: () => editor.setShadow(editor.selectedShapes()[0]?.shadow ?? editor.DEFAULT_SHADOW), enabled: hasSelection },
      { label: 'Quitar sombra', action: () => editor.setShadow(null), enabled: () => editor.selectedShapes().some((s) => s.shadow) },
      'separator',
      { label: 'Transparencia y degradados: botón de relleno en la barra de propiedades', enabled: () => false },
    ],
  },
  {
    name: 'Mapas de bits',
    items: [
      { label: 'Quitar fondo…', action: () => void openBackgroundDialog(), enabled: () => editor.selectedShapes().length === 1 && editor.selectedShapes()[0]!.kind === 'image' },
      { label: 'Vectorizar imagen… (logo a curvas)', action: () => void openTraceDialog(), enabled: () => editor.selectedShapes().length === 1 && editor.selectedShapes()[0]!.kind === 'image' },
      { label: 'Recortar foto', shortcut: 'K', action: () => store.set({ tool: 'crop' }) },
      { label: 'Quitar recorte de la foto', action: editor.uncropSelection, enabled: () => editor.selectedShapes().some((s) => s.kind === 'image' && !!s.crop) },
    ],
  },
  { name: 'Texto', items: [{ label: 'Convertir textos en campos…', action: openFieldsDialog }] },
  { name: 'Tabla', items: soon('Tablas') },
  { name: 'Herramientas', items: soon('Herramientas') },
  {
    name: 'Ventana',
    items: [{ label: 'Biblioteca de elementos…', action: () => void openElementsLibrary() }, { label: 'Administrador de objetos', shortcut: 'Ctrl+F7', checked: () => store.get().showObjectManager, action: toggleObjectManager }],
  },
  { name: 'Ayuda', items: [{ label: 'Reportar un problema…', action: openReportDialog }, { label: 'Ver la animación de inicio', action: replayIntro }, 'separator', { label: 'Inkara Draw 1.8.2 · editor vectorial', enabled: () => false }] },
];

export function createMenuBar(documentName: () => string): HTMLElement & { paintTitle(): void } {
  const title = h('span', { class: 'titlebar-doc' });
  const paintTitle = () => {
    const state = store.get();
    title.textContent = `${state.dirty ? '• ' : ''}${documentName()} — Inkara Draw`;
    title.title = state.filePath ?? 'Aún no se ha guardado';
  };
  paintTitle();
  store.subscribe((state, previous) => {
    if (state.dirty !== previous.dirty || state.document.name !== previous.document.name || state.filePath !== previous.filePath) paintTitle();
  });

  let openIndex: number | null = null;
  let popup: HTMLElement | null = null;
  const buttons = MENUS.map((menu, i) =>
    h('button', { type: 'button', class: 'menu', 'aria-haspopup': 'menu', 'aria-expanded': 'false', onclick: () => (openIndex === i ? close() : open(i)), onpointerenter: () => openIndex !== null && openIndex !== i && open(i) }, menu.name),
  );

  const close = () => {
    popup?.remove();
    popup = null;
    if (openIndex !== null) buttons[openIndex]?.setAttribute('aria-expanded', 'false');
    openIndex = null;
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', onKey, true);
  };
  const outside = (event: Event) => {
    const target = event.target as Node;
    if (popup?.contains(target) || buttons.some((b) => b.contains(target))) return;
    close();
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  };

  const open = (index: number) => {
    close();
    const menu = MENUS[index]!;
    const button = buttons[index]!;
    openIndex = index;
    button.setAttribute('aria-expanded', 'true');
    const list = h('div', { class: 'menu-popup', role: 'menu', 'aria-label': menu.name });
    popup = list;
    const rect = button.getBoundingClientRect();
    list.style.left = `${Math.round(rect.left)}px`;
    list.style.top = `${Math.round(rect.bottom + 2)}px`;
    document.body.append(list);

    const render = (entries: MenuEntry[]): Node[] =>
      entries.flatMap((entry): Node[] => {
        if (entry === 'separator') return [h('div', { class: 'menu-sep', role: 'separator' })];
        if (typeof entry === 'function') {
          // Contenido que se carga al abrir (recientes): se inserta cuando llega.
          const slot = h('div', { class: 'menu-slot' });
          void entry().then((more) => slot.replaceChildren(...render(more)));
          return [slot];
        }
        if ('group' in entry) return [h('div', { class: 'menu-group' }, entry.group)];
        const enabled = entry.enabled ? entry.enabled() : true;
        return [
          h(
            'button',
            {
              type: 'button',
              class: 'menu-item',
              role: entry.checked ? 'menuitemcheckbox' : 'menuitem',
              ...(entry.checked ? { 'aria-checked': String(entry.checked()) } : {}),
              disabled: !enabled || !entry.action,
              onclick: () => {
                close();
                entry.action?.();
              },
            },
            h('span', { class: 'menu-label' }, entry.checked ? h('span', { class: 'menu-check' }, entry.checked() ? icon('check') : null) : null, entry.label),
            h('span', { class: 'menu-shortcut' }, entry.shortcut ?? ''),
          ),
        ];
      });
    list.append(...render(menu.items));
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', onKey, true);
  };

  const bar = h('header', { class: 'titlebar' }, h('span', { class: 'app-mark', 'aria-hidden': 'true' }), h('nav', { class: 'menubar', 'aria-label': 'Menú principal' }, ...buttons), title);
  return Object.assign(bar, { paintTitle });
}

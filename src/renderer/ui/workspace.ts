import { CanvasRenderer, DARK_CANVAS_THEME, LIGHT_CANVAS_THEME } from '../../engine/canvas-renderer';
import { DARK_RULER_THEME, LIGHT_RULER_THEME, Ruler } from '../../engine/rulers';
import { Viewport } from '../../engine/viewport';
import type { EditorOverlay } from '../../engine/canvas-renderer';

const EMPTY: EditorOverlay = { selection: [], selectionBounds: null, mode: 'scale', marquee: null, preview: null, hover: null, caret: null, textSelection: [], editing: null, pathEdit: null };
import * as editor from '../editor';
import { createInteraction } from '../interaction';
import { imageFor, onImageReady } from '../images';
import { displayedDocument, onPreviewReady, previewRow } from '../merge';
import { fileNameFor } from '../../engine/merge';
import { importBrowserFiles, newDocument } from '../session';
import { initTextEditing } from '../text-edit';
import { store } from '../state';
import { allPages } from '../../engine/document';
import { togglePopover } from './popover';
import { openPagesOverview } from './pages-overview';
import { h, icon, iconButton } from './dom';

export interface Workspace {
  element: HTMLElement;
  fitPage(): void;
  setZoom(zoom: number): void;
  /** Esc: cancela el arrastre en curso. Devuelve false si no había ninguno. */
  cancelGesture(): boolean;
  /** Herramienta Recortar: aplica el recorte (Enter). */
  applyCrop(): void;
}

const RULER_SIZE = 20;

/**
 * Área central: pestañas de documento, reglas, lienzo y navegador de páginas.
 * Aquí viven las interacciones de vista: rueda, zoom, desplazamiento.
 *  - Rueda: desplaza (Mayús + rueda: horizontal). Ctrl + rueda: zoom al cursor.
 *  - Barra espaciadora + arrastrar, botón central o herramienta Mano: mover la vista.
 *  - Herramienta Zoom: clic acerca, Mayús + clic aleja.
 */
export function createWorkspace(): Workspace {
  const viewport = new Viewport();
  const canvas = h('canvas', { class: 'canvas', 'aria-label': 'Lienzo de dibujo' });
  const hCanvas = h('canvas', { class: 'ruler ruler-h', 'aria-hidden': 'true' });
  const vCanvas = h('canvas', { class: 'ruler ruler-v', 'aria-hidden': 'true' });

  const interaction = createInteraction(viewport, () => renderer.requestRender());
  // En la vista previa de placas en serie se dibuja la placa de esa fila, no el diseño.
  const renderer = new CanvasRenderer(canvas, viewport, displayedDocument, () => (store.get().mergePreview === null ? interaction.overlay() : EMPTY));
  renderer.resolveImage = (assetId) => imageFor(displayedDocument().assets[assetId]);
  onPreviewReady(() => renderer.requestRender());
  onImageReady(() => renderer.requestRender());
  const unit = () => store.get().document.unit;
  const hRuler = new Ruler(hCanvas, 'horizontal', viewport, unit);
  const vRuler = new Ruler(vCanvas, 'vertical', viewport, unit);

  /** Tema claro u oscuro: lienzo, reglas y la propia ventana. */
  const applyTheme = () => {
    const light = store.get().uiTheme === 'light';
    document.documentElement.dataset.theme = light ? 'light' : 'dark';
    renderer.theme = light ? LIGHT_CANVAS_THEME : DARK_CANVAS_THEME;
    hRuler.theme = vRuler.theme = light ? LIGHT_RULER_THEME : DARK_RULER_THEME;
  };
  applyTheme();

  const redraw = () => {
    renderer.requestRender();
    hRuler.render();
    vRuler.render();
    if (store.get().zoom !== viewport.zoom) store.set({ zoom: viewport.zoom });
  };

  const fitPage = () => {
    const { widthMm, heightMm, bleedMm } = store.get().document.page;
    viewport.fit({ x: -bleedMm, y: -bleedMm, width: widthMm + bleedMm * 2, height: heightMm + bleedMm * 2 });
    redraw();
  };
  const setZoom = (zoom: number) => {
    viewport.setZoom(zoom);
    redraw();
  };

  // ---- Pestañas de documento ----
  const tabTitle = h('span', { class: 'doc-tab-title' });
  const tabs = h(
    'div',
    { class: 'doc-tabs', role: 'tablist', 'aria-label': 'Documentos abiertos' },
    h('div', { class: 'doc-tab', role: 'tab', 'aria-selected': 'true' }, tabTitle, iconButton('close', 'Cerrar documento', undefined, { class: 'icon-button doc-tab-close' })),
    iconButton('plus', 'Nuevo documento (Ctrl+N)', () => void newDocument(), { class: 'icon-button doc-tab-new' }),
  );

  // ---- Navegador de páginas ----
  const pagerCount = h('span', { class: 'pager-count' });
  const pagerTabs = h('div', { class: 'pager-tabs', role: 'tablist', 'aria-label': 'Páginas' });
  const prevPage = iconButton('prev', 'Página anterior (RePág)', () => editor.goToPage(editor.pageIndex() - 1));
  const nextPage = iconButton('next', 'Página siguiente (AvPág)', () => editor.goToPage(editor.pageIndex() + 1));
  const pager = h(
    'div',
    { class: 'pager' },
    prevPage,
    pagerCount,
    nextPage,
    pagerTabs,
    h('button', { type: 'button', class: 'pager-add', title: 'Insertar página después de esta', 'aria-label': 'Insertar página', onclick: () => editor.addPage() }, icon('plus')),
    h('button', { type: 'button', class: 'pager-all', title: 'Ver todas las páginas en miniatura (con sus avisos)', onclick: () => openPagesOverview() }, 'Ver todas'),
  );
  let renamingPage: number | null = null;
  const paintPager = () => {
    const pages = allPages(store.get().document);
    const current = editor.pageIndex();
    pagerCount.textContent = `${current + 1} de ${pages.length}`;
    prevPage.disabled = current === 0;
    nextPage.disabled = current >= pages.length - 1;
    pagerTabs.replaceChildren(
      ...pages.map((page, i) => {
        if (renamingPage === i) {
          const input = h('input', { class: 'input pager-rename', value: page.name, 'aria-label': 'Nombre de la página', maxlength: 100 });
          let done = false;
          const finish = (save: boolean) => {
            if (done) return;
            done = true;
            renamingPage = null;
            if (save) editor.renamePage(i, input.value);
            paintPager();
          };
          input.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Enter') finish(true);
            if (e.key === 'Escape') finish(false);
          });
          input.addEventListener('blur', () => finish(true));
          queueMicrotask(() => (input.focus(), input.select()));
          return input;
        }
        const tab = h(
          'button',
          {
            type: 'button',
            class: 'pager-tab',
            role: 'tab',
            'aria-selected': String(i === current),
            title: `${page.name} · doble clic: cambiar nombre · clic derecho: más opciones`,
            onclick: () => editor.goToPage(i),
            ondblclick: () => {
              renamingPage = i;
              paintPager();
            },
          },
          page.name,
        );
        tab.addEventListener('contextmenu', (event) => {
          event.preventDefault();
          editor.goToPage(i);
          togglePopover(tab, (close) => pageMenu(i, close, () => ((renamingPage = i), paintPager())));
        });
        return tab;
      }),
    );
  };

  // Barra de vista previa de placas en serie (encima del lienzo)
  const previewLabel = h('span', { class: 'merge-bar-label' });
  const previewBar = h(
    'div',
    { class: 'merge-bar', role: 'toolbar', 'aria-label': 'Vista previa de placas en serie', hidden: true },
    iconButton('prev', 'Placa anterior', () => previewRow((store.get().mergePreview ?? 0) - 1)),
    previewLabel,
    iconButton('next', 'Placa siguiente', () => previewRow((store.get().mergePreview ?? 0) + 1)),
    h('button', { type: 'button', class: 'button', onclick: () => previewRow(null) }, 'Volver al diseño'),
  );
  const paintPreview = () => {
    const { mergePreview, document: doc } = store.get();
    previewBar.hidden = mergePreview === null || !doc.merge;
    if (mergePreview !== null && doc.merge) {
      previewLabel.textContent = `${mergePreview + 1} de ${doc.merge.rows.length} · ${fileNameFor(doc.merge, doc.merge.rows[mergePreview] ?? [], mergePreview)}`;
    }
  };
  const stage = h('div', { class: 'stage' }, canvas, previewBar);
  initTextEditing(stage, viewport, () => renderer.requestRender());

  // Soltar archivos del Explorador: imágenes donde se sueltan; un .trz se abre.
  let dragDepth = 0;
  const hasFiles = (event: DragEvent) => !!event.dataTransfer?.types.includes('Files');
  stage.addEventListener('dragenter', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth++;
    stage.classList.add('is-drop-target');
  });
  stage.addEventListener('dragover', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  });
  stage.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) stage.classList.remove('is-drop-target');
  });
  stage.addEventListener('drop', (event) => {
    event.preventDefault();
    dragDepth = 0;
    stage.classList.remove('is-drop-target');
    const files = [...(event.dataTransfer?.files ?? [])];
    if (files.length > 0) void importBrowserFiles(files, viewport.screenToDoc(local(event)));
  });
  const element = h(
    'section',
    { class: 'workspace', 'aria-label': 'Área de trabajo' },
    tabs,
    h('div', { class: 'ruler-grid' }, h('div', { class: 'ruler-corner', title: 'Origen de las reglas' }), hCanvas, vCanvas, stage),
    pager,
  );

  // ---- Tamaño: el lienzo sigue al contenedor (al maximizar, al abrir paneles…) ----
  let firstLayout = true;
  new ResizeObserver(() => {
    const rect = stage.getBoundingClientRect();
    renderer.resize(rect.width, rect.height);
    hRuler.resize(rect.width, RULER_SIZE);
    vRuler.resize(RULER_SIZE, rect.height);
    if (firstLayout && rect.width > 0) {
      firstLayout = false;
      fitPage();
    } else {
      redraw();
    }
  }).observe(stage);

  // ---- Interacciones ----
  const local = (event: MouseEvent) => {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  canvas.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      if (event.ctrlKey) {
        // Ctrl + rueda (y el gesto de pellizco del touchpad): zoom suave al cursor
        viewport.zoomAt(Math.exp(-event.deltaY * 0.0025), local(event));
      } else if (event.shiftKey) {
        viewport.pan(-event.deltaY, 0);
      } else {
        viewport.pan(-event.deltaX, -event.deltaY);
      }
      redraw();
    },
    { passive: false },
  );

  let spaceDown = false;
  let drag: { x: number; y: number } | null = null;
  const panning = () => spaceDown || store.get().tool === 'pan';
  const modifiers = (event: MouseEvent) => ({ shift: event.shiftKey, ctrl: event.ctrlKey || event.metaKey });
  /** Cursor según lo que hay debajo: tiradores, objetos (mover)… */
  const paintDynamicCursor = (event: MouseEvent) => {
    canvas.style.cursor = drag || panning() ? '' : (interaction.cursorAt(local(event)) ?? '');
  };
  const paintCursor = () => {
    const tool = store.get().tool;
    canvas.dataset.cursor = drag ? 'grabbing' : panning() ? 'grab' : tool === 'zoom' ? 'zoom' : tool === 'text' ? 'text' : ['select', 'shape'].includes(tool) ? 'default' : 'crosshair';
  };

  canvas.addEventListener('pointerdown', (event) => {
    // En la vista previa no se edita: un clic vuelve al diseño.
    if (store.get().mergePreview !== null && event.button === 0 && !panning()) {
      previewRow(null);
      store.set({ hint: 'De vuelta al diseño (los campos se ven como {{Nombre}}).' });
      return;
    }
    const middle = event.button === 1;
    if (middle || (event.button === 0 && panning())) {
      event.preventDefault();
      drag = { x: event.clientX, y: event.clientY };
      canvas.setPointerCapture(event.pointerId);
      paintCursor();
      return;
    }
    if (event.button === 0 && store.get().tool === 'eyedropper') {
      pickColor(event);
      return;
    }
    if (event.button === 0 && store.get().tool === 'zoom') {
      viewport.zoomAt(event.shiftKey || event.altKey ? 0.5 : 2, local(event));
      redraw();
      return;
    }
    if (event.button === 0 && interaction.pointerDown(local(event), modifiers(event))) {
      canvas.setPointerCapture(event.pointerId);
      paintDynamicCursor(event);
    }
  });
  canvas.addEventListener('pointermove', (event) => {
    if (drag) {
      viewport.pan(event.clientX - drag.x, event.clientY - drag.y);
      drag = { x: event.clientX, y: event.clientY };
      redraw();
    } else {
      interaction.pointerMove(local(event), modifiers(event));
      paintDynamicCursor(event);
    }
    const point = local(event);
    hRuler.cursor = point.x;
    vRuler.cursor = point.y;
    hRuler.render();
    vRuler.render();
    store.set({ cursorMm: viewport.screenToDoc(point) });
  });
  const endDrag = (event: PointerEvent) => {
    if (interaction.active) {
      interaction.pointerUp(local(event), modifiers(event));
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      paintDynamicCursor(event);
      return;
    }
    if (!drag) return;
    drag = null;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    paintCursor();
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', (event) => {
    if (interaction.active) interaction.cancel();
    endDrag(event);
  });
  canvas.addEventListener('pointerleave', () => {
    hRuler.cursor = null;
    vRuler.cursor = null;
    hRuler.render();
    vRuler.render();
    store.set({ cursorMm: null });
  });
  // Guías: se arrastran desde las reglas (la de arriba da una horizontal; la de la izquierda, una vertical).
  for (const [ruler, axis] of [[hCanvas, 'y'], [vCanvas, 'x']] as const) {
    ruler.title = axis === 'y' ? 'Arrastra hacia abajo para poner una guía horizontal' : 'Arrastra hacia la derecha para poner una guía vertical';
    ruler.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || store.get().mergePreview !== null) return;
      event.preventDefault();
      ruler.setPointerCapture(event.pointerId);
      interaction.startGuide(axis, local(event));
    });
    ruler.addEventListener('pointermove', (event) => {
      if (!ruler.hasPointerCapture(event.pointerId)) return;
      interaction.pointerMove(local(event), modifiers(event));
    });
    const finish = (event: PointerEvent) => {
      if (!ruler.hasPointerCapture(event.pointerId)) return;
      ruler.releasePointerCapture(event.pointerId);
      interaction.pointerUp(local(event), modifiers(event));
    };
    ruler.addEventListener('pointerup', finish);
    ruler.addEventListener('pointercancel', (event) => {
      interaction.cancel();
      finish(event);
    });
  }
  canvas.addEventListener('auxclick', (event) => event.preventDefault());
  // El lienzo no debe quitarle el foco al texto que se está escribiendo.
  canvas.addEventListener('mousedown', (event) => event.preventDefault());
  canvas.addEventListener('dblclick', (event) => {
    if (!panning()) interaction.doubleClick(local(event));
  });

  window.addEventListener('keydown', (event) => {
    if (event.code === 'Space' && !isTyping(event)) {
      event.preventDefault();
      if (!spaceDown) {
        spaceDown = true;
        paintCursor();
      }
    }
  });
  window.addEventListener('keyup', (event) => {
    if (event.code === 'Space') {
      spaceDown = false;
      paintCursor();
    }
  });

  /**
   * Cuentagotas: toma el color del punto del lienzo. Con objetos seleccionados se
   * lo pone como relleno (Mayús: como contorno); sin selección, queda como color
   * para los objetos nuevos.
   */
  const pickColor = (event: PointerEvent) => {
    const p = local(event);
    const dpr = window.devicePixelRatio || 1;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const [r, g, b] = ctx.getImageData(Math.round(p.x * dpr), Math.round(p.y * dpr), 1, 1).data;
    const hex = `#${[r, g, b].map((v) => (v ?? 0).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
    if (store.get().selection.length > 0) {
      if (event.shiftKey) editor.setStroke(hex, hex);
      else editor.setFill(hex, hex);
    } else {
      store.set(event.shiftKey ? { outline: { name: hex, hex } } : { fill: { name: hex, hex }, hint: `Color tomado: ${hex} (para los objetos nuevos)` });
    }
  };

  // ---- Reacciones al estado ----
  const paintTab = () => (tabTitle.textContent = `${store.get().document.name}.${/\.trz$/i.test(store.get().filePath ?? '') ? 'trz' : 'ink'}`);
  store.subscribe((state, previous) => {
    if (state.tool !== previous.tool) {
      paintCursor();
      if (state.cropArea && state.tool !== 'crop') store.set({ cropArea: null });
      renderer.requestRender();
    }
    if (state.cropArea !== previous.cropArea || state.showGuides !== previous.showGuides) renderer.requestRender();
    if (state.uiTheme !== previous.uiTheme) {
      applyTheme();
      redraw();
    }
    if (state.mergePreview !== previous.mergePreview || state.document !== previous.document) paintPreview();
    if (state.document.pages !== previous.document.pages || state.document.pageIndex !== previous.document.pageIndex) paintPager();
    if (state.document !== previous.document) {
      paintTab();
      redraw();
    } else if (state.selection !== previous.selection || state.transformMode !== previous.transformMode || state.editingTextId !== previous.editingTextId || state.mergePreview !== previous.mergePreview) {
      renderer.requestRender();
    }
    if (state.showBleed !== previous.showBleed || state.showSafeArea !== previous.showSafeArea) {
      renderer.overlays = { showBleed: state.showBleed, showSafeArea: state.showSafeArea };
      redraw();
    }
  });
  paintTab();
  paintCursor();
  paintPager();

  return { element, fitPage, setZoom, cancelGesture: () => interaction.cancel(), applyCrop: () => interaction.applyCrop() };
}

/** Menú de una página (clic derecho en su pestaña). */
function pageMenu(index: number, close: () => void, rename: () => void): HTMLElement {
  const count = editor.pageCount();
  const item = (label: string, run: () => void, disabled = false) =>
    h('button', { type: 'button', class: 'pop-item', disabled, onclick: () => (close(), run()) }, h('span', {}, label));
  return h(
    'div',
    { class: 'pop-list' },
    item('Cambiar nombre', rename),
    item('Insertar página después', () => editor.addPage(index)),
    item('Duplicar página', () => editor.addPage(index, true)),
    item('Mover a la izquierda', () => editor.movePage(index, index - 1), index === 0),
    item('Mover a la derecha', () => editor.movePage(index, index + 1), index >= count - 1),
    item('Eliminar página', () => editor.deletePage(index), count <= 1),
  );
}

/** ¿El usuario está escribiendo en un campo? (entonces los atajos no aplican) */
export function isTyping(event: KeyboardEvent): boolean {
  const target = event.target as HTMLElement | null;
  return !!target && (target.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName));
}

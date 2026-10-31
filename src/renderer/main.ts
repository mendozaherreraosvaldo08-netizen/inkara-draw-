import type { AlignMode } from '../engine/arrange';
import * as editor from './editor';
import { initFonts } from './fonts';
import * as session from './session';
import { openExportDialog } from './ui/export-dialog';
import { convertSelectionToCurves } from './node-edit';
import { handlePathKey } from './path-tools';
import { openContourDialog } from './ui/contour-dialog';
import { openBatch } from './ui/batch-dialog';
import { importTemplatePack, seedExampleTemplates } from './ui/templates-dialog';
import { store } from './state';
import { createMenuBar, toggleObjectManager, toggleSnap } from './ui/menu-bar';
import { createPalette } from './ui/palette';
import { createPropertyBar } from './ui/property-bar';
import { createStandardBar } from './ui/standard-bar';
import { createStatusBar } from './ui/status-bar';
import { createToolbox } from './ui/toolbox';
import { ALL_TOOLS } from './ui/tools';
import { createWorkspace, isTyping } from './ui/workspace';
import { createObjectManager } from './ui/object-manager';
import { runSplash } from './splash';
import { installErrorLog } from './error-log';

installErrorLog();
runSplash();

/**
 * Punto de entrada de la interfaz. Distribución (como los editores vectoriales
 * clásicos):
 *   ┌ barra de título con menús ───────────────────────────┐
 *   ├ barra estándar (archivo, zoom, guías) ───────────────┤
 *   ├ barra de propiedades (cambia según la herramienta) ──┤
 *   │ herramientas │      lienzo con reglas      │ paleta  │
 *   └ barra de estado ─────────────────────────────────────┘
 */
const workspace = createWorkspace();
const menuBar = createMenuBar(() => store.get().document.name);

const app = document.getElementById('app');
if (!app) throw new Error('Falta #app en index.html');
app.append(
  menuBar,
  createStandardBar({ fitPage: workspace.fitPage, setZoom: workspace.setZoom }),
  createPropertyBar(workspace.fitPage),
  createToolbox(),
  workspace.element,
  createObjectManager(),
  createPalette(),
  createStatusBar(),
);

const ALIGN_KEYS: Record<string, AlignMode | undefined> = { l: 'left', r: 'right', t: 'top', b: 'bottom', e: 'center-x', c: 'center-y', p: 'page-center' };

/**
 * Atajos de edición (los de siempre en los editores vectoriales). Devuelve true si
 * la tecla se usó.
 */
function editShortcut(event: KeyboardEvent): boolean {
  // Pluma (Enter, Esc, Retroceso) y nodos de la herramienta Forma (Supr, flechas, Ctrl+A) primero.
  if (handlePathKey(event)) return true;
  const ctrl = event.ctrlKey || event.metaKey;
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  if (ctrl && !event.altKey) {
    if (key === 'z' && !event.shiftKey) editor.undo();
    else if (key === 'y' || (key === 'z' && event.shiftKey)) editor.redo();
    else if (key === 'a') editor.selectAll();
    else if (key === 'd') editor.duplicateSelection();
    else if (key === 'c') editor.copySelection();
    else if (key === 'x') editor.cutSelection();
    // Ctrl+V lo atiende el evento "paste" (session.ts): así también pega imágenes copiadas.
    else if (key === 'v') return false;
    else if (key === 'n') void session.newDocument();
    else if (key === 'o') void session.openDialog();
    else if (key === 's') void session.save(event.shiftKey);
    else if (key === 'i') void session.importDialog();
    else if (key === 'e') openExportDialog('export');
    else if (key === 'p') openExportDialog('print');
    else if (key === 'q') void convertSelectionToCurves();
    else if (key === 'g') editor.groupSelection();
    else if (key === 'u') editor.ungroupSelection();
    else if (key === 'F9') openContourDialog();
    else if (key === 'm') openBatch();
    else if (key === 'F7') toggleObjectManager();
    else if (key === 'PageUp') editor.reorder('forward');
    else if (key === 'PageDown') editor.reorder('backward');
    else if (!key.startsWith('Arrow')) return false;
  }
  // Alinear con la herramienta Selección (L R T B E C P), como en los editores vectoriales.
  const align = ALIGN_KEYS[key];
  if (!ctrl && !event.altKey && store.get().tool === 'select' && store.get().selection.length > 0) {
    if (align && !event.shiftKey) {
      editor.align(align);
      return true;
    }
    if (event.shiftKey && (key === 'h' || key === 'v')) {
      editor.distribute(key === 'h' ? 'x' : 'y');
      return true;
    }
  }
  if (!ctrl && event.shiftKey && key === 'PageUp') editor.reorder('front');
  else if (!ctrl && event.shiftKey && key === 'PageDown') editor.reorder('back');
  else if (key === 'Enter' && store.get().cropArea) workspace.applyCrop();
  else if (!ctrl && !event.shiftKey && key === 'PageUp') editor.goToPage(editor.pageIndex() - 1);
  else if (!ctrl && !event.shiftKey && key === 'PageDown') editor.goToPage(editor.pageIndex() + 1);
  else if (key === 'Delete' || key === 'Backspace') editor.deleteSelection();
  else if (key === 'Escape') {
    if (!workspace.cancelGesture()) editor.clearSelection();
  } else if (key.startsWith('Arrow')) {
    // Desplazar: 1 mm; Mayús: 10 mm; Ctrl: 0.1 mm (ajuste fino).
    const step = event.shiftKey ? 10 : ctrl ? 0.1 : 1;
    const dx = key === 'ArrowLeft' ? -step : key === 'ArrowRight' ? step : 0;
    const dy = key === 'ArrowUp' ? -step : key === 'ArrowDown' ? step : 0;
    if (store.get().selection.length === 0) return false;
    editor.nudge(dx, dy);
  } else if (!ctrl) return false;
  return true;
}

// Atajos de teclado globales (edición, herramientas y vista).
window.addEventListener('keydown', (event) => {
  if (isTyping(event)) return;
  if (event.shiftKey && event.key === 'F4') {
    event.preventDefault();
    workspace.fitPage();
    return;
  }
  if (event.altKey && !event.ctrlKey && event.key.toLowerCase() === 'q') {
    event.preventDefault();
    toggleSnap();
    return;
  }
  if (editShortcut(event)) {
    event.preventDefault();
    return;
  }
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  const key = event.key.length === 1 ? event.key.toUpperCase() : event.key;
  const tool = ALL_TOOLS.find((t) => t.shortcut === key);
  if (tool) {
    event.preventDefault();
    store.set({ tool: tool.id, hint: tool.hint });
  }
});

// Archivos: guardar, abrir, autoguardado y recuperación.
session.initSession({ fitPage: workspace.fitPage });
session.onListFile((file) => openBatch(file));
session.onPackFile((file) => void importTemplatePack(file));
void seedExampleTemplates().catch(() => undefined);
// Tema guardado: también para los botones nativos de la ventana.
if (store.get().uiTheme === 'light') window.trazo?.setTheme?.('light');

// Fuentes: las del sistema, las ya descargadas y búsqueda en Google Fonts.
void initFonts();

// Información de la app desde el proceso principal (solo dentro de Electron).
void window.trazo?.getAppInfo().then((info) => {
  document.documentElement.dataset.platform = info.platform;
  console.info(`Inkara Draw ${info.version} · Electron ${info.versions.electron} · Chromium ${info.versions.chrome}`);
});


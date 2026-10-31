import { apply, invert, multiply, translate } from '../engine/matrix';
import { shapeBounds, type TextShape } from '../engine/shapes';
import { caretSegment, createText, indexAtLocalPoint, relayoutText, selectionQuads } from '../engine/text';
import type { Point, Viewport } from '../engine/viewport';
import * as editor from './editor';
import { ensureFont } from './fonts';
import { store } from './state';

/**
 * Escribir y editar texto sobre el lienzo.
 *
 * Las teclas las recibe un <textarea> invisible que va siguiendo al cursor. Así
 * funcionan los acentos y la ñ (teclas muertas del teclado en español), el
 * dictado y los métodos de entrada, pegar con Ctrl+V, seleccionar con Mayús +
 * flechas y deshacer dentro del texto, sin reinventar nada. El lienzo solo dibuja
 * el texto, el cursor y la selección.
 *
 * Toda la edición (crear + escribir + cambiar fuente) es UN paso del historial.
 */

let textarea: HTMLTextAreaElement | null = null;
let viewport: Viewport | null = null;
let render: () => void = () => undefined;
let editingId: string | null = null;
/** Texto en arco: mientras se escribe se ve derecho (con el cursor en su lugar); al terminar vuelve al arco. */
let pausedArc: number | null = null;
let isNew = false;
let caretVisible = true;
let blink = 0;

export function initTextEditing(host: HTMLElement, vp: Viewport, requestRender: () => void): void {
  viewport = vp;
  render = requestRender;
  textarea = document.createElement('textarea');
  textarea.className = 'text-input';
  textarea.setAttribute('aria-label', 'Texto');
  textarea.spellcheck = false;
  textarea.autocomplete = 'off';
  host.append(textarea);

  textarea.addEventListener('input', () => {
    const shape = current();
    if (!shape || !textarea) return;
    replace({ ...shape, text: textarea.value });
    wake();
  });
  textarea.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      stopTextEditing();
      return;
    }
    // Ctrl+Enter también termina (Enter solo hace un salto de línea).
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      stopTextEditing();
      return;
    }
    requestAnimationFrame(wake);
  });
  textarea.addEventListener('keyup', wake);
  textarea.addEventListener('select', wake);
  document.addEventListener('selectionchange', () => {
    if (editingId) wake();
  });
  // Si el foco se va a la barra de propiedades (cambiar fuente, tamaño…) se sigue editando.
  textarea.addEventListener('blur', () => render());

  store.subscribe((state, previous) => {
    if (!editingId) return;
    // Al cambiar de herramienta (salvo a Texto) o si el objeto desaparece (deshacer), se termina.
    if (state.tool !== previous.tool && state.tool !== 'text') stopTextEditing();
    else if (!state.document.shapes.some((s) => s.id === editingId)) finish(false);
  });
}

const current = (): TextShape | null => {
  const shape = store.get().document.shapes.find((s) => s.id === editingId);
  return shape?.kind === 'text' ? shape : null;
};

function replace(next: TextShape): void {
  const shapes = store.get().document.shapes.map((s) => (s.id === next.id ? relayoutText(next) : s));
  editor.live(shapes, [next.id]);
}

/** Reinicia el parpadeo (el cursor se ve fijo mientras se escribe) y repinta. */
function wake(): void {
  caretVisible = true;
  window.clearInterval(blink);
  blink = window.setInterval(() => {
    caretVisible = !caretVisible;
    render();
  }, 530);
  placeTextarea();
  render();
}

/** El cuadro invisible va donde está el cursor: así la ventana de acentos o del IME sale en su sitio. */
function placeTextarea(): void {
  const shape = current();
  if (!shape || !textarea || !viewport) return;
  const caret = caretSegment(shape, textarea.selectionEnd);
  const p = viewport.docToScreen(caret.top);
  textarea.style.left = `${Math.round(p.x)}px`;
  textarea.style.top = `${Math.round(p.y)}px`;
}

export const isEditingText = (): boolean => editingId !== null;
export const editingTextId = (): string | null => editingId;

/** Cambia el texto manteniendo el centro de su caja (al enderezar o volver a curvar un arco). */
function keepCenter(before: TextShape, after: TextShape): TextShape {
  const laid = relayoutText(after);
  const a = shapeBounds(before);
  const b = shapeBounds(laid);
  const dx = a.x + a.width / 2 - (b.x + b.width / 2);
  const dy = a.y + a.height / 2 - (b.y + b.height / 2);
  return { ...laid, transform: multiply(translate(dx, dy), laid.transform) };
}

/**
 * Empieza a escribir un texto nuevo en `point` (mm). Con `frameWidth` es texto
 * de párrafo: las líneas se cortan solas para caber en ese ancho.
 */
export function startNewText(point: Point, frameWidth?: number): void {
  stopTextEditing();
  const state = store.get();
  let shape = createText(point, {
    // Como en los editores vectoriales: el texto nace con relleno negro y sin contorno,
    // salvo que se haya elegido un relleno por defecto en la paleta.
    fill: state.fill?.hex ?? '#000000',
    stroke: null,
    strokeWidth: state.strokeWidth,
    ...state.text,
  });
  if (frameWidth && frameWidth > 0) {
    // Párrafo: el clic marca la esquina de arriba a la izquierda del marco.
    shape = relayoutText({ ...shape, frameWidth, align: state.text.align, transform: [1, 0, 0, 1, point.x, point.y] });
  }
  void ensureFont(shape.fontFamily);
  editor.beginGesture();
  editor.live([...state.document.shapes, shape], [shape.id]);
  begin(shape.id, 0, true);
}

/** Edita un texto existente; `at` es el punto del clic (mm) para poner ahí el cursor. */
export function editText(id: string, at?: Point): void {
  if (editingId === id) {
    if (at) placeCaretAt(at);
    return;
  }
  stopTextEditing();
  const shape = store.get().document.shapes.find((s) => s.id === id);
  if (shape?.kind !== 'text') return;
  editor.select([id]);
  editor.beginGesture();
  let straight = shape;
  if (shape.arc) {
    pausedArc = shape.arc;
    straight = keepCenter(shape, { ...shape, arc: undefined });
    delete straight.arc;
    editor.live(store.get().document.shapes.map((s) => (s.id === id ? straight : s)), [id]);
  }
  begin(id, at && !shape.arc ? indexAt(shape, at) : shape.text.length, false);
}

function begin(id: string, caret: number, created: boolean): void {
  if (!textarea) return;
  editingId = id;
  isNew = created;
  store.set({ editingTextId: id, hint: 'Escribe el texto · Enter: nueva línea · Esc o clic fuera: terminar' });
  textarea.value = current()?.text ?? '';
  textarea.focus({ preventScroll: true });
  textarea.setSelectionRange(caret, caret);
  wake();
}

function indexAt(shape: TextShape, p: Point): number {
  try {
    return indexAtLocalPoint(shape, apply(invert(shape.transform), p));
  } catch {
    return shape.text.length;
  }
}

function placeCaretAt(p: Point): void {
  const shape = current();
  if (!shape || !textarea) return;
  const index = indexAt(shape, p);
  textarea.focus({ preventScroll: true });
  textarea.setSelectionRange(index, index);
  wake();
}

/** Vuelve a poner el foco en el texto (tras usar la barra de propiedades). */
export function refocusText(): void {
  if (editingId && textarea) {
    textarea.focus({ preventScroll: true });
    wake();
  }
}

/** Termina de escribir. Un texto vacío se descarta. */
export function stopTextEditing(): void {
  finish(true);
}

function finish(keep: boolean): void {
  if (!editingId) return;
  let shape = current();
  const created = isNew;
  // Vuelve al arco (dentro del mismo paso del historial).
  if (shape && pausedArc !== null && keep && shape.text.trim() !== '') {
    const curved = keepCenter(shape, { ...shape, arc: pausedArc });
    editor.live(store.get().document.shapes.map((s) => (s.id === curved.id ? curved : s)), store.get().selection);
    shape = curved;
  }
  pausedArc = null;
  editingId = null;
  isNew = false;
  window.clearInterval(blink);
  textarea?.blur();
  if (!keep || !shape || shape.text.trim() === '') {
    // Nada escrito: como si no hubiera pasado nada (sin paso en el historial).
    editor.cancelGesture();
    store.set({ editingTextId: null, hint: 'Listo' });
  } else {
    editor.endGesture(created ? 'Crear texto' : 'Editar texto');
    store.set({ editingTextId: null });
  }
  render();
}

/** Cursor y selección para dibujarlos en el lienzo. */
export function textOverlay(): { caret: { top: Point; bottom: Point } | null; ranges: Point[][]; editing: TextShape | null } {
  const shape = current();
  if (!shape || !textarea) return { caret: null, ranges: [], editing: null };
  const { selectionStart: start, selectionEnd: end } = textarea;
  const focused = document.activeElement === textarea;
  return {
    caret: start === end && caretVisible && focused ? caretSegment(shape, end) : null,
    ranges: selectionQuads(shape, start, end),
    editing: shape,
  };
}

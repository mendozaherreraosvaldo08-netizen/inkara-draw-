import { History } from '../engine/history';
import { allPages, currentPageIndex, withPages, type Guide, type PageData } from '../engine/document';
import { cropImage, uncropImage } from '../engine/crop';
import { rotateAbout, rotationOf, scaleAbout, translate, type Matrix } from '../engine/matrix';
import { centerOf } from '../engine/selection';
import { alignOffsets, distributeOffsets, expandIds, unitsOf, visibleBounds, type AlignMode } from '../engine/arrange';
import { canBeContainer, KIND_LABELS, newShapeId, shapeBounds, transformShape, type Rect, type Shape, type TextAlign, type TextShape } from '../engine/shapes';
import { realignText, relayoutText, visualScale } from '../engine/text';
import { store } from './state';

/**
 * Comandos de edición. Todo cambio al documento pasa por aquí para que quede en
 * el historial: `commit` para cambios de un golpe (borrar, pegar, cambiar color)
 * y `beginGesture` / `live` / `endGesture` para arrastres, que actualizan el
 * lienzo en cada movimiento pero guardan un solo paso al soltar.
 */

interface Snapshot {
  shapes: Shape[];
  selection: string[];
  /** Las guías también se deshacen (como en los editores vectoriales). */
  guides?: Guide[];
  /** Páginas: deshacer vuelve a la página donde se hizo el cambio. */
  pages?: PageData[];
  pageIndex?: number;
}

let history = new History<Snapshot>();
let gesture: Snapshot | null = null;
let clipboard: Shape[] = [];

const snapshot = (): Snapshot => {
  const doc = store.get().document;
  return { shapes: doc.shapes, selection: store.get().selection, guides: doc.guides, pages: doc.pages, pageIndex: doc.pageIndex };
};

function syncHistory(): void {
  store.set({ history: { canUndo: history.canUndo, canRedo: history.canRedo, undoLabel: history.undoLabel, redoLabel: history.redoLabel } });
}

function apply(next: Snapshot, hint?: string): void {
  const state = store.get();
  // Los textos se vuelven a medir con las fuentes de ahora (una pudo descargarse después).
  next = { ...next, shapes: next.shapes.map((s) => (s.kind === 'text' ? relayoutText(s) : s)) };
  // Una selección vacía siempre vuelve a los tiradores de escala.
  const transformMode = next.selection.length === 0 ? 'scale' : state.transformMode;
  const document = { ...state.document, shapes: next.shapes };
  if ('guides' in next) {
    if (next.guides?.length) document.guides = next.guides;
    else delete document.guides;
  }
  if ('pages' in next) {
    if (next.pages?.length) {
      document.pages = next.pages;
      document.pageIndex = next.pageIndex ?? 0;
    } else {
      delete document.pages;
      delete document.pageIndex;
    }
  }
  store.set({ document, selection: next.selection, transformMode, ...(hint ? { hint } : {}) });
}

/** Cambio de un golpe: guarda el estado anterior y aplica el nuevo. */
export function commit(label: string, shapes: Shape[], selection = store.get().selection): void {
  // Dentro de un gesto (p. ej. escribiendo un texto) el cambio forma parte de ese paso.
  if (gesture) {
    live(shapes, selection);
    return;
  }
  history.record(snapshot(), label);
  apply({ shapes, selection: selection.filter((id) => shapes.some((s) => s.id === id)) }, label);
  syncHistory();
}

// ---- Gestos (arrastres) ----

export function beginGesture(): void {
  gesture = snapshot();
}

/** Durante el arrastre: actualiza el lienzo sin tocar el historial. */
export function live(shapes: Shape[], selection = store.get().selection): void {
  apply({ shapes, selection });
}

/** Durante el arrastre de una guía. */
export function liveGuides(guides: Guide[]): void {
  apply({ ...snapshot(), guides });
}

export function endGesture(label: string): void {
  if (!gesture) return;
  const before = gesture;
  gesture = null;
  if (before.shapes === store.get().document.shapes && before.selection === store.get().selection && before.guides === store.get().document.guides) return;
  history.record(before, label);
  store.set({ hint: label });
  syncHistory();
}

/** Cancela el arrastre (Esc) y deja todo como estaba. */
export function cancelGesture(): void {
  if (!gesture) return;
  apply(gesture);
  gesture = null;
}

export const inGesture = (): boolean => gesture !== null;

export function undo(): void {
  if (gesture) cancelGesture();
  const entry = history.undo(snapshot());
  if (!entry) return;
  apply(entry.snapshot, `Deshacer: ${entry.label}`);
  syncHistory();
}

export function redo(): void {
  if (gesture) return;
  const entry = history.redo(snapshot());
  if (!entry) return;
  apply(entry.snapshot, `Rehacer: ${entry.label}`);
  syncHistory();
}

// ---- Selección ----

export function selectedShapes(): Shape[] {
  const ids = new Set(store.get().selection);
  return store.get().document.shapes.filter((s) => ids.has(s.id));
}

/** Caja de la selección (lo que está dentro de un PowerClip no cuenta: no se ve fuera del marco). */
export function selectionBounds(): Rect | null {
  return visibleBounds(selectedShapes());
}

/**
 * Selecciona objetos. Con `exact` = false (lo normal) se eligen grupos y
 * PowerClips completos; con true, solo esos objetos (Ctrl+clic dentro de un grupo).
 */
export function select(ids: string[], exact = false): void {
  if (!exact) ids = [...expandIds(store.get().document.shapes, ids)];
  const state = store.get();
  const same = ids.length === state.selection.length && ids.every((id, i) => id === state.selection[i]);
  if (same) return;
  // Se guarda en orden de apilado, así "copiar" y "duplicar" respetan qué va encima.
  const ordered = state.document.shapes.filter((s) => ids.includes(s.id)).map((s) => s.id);
  store.set({ selection: ordered, transformMode: 'scale', nodeSelection: [], hint: describeSelection(ordered) });
}

/** Ctrl+A: todo lo que se ve y no está bloqueado. */
export const selectAll = (): void => select(store.get().document.shapes.filter((s) => !s.hidden && !s.locked).map((s) => s.id));
export const clearSelection = (): void => select([]);

export function toggleTransformMode(): void {
  const mode = store.get().transformMode === 'scale' ? 'rotate' : 'scale';
  store.set({ transformMode: mode, hint: mode === 'rotate' ? 'Arrastra las flechas de las esquinas para rotar (Ctrl: de 15° en 15°)' : describeSelection(store.get().selection) });
}

export function describeSelection(ids = store.get().selection): string {
  const shapes = store.get().document.shapes.filter((s) => ids.includes(s.id));
  if (shapes.length === 0) return 'Listo';
  const kind = selectionKind(shapes);
  if (kind === 'group') return `Grupo de ${shapes.length} objetos seleccionado`;
  if (kind === 'powerclip') return 'PowerClip seleccionado (contenedor con su contenido)';
  if (shapes.length === 1) return `${KIND_LABELS[shapes[0]!.kind]} seleccionado`;
  return `${shapes.length} objetos seleccionados`;
}

// ---- Comandos sobre la selección ----

/** Aplica `fn` a cada objeto seleccionado y lo guarda como un paso. */
function mapSelected(label: string, fn: (shape: Shape) => Shape): void {
  const ids = new Set(store.get().selection);
  if (ids.size === 0) return;
  commit(label, store.get().document.shapes.map((s) => (ids.has(s.id) ? fn(s) : s)));
}

export function transformSelection(label: string, m: Matrix): void {
  mapSelected(label, (s) => transformShape(s, m));
}

export function deleteSelection(): void {
  const ids = new Set(store.get().selection);
  if (ids.size === 0) return;
  commit(ids.size === 1 ? 'Eliminar objeto' : `Eliminar ${ids.size} objetos`, store.get().document.shapes.filter((s) => !ids.has(s.id)), []);
}

/**
 * Copias con ids nuevos, desplazadas `offset` mm (como Ctrl+D). Los grupos y
 * PowerClips copiados quedan como grupos y PowerClips nuevos (no se mezclan con
 * los originales).
 */
function cloneShapes(shapes: Shape[], offset: number): Shape[] {
  const ids = new Map(shapes.map((s) => [s.id, newShapeId()]));
  const groups = new Map<string, string>();
  const groupOf = (g: string) => groups.get(g) ?? (groups.set(g, `g${newShapeId()}`), groups.get(g)!);
  return shapes.map((s) => {
    const copy: Shape = { ...s, id: ids.get(s.id)! };
    if (s.groupId) copy.groupId = groupOf(s.groupId);
    if (s.clipId) {
      if (ids.has(s.clipId)) copy.clipId = ids.get(s.clipId)!;
      else delete copy.clipId;
    }
    return transformShape(copy, translate(offset, offset));
  });
}

/** Qué es la selección: un grupo, un PowerClip o varios objetos sueltos. */
export function selectionKind(shapes = selectedShapes()): 'group' | 'powerclip' | 'mixed' | 'single' | 'none' {
  if (shapes.length === 0) return 'none';
  const ids = new Set(shapes.map((s) => s.id));
  const top = shapes.filter((s) => !(s.clipId && ids.has(s.clipId)));
  if (top.length === 1) return shapes.length > 1 ? 'powerclip' : 'single';
  const g = top[0]!.groupId;
  if (g && top.every((s) => s.groupId === g)) return 'group';
  return 'mixed';
}

// ---- Agrupar ----

/** Ctrl+G: la selección queda como un grupo (seguida en el orden de apilado, donde estaba la de más arriba). */
export function groupSelection(): void {
  const doc = store.get().document.shapes;
  const ids = new Set(store.get().selection);
  if (unitsOf(doc, selectedShapes()).length < 2) {
    store.set({ hint: 'Selecciona dos o más objetos para agruparlos.' });
    return;
  }
  const groupId = `g${newShapeId()}`;
  const members = doc.filter((s) => ids.has(s.id)).map((s) => (s.clipId && ids.has(s.clipId) ? s : { ...s, groupId }));
  const lastIndex = Math.max(...doc.map((s, i) => (ids.has(s.id) ? i : -1)));
  const before = doc.slice(0, lastIndex + 1).filter((s) => !ids.has(s.id));
  const after = doc.slice(lastIndex + 1);
  commit('Agrupar', [...before, ...members, ...after], [...ids]);
  store.set({ hint: `Agrupados ${ids.size} objetos (Ctrl+U para desagrupar).` });
}

/** Ctrl+U: quita el grupo (los PowerClips siguen como están). */
export function ungroupSelection(): void {
  const ids = new Set(store.get().selection);
  const doc = store.get().document.shapes;
  if (!doc.some((s) => ids.has(s.id) && s.groupId)) {
    store.set({ hint: 'La selección no es un grupo.' });
    return;
  }
  commit('Desagrupar', doc.map((s) => (ids.has(s.id) && s.groupId ? (({ groupId: _g, ...rest }) => rest as Shape)(s) : s)));
}

// ---- PowerClip ----

/**
 * Meter en contenedor: el objeto de más arriba de la selección (una figura
 * cerrada) es el marco; lo demás queda dentro, recortado a su forma.
 */
export function powerClipSelection(): void {
  const doc = store.get().document.shapes;
  const selected = selectedShapes();
  const ids = new Set(selected.map((s) => s.id));
  const top = selected.filter((s) => !(s.clipId && ids.has(s.clipId)));
  const container = [...top].reverse().find((s) => canBeContainer(s));
  if (!container || top.length < 2) {
    store.set({ hint: 'Selecciona la foto (o lo que va dentro) y, encima de ella, una figura cerrada como marco: círculo, rectángulo, curva…' });
    return;
  }
  const contentIds = new Set(top.filter((s) => s.id !== container.id).map((s) => s.id));
  const contents = doc.filter((s) => ids.has(s.id) && s.id !== container.id && !(s.clipId === container.id)).map((s) => (contentIds.has(s.id) ? { ...s, clipId: container.id } : s));
  const rest = doc.filter((s) => !ids.has(s.id) || s.id === container.id);
  const at = rest.findIndex((s) => s.id === container.id);
  // Orden: el contenedor y, justo después, su contenido (se dibuja dentro de él).
  const next = [...rest.slice(0, at), container, ...doc.filter((s) => s.clipId === container.id && !ids.has(s.id)), ...contents, ...rest.slice(at + 1)];
  commit('PowerClip', dedupe(next), [...ids]);
  store.set({ hint: 'Listo: el contenido quedó dentro del marco. Clic: se elige todo junto; Ctrl+clic: solo el contenido. Para sacarlo: Objeto › Sacar contenido del PowerClip.' });
}

/** Saca el contenido de los contenedores seleccionados (queda suelto, en el mismo lugar). */
export function extractContents(): void {
  const ids = new Set(store.get().selection);
  const doc = store.get().document.shapes;
  const freed: string[] = [];
  const next = doc.map((s) => {
    if (s.clipId && ids.has(s.clipId) && ids.has(s.id)) {
      freed.push(s.id);
      return (({ clipId: _c, ...rest }) => rest as Shape)(s);
    }
    return s;
  });
  if (freed.length === 0) {
    store.set({ hint: 'La selección no tiene contenido de PowerClip.' });
    return;
  }
  commit('Extraer contenido', next, freed);
}

function dedupe(list: Shape[]): Shape[] {
  const seen = new Set<string>();
  return list.filter((s) => (seen.has(s.id) ? false : (seen.add(s.id), true)));
}

// ---- Alinear y distribuir ----

export function align(mode: AlignMode): void {
  const doc = store.get().document;
  const units = unitsOf(doc.shapes, selectedShapes());
  if (units.length === 0) return;
  const page = { x: 0, y: 0, width: doc.page.widthMm, height: doc.page.heightMm };
  const offsets = alignOffsets(units, mode, page);
  const moveOf = new Map<string, { dx: number; dy: number }>();
  units.forEach((u, i) => u.ids.forEach((id) => moveOf.set(id, offsets[i]!)));
  const labels: Record<AlignMode, string> = { left: 'Alinear a la izquierda', 'center-x': 'Centrar horizontalmente', right: 'Alinear a la derecha', top: 'Alinear arriba', 'center-y': 'Centrar verticalmente', bottom: 'Alinear abajo', 'page-center': 'Centrar en la página' };
  commit(units.length === 1 && mode !== 'page-center' ? `${labels[mode]} (en la página)` : labels[mode], doc.shapes.map((s) => {
    const m = moveOf.get(s.id);
    return m && (m.dx || m.dy) ? transformShape(s, translate(m.dx, m.dy)) : s;
  }));
}

export function distribute(axis: 'x' | 'y'): void {
  const doc = store.get().document;
  const units = unitsOf(doc.shapes, selectedShapes());
  if (units.length < 3) {
    store.set({ hint: 'Para distribuir hacen falta tres o más objetos.' });
    return;
  }
  const offsets = distributeOffsets(units, axis);
  const moveOf = new Map<string, { dx: number; dy: number }>();
  units.forEach((u, i) => u.ids.forEach((id) => moveOf.set(id, offsets[i]!)));
  commit(axis === 'x' ? 'Distribuir en horizontal' : 'Distribuir en vertical', doc.shapes.map((s) => {
    const m = moveOf.get(s.id);
    return m && (m.dx || m.dy) ? transformShape(s, translate(m.dx, m.dy)) : s;
  }));
}

// ---- Relleno y transparencia ----

export function setGradient(gradient: Shape['gradient'] | null): void {
  mapSelected(gradient ? 'Degradado' : 'Relleno sólido', (s) => {
    const next = { ...s };
    if (gradient) next.gradient = gradient;
    else delete next.gradient;
    return next;
  });
}

export function setOpacity(opacity: number): void {
  mapSelected('Transparencia', (s) => {
    const next = { ...s };
    if (opacity < 1) next.opacity = Math.max(0, opacity);
    else delete next.opacity;
    return next;
  });
}

export function setFade(fade: Shape['fade'] | null): void {
  mapSelected(fade ? 'Desvanecer' : 'Quitar desvanecido', (s) => {
    const next = { ...s };
    if (fade) next.fade = fade;
    else delete next.fade;
    return next;
  });
}

export function duplicateSelection(): void {
  const selected = selectedShapes();
  if (selected.length === 0) return;
  const copies = cloneShapes(selected, 5);
  commit('Duplicar', [...store.get().document.shapes, ...copies], copies.map((s) => s.id));
}

export function copySelection(): void {
  const selected = selectedShapes();
  if (selected.length === 0) return;
  clipboard = selected;
  store.set({ hint: selected.length === 1 ? 'Objeto copiado' : `${selected.length} objetos copiados` });
}

export function cutSelection(): void {
  if (store.get().selection.length === 0) return;
  copySelection();
  deleteSelection();
}

/** Pegar deja la copia en el mismo sitio, encima de todo (como los editores vectoriales). */
export function paste(): void {
  if (clipboard.length === 0) return;
  const copies = cloneShapes(clipboard, 0);
  commit('Pegar', [...store.get().document.shapes, ...copies], copies.map((s) => s.id));
}

export function nudge(dx: number, dy: number): void {
  transformSelection('Mover', translate(dx, dy));
}

export type OrderCommand = 'front' | 'back' | 'forward' | 'backward';
const ORDER_LABELS: Record<OrderCommand, string> = {
  front: 'Al frente de la capa',
  back: 'Al fondo de la capa',
  forward: 'Adelante uno',
  backward: 'Atrás uno',
};

export function reorder(command: OrderCommand): void {
  const shapes = store.get().document.shapes;
  const ids = new Set(store.get().selection);
  if (ids.size === 0) return;
  const selected = shapes.filter((s) => ids.has(s.id));
  const rest = shapes.filter((s) => !ids.has(s.id));
  let next: Shape[];
  if (command === 'front') next = [...rest, ...selected];
  else if (command === 'back') next = [...selected, ...rest];
  else {
    next = [...shapes];
    // Se mueve cada objeto un puesto, sin saltar sobre otro seleccionado.
    const order = command === 'forward' ? [...next.keys()].reverse() : [...next.keys()];
    for (const i of order) {
      const j = command === 'forward' ? i + 1 : i - 1;
      const a = next[i]!;
      const b = next[j];
      if (ids.has(a.id) && b && !ids.has(b.id)) {
        next[i] = b;
        next[j] = a;
      }
    }
  }
  if (next.every((s, i) => s === shapes[i])) return;
  commit(ORDER_LABELS[command], next);
}

export function setFill(hex: string | null, name: string): void {
  // Un color de la paleta reemplaza al degradado (como en los editores vectoriales).
  mapSelected(`Relleno: ${name}`, (s) => {
    const next = { ...s, fill: hex };
    delete next.gradient;
    return next;
  });
}

export function setStroke(hex: string | null, name: string): void {
  mapSelected(`Contorno: ${name}`, (s) => ({ ...s, stroke: hex }));
}

export function setStrokeWidth(mm: number): void {
  // 0 = sin contorno; dar grosor a un objeto sin contorno le pone uno negro.
  mapSelected('Grosor de contorno', (s) => (mm > 0 ? { ...s, strokeWidth: mm, stroke: s.stroke ?? '#000000' } : { ...s, stroke: null }));
}

export function setCornerRadius(mm: number): void {
  mapSelected('Esquinas redondeadas', (s) => (s.kind === 'rectangle' ? { ...s, cornerRadius: Math.max(0, mm) } : s));
}

export function setSides(sides: number): void {
  mapSelected('Lados del polígono', (s) => (s.kind === 'polygon' ? { ...s, sides: Math.min(100, Math.max(3, Math.round(sides))) } : s));
}

/** Mueve la selección para que su centro quede en (x, y) mm. */
export function setCenter(x: number | null, y: number | null): void {
  const box = selectionBounds();
  if (!box) return;
  const c = centerOf(box);
  transformSelection('Posición', translate(x === null ? 0 : x - c.x, y === null ? 0 : y - c.y));
}

/** Cambia el tamaño de la caja de la selección (mm), desde su centro. */
export function setSize(width: number | null, height: number | null, keepRatio: boolean): void {
  const box = selectionBounds();
  if (!box) return;
  let sx = width !== null && box.width > 1e-6 ? width / box.width : 1;
  let sy = height !== null && box.height > 1e-6 ? height / box.height : 1;
  if (keepRatio) {
    if (width !== null) sy = sx;
    else sx = sy;
  }
  if (!(sx > 0 && sy > 0)) return;
  transformSelection('Tamaño', scaleAbout(sx, sy, centerOf(box)));
}

/** Ángulo de la selección (el del objeto si es uno solo). */
export function selectionAngle(): number {
  const selected = selectedShapes();
  return selected.length === 1 ? rotationOf(selected[0]!.transform) : 0;
}

/** Rota la selección hasta `degrees` (uno solo) o `degrees` más (varios), alrededor de su centro. */
export function setAngle(degrees: number): void {
  const box = selectionBounds();
  if (!box) return;
  const delta = degrees - selectionAngle();
  if (Math.abs(delta) < 1e-9) return;
  transformSelection('Rotar', rotateAbout(delta, centerOf(box)));
}

export function mirror(horizontal: boolean): void {
  const box = selectionBounds();
  if (!box) return;
  transformSelection(horizontal ? 'Reflejar horizontal' : 'Reflejar vertical', scaleAbout(horizontal ? -1 : 1, horizontal ? 1 : -1, centerOf(box)));
}

// ---- Texto ----

function mapTexts(label: string, fn: (shape: TextShape) => TextShape): void {
  mapSelected(label, (s) => (s.kind === 'text' ? relayoutText(fn(s)) : s));
}

export function setFontFamily(family: string): void {
  mapTexts(`Fuente: ${family}`, (s) => ({ ...s, fontFamily: family }));
}

/** Tamaño en puntos tal como se ve (si el texto se escaló, se compensa). */
export function setFontSize(pt: number): void {
  if (!(pt > 0)) return;
  mapTexts('Tamaño de letra', (s) => ({ ...s, fontSizePt: pt / visualScale(s) }));
}

export function setTextStyle(patch: { bold?: boolean; italic?: boolean }): void {
  mapTexts(patch.bold !== undefined ? 'Negrita' : 'Cursiva', (s) => ({ ...s, ...patch }));
}

/** Ancho máximo del texto (mm de la página) o null para quitarlo. */
export function setTextMaxWidth(mm: number | null): void {
  mapTexts(mm ? 'Ancho máximo' : 'Quitar ancho máximo', (s) => {
    const next = { ...s };
    if (mm && mm > 0) next.maxWidthMm = mm / visualScale(s);
    else delete next.maxWidthMm;
    return next;
  });
}

/** Placas en serie: la imagen toma la foto de esta columna (o ninguna). */
export function setImageField(column: string | null): void {
  mapSelected(column ? `Foto de ${column}` : 'Quitar foto variable', (s) => {
    if (s.kind !== 'image') return s;
    const next = { ...s };
    if (column) next.field = column;
    else delete next.field;
    return next;
  });
}

export function setTextAlign(align: TextAlign): void {
  mapSelected('Alineación', (s) => (s.kind === 'text' ? realignText(s, align) : s));
}

/** Documento nuevo o abierto: el historial empieza de cero. */
export function resetHistory(): void {
  history = new History<Snapshot>();
  gesture = null;
  syncHistory();
}

// ---- Guías ----

let guideCounter = 0;
const newGuideId = () => `guia-${Date.now().toString(36)}-${(guideCounter++).toString(36)}`;

function commitGuides(label: string, guides: Guide[]): void {
  if (gesture) {
    liveGuides(guides);
    return;
  }
  history.record(snapshot(), label);
  apply({ ...snapshot(), guides }, label);
  syncHistory();
}

export function addGuide(axis: 'x' | 'y', pos: number): Guide {
  const guide = { id: newGuideId(), axis, pos };
  commitGuides(axis === 'x' ? 'Guía vertical' : 'Guía horizontal', [...(store.get().document.guides ?? []), guide]);
  return guide;
}

export function removeGuide(id: string): void {
  const guides = store.get().document.guides ?? [];
  if (!guides.some((g) => g.id === id)) return;
  commitGuides('Quitar guía', guides.filter((g) => g.id !== id));
}

export function clearGuides(): void {
  if (!store.get().document.guides?.length) {
    store.set({ hint: 'No hay guías.' });
    return;
  }
  commitGuides('Borrar todas las guías', []);
}

// ---- Administrador de objetos: ocultar, bloquear, nombrar, ordenar ----

/** Con un grupo o PowerClip, el cambio aplica a todas sus piezas. */
function mapIds(label: string, ids: Iterable<string>, fn: (s: Shape) => Shape, selection = store.get().selection): void {
  const set = new Set(ids);
  const shapes = store.get().document.shapes;
  const next = shapes.map((s) => (set.has(s.id) ? fn(s) : s));
  if (next.every((s, i) => s === shapes[i])) return;
  commit(label, next, selection);
}

export function setHidden(ids: Iterable<string>, hidden: boolean): void {
  const set = new Set(ids);
  mapIds(hidden ? 'Ocultar' : 'Mostrar', set, (s) => {
    const next = { ...s };
    if (hidden) next.hidden = true;
    else delete next.hidden;
    return next;
  }, hidden ? store.get().selection.filter((id) => !set.has(id)) : store.get().selection); // lo oculto deja de estar seleccionado
}

export function setLocked(ids: Iterable<string>, locked: boolean): void {
  const set = new Set(ids);
  mapIds(locked ? 'Bloquear' : 'Desbloquear', set, (s) => {
    const next = { ...s };
    if (locked) next.locked = true;
    else delete next.locked;
    return next;
  }, locked ? store.get().selection.filter((id) => !set.has(id)) : store.get().selection);
  if (locked) store.set({ hint: 'Bloqueado: ya no se puede elegir ni mover desde el lienzo. Desbloquéalo en el administrador de objetos.' });
}

export function renameShape(id: string, name: string): void {
  const clean = name.trim().slice(0, 120);
  mapIds('Cambiar nombre', [id], (s) => {
    const next = { ...s };
    if (clean) next.name = clean;
    else delete next.name;
    return next;
  });
}

/**
 * Arrastrar en el administrador de objetos: `ids` (un objeto, un grupo o un
 * PowerClip) pasa a quedar justo encima o debajo de `targetIds`.
 */
export function moveInStack(ids: Set<string>, targetIds: Set<string>, above: boolean): void {
  const shapes = store.get().document.shapes;
  if ([...targetIds].some((id) => ids.has(id))) return;
  const moving = shapes.filter((s) => ids.has(s.id));
  const rest = shapes.filter((s) => !ids.has(s.id));
  const indexes = rest.map((s, i) => (targetIds.has(s.id) ? i : -1)).filter((i) => i >= 0);
  if (moving.length === 0 || indexes.length === 0) return;
  // La lista se dibuja de arriba (frente) a abajo (fondo): "encima" = después en el orden de apilado.
  const at = above ? Math.max(...indexes) + 1 : Math.min(...indexes);
  const next = [...rest.slice(0, at), ...moving, ...rest.slice(at)];
  if (next.every((s, i) => s === shapes[i])) return;
  commit('Cambiar orden', next, store.get().selection);
}

// ---- Recortar fotos ----

/**
 * Recorta al rectángulo `area` las fotos elegidas o, si no hay ninguna elegida,
 * las fotos que toca el rectángulo. Devuelve cuántas se recortaron.
 */
export function cropToArea(area: Rect): number {
  const shapes = store.get().document.shapes;
  const selected = new Set(store.get().selection);
  const candidates = shapes.filter((s) => s.kind === 'image' && !s.hidden && !s.locked && (selected.size ? selected.has(s.id) : intersects(shapeBounds(s), area)));
  const results = new Map<string, Shape | null>();
  for (const s of candidates) if (s.kind === 'image') results.set(s.id, cropImage(s, area));
  const cropped = [...results.values()].filter(Boolean).length;
  if (cropped === 0) {
    store.set({ hint: selected.size ? 'El recorte no toca la foto elegida.' : 'Dibuja el recorte encima de una foto (solo se recortan fotos e imágenes).' });
    return 0;
  }
  const next = shapes.map((s) => results.get(s.id) ?? s);
  commit('Recortar foto', next, [...results.entries()].filter(([, r]) => r).map(([id]) => id));
  store.set({ hint: cropped === 1 ? 'Foto recortada. Para volver a la foto completa: Quitar recorte.' : `${cropped} fotos recortadas.` });
  return cropped;
}

/** Aplica el recorte elegido con la herramienta Recortar (Enter, doble clic o el botón). */
export function applyCropArea(): void {
  const area = store.get().cropArea;
  if (!area) {
    store.set({ hint: 'Primero arrastra sobre la foto el área que quieres conservar.' });
    return;
  }
  if (cropToArea(area) > 0) store.set({ cropArea: null });
}

export function uncropSelection(): void {
  mapSelected('Quitar recorte', (s) => (s.kind === 'image' && s.crop ? uncropImage(s) : s));
}

const intersects = (a: Rect, b: Rect) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

// ---- Texto en arco y de párrafo ----

/** Cambia un texto manteniendo el centro de su caja en la página. */
function keepTextCenter(before: TextShape, after: TextShape): TextShape {
  const laid = relayoutText(after);
  const a = shapeBounds(before);
  const b = shapeBounds(laid);
  return translateShape(laid, a.x + a.width / 2 - (b.x + b.width / 2), a.y + a.height / 2 - (b.y + b.height / 2));
}

function translateShape<T extends Shape>(shape: T, dx: number, dy: number): T {
  return transformShape(shape, translate(dx, dy)) as T;
}

/** Arco del texto en grados (0 = derecho). El texto de párrafo pasa a texto artístico. */
export function setTextArc(degrees: number): void {
  const value = Math.round(Math.max(-359, Math.min(359, degrees)));
  mapSelected(value ? `Texto en arco: ${value}°` : 'Texto derecho', (s) => {
    if (s.kind !== 'text') return s;
    const next: TextShape = { ...s };
    if (Math.abs(value) >= 1) next.arc = value;
    else delete next.arc;
    delete next.frameWidth;
    return keepTextCenter(s, next);
  });
}

/** Texto de párrafo con este ancho (mm de la página), o null para volverlo artístico. */
export function setParagraphWidth(mm: number | null): void {
  mapSelected(mm ? 'Texto de párrafo' : 'Texto artístico', (s) => {
    if (s.kind !== 'text') return s;
    const next: TextShape = { ...s };
    if (mm && mm > 0) {
      next.frameWidth = Math.max(1, mm / visualScale(s));
      delete next.arc;
      delete next.maxWidthMm;
    } else delete next.frameWidth;
    // El borde izquierdo de la caja no se mueve (como al cambiar el ancho de un marco).
    const laid = relayoutText(next);
    const a = shapeBounds(s);
    const b = shapeBounds(laid);
    return translateShape(laid, a.x - b.x, a.y - b.y);
  });
}

// ---- Páginas ----

let pageCounter = 0;
const newPageId = () => `pag-${Date.now().toString(36)}-${(pageCounter++).toString(36)}`;

/** Cambio de páginas que queda en el historial. */
function commitPages(label: string, pages: PageData[], index: number): void {
  if (gesture) return;
  history.record(snapshot(), label);
  const doc = withPages(store.get().document, pages, index);
  apply({ shapes: doc.shapes, selection: [], guides: doc.guides, pages: doc.pages, pageIndex: doc.pageIndex }, label);
  syncHistory();
}

export const pageCount = (): number => allPages(store.get().document).length;
export const pageIndex = (): number => currentPageIndex(store.get().document);

/** Ir a otra página (no es un cambio del diseño: no va al historial). */
export function goToPage(index: number): void {
  const doc = store.get().document;
  const pages = allPages(doc);
  if (index < 0 || index >= pages.length || index === currentPageIndex(doc) || gesture) return;
  const next = withPages(doc, pages, index);
  store.set({ document: { ...next, shapes: next.shapes.map((s) => (s.kind === 'text' ? relayoutText(s) : s)) }, selection: [], nodeSelection: [], hint: `${pages[index]!.name} (${index + 1} de ${pages.length})` });
}

export function addPage(after = pageIndex(), duplicate = false): void {
  const pages = allPages(store.get().document);
  const source = pages[after]!;
  const page: PageData = {
    id: newPageId(),
    name: duplicate ? `${source.name} (copia)` : `Página ${pages.length + 1}`,
    shapes: duplicate ? cloneShapes(source.shapes, 0) : [],
  };
  const next = [...pages.slice(0, after + 1), page, ...pages.slice(after + 1)];
  // Si la primera página aún no tiene lista, se le da su nombre.
  commitPages(duplicate ? 'Duplicar página' : 'Insertar página', next, after + 1);
}

export function deletePage(index = pageIndex()): void {
  const pages = allPages(store.get().document);
  if (pages.length <= 1) {
    store.set({ hint: 'El diseño necesita al menos una página.' });
    return;
  }
  const next = pages.filter((_, i) => i !== index);
  commitPages(`Eliminar ${pages[index]!.name}`, next, Math.min(index, next.length - 1));
}

export function renamePage(index: number, name: string): void {
  const clean = name.trim().slice(0, 100);
  const pages = allPages(store.get().document);
  if (!clean || !pages[index] || pages[index]!.name === clean) return;
  commitPages('Cambiar nombre de página', pages.map((p, i) => (i === index ? { ...p, name: clean } : p)), pageIndex());
}

export function movePage(from: number, to: number): void {
  const pages = allPages(store.get().document);
  if (from === to || !pages[from] || to < 0 || to >= pages.length) return;
  const next = [...pages];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  const current = pages[pageIndex()]!.id;
  commitPages('Mover página', next, next.findIndex((p) => p.id === current));
}

/** Manda la selección a otra página (se corta de esta y aparece en la misma posición allá). */
export function moveSelectionToPage(index: number): void {
  const doc = store.get().document;
  const pages = allPages(doc);
  const from = currentPageIndex(doc);
  const ids = new Set(store.get().selection);
  if (ids.size === 0 || index === from || !pages[index]) return;
  const moving = doc.shapes.filter((s) => ids.has(s.id));
  const next = pages.map((p, i) => (i === from ? { ...p, shapes: p.shapes.filter((s) => !ids.has(s.id)) } : i === index ? { ...p, shapes: [...p.shapes, ...cloneShapes(moving, 0)] } : p));
  commitPages(`Mover a ${pages[index]!.name}`, next, from);
}

// ---- Sombra ----

export const DEFAULT_SHADOW = { dx: 1.2, dy: 1.2, blur: 1.5, color: '#000000', opacity: 0.55 };

/** Sombra paralela de lo seleccionado (null = quitarla). */
export function setShadow(shadow: Shape['shadow'] | null): void {
  mapSelected(shadow ? 'Sombra' : 'Quitar sombra', (s) => {
    const next = { ...s };
    if (shadow) next.shadow = shadow;
    else delete next.shadow;
    return next;
  });
}

/** Reemplaza todas las páginas (p. ej., una por placa). Con `assets`, se agregan esas imágenes. */
export function replacePages(label: string, pages: PageData[], index: number, assets: Record<string, import('../engine/document').ImageAsset> = {}): void {
  const doc = store.get().document;
  if (Object.keys(assets).length) store.set({ document: { ...doc, assets: { ...doc.assets, ...assets } } });
  commitPages(label, pages, index);
}

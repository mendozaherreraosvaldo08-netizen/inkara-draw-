import type { EditorOverlay } from '../engine/canvas-renderer';
import { rotateAbout, scaleAbout, translate } from '../engine/matrix';
import { centerOf, HANDLE_CURSORS, handleAt, scaleAnchor, handleAxes, type Handle, type ScaleHandle } from '../engine/selection';
import { createShape, hitTest, insideRect, KIND_LABELS, transformShape, type Rect, type Shape, type GeometricKind } from '../engine/shapes';
import type { Point, Viewport } from '../engine/viewport';
import { expandIds } from '../engine/arrange';
import { snapPoint, snapRect, snapTargets, type SnapLine, type SnapTargets } from '../engine/snap';
import type { Guide } from '../engine/document';
import * as editor from './editor';
import { store } from './state';
import { createPathTools, isPathTool } from './path-tools';
import { editText, editingTextId, startNewText, stopTextEditing, textOverlay } from './text-edit';

/**
 * Interacción con el ratón sobre el lienzo (herramientas Selección y figuras).
 * Trabaja en mm del documento; el viewport solo traduce desde la pantalla.
 *
 * Selección:
 *  - Clic en un objeto: lo selecciona (Mayús: añade o quita). Clic de nuevo: tiradores de rotación.
 *  - Arrastrar un objeto: mover (Ctrl: solo en horizontal o vertical).
 *  - Tiradores de esquina: escala proporcional; de lado: estira. Mayús: desde el centro.
 *  - Flechas de rotación: rotar alrededor del centro (Ctrl: de 15° en 15°).
 *  - Arrastrar en vacío: marco de selección (lo que quede completamente dentro).
 * Rectángulo, Elipse, Polígono: arrastrar dibuja (Ctrl: cuadrado/círculo; Mayús: desde el centro).
 */

const CREATION_TOOLS: Partial<Record<string, GeometricKind>> = { rectangle: 'rectangle', ellipse: 'ellipse', polygon: 'polygon' };
/** Píxeles que hay que mover el ratón para que un clic se convierta en arrastre. */
const DRAG_THRESHOLD = 3;

const ROTATE_CURSOR = (() => {
  const svgCursor = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="M19 12a7 7 0 1 1-2.05-4.95" fill="none" stroke="white" stroke-width="4" stroke-linecap="round"/><path d="M19 12a7 7 0 1 1-2.05-4.95" fill="none" stroke="black" stroke-width="1.8" stroke-linecap="round"/><path d="M18 3v5h-5" fill="none" stroke="white" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M18 3v5h-5" fill="none" stroke="black" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svgCursor)}") 12 12, crosshair`;
})();

type Gesture =
  | { kind: 'pending'; start: Point; screen: Point; hit: Shape | null; wasSelected: boolean; shift: boolean; ctrl: boolean }
  | { kind: 'move'; start: Point; original: Shape[]; box: Rect | null; targets: SnapTargets }
  | { kind: 'scale'; handle: ScaleHandle; box: Rect; original: Shape[]; targets: SnapTargets }
  | { kind: 'guide'; id: string; axis: 'x' | 'y'; isNew: boolean; targets: SnapTargets }
  | { kind: 'crop-new'; start: Point; targets: SnapTargets }
  | { kind: 'crop-move'; start: Point; box: Rect; targets: SnapTargets }
  | { kind: 'crop-resize'; handle: ScaleHandle; box: Rect; targets: SnapTargets }
  | { kind: 'rotate'; center: Point; startAngle: number; original: Shape[] }
  | { kind: 'marquee'; start: Point; current: Point; additive: boolean }
  | { kind: 'text-frame'; start: Point; current: Point }
  | { kind: 'create'; shapeKind: GeometricKind; start: Point; current: Point; targets: SnapTargets };

interface Modifiers {
  shift: boolean;
  ctrl: boolean;
}

export interface Interaction {
  overlay(): EditorOverlay;
  /** Devuelve true si el evento se usó (para que el área de trabajo no haga otra cosa). */
  pointerDown(screen: Point, mods: Modifiers): boolean;
  pointerMove(screen: Point, mods: Modifiers): void;
  pointerUp(screen: Point, mods: Modifiers): void;
  /** Esc durante un arrastre: lo deshace. */
  cancel(): boolean;
  doubleClick(screen: Point): void;
  /** Empieza a arrastrar una guía nueva desde una regla (axis 'x' = vertical, desde la regla vertical). */
  startGuide(axis: 'x' | 'y', screen: Point): void;
  /** Herramienta Recortar: aplica el recorte elegido (Enter o doble clic). */
  applyCrop(): void;
  /** Cursor que corresponde al punto (tirador, objeto…), o null = el de la herramienta. */
  cursorAt(screen: Point): string | null;
  readonly active: boolean;
}

export function createInteraction(viewport: Viewport, requestRender: () => void): Interaction {
  let gesture: Gesture | null = null;
  /** Id del objeto bajo el cursor (el id, no el objeto: este cambia con cada edición). */
  let hoverId: string | null = null;

  const tool = () => store.get().tool;
  const isSelectTool = () => tool() === 'select';
  const creationKind = () => CREATION_TOOLS[tool()];
  /** Pluma, mano alzada y forma (curvas). */
  const pathTools = createPathTools(viewport, requestRender);

  /** Tolerancia de clic: 4 px de pantalla, en mm. */
  const tolerance = () => 4 / viewport.scale;

  // ---- Imán (ajuste a guías, objetos y página) ----
  /** Líneas de ajuste que se ven mientras algo está pegado. */
  let snapLines: SnapLine[] = [];
  const NO_TARGETS: SnapTargets = { x: [], y: [] };
  const targetsExcept = (exclude: Iterable<string>, withGuides = true): SnapTargets => {
    const { snap, document: doc } = store.get();
    if (!snap.enabled) return NO_TARGETS;
    return snapTargets(doc, new Set(exclude), { guides: withGuides && snap.guides && store.get().showGuides, objects: snap.objects, page: snap.page });
  };
  /** Se pega a menos de 6 px de pantalla. */
  const snapDistance = () => 6 / viewport.scale;
  const snapped = (p: Point, targets: SnapTargets, axes = { x: true, y: true }): Point => {
    const r = snapPoint(p, targets, snapDistance(), axes);
    snapLines = r.lines;
    return r.point;
  };

  // ---- Guías ----
  const guides = (): Guide[] => (store.get().showGuides ? (store.get().document.guides ?? []) : []);
  /** Guía bajo el cursor (a menos de 4 px). */
  const guideAt = (screen: Point): Guide | null => {
    let best: { g: Guide; d: number } | null = null;
    for (const g of guides()) {
      const s = viewport.docToScreen({ x: g.pos, y: g.pos });
      const d = Math.abs(g.axis === 'x' ? screen.x - s.x : screen.y - s.y);
      if (d <= 4 && (!best || d < best.d)) best = { g, d };
    }
    return best?.g ?? null;
  };
  const setGuidePos = (id: string, pos: number) => editor.liveGuides((store.get().document.guides ?? []).map((g) => (g.id === id ? { ...g, pos } : g)));

  // ---- Recortar ----
  const cropArea = () => store.get().cropArea;

  /**
   * Objeto bajo el punto. El contenido de un PowerClip no se toca suelto: un clic
   * dentro del marco (aunque el marco no tenga relleno) elige el contenedor.
   */
  const shapeAt = (p: Point, deep = false): Shape | null => {
    const shapes = store.get().document.shapes;
    const byId = new Map(shapes.map((s) => [s.id, s]));
    const ids = new Set(byId.keys());
    const containers = new Set(shapes.filter((s) => s.clipId && ids.has(s.clipId)).map((s) => s.clipId!));
    const insideContainer = (s: Shape): boolean => {
      const c = s.clipId ? byId.get(s.clipId) : undefined;
      if (!c) return true;
      return hitTest({ ...c, fill: c.fill ?? '#000000' }, p, 0) && insideContainer(c);
    };
    for (let i = shapes.length - 1; i >= 0; i--) {
      const s = shapes[i]!;
      if (s.hidden || s.locked) continue;
      if (s.clipId && ids.has(s.clipId)) {
        // Ctrl+clic: el contenido (solo donde se ve, dentro del marco).
        if (deep && hitTest(s.kind === 'image' ? s : { ...s, fill: s.fill ?? '#000000' }, p, tolerance()) && insideContainer(s)) return s;
        continue;
      }
      const probe = containers.has(s.id) && !s.fill ? { ...s, fill: '#000000' } : s;
      if (hitTest(probe, p, tolerance())) return s;
    }
    return null;
  };

  const screenBox = (rect: Rect): Rect => {
    const tl = viewport.docToScreen({ x: rect.x, y: rect.y });
    const br = viewport.docToScreen({ x: rect.x + rect.width, y: rect.y + rect.height });
    return { x: tl.x, y: tl.y, width: br.x - tl.x, height: br.y - tl.y };
  };

  const handleUnder = (screen: Point): Handle | null => {
    if (!isSelectTool()) return null;
    const box = editor.selectionBounds();
    return box ? handleAt(screen, screenBox(box), store.get().transformMode) : null;
  };

  const insideBox = (p: Point, r: Rect) => p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;
  const toolHint = () => (tool() === 'crop' ? 'Arrastra sobre una foto el área que quieres conservar' : 'Listo');

  const rectFrom = (a: Point, b: Point): Rect => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) });

  /** Caja de la figura que se dibuja, con Ctrl (proporción 1:1) y Mayús (desde el centro). */
  const creationRect = (start: Point, current: Point, mods: Modifiers): Rect => {
    let dx = current.x - start.x;
    let dy = current.y - start.y;
    if (mods.ctrl) {
      const size = Math.max(Math.abs(dx), Math.abs(dy));
      dx = Math.sign(dx || 1) * size;
      dy = Math.sign(dy || 1) * size;
    }
    if (mods.shift) return { x: start.x - Math.abs(dx), y: start.y - Math.abs(dy), width: Math.abs(dx) * 2, height: Math.abs(dy) * 2 };
    return rectFrom(start, { x: start.x + dx, y: start.y + dy });
  };

  const newShape = (kind: GeometricKind, rect: Rect): Shape => {
    const state = store.get();
    return createShape(kind, rect, { fill: state.fill?.hex ?? null, stroke: state.outline?.hex ?? null, strokeWidth: state.strokeWidth }, { cornerRadius: state.cornerRadius, sides: state.sides });
  };

  let lastMods: Modifiers = { shift: false, ctrl: false };

  const preview = (): Shape | null => {
    if (gesture?.kind !== 'create') return null;
    const rect = creationRect(gesture.start, gesture.current, lastMods);
    return rect.width > 0 && rect.height > 0 ? newShape(gesture.shapeKind, rect) : null;
  };

  const startDrag = (g: Extract<Gesture, { kind: 'pending' }>): Gesture => {
    if (g.hit) {
      // Arrastrar un objeto no seleccionado lo selecciona primero (y solo a él).
      if (!g.wasSelected) editor.select(g.shift ? [...store.get().selection, g.hit.id] : [g.hit.id], g.ctrl);
      editor.beginGesture();
      return { kind: 'move', start: g.start, original: store.get().document.shapes, box: editor.selectionBounds(), targets: targetsExcept(store.get().selection) };
    }
    return { kind: 'marquee', start: g.start, current: g.start, additive: g.shift };
  };

  const selectedIds = () => new Set(store.get().selection);

  return {
    get active() {
      return gesture !== null || pathTools.active;
    },

    overlay(): EditorOverlay {
      const text = textOverlay();
      const selection = text.editing ? [] : editor.selectedShapes();
      const marquee = gesture?.kind === 'marquee' || gesture?.kind === 'text-frame' ? rectFrom(gesture.start, gesture.current) : pathTools.marquee();
      const curves = isPathTool(tool());
      return {
        selection,
        // Mientras se escribe o se editan nodos no hay tiradores.
        selectionBounds: gesture?.kind === 'create' || text.editing || curves || tool() === 'crop' ? null : editor.selectionBounds(),
        pathEdit: pathTools.overlay(),
        mode: store.get().transformMode,
        marquee,
        preview: preview(),
        caret: text.caret,
        textSelection: text.ranges,
        editing: text.editing,
        snapLines,
        guides: guides(),
        activeGuide: gesture?.kind === 'guide' ? gesture.id : null,
        crop: tool() === 'crop' ? cropArea() : null,
        hover: isSelectTool() && !gesture && !text.editing && hoverId && !store.get().selection.includes(hoverId) ? (store.get().document.shapes.find((s) => s.id === hoverId) ?? null) : null,
      };
    },

    pointerDown(screen, mods) {
      lastMods = mods;
      if (isPathTool(tool())) {
        stopTextEditing();
        return pathTools.pointerDown(screen, mods, shapeAt);
      }
      const p = viewport.screenToDoc(screen);
      const hit = shapeAt(p, isSelectTool() && mods.ctrl);
      // Texto: clic en un texto lo edita (con el cursor donde se hizo clic); en vacío, empieza uno nuevo.
      if (tool() === 'text') {
        if (hit?.kind === 'text') {
          editText(hit.id, p);
          requestRender();
          return true;
        }
        // Clic: texto artístico. Arrastrar: marco de texto de párrafo.
        stopTextEditing();
        gesture = { kind: 'text-frame', start: p, current: p };
        return true;
      }
      // Escribiendo con otra herramienta: un clic dentro mueve el cursor; fuera, termina.
      const editing = editingTextId();
      if (editing) {
        if (hit?.id === editing) {
          editText(editing, p);
          return true;
        }
        stopTextEditing();
      }
      const kind = creationKind();
      if (kind) {
        const targets = targetsExcept([]);
        const start = snapped(p, targets);
        gesture = { kind: 'create', shapeKind: kind, start, current: start, targets };
        requestRender();
        return true;
      }
      if (tool() === 'crop') {
        const area = cropArea();
        const targets = targetsExcept([]);
        if (area) {
          const handle = handleAt(screen, screenBox(area), 'scale');
          if (handle && !handle.startsWith('rot-')) {
            gesture = { kind: 'crop-resize', handle: handle as ScaleHandle, box: area, targets };
            return true;
          }
          if (insideBox(p, area)) {
            gesture = { kind: 'crop-move', start: p, box: area, targets };
            return true;
          }
        }
        const start = snapped(p, targets);
        gesture = { kind: 'crop-new', start, targets };
        store.set({ cropArea: null });
        return true;
      }
      if (!isSelectTool()) return false;

      const handle = handleUnder(screen);
      const box = editor.selectionBounds();
      if (handle && box) {
        editor.beginGesture();
        const original = store.get().document.shapes;
        if (handle.startsWith('rot-')) {
          const center = centerOf(box);
          gesture = { kind: 'rotate', center, startAngle: Math.atan2(p.y - center.y, p.x - center.x), original };
        } else {
          gesture = { kind: 'scale', handle: handle as ScaleHandle, box, original, targets: targetsExcept(store.get().selection) };
        }
        return true;
      }
      // Guías: se arrastran para moverlas; soltarlas sobre la regla las quita.
      const guide = guideAt(screen);
      if (guide) {
        editor.beginGesture();
        gesture = { kind: 'guide', id: guide.id, axis: guide.axis, isNew: false, targets: targetsExcept([], false) };
        return true;
      }

      const wasSelected = !!hit && selectedIds().has(hit.id);
      gesture = { kind: 'pending', start: p, screen, hit, wasSelected, shift: mods.shift, ctrl: mods.ctrl };
      return true;
    },

    pointerMove(screen, mods) {
      lastMods = mods;
      if (isPathTool(tool())) {
        pathTools.pointerMove(screen, mods);
        return;
      }
      let p = viewport.screenToDoc(screen);
      if (!gesture) {
        const next = isSelectTool() ? (shapeAt(p)?.id ?? null) : null;
        if (next !== hoverId) {
          hoverId = next;
          requestRender();
        }
        return;
      }

      if (gesture.kind === 'pending') {
        if (Math.hypot(screen.x - gesture.screen.x, screen.y - gesture.screen.y) < DRAG_THRESHOLD) return;
        gesture = startDrag(gesture);
      }

      const ids = selectedIds();
      switch (gesture.kind) {
        case 'move': {
          let dx = p.x - gesture.start.x;
          let dy = p.y - gesture.start.y;
          let axes = { x: true, y: true };
          if (mods.ctrl) {
            if (Math.abs(dx) > Math.abs(dy)) dy = 0;
            else dx = 0;
            axes = { x: dx !== 0, y: dy !== 0 };
          }
          snapLines = [];
          if (gesture.box) {
            const b = gesture.box;
            const snap = snapRect({ ...b, x: b.x + dx, y: b.y + dy }, gesture.targets, snapDistance(), axes);
            dx += snap.dx;
            dy += snap.dy;
            snapLines = snap.lines;
          }
          const m = translate(dx, dy);
          editor.live(gesture.original.map((s) => (ids.has(s.id) ? transformShape(s, m) : s)));
          store.set({ hint: `Mover: ${dx.toFixed(2)} ; ${dy.toFixed(2)} mm` });
          break;
        }
        case 'scale': {
          const { handle, box } = gesture;
          const anchor = mods.shift ? centerOf(box) : scaleAnchor(handle, box);
          // Posición original del tirador (sobre la caja, sin el margen visual).
          const origin = { x: handle.includes('w') ? box.x : handle.includes('e') ? box.x + box.width : box.x + box.width / 2, y: handle.includes('n') ? box.y : handle.includes('s') ? box.y + box.height : box.y + box.height / 2 };
          const axes = handleAxes(handle);
          p = snapped(p, gesture.targets, { x: axes.x, y: axes.y });
          const ratio = (now: number, from: number, fixed: number) => (Math.abs(from - fixed) < 1e-9 ? 1 : (now - fixed) / (from - fixed));
          let sx = axes.x ? ratio(p.x, origin.x, anchor.x) : 1;
          let sy = axes.y ? ratio(p.y, origin.y, anchor.y) : 1;
          // Esquinas: escala proporcional; lados: estiran en un solo eje.
          if (axes.x && axes.y) {
            const s = Math.abs(sx) > Math.abs(sy) ? sx : sy;
            sx = s;
            sy = s;
          }
          const clamp = (v: number) => (Math.abs(v) < 0.001 ? (v < 0 ? -0.001 : 0.001) : v);
          sx = clamp(sx);
          sy = clamp(sy);
          const m = scaleAbout(sx, sy, anchor);
          editor.live(gesture.original.map((s) => (ids.has(s.id) ? transformShape(s, m) : s)));
          store.set({ hint: `Escalar: ${Math.round(Math.abs(sx) * 100)} % × ${Math.round(Math.abs(sy) * 100)} %${sx < 0 || sy < 0 ? ' (reflejado)' : ''}` });
          break;
        }
        case 'rotate': {
          const angle = Math.atan2(p.y - gesture.center.y, p.x - gesture.center.x);
          let degrees = ((angle - gesture.startAngle) * 180) / Math.PI;
          degrees = ((degrees + 540) % 360) - 180;
          if (mods.ctrl) degrees = Math.round(degrees / 15) * 15;
          const m = rotateAbout(degrees, gesture.center);
          editor.live(gesture.original.map((s) => (ids.has(s.id) ? transformShape(s, m) : s)));
          store.set({ hint: `Rotar: ${(-degrees).toFixed(1)}°` });
          break;
        }
        case 'marquee':
          gesture.current = p;
          requestRender();
          break;
        case 'text-frame':
          gesture.current = p;
          store.set({ hint: `Párrafo: ${Math.abs(p.x - gesture.start.x).toFixed(1)} mm de ancho — suelta para escribir` });
          requestRender();
          break;
        case 'guide': {
          // Sobre la regla (fuera del lienzo): se quitará al soltar.
          const off = gesture.axis === 'x' ? screen.x < 0 : screen.y < 0;
          const q = snapped(p, gesture.targets, { x: gesture.axis === 'x', y: gesture.axis === 'y' });
          const pos = gesture.axis === 'x' ? q.x : q.y;
          setGuidePos(gesture.id, pos);
          store.set({ hint: off ? 'Suelta aquí para quitar la guía' : `Guía ${gesture.axis === 'x' ? 'vertical' : 'horizontal'}: ${pos.toFixed(2)} mm` });
          requestRender();
          break;
        }
        case 'crop-new': {
          const q = snapped(p, gesture.targets);
          const area = rectFrom(gesture.start, q);
          store.set({ cropArea: area, hint: `Recorte: ${area.width.toFixed(1)} × ${area.height.toFixed(1)} mm — Enter o doble clic para aplicar, Esc para cancelar` });
          break;
        }
        case 'crop-move': {
          const b = gesture.box;
          let dx = p.x - gesture.start.x;
          let dy = p.y - gesture.start.y;
          const snap = snapRect({ ...b, x: b.x + dx, y: b.y + dy }, gesture.targets, snapDistance());
          dx += snap.dx;
          dy += snap.dy;
          snapLines = snap.lines;
          store.set({ cropArea: { ...b, x: b.x + dx, y: b.y + dy } });
          break;
        }
        case 'crop-resize': {
          const b = gesture.box;
          const axes = handleAxes(gesture.handle);
          const q = snapped(p, gesture.targets, { x: axes.x, y: axes.y });
          let x0 = b.x, y0 = b.y, x1 = b.x + b.width, y1 = b.y + b.height;
          if (gesture.handle.includes('w')) x0 = q.x;
          if (gesture.handle.includes('e')) x1 = q.x;
          if (gesture.handle.includes('n')) y0 = q.y;
          if (gesture.handle.includes('s')) y1 = q.y;
          store.set({ cropArea: rectFrom({ x: x0, y: y0 }, { x: x1, y: y1 }) });
          break;
        }
        case 'create': {
          p = snapped(p, gesture.targets);
          gesture.current = p;
          const rect = creationRect(gesture.start, p, mods);
          store.set({ hint: `${KIND_LABELS[gesture.shapeKind]}: ${rect.width.toFixed(2)} × ${rect.height.toFixed(2)} mm` });
          requestRender();
          break;
        }
      }
    },

    pointerUp(screen, mods) {
      lastMods = mods;
      if (isPathTool(tool()) || pathTools.active) {
        pathTools.pointerUp(screen);
        return;
      }
      const g = gesture;
      gesture = null;
      snapLines = [];
      if (!g) return;
      switch (g.kind) {
        case 'text-frame': {
          const frame = rectFrom(g.start, g.current);
          if (frame.width * viewport.scale >= 8) startNewText({ x: frame.x, y: frame.y }, frame.width);
          else startNewText(g.start);
          break;
        }
        case 'guide': {
          const off = g.axis === 'x' ? screen.x < 0 : screen.y < 0;
          if (off && g.isNew) {
            editor.cancelGesture();
            store.set({ hint: 'Listo' });
          } else if (off) {
            editor.cancelGesture();
            editor.removeGuide(g.id);
          } else {
            editor.endGesture(g.isNew ? 'Nueva guía' : 'Mover guía');
          }
          break;
        }
        case 'crop-new': {
          const area = cropArea();
          if (!area || area.width * viewport.scale < 3 || area.height * viewport.scale < 3) store.set({ cropArea: null, hint: toolHint() });
          break;
        }
        case 'crop-move':
        case 'crop-resize':
          break;
        case 'pending': {
          // Clic sin arrastrar.
          if (!g.hit) {
            if (!g.shift) editor.clearSelection();
          } else if (g.shift) {
            const ids = store.get().selection;
            // Mayús+clic en algo elegido lo quita (con su grupo entero).
            const unit = expandIds(store.get().document.shapes, [g.hit.id]);
            editor.select(g.wasSelected ? ids.filter((id) => !unit.has(id)) : [...ids, g.hit.id], g.ctrl);
          } else if (g.wasSelected) {
            editor.toggleTransformMode();
          } else {
            // Ctrl+clic: solo ese objeto, aunque esté en un grupo (como en los editores vectoriales).
            editor.select([g.hit.id], g.ctrl);
          }
          break;
        }
        case 'move':
          editor.endGesture('Mover');
          break;
        case 'scale':
          editor.endGesture('Escalar');
          break;
        case 'rotate':
          editor.endGesture('Rotar');
          break;
        case 'marquee': {
          const rect = rectFrom(g.start, g.current);
          const inside = store.get().document.shapes.filter((s) => !s.hidden && !s.locked && insideRect(s, rect)).map((s) => s.id);
          editor.select(g.additive ? [...new Set([...store.get().selection, ...inside])] : inside);
          break;
        }
        case 'create': {
          const rect = creationRect(g.start, g.current, mods);
          // Un clic sin arrastrar (menos de 2 px) no crea nada: como en los editores vectoriales.
          if (rect.width * viewport.scale < 2 || rect.height * viewport.scale < 2) break;
          const shape = newShape(g.shapeKind, rect);
          editor.commit(`Crear ${KIND_LABELS[g.shapeKind].toLowerCase()}`, [...store.get().document.shapes, shape], [shape.id]);
          store.set({ transformMode: 'scale' });
          break;
        }
      }
      requestRender();
    },

    doubleClick(screen) {
      if (isPathTool(tool())) {
        pathTools.doubleClick(screen);
        return;
      }
      if (tool() === 'crop') {
        const area = cropArea();
        if (area && insideBox(viewport.screenToDoc(screen), area)) this.applyCrop();
        return;
      }
      // Doble clic en un texto con la herramienta Selección: editarlo.
      if (!isSelectTool()) return;
      const p = viewport.screenToDoc(screen);
      const hit = shapeAt(p);
      if (hit?.kind === 'text') editText(hit.id, p);
    },

    startGuide(axis, screen) {
      if (gesture) return;
      editor.beginGesture();
      const p = viewport.screenToDoc(screen);
      const guide = editor.addGuide(axis, axis === 'x' ? p.x : p.y);
      if (!store.get().showGuides) store.set({ showGuides: true });
      gesture = { kind: 'guide', id: guide.id, axis, isNew: true, targets: targetsExcept([], false) };
      requestRender();
    },

    applyCrop() {
      editor.applyCropArea();
      requestRender();
    },

    cancel() {
      if (pathTools.cancel()) return true;
      if (!gesture && cropArea()) {
        store.set({ cropArea: null, hint: 'Recorte cancelado' });
        return true;
      }
      if (!gesture) return false;
      snapLines = [];
      if (gesture.kind.startsWith('crop')) {
        gesture = null;
        store.set({ cropArea: null, hint: 'Recorte cancelado' });
        return true;
      }
      gesture = null;
      editor.cancelGesture();
      store.set({ hint: 'Cancelado' });
      requestRender();
      return true;
    },

    cursorAt(screen) {
      if (isPathTool(tool())) return pathTools.cursorAt(screen);
      if (tool() === 'text') return null;
      const editing = editingTextId();
      if (editing && shapeAt(viewport.screenToDoc(screen))?.id === editing) return 'text';
      if (gesture?.kind === 'move') return 'move';
      if (gesture?.kind === 'rotate') return ROTATE_CURSOR;
      if (gesture?.kind === 'scale' || gesture?.kind === 'crop-resize') return HANDLE_CURSORS[gesture.handle];
      if (gesture?.kind === 'guide') return gesture.axis === 'x' ? 'col-resize' : 'row-resize';
      if (gesture?.kind === 'crop-move') return 'move';
      if (tool() === 'crop') {
        const area = cropArea();
        if (!area) return null;
        const h = handleAt(screen, screenBox(area), 'scale');
        if (h && !h.startsWith('rot-')) return HANDLE_CURSORS[h as ScaleHandle];
        return insideBox(viewport.screenToDoc(screen), area) ? 'move' : null;
      }
      if (!isSelectTool()) return null;
      const handle = handleUnder(screen);
      if (handle) return handle.startsWith('rot-') ? ROTATE_CURSOR : HANDLE_CURSORS[handle as ScaleHandle];
      const guide = guideAt(screen);
      if (guide) return guide.axis === 'x' ? 'col-resize' : 'row-resize';
      const hit = shapeAt(viewport.screenToDoc(screen));
      return hit ? 'move' : null;
    },
  };
}

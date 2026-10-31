import type { PathOverlay } from '../engine/canvas-renderer';
import { apply } from '../engine/matrix';
import { addNodeAt, createPath, fitFreehand, flatten, localDelta, moveHandle, moveNodes, node, normalizePath, refKey, segmentAt, toLocal, type NodeRef, type PathNode } from '../engine/path';
import { bezierPoint } from '../engine/path-geom';
import type { PathShape, Rect, Shape } from '../engine/shapes';
import type { Point, Viewport } from '../engine/viewport';
import * as editor from './editor';
import { currentPath, deleteSelectedNodes, nudgeNodes, replacePath, selectAllNodes, selectedRefs, selectNodes } from './node-edit';
import { store } from './state';

/**
 * Herramientas de curvas:
 *  - Pluma (P): clic = nodo de esquina; clic y arrastrar = nodo suave con manijas.
 *    Clic en el primer nodo cierra la curva. Enter, Esc o doble clic terminan.
 *    Retroceso borra el último nodo. Ctrl: ángulos de 15° en 15°.
 *  - Mano alzada (F5): dibuja arrastrando; el trazo se suaviza solo. Si termina
 *    cerca de donde empezó, la curva se cierra.
 *  - Forma (F10): edita los nodos de una curva. Clic o marco para elegir nodos
 *    (Mayús: añadir), arrastrar nodos y manijas, doble clic en la línea añade
 *    un nodo, doble clic en un nodo lo borra.
 */

interface Modifiers {
  shift: boolean;
  ctrl: boolean;
}

type Gesture =
  | { kind: 'nodes'; start: Point; original: PathShape; refs: NodeRef[]; moved: boolean }
  | { kind: 'handle'; original: PathShape; ref: NodeRef; which: 'in' | 'out'; moved: boolean }
  | { kind: 'marquee'; start: Point; current: Point; additive: boolean }
  | { kind: 'freehand'; points: Point[] };

const PATH_TOOLS = ['pen', 'freehand', 'shape'];
export const isPathTool = (tool: string) => PATH_TOOLS.includes(tool);

export interface PathTools {
  readonly active: boolean;
  overlay(): PathOverlay | null;
  marquee(): Rect | null;
  pointerDown(screen: Point, mods: Modifiers, shapeAt: (p: Point) => Shape | null): boolean;
  pointerMove(screen: Point, mods: Modifiers): void;
  pointerUp(screen: Point): void;
  doubleClick(screen: Point): void;
  cancel(): boolean;
  cursorAt(screen: Point): string | null;
}

let instance: { key(event: KeyboardEvent): boolean } | null = null;

/** Teclas de las herramientas de curvas (Enter, Esc, Retroceso, Supr, flechas…). */
export function handlePathKey(event: KeyboardEvent): boolean {
  return instance?.key(event) ?? false;
}

export function createPathTools(viewport: Viewport, requestRender: () => void): PathTools {
  let gesture: Gesture | null = null;
  /** Curva que se está dibujando con la pluma (en mm de la página). */
  let pen: { nodes: PathNode[]; dragging: boolean; cursor: Point | null; closeHover: boolean } | null = null;

  const tool = () => store.get().tool;
  const px = (n: number) => n / viewport.scale; // n píxeles de pantalla → mm
  const near = (a: Point, b: Point, pixels = 7) => Math.hypot(a.x - b.x, a.y - b.y) <= px(pixels);
  const style = (closed: boolean) => {
    const s = store.get();
    return { fill: closed ? (s.fill?.hex ?? null) : null, stroke: s.outline?.hex ?? '#000000', strokeWidth: s.strokeWidth };
  };

  // ---- Pluma ----

  const finishPen = (closed: boolean) => {
    if (!pen) return;
    const nodes = pen.nodes;
    pen = null;
    if (nodes.length >= 2) {
      const shape = createPath([{ nodes, closed: closed && nodes.length >= 3 }], style(closed));
      editor.commit(closed ? 'Crear curva cerrada' : 'Crear curva', [...store.get().document.shapes, shape], [shape.id]);
    } else {
      store.set({ hint: 'Una curva necesita al menos dos nodos.' });
    }
    requestRender();
  };

  /** Ctrl: el nuevo nodo queda en un ángulo múltiplo de 15° respecto del anterior. */
  const constrain = (p: Point, from: Point | undefined, mods: Modifiers): Point => {
    if (!mods.ctrl || !from) return p;
    const d = Math.hypot(p.x - from.x, p.y - from.y);
    const step = Math.PI / 12;
    const angle = Math.round(Math.atan2(p.y - from.y, p.x - from.x) / step) * step;
    return { x: from.x + d * Math.cos(angle), y: from.y + d * Math.sin(angle) };
  };

  // ---- Forma ----

  /** Nodo o manija bajo el cursor en la curva que se edita. */
  const pickNode = (shape: PathShape, p: Point): { ref: NodeRef; handle: 'in' | 'out' | null } | null => {
    const m = shape.transform;
    // Primero las manijas de los nodos elegidos (están encima).
    for (const ref of selectedRefs(shape)) {
      const n = shape.subpaths[ref.sub]!.nodes[ref.node]!;
      for (const which of ['in', 'out'] as const) {
        const h = n[which];
        if (h && near(apply(m, h), p, 6)) return { ref, handle: which };
      }
    }
    for (const [si, s] of shape.subpaths.entries()) {
      for (const [ni, n] of s.nodes.entries()) if (near(apply(m, n), p, 6)) return { ref: { sub: si, node: ni }, handle: null };
    }
    return null;
  };

  const rectFrom = (a: Point, b: Point): Rect => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) });

  instance = {
    key(event) {
      const key = event.key;
      if (pen) {
        if (key === 'Enter' || key === 'Escape') {
          finishPen(false);
          return true;
        }
        if (key === 'Backspace' || key === 'Delete') {
          pen.nodes.pop();
          if (pen.nodes.length === 0) pen = null;
          requestRender();
          return true;
        }
        return false;
      }
      if (tool() !== 'shape' || !currentPath()) return false;
      const ctrl = event.ctrlKey || event.metaKey;
      if ((key === 'Delete' || key === 'Backspace') && selectedRefs().length > 0) {
        deleteSelectedNodes();
        return true;
      }
      if (ctrl && key.toLowerCase() === 'a') {
        selectAllNodes();
        return true;
      }
      if (key === 'Escape' && selectedRefs().length > 0) {
        selectNodes([]);
        return true;
      }
      if (key.startsWith('Arrow') && selectedRefs().length > 0) {
        const step = event.shiftKey ? 10 : ctrl ? 0.1 : 1;
        nudgeNodes(key === 'ArrowLeft' ? -step : key === 'ArrowRight' ? step : 0, key === 'ArrowUp' ? -step : key === 'ArrowDown' ? step : 0);
        return true;
      }
      return false;
    },
  };

  // Cambiar de herramienta termina la curva de la pluma.
  store.subscribe((state, previous) => {
    if (state.tool !== previous.tool && pen) finishPen(false);
    if (state.nodeSelection !== previous.nodeSelection) requestRender();
  });

  return {
    get active() {
      return gesture !== null || pen?.dragging === true;
    },

    marquee() {
      return gesture?.kind === 'marquee' ? rectFrom(gesture.start, gesture.current) : null;
    },

    overlay(): PathOverlay | null {
      if (gesture?.kind === 'freehand') {
        return { outline: [{ points: gesture.points, closed: false }], anchors: [], handles: [], rubber: null };
      }
      if (pen) {
        const nodes = pen.nodes;
        const last = nodes[nodes.length - 1];
        const draft = flatten({ nodes, closed: false }, [1, 0, 0, 1, 0, 0]);
        let rubber: Point[] | null = null;
        if (last && pen.cursor && !pen.dragging) {
          const target = pen.closeHover ? nodes[0]! : pen.cursor;
          const seg = { p0: last, c1: last.out ?? last, c2: target, p1: target, line: !last.out };
          rubber = seg.line ? [last, target] : Array.from({ length: 17 }, (_, i) => bezierPoint(seg, i / 16));
        }
        return {
          outline: [{ points: draft, closed: false }],
          anchors: nodes.map((n, i) => ({ p: n, selected: i === nodes.length - 1, smooth: n.type !== 'cusp', highlight: i === 0 && pen!.closeHover })),
          handles: last ? [...(last.in ? [{ from: last, to: last.in }] : []), ...(last.out ? [{ from: last, to: last.out }] : [])] : [],
          rubber,
        };
      }
      if (tool() !== 'shape') return null;
      const shape = currentPath();
      if (!shape) return null;
      const m = shape.transform;
      const keys = new Set(store.get().nodeSelection);
      const handles: PathOverlay['handles'] = [];
      for (const ref of selectedRefs(shape)) {
        const n = shape.subpaths[ref.sub]!.nodes[ref.node]!;
        const at = apply(m, n);
        if (n.in) handles.push({ from: at, to: apply(m, n.in) });
        if (n.out) handles.push({ from: at, to: apply(m, n.out) });
      }
      return {
        outline: shape.subpaths.map((s) => ({ points: flatten(s, m), closed: s.closed })),
        anchors: shape.subpaths.flatMap((s, si) => s.nodes.map((n, ni) => ({ p: apply(m, n), selected: keys.has(`${si}:${ni}`), smooth: n.type !== 'cusp' }))),
        handles,
        rubber: null,
      };
    },

    pointerDown(screen, mods, shapeAt) {
      const p = viewport.screenToDoc(screen);
      const t = tool();

      if (t === 'pen') {
        if (pen && pen.nodes.length >= 2 && near(p, pen.nodes[0]!)) {
          finishPen(true);
          return true;
        }
        pen ??= { nodes: [], dragging: false, cursor: null, closeHover: false };
        const at = constrain(p, pen.nodes[pen.nodes.length - 1], mods);
        pen.nodes.push(node(at.x, at.y));
        pen.dragging = true;
        store.set({ hint: 'Clic: esquina · Arrastrar: curva · Clic en el primer nodo: cerrar · Enter: terminar' });
        requestRender();
        return true;
      }

      if (t === 'freehand') {
        gesture = { kind: 'freehand', points: [p] };
        return true;
      }

      // Forma
      const shape = currentPath();
      if (shape) {
        const picked = pickNode(shape, p);
        if (picked?.handle) {
          editor.beginGesture();
          gesture = { kind: 'handle', original: shape, ref: picked.ref, which: picked.handle, moved: false };
          return true;
        }
        if (picked) {
          const keys = store.get().nodeSelection;
          const key = refKey(picked.ref);
          let refs = selectedRefs(shape);
          if (mods.shift) {
            refs = keys.includes(key) ? refs.filter((r) => refKey(r) !== key) : [...refs, picked.ref];
          } else if (!keys.includes(key)) {
            refs = [picked.ref];
          }
          selectNodes(refs);
          editor.beginGesture();
          gesture = { kind: 'nodes', start: p, original: shape, refs, moved: false };
          return true;
        }
      }
      const hit = shapeAt(p);
      if (hit && hit.id !== shape?.id) {
        editor.select([hit.id]);
        store.set({ hint: hit.kind === 'path' ? 'Elige nodos para editarlos: clic, o arrastra un marco.' : 'Para editar sus nodos, conviértelo a curvas (Ctrl+Q).' });
        return true;
      }
      if (shape && hit?.id === shape.id) {
        if (!mods.shift) selectNodes([]);
        return true;
      }
      if (!shape && !hit) editor.clearSelection();
      // Marco para elegir nodos (o nada, si no hay curva).
      gesture = { kind: 'marquee', start: p, current: p, additive: mods.shift };
      return true;
    },

    pointerMove(screen, mods) {
      const p = viewport.screenToDoc(screen);
      if (pen) {
        const last = pen.nodes[pen.nodes.length - 1]!;
        if (pen.dragging) {
          // Arrastrar al poner un nodo: lo vuelve suave con manijas simétricas.
          if (Math.hypot(p.x - last.x, p.y - last.y) > px(2)) {
            last.out = { x: p.x, y: p.y };
            last.in = { x: 2 * last.x - p.x, y: 2 * last.y - p.y };
            last.type = 'symmetric';
          }
        } else {
          pen.cursor = constrain(p, last, mods);
          pen.closeHover = pen.nodes.length >= 2 && near(p, pen.nodes[0]!);
        }
        requestRender();
        return;
      }
      if (!gesture) return;
      switch (gesture.kind) {
        case 'freehand': {
          const last = gesture.points[gesture.points.length - 1]!;
          if (Math.hypot(p.x - last.x, p.y - last.y) > px(0.75)) gesture.points.push(p);
          break;
        }
        case 'nodes': {
          // Un temblor de 2 px al hacer clic no cuenta como mover.
          if (!gesture.moved && Math.hypot(p.x - gesture.start.x, p.y - gesture.start.y) < px(2)) return;
          gesture.moved = true;
          const d = localDelta(gesture.original, { x: p.x - gesture.start.x, y: p.y - gesture.start.y });
          replacePath(moveNodes(gesture.original, gesture.refs, d), null);
          break;
        }
        case 'handle':
          gesture.moved = true;
          replacePath(moveHandle(gesture.original, gesture.ref, gesture.which, toLocal(gesture.original, p)), null);
          break;
        case 'marquee':
          gesture.current = p;
          break;
      }
      requestRender();
    },

    pointerUp() {
      if (pen) {
        pen.dragging = false;
        requestRender();
        return;
      }
      const g = gesture;
      gesture = null;
      if (!g) return;
      if (g.kind === 'freehand') {
        if (g.points.length >= 3) {
          const first = g.points[0]!;
          const last = g.points[g.points.length - 1]!;
          const closed = g.points.length > 8 && near(first, last, 10);
          const sub = fitFreehand(g.points, px(1.5), closed);
          if (sub.nodes.length >= 2) {
            const shape = createPath([sub], style(closed));
            editor.commit('Mano alzada', [...store.get().document.shapes, shape], [shape.id]);
          }
        }
      } else if ((g.kind === 'nodes' || g.kind === 'handle') && !g.moved) {
        // Solo fue un clic para elegir el nodo: no deja paso en el historial.
        editor.cancelGesture();
      } else if (g.kind === 'nodes' || g.kind === 'handle') {
        const shape = currentPath();
        if (shape) replacePath(normalizePath(shape), null);
        editor.endGesture(g.kind === 'nodes' ? 'Mover nodos' : 'Mover manija');
      } else if (g.kind === 'marquee') {
        const shape = currentPath();
        if (shape) {
          const r = rectFrom(g.start, g.current);
          const inside = shape.subpaths.flatMap((s, si) =>
            s.nodes.flatMap((n, ni) => {
              const q = apply(shape.transform, n);
              return q.x >= r.x && q.x <= r.x + r.width && q.y >= r.y && q.y <= r.y + r.height ? [{ sub: si, node: ni }] : [];
            }),
          );
          selectNodes(g.additive ? [...selectedRefs(shape), ...inside] : inside);
        }
      }
      requestRender();
    },

    doubleClick(screen) {
      const p = viewport.screenToDoc(screen);
      if (pen) {
        // El doble clic dejó un nodo repetido: se quita y se termina.
        const n = pen.nodes;
        if (n.length >= 2 && near(n[n.length - 1]!, n[n.length - 2]!, 3)) n.pop();
        finishPen(false);
        return;
      }
      if (tool() !== 'shape') return;
      const shape = currentPath();
      if (!shape) return;
      const picked = pickNode(shape, p);
      if (picked && !picked.handle) {
        selectNodes([picked.ref]);
        deleteSelectedNodes();
        return;
      }
      const at = segmentAt(shape, p, px(6));
      if (at) {
        const { shape: next, ref } = addNodeAt(shape, at);
        replacePath(next, 'Añadir nodo', [ref]);
      }
    },

    cancel() {
      if (pen) {
        finishPen(false);
        return true;
      }
      if (!gesture) return false;
      if (gesture.kind === 'nodes' || gesture.kind === 'handle') editor.cancelGesture();
      gesture = null;
      requestRender();
      return true;
    },

    cursorAt(screen) {
      const t = tool();
      if (t === 'pen' && pen && pen.nodes.length >= 2 && near(viewport.screenToDoc(screen), pen.nodes[0]!)) return 'pointer';
      if (t !== 'shape') return null;
      const shape = currentPath();
      if (!shape) return null;
      const picked = pickNode(shape, viewport.screenToDoc(screen));
      return picked ? 'move' : null;
    },
  };
}

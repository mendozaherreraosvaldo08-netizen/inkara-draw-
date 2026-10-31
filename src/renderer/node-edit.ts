import { addNodesAfter, allRefs, breakAt, closeSubpaths, deleteNodes, localDelta, moveNodes, normalizePath, parseRef, refKey, setNodeType, setSegmentKind, type NodeRef, type NodeType } from '../engine/path';
import type { PathShape } from '../engine/shapes';
import * as editor from './editor';
import { store } from './state';

/**
 * Comandos de nodos (herramienta Forma): los usan la barra de propiedades, el
 * teclado y el ratón. Cada uno es un paso del historial.
 */

/** La curva que se está editando: la única seleccionada, si es una curva. */
export function currentPath(): PathShape | null {
  const selected = editor.selectedShapes();
  return selected.length === 1 && selected[0]!.kind === 'path' ? selected[0]! : null;
}

/** Nodos seleccionados que existen de verdad (tras deshacer, alguno pudo desaparecer). */
export function selectedRefs(shape = currentPath()): NodeRef[] {
  if (!shape) return [];
  return store
    .get()
    .nodeSelection.map(parseRef)
    .filter((r) => !!shape.subpaths[r.sub]?.nodes[r.node]);
}

export function selectNodes(refs: NodeRef[]): void {
  store.set({ nodeSelection: [...new Set(refs.map(refKey))] });
}

/** Reemplaza la curva en el documento (paso del historial con `label`, o en vivo si es null). */
export function replacePath(next: PathShape | null, label: string | null, nodeSelection?: NodeRef[]): void {
  const shape = currentPath();
  if (!shape) return;
  const shapes = next ? store.get().document.shapes.map((s) => (s.id === shape.id ? next : s)) : store.get().document.shapes.filter((s) => s.id !== shape.id);
  if (label === null) editor.live(shapes);
  else editor.commit(label, shapes, next ? [next.id] : []);
  if (nodeSelection) selectNodes(nodeSelection);
}

function withNodes(label: string, fn: (shape: PathShape, refs: NodeRef[]) => PathShape | null, keepSelection = true): void {
  const shape = currentPath();
  const refs = selectedRefs(shape);
  if (!shape || refs.length === 0) {
    store.set({ hint: 'Primero elige uno o más nodos (clic o marco con la herramienta Forma).' });
    return;
  }
  const next = fn(shape, refs);
  replacePath(next, label, keepSelection && next ? refs : []);
}

export const deleteSelectedNodes = () => withNodes('Eliminar nodos', (s, refs) => deleteNodes(s, refs), false);
export const setTypeOfSelected = (type: NodeType) => withNodes(type === 'cusp' ? 'Nodo cúspide' : type === 'smooth' ? 'Nodo suave' : 'Nodo simétrico', (s, refs) => setNodeType(s, refs, type));
export const segmentsTo = (kind: 'line' | 'curve') => withNodes(kind === 'line' ? 'A línea' : 'A curva', (s, refs) => setSegmentKind(s, refs, kind));
export const addNodesToSelected = () => withNodes('Añadir nodos', (s, refs) => addNodesAfter(s, refs), false);
export const closeSelectedPaths = () => withNodes('Cerrar curva', (s, refs) => closeSubpaths(s, refs));
export const breakAtSelected = () => withNodes('Separar curva', (s, refs) => breakAt(s, refs[0]!), false);

export function nudgeNodes(dx: number, dy: number): void {
  withNodes('Mover nodos', (s, refs) => normalizePath(moveNodes(s, refs, localDelta(s, { x: dx, y: dy }))));
}

export function selectAllNodes(): void {
  const shape = currentPath();
  if (shape) selectNodes(allRefs(shape));
}

/** Figuras y textos seleccionados → curvas (Ctrl+Q). */
export { convertToCurves as convertSelectionToCurves } from './shape-commands';

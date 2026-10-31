import { buildObjectTree, objectName, type ObjectNode } from '../../engine/object-tree';
import { expandIds } from '../../engine/arrange';
import * as editor from '../editor';
import { store } from '../state';
import { h, icon, iconButton } from './dom';
import type { IconName } from './icons';

/**
 * Administrador de objetos (panel a la derecha, Ventana › Administrador de
 * objetos): todos los objetos de adelante hacia atrás, con ojo (ocultar),
 * candado (bloquear), nombre (doble clic para cambiarlo) y arrastrar para
 * cambiar el orden. Los grupos y los PowerClip se abren con la flechita.
 */
export function createObjectManager(): HTMLElement {
  const list = h('div', { class: 'om-list', role: 'tree', 'aria-label': 'Objetos del diseño' });
  const count = h('span', { class: 'om-count' });
  const panel = h(
    'aside',
    { class: 'object-manager', 'aria-label': 'Administrador de objetos', hidden: true },
    h('div', { class: 'om-header' }, icon('layers'), h('span', { class: 'om-title' }, 'Objetos'), count, iconButton('close', 'Cerrar el administrador de objetos', () => store.set({ showObjectManager: false }), { class: 'icon-button om-close' })),
    list,
    h('div', { class: 'om-footer' }, 'Arrastra para cambiar el orden. Doble clic en el nombre para cambiarlo.'),
  );

  /** Grupos y PowerClips abiertos (por clave de fila). */
  const open = new Set<string>();
  let renaming: string | null = null;
  let dragged: ObjectNode | null = null;

  const kindIcon = (node: ObjectNode): IconName => {
    if (node.type === 'group') return 'group';
    const s = node.shape!;
    if (node.children.length) return 'powerclip';
    return ({ rectangle: 'rectangle', ellipse: 'ellipse', polygon: 'polygon', text: 'text', image: 'import', path: 'pen' } as const)[s.kind];
  };

  const render = () => {
    const state = store.get();
    panel.hidden = !state.showObjectManager;
    if (panel.hidden) return;
    const { shapes, assets } = state.document;
    const tree = buildObjectTree(shapes);
    const selected = new Set(state.selection);
    count.textContent = String(shapes.length);
    const rows: HTMLElement[] = [];

    const row = (node: ObjectNode, depth: number, unit: ObjectNode) => {
      const members = node.ids.map((id) => shapes.find((s) => s.id === id)!).filter(Boolean);
      const hidden = node.type === 'group' ? members.every((s) => s.hidden) : !!node.shape!.hidden;
      const locked = members.length > 0 && members.every((s) => s.locked);
      const isSelected = node.ids.every((id) => selected.has(id)) && (node.type === 'group' || selected.has(node.key));
      const label = node.type === 'group' ? `Grupo (${node.children.length})` : objectName(node.shape!, assets) + (node.children.length ? ' · PowerClip' : '');
      const expandable = node.children.length > 0;
      const isOpen = open.has(node.key);

      const name =
        renaming === node.key && node.shape
          ? renameInput(node.shape.id, node.shape.name ?? objectName(node.shape, assets))
          : h('span', { class: 'om-name', title: label }, label);
      const el = h(
        'div',
        {
          class: `om-row${isSelected ? ' is-selected' : ''}${hidden ? ' is-hidden' : ''}${locked ? ' is-locked' : ''}`,
          role: 'treeitem',
          'aria-selected': String(isSelected),
          'aria-level': depth + 1,
          ...(expandable ? { 'aria-expanded': String(isOpen) } : {}),
          draggable: depth === 0 && renaming !== node.key ? 'true' : undefined,
          'data-key': node.key,
        },
        indent(depth),
        expandable
          ? iconButton(isOpen ? 'chevronDown' : 'chevronRight', isOpen ? 'Cerrar' : 'Abrir', () => {
              if (isOpen) open.delete(node.key);
              else open.add(node.key);
              render();
            }, { class: 'icon-button om-toggle' })
          : h('span', { class: 'om-toggle-space' }),
        h('span', { class: 'om-kind' }, icon(kindIcon(node))),
        name,
        iconButton(hidden ? 'eyeOff' : 'eye', hidden ? 'Mostrar' : 'Ocultar (no se ve ni se imprime)', () => editor.setHidden(node.type === 'group' ? node.ids : [node.shape!.id], !hidden), { class: 'icon-button om-eye' }),
        iconButton(locked ? 'lock' : 'unlock', locked ? 'Desbloquear' : 'Bloquear (no se puede elegir ni mover)', () => editor.setLocked(node.ids, !locked), { class: 'icon-button om-lock' }),
      );

      el.addEventListener('click', (event) => {
        if ((event.target as HTMLElement).closest('button, input')) return;
        if (locked || hidden) {
          store.set({ hint: locked ? 'Está bloqueado: desbloquéalo (candado) para elegirlo.' : 'Está oculto: muéstralo (ojo) para elegirlo.' });
          return;
        }
        const pick = node.type === 'group' ? node.ids : [node.shape!.id];
        // Una pieza de grupo o el contenido de un PowerClip se elige sola.
        const exact = depth > 0;
        if (event.shiftKey) editor.select([...new Set([...store.get().selection, ...pick])], exact);
        else editor.select(pick, exact);
      });
      el.addEventListener('dblclick', (event) => {
        if (!node.shape || (event.target as HTMLElement).closest('button')) return;
        renaming = node.key;
        render();
      });

      // Arrastrar para cambiar el orden (solo filas de primer nivel: objetos, grupos o PowerClips enteros).
      if (depth === 0) {
        el.addEventListener('dragstart', (event) => {
          dragged = unit;
          event.dataTransfer?.setData('text/plain', unit.key);
          if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
          el.classList.add('is-dragging');
        });
        el.addEventListener('dragend', () => {
          dragged = null;
          el.classList.remove('is-dragging');
          clearDropMarks();
        });
        el.addEventListener('dragover', (event) => {
          if (!dragged || dragged.key === unit.key) return;
          event.preventDefault();
          const above = event.offsetY < el.offsetHeight / 2;
          clearDropMarks();
          el.classList.add(above ? 'drop-above' : 'drop-below');
        });
        el.addEventListener('drop', (event) => {
          if (!dragged || dragged.key === unit.key) return;
          event.preventDefault();
          const above = event.offsetY < el.offsetHeight / 2;
          editor.moveInStack(new Set(expandIds(shapes, dragged.ids)), new Set(unit.ids), above);
          dragged = null;
          clearDropMarks();
        });
      }
      rows.push(el);
      if (expandable && isOpen) for (const c of node.children) row(c, depth + 1, unit);
    };
    for (const node of tree) row(node, 0, node);
    if (rows.length === 0) rows.push(h('div', { class: 'om-empty' }, 'La página está vacía. Lo que dibujes aparece aquí.'));
    list.replaceChildren(...rows);
    const input = list.querySelector<HTMLInputElement>('.om-rename');
    input?.focus();
    input?.select();
  };

  /** Sangría (por CSSOM: la política de seguridad no deja estilos en línea). */
  const indent = (depth: number) => {
    const span = h('span', { class: 'om-indent' });
    span.style.width = `${depth * 16}px`;
    return span;
  };

  const clearDropMarks = () => list.querySelectorAll('.drop-above, .drop-below').forEach((e) => e.classList.remove('drop-above', 'drop-below'));

  const renameInput = (id: string, current: string) => {
    const input = h('input', { class: 'input om-rename', value: current, 'aria-label': 'Nombre del objeto', maxlength: 120 });
    let done = false;
    const finish = (save: boolean) => {
      if (done) return;
      done = true;
      renaming = null;
      if (save) editor.renameShape(id, input.value);
      render();
    };
    input.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Enter') finish(true);
      if (event.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
    return input;
  };

  store.subscribe((state, previous) => {
    if (state.showObjectManager !== previous.showObjectManager || (state.showObjectManager && (state.document.shapes !== previous.document.shapes || state.selection !== previous.selection || state.document.assets !== previous.document.assets))) {
      if (renaming && state.document.shapes !== previous.document.shapes) renaming = null;
      render();
    }
  });
  render();
  return panel;
}

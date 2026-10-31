import { norm } from '../../engine/finishes';
import type { Shape } from '../../engine/shapes';
import * as editor from '../editor';
import { store } from '../state';
import { h } from './dom';

/**
 * Objeto › Mostrar solo si…: en placas en serie, el objeto elegido (un logo,
 * el yin-yang…) solo sale en las placas cuya columna contiene ese valor.
 * Así una sola plantilla sirve para varias carreras.
 */
export function openConditionDialog(): void {
  const selected = editor.selectedShapes();
  if (selected.length === 0) {
    store.set({ hint: 'Selecciona el objeto (por ejemplo, el logo) que solo debe salir en algunas placas.' });
    return;
  }
  const doc = store.get().document;
  const columns = doc.merge?.columns ?? [];
  const current = selected.find((s) => s.showWhen)?.showWhen;
  const column = h('input', { class: 'input', value: current?.column ?? columns.find((c) => /carrera|facultad|escuela/i.test(norm(c))) ?? columns[1] ?? 'Carrera', list: 'cond-cols', maxlength: 200, 'aria-label': 'Columna' });
  const cols = h('datalist', { id: 'cond-cols' }, ...columns.map((c) => h('option', { value: c })));
  const value = h('input', { class: 'input', value: current?.value ?? '', maxlength: 300, placeholder: 'Ej. Industrial', 'aria-label': 'Valor' });
  const status = h('span', { class: 'export-status' });
  const dialog = h(
    'div',
    { class: 'modal contour-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'cond-title' },
    h('header', { class: 'modal-head' }, h('h2', { id: 'cond-title' }, 'Mostrar solo si…'), h('span', { class: 'modal-sub' }, selected.length === 1 ? (selected[0]!.name ?? 'Objeto elegido') : `${selected.length} objetos`)),
    h(
      'div',
      { class: 'contour-body' },
      h('label', { class: 'field-row' }, h('span', { class: 'field-label' }, 'Si la columna'), column, cols),
      h('label', { class: 'field-row' }, h('span', { class: 'field-label' }, 'contiene'), value),
      h('p', { class: 'export-note' }, 'Ejemplo: pon los dos logos encimados. Al de Ingeniería: Carrera contiene "Industrial". Al de Administración: Carrera contiene "Contaduría|Administración" (con | separas varias opciones). En las demás placas el objeto no sale.'),
    ),
    h(
      'footer',
      { class: 'modal-foot' },
      h('button', { type: 'button', class: 'button', disabled: !current, onclick: () => apply(null) }, 'Quitar condición'),
      status,
      h('button', { type: 'button', class: 'button', onclick: () => close() }, 'Cancelar'),
      h('button', { type: 'button', class: 'button primary', onclick: () => apply({ column: column.value.trim(), value: value.value.trim() }) }, 'Aplicar'),
    ),
  );
  const backdrop = h('div', { class: 'modal-backdrop' }, dialog);
  document.body.append(backdrop);
  backdrop.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') close();
    if (e.key === 'Enter') apply({ column: column.value.trim(), value: value.value.trim() });
  });
  value.focus();
  function close() {
    backdrop.remove();
  }
  function apply(cond: { column: string; value: string } | null) {
    if (cond && (!cond.column || !cond.value)) {
      status.textContent = 'Escribe la columna y el valor.';
      return;
    }
    const ids = new Set(selected.map((s) => s.id));
    const shapes = store.get().document.shapes.map((s): Shape => {
      if (!ids.has(s.id)) return s;
      if (cond) return { ...s, showWhen: cond };
      const { showWhen: _drop, ...rest } = s;
      return rest as Shape;
    });
    editor.commit(cond ? 'Mostrar solo si…' : 'Quitar condición', shapes);
    store.set({ hint: cond ? `Solo sale si “${cond.column}” contiene “${cond.value}”. Revísalo en Placas en serie.` : 'El objeto sale en todas las placas.' });
    close();
  }
}

import { pageDocument, allPages } from '../../engine/document';
import { DEFAULT_EXPORT } from '../../engine/export';
import { preflight } from '../../engine/preflight';
import * as editor from '../editor';
import { renderPreview } from '../exporter';
import { store } from '../state';
import { h } from './dom';

/**
 * Vista de todas las páginas (Diseño › Ver todas las páginas): miniaturas de
 * cada placa con sus avisos (foto borrosa, texto fuera del margen…). Un clic
 * lleva a esa página para corregirla; las demás no se tocan.
 */
export function openPagesOverview(): void {
  const doc = store.get().document;
  const pages = allPages(doc);
  const current = editor.pageIndex();
  const grid = h('div', { class: 'pages-grid', role: 'list' });
  const filter = h('input', { class: 'input', type: 'search', placeholder: 'Buscar por nombre…', 'aria-label': 'Buscar página' });
  const onlyIssues = h('input', { type: 'checkbox', 'aria-label': 'Solo las que tienen avisos' });
  const summary = h('span', { class: 'export-note' });

  const cards = pages.map((page, i) => {
    const pdoc = pageDocument(doc, i);
    const issues = preflight(pdoc).filter((x) => x.level !== 'info');
    const errors = issues.filter((x) => x.level === 'error').length;
    const canvas = h('canvas', { class: 'page-thumb', 'aria-hidden': 'true' });
    const badge = issues.length ? h('span', { class: `page-badge${errors ? ' is-error' : ''}`, title: issues.map((x) => `• ${x.message}`).join('\n') }, `⚠ ${issues.length}`) : h('span', { class: 'page-badge is-ok', title: 'Sin avisos' }, '✓');
    const card = h(
      'button',
      { type: 'button', class: `page-card${i === current ? ' is-current' : ''}`, role: 'listitem', title: `${page.name} · clic para editar esta página`, onclick: () => (close(), editor.goToPage(i)) },
      h('div', { class: 'page-thumb-wrap' }, canvas, badge),
      h('span', { class: 'page-card-name' }, `${i + 1}. ${page.name}`),
    );
    return { card, canvas, pdoc, name: page.name.toLowerCase(), hasIssues: issues.length > 0 };
  });
  grid.append(...cards.map((c) => c.card));
  const withIssues = cards.filter((c) => c.hasIssues).length;
  summary.textContent = `${pages.length} ${pages.length === 1 ? 'página' : 'páginas'}${withIssues ? ` · ${withIssues} con avisos (pasa el ratón sobre ⚠ para verlos)` : ' · sin avisos'}`;

  const applyFilter = () => {
    const q = filter.value.trim().toLowerCase();
    for (const c of cards) c.card.hidden = (q !== '' && !c.name.includes(q)) || (onlyIssues.checked && !c.hasIssues);
  };
  filter.addEventListener('input', applyFilter);
  onlyIssues.addEventListener('change', applyFilter);

  const dialog = h(
    'div',
    { class: 'modal pages-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'pages-title' },
    h('header', { class: 'modal-head' }, h('h2', { id: 'pages-title' }, 'Todas las páginas'), summary),
    h('div', { class: 'pages-tools' }, filter, h('label', { class: 'check' }, onlyIssues, h('span', {}, 'Solo las que tienen avisos'))),
    grid,
    h('footer', { class: 'modal-foot' }, h('span', { class: 'export-status' }, 'Clic en una placa para corregirla. Los cambios solo afectan a esa página.'), h('button', { type: 'button', class: 'button', onclick: () => close() }, 'Cerrar')),
  );
  const backdrop = h('div', { class: 'modal-backdrop' }, dialog);
  document.body.append(backdrop);
  backdrop.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key === 'Escape') close();
  });
  backdrop.addEventListener('pointerdown', (event) => {
    if (event.target === backdrop) close();
  });
  let open = true;
  function close() {
    open = false;
    backdrop.remove();
  }
  filter.focus();

  // Miniaturas una por una (no congela la ventana con muchas placas).
  void (async () => {
    for (const c of cards) {
      if (!open) return;
      await renderPreview(c.canvas, c.pdoc, { ...DEFAULT_EXPORT, bleed: false, mirror: false, cropMarks: false, background: 'white' }, 150, 190);
      await new Promise((r) => setTimeout(r, 0));
    }
  })();
}

import { contourSelection } from '../shape-commands';
import { store } from '../state';
import { h } from './dom';
import { DEFAULT_PALETTE } from './palette';

/**
 * Ventana "Contorno": crea una figura alrededor (o dentro) de lo seleccionado, a
 * una distancia en mm, con esquinas redondeadas. Muy usado en placas para que
 * un texto o un logo resalte sobre la foto (un borde blanco o dorado detrás).
 */

const STORAGE_KEY = 'trazo.contour.v1';

interface Saved {
  distance: number;
  direction: 'outside' | 'inside';
  fill: string | null;
}

function load(): Saved {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<Saved> | null;
    if (raw) return { distance: typeof raw.distance === 'number' && raw.distance > 0 ? raw.distance : 2, direction: raw.direction === 'inside' ? 'inside' : 'outside', fill: typeof raw.fill === 'string' || raw.fill === null ? raw.fill : '#FFFFFF' };
  } catch {
    // valores por defecto
  }
  return { distance: 2, direction: 'outside', fill: '#FFFFFF' };
}

export function openContourDialog(): void {
  if (store.get().selection.length === 0) {
    store.set({ hint: 'Selecciona un texto, un logo o una figura para hacerle contorno.' });
    return;
  }
  const options = load();
  const distance = h('input', { class: 'input number', type: 'number', min: 0.1, step: 0.5, value: options.distance, 'aria-label': 'Distancia en milímetros' });
  const dirButtons = (['outside', 'inside'] as const).map((d) =>
    h('button', { type: 'button', class: 'segment', 'aria-pressed': String(options.direction === d), onclick: () => setDirection(d) }, d === 'outside' ? 'Exterior' : 'Interior'),
  );
  const color = h(
    'select',
    { class: 'input', 'aria-label': 'Color del contorno' },
    h('option', { value: '' }, 'Sin relleno'),
    ...DEFAULT_PALETTE.map((s) => h('option', { value: s.hex }, s.name)),
  );
  color.value = options.fill ?? '';
  const chip = h('span', { class: 'color-chip' });
  const paintChip = () => {
    chip.style.background = color.value || 'transparent';
    chip.classList.toggle('is-none', !color.value);
  };
  color.addEventListener('change', paintChip);
  paintChip();
  const status = h('div', { class: 'export-status', role: 'status' });

  function setDirection(d: 'outside' | 'inside') {
    options.direction = d;
    dirButtons.forEach((b, i) => b.setAttribute('aria-pressed', String((i === 0 ? 'outside' : 'inside') === d)));
  }

  const apply = h('button', { type: 'button', class: 'button primary', onclick: () => void submit() }, 'Aplicar');
  const dialog = h(
    'div',
    { class: 'modal contour-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'contour-title' },
    h('header', { class: 'modal-head' }, h('h2', { id: 'contour-title' }, 'Contorno')),
    h(
      'div',
      { class: 'contour-body' },
      h('p', { class: 'export-note' }, 'Crea una figura alrededor de lo seleccionado, con esquinas redondeadas. Ideal para un borde blanco detrás de un texto o un logo.'),
      h('label', { class: 'field-row' }, h('span', { class: 'field-label' }, 'Distancia'), h('span', { class: 'prop-field' }, distance, h('span', { class: 'prop-suffix' }, 'mm'))),
      h('div', { class: 'field-row' }, h('span', { class: 'field-label' }, 'Hacia'), h('div', { class: 'segments two' }, ...dirButtons)),
      h('label', { class: 'field-row' }, h('span', { class: 'field-label' }, 'Color'), h('span', { class: 'prop-field' }, chip, color)),
    ),
    h('footer', { class: 'modal-foot' }, status, h('button', { type: 'button', class: 'button', onclick: () => close() }, 'Cancelar'), apply),
  );
  const backdrop = h('div', { class: 'modal-backdrop' }, dialog);
  document.body.append(backdrop);
  backdrop.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key === 'Escape') close();
    if (event.key === 'Enter') void submit();
  });
  backdrop.addEventListener('pointerdown', (event) => {
    if (event.target === backdrop) close();
  });
  distance.focus();
  distance.select();

  function close() {
    backdrop.remove();
  }

  async function submit() {
    const d = Number(distance.value.replace(',', '.'));
    if (!(d > 0 && d <= 200)) {
      status.textContent = 'Escribe una distancia entre 0.1 y 200 mm.';
      return;
    }
    options.distance = d;
    options.fill = color.value || null;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(options));
    } catch {
      // no se recuerda, no pasa nada
    }
    apply.disabled = true;
    status.textContent = 'Calculando…';
    close();
    await contourSelection(options);
  }
}

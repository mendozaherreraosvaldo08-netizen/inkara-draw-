import type { AlignMode } from '../../engine/arrange';
import * as editor from '../editor';
import { DEFAULT_PALETTE } from './palette';
import { h, icon } from './dom';
import type { IconName } from './icons';

/** Alinear y distribuir: con un objeto, respecto de la página; con varios, entre ellos. */
export function alignPanel(close: () => void): HTMLElement {
  const item = (name: IconName, label: string, key: string, run: () => void) =>
    h('button', { type: 'button', class: 'pop-item', title: `${label} (${key})`, onclick: () => (run(), close()) }, icon(name), h('span', {}, label), h('kbd', {}, key));
  const a = (mode: AlignMode) => () => editor.align(mode);
  const single = editor.selectedShapes().length > 0 && new Set(editor.selectedShapes().map((s) => s.groupId ?? s.id)).size === 1;
  return h(
    'div',
    { class: 'pop-list' },
    h('div', { class: 'menu-group' }, single ? 'Alinear con la página' : 'Alinear entre sí'),
    item('alignObjLeft', 'Izquierda', 'L', a('left')),
    item('alignObjCenterX', 'Centro horizontal', 'E', a('center-x')),
    item('alignObjRight', 'Derecha', 'R', a('right')),
    item('alignObjTop', 'Arriba', 'T', a('top')),
    item('alignObjCenterY', 'Centro vertical', 'C', a('center-y')),
    item('alignObjBottom', 'Abajo', 'B', a('bottom')),
    item('alignPage', 'Centrar en la página', 'P', a('page-center')),
    h('div', { class: 'menu-group' }, 'Distribuir (3 o más)'),
    item('distributeX', 'Mismo espacio en horizontal', 'Mayús+H', () => editor.distribute('x')),
    item('distributeY', 'Mismo espacio en vertical', 'Mayús+V', () => editor.distribute('y')),
  );
}

const FADES: Array<{ id: string; label: string; angle: number }> = [
  { id: 'none', label: 'Sin desvanecer', angle: 0 },
  { id: 'down', label: 'Se desvanece hacia abajo', angle: 270 },
  { id: 'up', label: 'Se desvanece hacia arriba', angle: 90 },
  { id: 'right', label: 'Se desvanece a la derecha', angle: 0 },
  { id: 'left', label: 'Se desvanece a la izquierda', angle: 180 },
];

/**
 * Relleno (sólido, degradado lineal o radial) y transparencia (uniforme o
 * desvanecida) del objeto seleccionado. Cada cambio se puede deshacer.
 */
export function fillPanel(): HTMLElement {
  const first = () => editor.selectedShapes()[0];
  const s = first();
  const type = s?.gradient ? s.gradient.type : s?.fill ? 'solid' : 'none';
  const c1 = h('input', { type: 'color', 'aria-label': 'Color 1', value: s?.gradient?.stops[0]?.color ?? s?.fill ?? '#C9A227' });
  const c2 = h('input', { type: 'color', 'aria-label': 'Color 2', value: s?.gradient?.stops[s.gradient.stops.length - 1]?.color ?? '#FFFFFF' });
  const angle = h('input', { class: 'input number', type: 'number', step: 15, value: s?.gradient?.angle ?? 90, 'aria-label': 'Ángulo del degradado' });
  const types = (['solid', 'linear', 'radial', 'none'] as const).map((t) => h('button', { type: 'button', class: 'segment', 'aria-pressed': String(t === type), onclick: () => setType(t) }, { solid: 'Sólido', linear: 'Lineal', radial: 'Radial', none: 'Ninguno' }[t]));
  let current: 'solid' | 'linear' | 'radial' | 'none' = type;
  const c1Label = h('span', { class: 'field-label pop-label' }, 'Color');
  const gradientRow = h('div', { class: 'pop-row' }, h('span', { class: 'field-label pop-label' }, 'Hasta'), c2, h('label', { class: 'prop-field' }, h('span', { class: 'prop-label' }, 'Ángulo'), angle, h('span', { class: 'prop-suffix' }, '°')));
  const swatches = h('div', { class: 'pop-swatches' }, ...['#C9A227', '#E9CF7A', '#A67C00', '#C0C0C0', '#FFFFFF', '#000000', '#0B1F4B', '#6D0F2E'].map((hex) => {
    const b = h('button', { type: 'button', class: 'swatch', title: DEFAULT_PALETTE.find((p) => p.hex === hex)?.name ?? hex, onclick: () => ((c1.value = hex), apply()) });
    b.style.setProperty('--swatch', hex);
    return b;
  }));
  const opacity = h('input', { type: 'range', min: 0, max: 100, step: 5, value: Math.round((1 - (s?.opacity ?? 1)) * 100), 'aria-label': 'Transparencia' });
  const opacityLabel = h('span', { class: 'prop-info' });
  const fade = h('select', { class: 'input', 'aria-label': 'Desvanecer' }, ...FADES.map((f) => h('option', { value: f.id }, f.label)));
  fade.value = s?.fade ? (FADES.find((f) => f.id !== 'none' && f.angle === s.fade!.angle)?.id ?? 'down') : 'none';

  const paintLabel = () => (opacityLabel.textContent = `${opacity.value} % transparente`);
  paintLabel();
  function setType(t: typeof current) {
    current = t;
    types.forEach((b, i) => b.setAttribute('aria-pressed', String((['solid', 'linear', 'radial', 'none'] as const)[i] === t)));
    gradientRow.hidden = t === 'solid' || t === 'none';
    c1Label.textContent = t === 'linear' || t === 'radial' ? 'Desde' : 'Color';
    apply();
  }
  function apply() {
    if (current === 'none') {
      editor.setGradient(null);
      editor.setFill(null, 'sin relleno');
    } else if (current === 'solid') {
      editor.setFill(c1.value.toUpperCase(), c1.value.toUpperCase());
    } else {
      editor.setGradient({ type: current, angle: Number(angle.value) || 0, stops: [{ offset: 0, color: c1.value.toUpperCase() }, { offset: 1, color: c2.value.toUpperCase() }] });
    }
  }
  c1.addEventListener('change', apply);
  c2.addEventListener('change', apply);
  angle.addEventListener('change', apply);
  opacity.addEventListener('input', paintLabel);
  opacity.addEventListener('change', () => editor.setOpacity(1 - Number(opacity.value) / 100));
  fade.addEventListener('change', () => {
    const f = FADES.find((x) => x.id === fade.value)!;
    editor.setFade(f.id === 'none' ? null : { angle: f.angle, from: 1, to: 0 });
  });
  gradientRow.hidden = type === 'solid' || type === 'none';
  if (!gradientRow.hidden) c1Label.textContent = 'Desde';
  return h(
    'div',
    { class: 'pop-form' },
    h('div', { class: 'field-label' }, 'Relleno'),
    h('div', { class: 'segments' }, ...types),
    h('div', { class: 'pop-row' }, c1Label, c1, swatches),
    gradientRow,
    h('div', { class: 'field-label' }, 'Transparencia'),
    h('div', { class: 'pop-row' }, opacity, opacityLabel),
    h('div', { class: 'pop-row' }, fade),
    h('div', { class: 'export-note' }, 'Desvanecer: el objeto pasa de opaco a transparente (por ejemplo, una foto que se funde con el fondo).'),
  );
}

const DIRECTIONS: Array<{ id: string; label: string; x: number; y: number }> = [
  { id: 'br', label: '↘ Abajo a la derecha', x: 1, y: 1 },
  { id: 'b', label: '↓ Abajo', x: 0, y: 1 },
  { id: 'bl', label: '↙ Abajo a la izquierda', x: -1, y: 1 },
  { id: 'r', label: '→ Derecha', x: 1, y: 0 },
  { id: 'c', label: '● Alrededor (resplandor)', x: 0, y: 0 },
];

/** Sombra paralela: dirección, distancia, difuminado, color y opacidad. */
export function shadowPanel(): HTMLElement {
  const s = editor.selectedShapes()[0];
  const current = s?.shadow ?? null;
  const base = current ?? editor.DEFAULT_SHADOW;
  const enabled = h('input', { type: 'checkbox', 'aria-label': 'Con sombra', checked: !!current });
  const dist = Math.hypot(base.dx, base.dy);
  const direction = h('select', { class: 'input', 'aria-label': 'Dirección de la sombra' }, ...DIRECTIONS.map((d) => h('option', { value: d.id }, d.label)));
  direction.value = DIRECTIONS.reduce((best, d) => {
    const len = Math.hypot(d.x, d.y) || 1;
    const score = dist < 1e-6 ? (d.id === 'c' ? 1 : 0) : (d.x / len) * (base.dx / dist) + (d.y / len) * (base.dy / dist);
    return score > best.score ? { id: d.id, score } : best;
  }, { id: 'br', score: -2 }).id;
  const distance = h('input', { class: 'input number', type: 'number', min: 0, max: 50, step: 0.5, value: Math.round(dist * 10) / 10, 'aria-label': 'Distancia de la sombra en mm' });
  const blur = h('input', { class: 'input number', type: 'number', min: 0, max: 50, step: 0.5, value: base.blur, 'aria-label': 'Difuminado de la sombra en mm' });
  const color = h('input', { type: 'color', value: base.color, 'aria-label': 'Color de la sombra' });
  const opacity = h('input', { type: 'range', min: 5, max: 100, step: 5, value: Math.round(base.opacity * 100), 'aria-label': 'Opacidad de la sombra' });
  const opacityLabel = h('span', { class: 'prop-info' });
  const paintLabel = () => (opacityLabel.textContent = `${opacity.value} %`);
  paintLabel();
  const apply = () => {
    if (!enabled.checked) {
      editor.setShadow(null);
      return;
    }
    const d = DIRECTIONS.find((x) => x.id === direction.value)!;
    const len = Math.hypot(d.x, d.y) || 1;
    const k = (Number(distance.value) || 0) / len;
    editor.setShadow({ dx: d.x * k, dy: d.y * k, blur: Math.max(0, Number(blur.value) || 0), color: color.value.toUpperCase(), opacity: Number(opacity.value) / 100 });
  };
  for (const el of [direction, distance, blur, color, opacity]) {
    el.addEventListener('change', () => {
      enabled.checked = true;
      apply();
    });
  }
  opacity.addEventListener('input', paintLabel);
  enabled.addEventListener('change', apply);
  return h(
    'div',
    { class: 'pop-form' },
    h('label', { class: 'check' }, enabled, h('span', {}, 'Sombra paralela', h('small', {}, 'Da relieve a textos y fotos sobre el fondo.'))),
    h('div', { class: 'pop-row' }, direction),
    h('div', { class: 'pop-row' }, h('span', { class: 'field-label pop-label' }, 'Distancia'), distance, h('span', { class: 'prop-suffix' }, 'mm'), h('span', { class: 'field-label' }, 'Difuminado'), blur, h('span', { class: 'prop-suffix' }, 'mm')),
    h('div', { class: 'pop-row' }, h('span', { class: 'field-label pop-label' }, 'Color'), color, opacity, opacityLabel),
  );
}

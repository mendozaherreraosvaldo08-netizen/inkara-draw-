import { cmykToRgb, parseHex, rgbToCmyk, toHex, type Cmyk, type Rgb } from '../../engine/color';
import * as editor from '../editor';
import { store } from '../state';
import { h } from './dom';
import { addCustomSwatch } from './palette';

/**
 * Selector de color: CMYK (como en un manual de marca o lo que pide un
 * cliente), RGB y hexadecimal, todo sincronizado. El color va al relleno o al
 * contorno de lo seleccionado; sin selección, queda para los objetos nuevos.
 */
export function openColorDialog(target: 'fill' | 'outline'): void {
  const state = store.get();
  const first = editor.selectedShapes()[0];
  const startHex = (first ? (target === 'fill' ? (first.gradient?.stops[0]?.color ?? first.fill) : first.stroke) : (target === 'fill' ? state.fill?.hex : state.outline?.hex)) ?? '#000000';
  let rgb: Rgb = parseHex(startHex) ?? { r: 0, g: 0, b: 0 };
  let cmyk: Cmyk = rgbToCmyk(rgb);

  const before = h('span', { class: 'color-swatch-big', title: `Antes: ${startHex}` });
  before.style.background = startHex;
  const after = h('span', { class: 'color-swatch-big' });

  const slider = (label: string, key: keyof Cmyk, track: string) => {
    const range = h('input', { type: 'range', min: 0, max: 100, step: 1, class: 'color-range', 'aria-label': `${label} (%)` });
    range.style.setProperty('--track', track);
    const num = h('input', { class: 'input number color-num', type: 'number', min: 0, max: 100, step: 1, 'aria-label': `${label} en por ciento` });
    const set = (v: number) => {
      cmyk = { ...cmyk, [key]: Math.round(Math.min(100, Math.max(0, v || 0))) };
      rgb = cmykToRgb(cmyk);
      paint(key);
    };
    range.addEventListener('input', () => set(Number(range.value)));
    num.addEventListener('input', () => set(Number(num.value)));
    return { row: h('label', { class: 'color-row', title: label }, h('span', { class: 'color-key' }, key.toUpperCase()), range, num, h('span', { class: 'prop-suffix' }, '%')), range, num, key };
  };
  const cmykRows = [
    slider('Cian', 'c', 'linear-gradient(90deg, #fff, #00aeef)'),
    slider('Magenta', 'm', 'linear-gradient(90deg, #fff, #ec008c)'),
    slider('Amarillo', 'y', 'linear-gradient(90deg, #fff, #fff200)'),
    slider('Negro (K)', 'k', 'linear-gradient(90deg, #fff, #000)'),
  ];
  const rgbInputs = (['r', 'g', 'b'] as const).map((key) => {
    const input = h('input', { class: 'input number color-num', type: 'number', min: 0, max: 255, step: 1, 'aria-label': { r: 'Rojo', g: 'Verde', b: 'Azul' }[key] });
    input.addEventListener('input', () => {
      rgb = { ...rgb, [key]: Math.round(Math.min(255, Math.max(0, Number(input.value) || 0))) };
      cmyk = rgbToCmyk(rgb);
      paint(key);
    });
    return { key, input };
  });
  const hex = h('input', { class: 'input color-hex', 'aria-label': 'Color hexadecimal', maxlength: 7, spellcheck: false });
  hex.addEventListener('input', () => {
    const parsed = parseHex(hex.value);
    if (!parsed) return;
    rgb = parsed;
    cmyk = rgbToCmyk(rgb);
    paint('hex');
  });
  const name = h('input', { class: 'input', placeholder: 'Nombre (opcional), p. ej. Azul de la escuela', 'aria-label': 'Nombre del color', maxlength: 40 });

  /** Repinta todo menos el campo que el usuario está escribiendo. */
  function paint(source: string) {
    const value = toHex(rgb);
    after.style.background = value;
    after.title = `Nuevo: ${value}`;
    for (const r of cmykRows) {
      if (source !== r.key) r.num.value = String(cmyk[r.key]);
      r.range.value = String(cmyk[r.key]);
    }
    for (const r of rgbInputs) if (source !== r.key) r.input.value = String(rgb[r.key]);
    if (source !== 'hex') hex.value = value;
  }

  const label = () => name.value.trim() || `C${cmyk.c} M${cmyk.m} Y${cmyk.y} K${cmyk.k}`;
  const apply = () => {
    const value = toHex(rgb);
    const swatch = { name: label(), hex: value };
    if (store.get().selection.length > 0) {
      if (target === 'fill') editor.setFill(value, swatch.name);
      else editor.setStroke(value, swatch.name);
    } else {
      store.set(target === 'fill' ? { fill: swatch, hint: `Relleno para objetos nuevos: ${swatch.name}` } : { outline: swatch, hint: `Contorno para objetos nuevos: ${swatch.name}` });
    }
    close();
  };

  const dialog = h(
    'div',
    { class: 'modal color-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'color-title' },
    h('header', { class: 'modal-head' }, h('h2', { id: 'color-title' }, target === 'fill' ? 'Color de relleno' : 'Color de contorno')),
    h(
      'div',
      { class: 'color-body' },
      h('div', { class: 'color-compare' }, h('div', {}, before, h('small', {}, 'Antes')), h('div', {}, after, h('small', {}, 'Nuevo'))),
      h('div', { class: 'field-label' }, 'CMYK'),
      ...cmykRows.map((r) => r.row),
      h('div', { class: 'field-label' }, 'RGB y hexadecimal'),
      h('div', { class: 'color-row' }, ...rgbInputs.flatMap((r) => [h('span', { class: 'color-key' }, r.key.toUpperCase()), r.input]), hex),
      name,
      h('p', { class: 'export-note' }, 'Los valores CMYK son una conversión estándar: la impresora de sublimación recibe RGB y su controlador hace la conversión final.'),
    ),
    h(
      'footer',
      { class: 'modal-foot' },
      h('span', { class: 'export-status' }),
      h('button', { type: 'button', class: 'button', onclick: (event: Event) => {
        addCustomSwatch({ name: label(), hex: toHex(rgb) });
        (event.currentTarget as HTMLButtonElement).textContent = 'Agregado ✓';
        store.set({ hint: `Agregado a la paleta: ${label()} (Mayús+clic en él para quitarlo)` });
      } }, 'Agregar a la paleta'),
      h('button', { type: 'button', class: 'button', onclick: () => close() }, 'Cancelar'),
      h('button', { type: 'button', class: 'button primary', onclick: apply }, 'Aplicar'),
    ),
  );
  const backdrop = h('div', { class: 'modal-backdrop' }, dialog);
  document.body.append(backdrop);
  backdrop.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key === 'Escape') close();
    if (event.key === 'Enter' && (event.target as HTMLElement).tagName !== 'BUTTON') apply();
  });
  backdrop.addEventListener('pointerdown', (event) => {
    if (event.target === backdrop) close();
  });
  function close() {
    backdrop.remove();
  }
  paint('');
  cmykRows[0]!.num.focus();
  cmykRows[0]!.num.select();
}

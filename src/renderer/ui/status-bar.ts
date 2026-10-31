import { formatLength } from '../../engine/units';
import { selectedShapes } from '../editor';
import { store } from '../state';
import { DEFAULT_PALETTE } from './palette';

/** Nombre del color si está en la paleta; si no, su código. */
const swatchFor = (hex: string | null) => (hex ? (DEFAULT_PALETTE.find((s) => s.hex.toLowerCase() === hex.toLowerCase()) ?? { name: hex.toUpperCase(), hex }) : null);
import { openColorDialog } from './color-dialog';
import { h } from './dom';

/** Barra de estado: posición del cursor, mensaje de la herramienta y colores actuales. */
export function createStatusBar(): HTMLElement {
  const position = h('span', { class: 'status-pos' });
  const hint = h('span', { class: 'status-hint' });
  const fill = h('span', { class: 'status-color', title: 'Relleno' });
  const outline = h('span', { class: 'status-color status-outline', title: 'Contorno' });
  const fillLabel = h('span', { class: 'status-label' }, 'Relleno');
  const fillText = h('span', {});
  const outlineText = h('span', {});

  const paintColor = (chip: HTMLElement, text: HTMLElement, swatch: { name: string; hex: string } | null) => {
    chip.classList.toggle('is-none', !swatch);
    chip.style.setProperty('--swatch', swatch ? swatch.hex : 'transparent');
    text.textContent = swatch ? swatch.name : 'Ninguno';
  };

  const paint = () => {
    const state = store.get();
    const unit = state.document.unit;
    position.textContent = state.cursorMm
      ? `( ${formatLength(state.cursorMm.x, unit)} ; ${formatLength(state.cursorMm.y, unit)} ) ${unit}`
      : '';
    hint.textContent = state.hint;
    // Con un objeto seleccionado se ven sus colores; si no, los de los objetos nuevos.
    const first = selectedShapes()[0];
    fillLabel.textContent = first ? 'Relleno' : 'Relleno nuevo';
    paintColor(fill, fillText, first ? swatchFor(first.fill) : state.fill);
    if (first?.gradient) {
      const stops = first.gradient.stops.map((s) => s.color).join(', ');
      fill.classList.remove('is-none');
      fill.style.setProperty('--swatch', `linear-gradient(90deg, ${stops})`);
      fillText.textContent = first.gradient.type === 'radial' ? 'Degradado radial' : 'Degradado lineal';
    }
    if (first && (first.opacity !== undefined || first.fade)) fillText.textContent += first.fade ? ' · desvanecido' : ` · ${Math.round((1 - first.opacity!) * 100)} % transp.`;
    paintColor(outline, outlineText, first ? (first.stroke ? { name: `${swatchFor(first.stroke)!.name} · ${Math.round(first.strokeWidth * 100) / 100} mm`, hex: first.stroke } : null) : state.outline);
  };
  store.subscribe(paint);
  paint();

  // Doble clic en el color (como en los editores vectoriales): abre el selector de color.
  for (const [el, target] of [[fill, 'fill'], [fillText, 'fill'], [outline, 'outline'], [outlineText, 'outline']] as const) {
    el.addEventListener('dblclick', () => openColorDialog(target));
    el.title = target === 'fill' ? 'Relleno · doble clic: elegir color (CMYK, RGB…)' : 'Contorno · doble clic: elegir color (CMYK, RGB…)';
  }
  return h(
    'footer',
    { class: 'statusbar' },
    position,
    hint,
    h('span', { class: 'status-colors' }, fillLabel, fill, fillText, h('span', { class: 'status-label' }, 'Contorno'), outline, outlineText),
  );
}

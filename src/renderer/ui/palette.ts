import * as editor from '../editor';
import { store, type Swatch } from '../state';
import { h, icon, iconButton } from './dom';
import { openColorDialog } from './color-dialog';

/**
 * Paleta de colores vertical (derecha). Clic izquierdo = relleno; clic
 * derecho = contorno, como en los editores vectoriales de siempre.
 * Colores pensados para impresión: grises, primarios CMYK y metálicos simulados
 * (dorado y plata son muy usados en placas de graduación).
 */
export const DEFAULT_PALETTE: Swatch[] = [
  { name: 'Negro', hex: '#000000' },
  { name: 'Gris 90 %', hex: '#1A1A1A' },
  { name: 'Gris 70 %', hex: '#4D4D4D' },
  { name: 'Gris 50 %', hex: '#808080' },
  { name: 'Gris 30 %', hex: '#B3B3B3' },
  { name: 'Gris 10 %', hex: '#E6E6E6' },
  { name: 'Blanco', hex: '#FFFFFF' },
  { name: 'Cian', hex: '#00AEEF' },
  { name: 'Magenta', hex: '#EC008C' },
  { name: 'Amarillo', hex: '#FFF200' },
  { name: 'Rojo', hex: '#ED1C24' },
  { name: 'Rojo oscuro', hex: '#9E0B0F' },
  { name: 'Naranja', hex: '#F7941D' },
  { name: 'Verde', hex: '#00A651' },
  { name: 'Verde oscuro', hex: '#005E20' },
  { name: 'Azul', hex: '#2E3192' },
  { name: 'Azul marino', hex: '#0B1F4B' },
  { name: 'Azul cielo', hex: '#7FD3F7' },
  { name: 'Violeta', hex: '#662D91' },
  { name: 'Lila', hex: '#B79FD1' },
  { name: 'Rosa', hex: '#F49AC1' },
  { name: 'Vino', hex: '#6D0F2E' },
  { name: 'Café', hex: '#754C24' },
  { name: 'Beige', hex: '#E8D9B5' },
  { name: 'Dorado', hex: '#C9A227' },
  { name: 'Dorado claro', hex: '#E9CF7A' },
  { name: 'Oro viejo', hex: '#A67C00' },
  { name: 'Plata', hex: '#C0C0C0' },
  { name: 'Bronce', hex: '#B08D57' },
  { name: 'Turquesa', hex: '#00A99D' },
];

const CUSTOM_KEY = 'trazo.palette.custom.v1';

/** Colores que el usuario agregó (selector de color › Agregar a la paleta). */
function loadCustom(): Swatch[] {
  try {
    const raw = JSON.parse(localStorage.getItem(CUSTOM_KEY) ?? '[]') as unknown;
    if (Array.isArray(raw)) {
      return raw
        .filter((s): s is Swatch => !!s && typeof s.name === 'string' && typeof s.hex === 'string' && /^#[0-9A-F]{6}$/i.test(s.hex))
        .slice(0, 60)
        .map((s) => ({ name: s.name.slice(0, 40), hex: s.hex.toUpperCase() }));
    }
  } catch {
    // sin almacenamiento: sin colores propios
  }
  return [];
}

function saveCustom(list: Swatch[]): void {
  try {
    localStorage.setItem(CUSTOM_KEY, JSON.stringify(list));
  } catch {
    // no se pudo recordar
  }
}

let repaintCustom: () => void = () => undefined;

export function addCustomSwatch(swatch: Swatch): void {
  const list = loadCustom().filter((s) => s.hex !== swatch.hex.toUpperCase());
  list.push({ name: swatch.name, hex: swatch.hex.toUpperCase() });
  saveCustom(list.slice(-60));
  repaintCustom();
}

export function createPalette(): HTMLElement {
  const list = h('div', { class: 'palette-list', role: 'listbox', 'aria-label': 'Colores' });

  // Con objetos seleccionados el color se les aplica a ellos; sin selección, cambia
  // el color por defecto de los objetos nuevos.
  const choose = (swatch: Swatch | null, target: 'fill' | 'outline') => {
    const name = swatch ? swatch.name : 'sin color';
    if (store.get().selection.length > 0) {
      if (target === 'fill') editor.setFill(swatch?.hex ?? null, name);
      else editor.setStroke(swatch?.hex ?? null, name);
      return;
    }
    const what = target === 'fill' ? 'Relleno' : 'Contorno';
    store.set({ [target]: swatch, hint: `${what} por defecto para objetos nuevos: ${swatch ? `${swatch.name} (${swatch.hex})` : 'sin color'}` });
  };

  const noColor = h(
    'button',
    {
      type: 'button',
      class: 'swatch swatch-none',
      title: 'Sin color (clic: sin relleno · clic derecho: sin contorno)',
      'aria-label': 'Sin color',
      onclick: () => choose(null, 'fill'),
      oncontextmenu: ((event: MouseEvent) => {
        event.preventDefault();
        choose(null, 'outline');
      }) as EventListener,
    },
    icon('noColor'),
  );
  list.append(noColor);

  for (const swatch of DEFAULT_PALETTE) {
    const button = h('button', {
      type: 'button',
      class: 'swatch',
      title: `${swatch.name} ${swatch.hex} (clic: relleno · clic derecho: contorno)`,
      'aria-label': swatch.name,
      onclick: () => choose(swatch, 'fill'),
      oncontextmenu: ((event: MouseEvent) => {
        event.preventDefault();
        choose(swatch, 'outline');
      }) as EventListener,
    });
    button.style.setProperty('--swatch', swatch.hex);
    list.append(button);
  }

  // Colores propios (después de los de siempre) y el botón para crear uno.
  const custom = h('div', { class: 'palette-custom' });
  repaintCustom = () => {
    custom.replaceChildren(
      ...loadCustom().map((swatch) => {
        const button = h('button', {
          type: 'button',
          class: 'swatch swatch-custom',
          title: `${swatch.name} ${swatch.hex} (clic: relleno · clic derecho: contorno · Mayús+clic: quitar de la paleta)`,
          'aria-label': swatch.name,
          onclick: ((event: MouseEvent) => {
            if (event.shiftKey) {
              saveCustom(loadCustom().filter((s) => s.hex !== swatch.hex));
              repaintCustom();
              store.set({ hint: `Quitado de la paleta: ${swatch.name}` });
            } else choose(swatch, 'fill');
          }) as EventListener,
          oncontextmenu: ((event: MouseEvent) => {
            event.preventDefault();
            choose(swatch, 'outline');
          }) as EventListener,
        });
        button.style.setProperty('--swatch', swatch.hex);
        return button;
      }),
    );
  };
  repaintCustom();
  const more = h(
    'button',
    {
      type: 'button',
      class: 'swatch swatch-more',
      title: 'Más colores: CMYK, RGB o hexadecimal (clic: relleno · clic derecho: contorno)',
      'aria-label': 'Más colores',
      onclick: () => openColorDialog('fill'),
      oncontextmenu: ((event: MouseEvent) => {
        event.preventDefault();
        openColorDialog('outline');
      }) as EventListener,
    },
    icon('plus'),
  );
  list.append(custom, more);

  const scroll = (direction: number) => list.scrollBy({ top: direction * 120, behavior: 'smooth' });
  return h(
    'aside',
    { class: 'palette', 'aria-label': 'Paleta de colores' },
    iconButton('chevronUp', 'Desplazar paleta arriba', () => scroll(-1), { class: 'icon-button palette-scroll' }),
    list,
    iconButton('chevronDown', 'Desplazar paleta abajo', () => scroll(1), { class: 'icon-button palette-scroll' }),
  );
}

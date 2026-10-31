import { ICONS, type IconName } from './icons';

type Attrs = Record<string, string | number | boolean | undefined | EventListener>;
type Child = Node | string | null | undefined | false;

/**
 * Crea elementos sin framework: h('button', { class: 'tool', onclick: … }, 'Texto').
 * Las claves "on…" se registran como eventos; el resto, como atributos.
 */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') {
      element.addEventListener(key.slice(2), value as EventListener);
    } else {
      element.setAttribute(key, value === true ? '' : String(value));
    }
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    element.append(child);
  }
  return element;
}

/** Ícono SVG propio (solo decorativo: el texto accesible va en el botón). */
export function icon(name: IconName): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = 'icon';
  span.innerHTML = ICONS[name]; // contenido fijo y propio, no viene del usuario
  return span;
}

/** Botón de solo ícono con nombre accesible y tooltip. */
export function iconButton(name: IconName, label: string, onClick?: () => void, extra: Attrs = {}): HTMLButtonElement {
  return h(
    'button',
    { type: 'button', class: 'icon-button', 'aria-label': label, title: label, onclick: onClick as EventListener | undefined, ...extra },
    icon(name),
  );
}

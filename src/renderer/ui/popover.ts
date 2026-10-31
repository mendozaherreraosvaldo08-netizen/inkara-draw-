import { h } from './dom';

/**
 * Ventanita que se abre debajo de un botón (alinear, relleno…). Se cierra con
 * Esc, con un clic fuera o al volver a pulsar el botón.
 */
let current: { anchor: HTMLElement; close: () => void } | null = null;

export function togglePopover(anchor: HTMLElement, build: (close: () => void) => HTMLElement, className = ''): void {
  if (current?.anchor === anchor) {
    current.close();
    return;
  }
  current?.close();
  const box = h('div', { class: `popover ${className}`.trim(), role: 'dialog' });
  const close = () => {
    box.remove();
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', onKey, true);
    anchor.setAttribute('aria-expanded', 'false');
    if (current?.anchor === anchor) current = null;
  };
  const outside = (e: Event) => {
    if (!box.contains(e.target as Node) && !anchor.contains(e.target as Node)) close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  };
  box.append(build(close));
  document.body.append(box);
  const r = anchor.getBoundingClientRect();
  box.style.left = `${Math.round(Math.max(8, Math.min(r.left, window.innerWidth - box.offsetWidth - 8)))}px`;
  box.style.top = `${Math.round(r.bottom + 4)}px`;
  anchor.setAttribute('aria-expanded', 'true');
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('keydown', onKey, true);
  current = { anchor, close };
}

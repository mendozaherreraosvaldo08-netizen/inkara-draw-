import { downloadedInfo, ensureFont, isAvailable, installInWindows, isDownloaded, lastCatalogError, loadCatalog, onFontsChanged, searchFonts } from '../fonts';
import { h, icon } from './dom';

const FAVORITES_KEY = 'inkara.fonts.favorites';
/** Fuentes favoritas (estrella): van hasta arriba en el selector. */
function favorites(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(FAVORITES_KEY) ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 50) : [];
  } catch {
    return [];
  }
}
function toggleFavorite(family: string): void {
  const list = favorites();
  const next = list.some((f) => f.toLowerCase() === family.toLowerCase()) ? list.filter((f) => f.toLowerCase() !== family.toLowerCase()) : [...list, family];
  try {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(next));
  } catch {
    // no se recuerda
  }
}

export interface FontPicker {
  element: HTMLElement;
  /** Vuelve a pintar el nombre de la fuente actual. */
  refresh(): void;
}

/**
 * Selector de fuente con buscador. Arriba, las fuentes del equipo (cada una
 * escrita con su propia letra); abajo, las de Google Fonts que no tienes: al
 * elegir una se descarga sola y el texto cambia en cuanto llega.
 */
export function createFontPicker(getValue: () => string, onPick: (family: string) => void): FontPicker {
  const label = h('span', { class: 'font-picker-name' });
  const button = h('button', { type: 'button', class: 'input font-picker', 'aria-haspopup': 'listbox', 'aria-expanded': 'false', title: 'Fuente (escribe para buscar, también en Google Fonts)' }, label, icon('chevronDown'));
  let popover: HTMLElement | null = null;
  let stopListening: (() => void) | null = null;

  const refresh = () => {
    const family = getValue();
    label.textContent = family;
    label.style.fontFamily = `"${family.replace(/["\\]/g, '')}", "Segoe UI", sans-serif`;
  };

  const close = () => {
    popover?.remove();
    popover = null;
    stopListening?.();
    stopListening = null;
    button.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outside, true);
  };
  const outside = (event: Event) => {
    if (popover && !popover.contains(event.target as Node) && !button.contains(event.target as Node)) close();
  };

  // Si la fuente no está, primero se descarga y luego se aplica. Si no existe en
  // ningún lado no se cambia nada (la barra de estado explica por qué).
  const choose = (family: string) => {
    close();
    if (isAvailable(family)) {
      onPick(family);
      return;
    }
    void ensureFont(family).then((ok) => {
      if (ok) onPick(downloadedInfo(family)?.family ?? family);
    });
  };

  const open = () => {
    const search = h('input', { class: 'input font-search', type: 'search', placeholder: 'Buscar fuente…', 'aria-label': 'Buscar fuente', spellcheck: 'false' });
    const list = h('div', { class: 'font-list', role: 'listbox', 'aria-label': 'Fuentes' });
    const footer = h('div', { class: 'font-footer' });
    popover = h('div', { class: 'font-popover' }, search, list, footer);
    document.body.append(popover);
    const rect = button.getBoundingClientRect();
    popover.style.left = `${Math.round(Math.min(rect.left, window.innerWidth - 340))}px`;
    popover.style.top = `${Math.round(rect.bottom + 4)}px`;
    button.setAttribute('aria-expanded', 'true');

    const paint = () => {
      const { installed, google } = searchFonts(search.value);
      const current = getValue().toLowerCase();
      const favs = favorites();
      const isFav = (family: string) => favs.some((f) => f.toLowerCase() === family.toLowerCase());
      const item = (family: string, extra: Node | null, preview: boolean) => {
        const name = h('span', { class: 'font-item-name' }, family);
        if (preview) name.style.fontFamily = `"${family.replace(/["\\]/g, '')}", "Segoe UI", sans-serif`;
        const star = h('span', { class: `font-star${isFav(family) ? ' on' : ''}`, role: 'button', tabindex: -1, title: isFav(family) ? 'Quitar de favoritas' : 'Agregar a favoritas (sale hasta arriba)', 'aria-label': `Favorita: ${family}` }, isFav(family) ? '★' : '☆');
        star.addEventListener('click', (e) => {
          e.stopPropagation();
          toggleFavorite(family);
          paint();
        });
        return h('button', { type: 'button', class: 'font-item', role: 'option', 'aria-selected': String(family.toLowerCase() === current), title: family, onclick: () => choose(family) }, star, name, extra);
      };
      const q = search.value.trim().toLowerCase();
      const favShown = favs.filter((f) => !q || f.toLowerCase().includes(q));
      list.replaceChildren(
        ...(favShown.length ? [h('div', { class: 'font-group' }, '★ Favoritas'), ...favShown.map((family) => item(family, isAvailable(family) ? null : h('span', { class: 'font-tag' }, 'no instalada'), true))] : []),
        h('div', { class: 'font-group' }, 'En tu equipo'),
        ...installed.map((family) => item(family, isDownloaded(family) ? h('span', { class: 'font-tag' }, 'Google') : null, true)),
        ...(installed.length === 0 ? [h('div', { class: 'font-empty' }, 'Ninguna coincide')] : []),
        h('div', { class: 'font-group' }, 'Google Fonts · se descarga al elegirla'),
        ...google.map((f) => item(f.family, h('span', { class: 'font-tag' }, f.category), false)),
        ...(google.length === 0 ? [h('div', { class: 'font-empty' }, lastCatalogError() ?? (search.value ? 'Ninguna coincide' : 'Cargando catálogo…'))] : []),
      );
      // Si la fuente actual vino de Google, se ofrece instalarla en Windows.
      const info = downloadedInfo(getValue());
      footer.replaceChildren();
      if (info && !info.installed && window.trazo) {
        footer.append(
          h('span', {}, `“${info.family}” es de Google Fonts (libre).`),
          h('button', { type: 'button', class: 'font-install', onclick: () => void installInWindows(info.family).then(paint) }, 'Instalar en Windows'),
        );
      } else if (info?.installed) {
        footer.append(h('span', {}, `“${info.family}” está instalada en Windows.`));
      }
    };

    search.addEventListener('input', paint);
    search.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
        button.focus();
      } else if (event.key === 'Enter') {
        event.preventDefault();
        // Enter: la primera coincidencia; si no hay ninguna, se intenta con lo escrito
        // (puede ser una fuente que aún no está en el catálogo descargado).
        const { installed, google } = searchFonts(search.value);
        const first = installed[0] ?? google[0]?.family ?? search.value.trim();
        if (first) choose(first);
      }
    });
    stopListening = onFontsChanged(paint);
    document.addEventListener('pointerdown', outside, true);
    paint();
    search.focus();
    void loadCatalog().then(() => popover && paint());
  };

  button.addEventListener('click', () => (popover ? close() : open()));
  refresh();
  return { element: button, refresh };
}

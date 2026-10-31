import { allPages, currentPageIndex, pageDocument, withPages } from '../../engine/document';
import { fitToContent, splitIntoPlates } from '../../engine/split';
import { multiply, translate } from '../../engine/matrix';
import { realignText, relayoutText, visualScale } from '../../engine/text';
import { shapeBounds, type Shape, type TextShape } from '../../engine/shapes';
import * as editor from '../editor';
import { store } from '../state';
import { stopTextEditing } from '../text-edit';
import { h } from './dom';
import { categoryInput, saveTemplateFrom } from './templates-dialog';

/**
 * Herramientas para convertir un PDF de Corel en plantilla:
 *  - Diseño › Dividir en placas: cada placa en su página, a su tamaño.
 *  - Texto › Convertir textos en campos: el nombre del ejemplo pasa a {{Nombre}}…
 */

function modal(title: string, sub: string, body: Node[], actions: HTMLElement[]): { close: () => void; status: HTMLElement } {
  const status = h('span', { class: 'export-status', role: 'status' });
  const dialog = h('div', { class: 'modal contour-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, h('header', { class: 'modal-head' }, h('h2', {}, title), sub ? h('span', { class: 'modal-sub' }, sub) : null), h('div', { class: 'contour-body' }, ...body), h('footer', { class: 'modal-foot' }, status, ...actions));
  const backdrop = h('div', { class: 'modal-backdrop' }, dialog);
  document.body.append(backdrop);
  backdrop.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') backdrop.remove();
  });
  return { close: () => backdrop.remove(), status };
}

/** Diseño › Dividir en placas… */
export function openSplitDialog(): void {
  stopTextEditing();
  const doc = store.get().document;
  const pages = allPages(doc);
  let columns: number | 'auto' = 'auto';
  const options: Array<number | 'auto'> = ['auto', 1, 2, 3, 4];
  const seg = h('div', { class: 'segments' }, ...options.map((n) => h('button', { type: 'button', class: 'segment', 'aria-pressed': String(n === columns), onclick: () => ((columns = n), seg.querySelectorAll('button').forEach((b, i) => b.setAttribute('aria-pressed', String(options[i] === n)))) }, n === 'auto' ? 'Automático' : `${n}`)));
  const { close, status } = modal(
    'Dividir en placas',
    `${pages.length} ${pages.length === 1 ? 'página' : 'páginas'}`,
    [h('div', { class: 'field-label' }, '¿Cuántas placas hay lado a lado en cada hoja?'), seg, h('p', { class: 'export-note' }, 'Automático: la app busca el fondo o el marco de cada placa (sirve aunque unas hojas traigan 2 placas y otras un diploma completo). Cada placa queda en su propia página. Se aplica a todas las páginas.')],
    [
      h('button', { type: 'button', class: 'button', onclick: () => close() }, 'Cancelar'),
      h(
        'button',
        {
          type: 'button',
          class: 'button primary',
          onclick: () => {
            const r = splitIntoPlates(allPages(store.get().document), columns);
            if (!r) {
              status.textContent = 'No hay nada dibujado que dividir.';
              return;
            }
            editor.replacePages(columns === 'auto' ? 'Dividir en placas' : `Dividir en ${columns} placas`, r.pages, 0);
            const page = store.get().document.page;
            store.updatePage({ widthMm: r.size.w, heightMm: r.size.h, safeMarginMm: Math.max(page.safeMarginMm, 4) });
            store.set({ hint: `Listo: ${r.pages.length} placas de ${(r.size.w / 25.4).toFixed(2)} × ${(r.size.h / 25.4).toFixed(2)} pulgadas, cada una en su página.` });
            close();
          },
        },
        'Dividir',
      ),
    ],
  );
}

type Role = '' | 'Nombre' | 'Carrera' | 'Generación' | 'otro';

/** Qué campo parece cada texto de la placa (el usuario lo puede cambiar). */
function guessRoles(texts: TextShape[]): Map<string, Role> {
  const roles = new Map<string, Role>();
  for (const t of texts) {
    if (/generaci/i.test(t.text) && /\d{4}/.test(t.text)) roles.set(t.id, 'Generación');
    else if (/^\s*(lic\.?|licenciatura|ing\.?|ingenier|maestr|mtr|dr\.?|doctor|arq|t[eé]c|bachiller|prepa)/i.test(t.text)) roles.set(t.id, 'Carrera');
  }
  // El nombre: el texto más grande que parece nombre propio (2 a 6 palabras con mayúscula inicial), sin números.
  const PARTICLE = /^(de|del|la|las|los|y|e)$/i;
  const looksLikeName = (text: string) => {
    const words = text.trim().split(/\s+/);
    return words.length >= 2 && words.length <= 6 && words.every((w) => PARTICLE.test(w) || /^[A-ZÁÉÍÓÚÑ][a-záéíóúüñ'.-]+$/.test(w));
  };
  const name = texts
    .filter((t) => !roles.has(t.id) && !/\d/.test(t.text) && t.text.length <= 70 && looksLikeName(t.text.replace(NAME_PREFIX, '')))
    .sort((a, b) => b.fontSizePt * visualScale(b) - a.fontSizePt * visualScale(a))[0];
  if (name) roles.set(name.id, 'Nombre');
  return roles;
}

/** "A: Daniela…" en diplomas: el "A:" se queda y solo el nombre pasa a campo. */
const NAME_PREFIX = /^\s*(a|para)\s*:\s*/i;

/** Cambia el texto conservando el centro vertical (un nombre de 2 líneas pasa a {{Nombre}} sin subirse). */
function retext(t: TextShape, text: string): TextShape {
  // Un nombre más o menos al centro de la placa queda centrado (así los nombres largos crecen hacia los dos lados).
  const page = store.get().document.page;
  const b = shapeBounds(t);
  const centered = Math.abs(b.x + b.width / 2 - page.widthMm / 2) < page.widthMm * 0.08 && t.align !== 'center' && !t.arc;
  const base = centered ? realignText(t, 'center') : t;
  const out = relayoutText({ ...base, text });
  const dh = out.height - base.height;
  return Math.abs(dh) > 1e-9 ? { ...out, transform: multiply(out.transform, translate(0, -dh / 2)) } : out;
}

/** El texto nuevo de un campo ("Generación: 2022-2025" → "Generación: {{Generación}}"). */
function fieldText(role: Role, name: string, text: string): string {
  if (role === 'Nombre' && NAME_PREFIX.test(text)) return `${text.match(NAME_PREFIX)![0]}{{${name}}}`;
  return role === 'Generación' && /\d{4}(\s*[-–]\s*\d{4})?/.test(text) ? text.replace(/\d{4}(\s*[-–]\s*\d{4})?/, `{{${name}}}`).replace(/\n/g, ' ') : `{{${name}}}`;
}

/** Convierte solos los textos que parecen Nombre, Carrera y Generación (para las demás páginas). */
export function autoFields(shapes: Shape[]): { shapes: Shape[]; changed: number } {
  const texts = shapes.filter((s): s is TextShape => s.kind === 'text' && !s.hidden && s.text.trim() !== '' && !/\{\{/.test(s.text));
  const roles = guessRoles([...texts].sort((a, b) => a.transform[5] - b.transform[5]));
  let changed = 0;
  const out = shapes.map((s): Shape => {
    const role = roles.get(s.id);
    if (s.kind !== 'text' || !role) return s;
    changed++;
    return retext(s, fieldText(role, role, s.text));
  });
  return { shapes: out, changed };
}

/** Texto › Convertir textos en campos… */
export function openFieldsDialog(): void {
  stopTextEditing();
  const doc = store.get().document;
  const texts = doc.shapes.filter((s): s is TextShape => s.kind === 'text' && !s.hidden && s.text.trim() !== '' && !/\{\{/.test(s.text));
  if (texts.length === 0) {
    store.set({ hint: 'En esta página no hay textos de ejemplo para convertir (o ya son campos {{…}}).' });
    return;
  }
  const sorted = [...texts].sort((a, b) => a.transform[5] - b.transform[5]);
  const guess = guessRoles(sorted);
  const rows = sorted.map((t) => {
    const select = h('select', { class: 'input', 'aria-label': `Campo para “${t.text}”` }, ...(['', 'Nombre', 'Carrera', 'Generación', 'otro'] as Role[]).map((r) => h('option', { value: r, selected: guess.get(t.id) === r }, r === '' ? 'Dejar igual' : r === 'otro' ? 'Otro campo…' : `{{${r}}}`)));
    const other = h('input', { class: 'input', placeholder: 'Nombre de la columna', hidden: true, maxlength: 60 });
    select.addEventListener('change', () => (other.hidden = select.value !== 'otro'));
    const preview = t.text.replace(/\n/g, ' ⏎ ');
    return { t, select, other, el: h('div', { class: 'fields-row' }, h('span', { class: 'fields-text', title: t.text }, preview.length > 48 ? `${preview.slice(0, 46)}…` : preview), select, other) };
  });
  const everyPage = h('input', { type: 'checkbox', checked: allPages(doc).length > 1 });
  const { close, status } = modal(
    'Convertir textos en campos',
    `Página ${currentPageIndex(doc) + 1}`,
    [
      h('p', { class: 'export-note' }, 'Elige qué dato va en cada texto. Así la plantilla pone el nombre, la carrera… de cada alumno. Ya marqué los que parecen.'),
      h('div', { class: 'fields-list' }, ...rows.map((r) => r.el)),
      ...(allPages(doc).length > 1 ? [h('label', { class: 'check' }, everyPage, h('span', {}, `También en las otras ${allPages(doc).length - 1} páginas`, h('small', {}, 'En las demás páginas la app elige sola el Nombre, la Carrera y la Generación.')))] : []),
    ],
    [
      h('button', { type: 'button', class: 'button', onclick: () => close() }, 'Cancelar'),
      h(
        'button',
        {
          type: 'button',
          class: 'button primary',
          onclick: () => {
            const changes = new Map<string, string>();
            for (const r of rows) {
              const role = r.select.value as Role;
              if (!role) continue;
              const name = role === 'otro' ? r.other.value.trim() : role;
              if (!name) {
                status.textContent = 'Escribe el nombre de la columna para "Otro campo".';
                return;
              }
              changes.set(r.t.id, fieldText(role, name, r.t.text));
            }
            const shapes = store.get().document.shapes.map((s): Shape => (s.kind === 'text' && changes.has(s.id) ? retext(s, changes.get(s.id)!) : s));
            if (everyPage.checked && allPages(store.get().document).length > 1) {
              const current = currentPageIndex(store.get().document);
              let total = changes.size;
              const pages = allPages(store.get().document).map((p, i) => {
                if (i === current) return { ...p, shapes };
                const r = autoFields(p.shapes);
                total += r.changed;
                return { ...p, shapes: r.shapes };
              });
              editor.replacePages('Convertir textos en campos', pages, current);
              store.set({ hint: `${total} textos convertidos en campos en ${pages.length} páginas. Ahora: Archivo › Guardar páginas como plantillas.` });
              return close();
            }
            if (changes.size === 0) return close();
            editor.commit('Convertir textos en campos', shapes, [...changes.keys()]);
            store.set({ hint: `${changes.size} ${changes.size === 1 ? 'texto convertido' : 'textos convertidos'} en campos. Ahora: Archivo › Guardar como plantilla.` });
            close();
          },
        },
        'Convertir',
      ),
    ],
  );
}

/** Cómo se ve un diseño, sin ids ni textos de ejemplo (para no guardar dos plantillas iguales). */
export function designSignature(shapes: Shape[]): string {
  // Redondeado a 2 mm: dos placas del mismo diseño cambian décimas por el largo del nombre.
  const r = (v: number) => Math.round(v / 2) * 2;
  return JSON.stringify(
    shapes.filter((s) => !s.clipId).map((s) => {
      const b = shapeBounds(s);
      // Los campos ({{Nombre}}…) no cuentan por su lugar: en cada placa del PDF el nombre quedó un poco movido.
      const where = s.kind === 'text' ? (/\{\{/.test(s.text) ? [] : [Math.round((b.x + b.width / 2) / 4), Math.round((b.y + b.height / 2) / 6)]) : [r(b.x), r(b.y), r(b.width), r(b.height)];
      return [s.kind, ...where, s.fill, s.stroke, s.hidden ? 1 : 0, s.kind === 'text' ? (/\{\{/.test(s.text) ? s.text : `${s.fontFamily}|${Math.round(s.fontSizePt)}`) : s.kind === 'image' ? s.assetId : s.kind === 'path' ? s.subpaths.length : 0];
    }),
  );
}

/** ¿Diploma o agradecimiento? Por lo que dicen sus textos. */
function kindOf(shapes: Shape[]): { word: string; category: string } | null {
  const text = shapes.map((s) => (s.kind === 'text' ? s.text : '')).join(' ');
  if (/\bdiploma\b|reconocimiento/i.test(text)) return { word: 'diploma', category: 'Diplomas' };
  if (/a mis padres|agradec|gracias|a mi mam|con todo mi amor|a dios/i.test(text)) return { word: 'agradecimiento', category: 'Agradecimientos' };
  return null;
}

/** Cómo es el fondo de una placa: blanca, negra o con textura (para el nombre de la plantilla). */
function backgroundOf(shapes: Shape[]): string {
  const first = shapes.find((s) => !s.hidden && !s.clipId);
  if (!first) return 'blanca';
  if (first.kind === 'image') return 'bronce';
  const c = first.fill ?? '#FFFFFF';
  const v = parseInt(c.slice(1), 16);
  const luma = 0.299 * ((v >> 16) & 255) + 0.587 * ((v >> 8) & 255) + 0.114 * (v & 255);
  return luma < 80 ? 'negra' : luma > 200 ? 'blanca' : 'de color';
}

/** Archivo › Guardar páginas como plantillas… (cada página, una plantilla; sin repetidas). */
export async function openSavePagesDialog(): Promise<void> {
  stopTextEditing();
  if (!window.trazo?.templates) {
    store.set({ hint: 'La biblioteca de plantillas funciona en la app de escritorio.' });
    return;
  }
  const doc = store.get().document;
  const pages = allPages(doc);
  const all = await window.trazo.templates.list();
  const prefix = h('input', { class: 'input', value: doc.name.replace(/\.(pdf|ink|trz)$/i, ''), maxlength: 60, 'aria-label': 'Nombre de las plantillas' });
  const category = categoryInput('Graduación', all.map((t) => t.category));
  const unique = h('input', { type: 'checkbox', checked: true });
  const onlyFields = h('input', { type: 'checkbox', checked: true });
  const byKind = h('input', { type: 'checkbox', checked: true });
  const { close, status } = modal(
    'Guardar páginas como plantillas',
    `${pages.length} páginas`,
    [
      h('label', { class: 'field-row' }, h('span', { class: 'field-label' }, 'Nombre'), prefix),
      h('label', { class: 'field-row' }, h('span', { class: 'field-label' }, 'Categoría'), category),
      h('label', { class: 'check' }, unique, h('span', {}, 'Saltar diseños repetidos', h('small', {}, 'Si varias placas son el mismo diseño con otro nombre, se guarda una sola.'))),
      h('label', { class: 'check' }, onlyFields, h('span', {}, 'Solo páginas con campos {{…}}', h('small', {}, 'Las que no tienen Nombre/Carrera no sirven para placas en serie.'))),
      h('label', { class: 'check' }, byKind, h('span', {}, 'Separar diplomas y agradecimientos', h('small', {}, 'Los que dicen "Diploma" van a Diplomas y los de "A mis padres", "Gracias"… a Agradecimientos.'))),
      h('p', { class: 'export-note' }, 'Cada plantilla se llama como el nombre + el fondo: "Graduación blanca 1", "Graduación negra 1"… Después las puedes renombrar.'),
    ],
    [
      h('button', { type: 'button', class: 'button', onclick: () => close() }, 'Cancelar'),
      h(
        'button',
        {
          type: 'button',
          class: 'button primary',
          onclick: async (e: Event) => {
            const button = e.currentTarget as HTMLButtonElement;
            button.disabled = true;
            const seen = new Set<string>();
            const counts = new Map<string, number>();
            const saved: string[] = [];
            let skipped = 0;
            for (let i = 0; i < pages.length; i++) {
              const page = pages[i]!;
              if (onlyFields.checked && !page.shapes.some((s) => s.kind === 'text' && /\{\{/.test(s.text))) {
                skipped++;
                continue;
              }
              const sig = designSignature(fitToContent(page.shapes)?.shapes ?? page.shapes);
              if (unique.checked && seen.has(sig)) {
                skipped++;
                continue;
              }
              seen.add(sig);
              const bg = backgroundOf(fitToContent(page.shapes)?.shapes ?? page.shapes);
              const kind = byKind.checked ? kindOf(page.shapes) : null;
              const label = kind ? `${kind.word} ${bg}` : bg;
              const n = (counts.get(label) ?? 0) + 1;
              counts.set(label, n);
              status.textContent = `Guardando ${saved.length + 1}…`;
              // Cada plantilla, del tamaño de su placa (una negra de 5×7 no hereda la hoja de una blanca de 5×7.5).
              const fit = fitToContent(page.shapes);
              const base = pageDocument(store.get().document, i);
              const one = fit ? withPages({ ...base, page: { ...base.page, widthMm: fit.size.w, heightMm: fit.size.h } }, [{ ...page, name: 'Página 1', shapes: fit.shapes }], 0) : withPages(base, [{ ...page, name: 'Página 1' }], 0);
              const r = await saveTemplateFrom(one, `${prefix.value.trim() || 'Plantilla'} ${label} ${n}`, false, kind?.category ?? category.value.trim());
              if (!r.ok) {
                status.textContent = r.error ?? 'No se pudo guardar.';
                button.disabled = false;
                return;
              }
              saved.push(r.name);
            }
            store.set({ hint: `${saved.length} plantillas guardadas${skipped ? ` (${skipped} páginas saltadas: repetidas o sin campos)` : ''}. Están en Archivo › Nuevo desde plantilla y en Placas en serie.` });
            close();
          },
        },
        'Guardar plantillas',
      ),
    ],
  );
}

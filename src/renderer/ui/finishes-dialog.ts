import type { TrazoDocument } from '../../engine/document';
import { DEFAULT_EXPORT } from '../../engine/export';
import { applyFinish, documentColors, luma, suggestFinishes, type Finish } from '../../engine/finishes';
import { newShapeId } from '../../engine/shapes';
import { renderPreview } from '../exporter';
import { createAsset } from '../images';
import { store } from '../state';
import { metalTexture, METALS, type Metal } from '../textures';
import { h } from './dom';

/** Estilo puesto desde código (la política de seguridad no deja estilos en atributos). */
const css = <T extends HTMLElement>(el: T, text: string): T => ((el.style.cssText = text), el);

/**
 * Acabados del diseño: el mismo diseño en blanco, negro, bronce… Cada acabado
 * dice qué color cambia por cuál y si el fondo lleva una textura de metal.
 */

const PREVIEW = { ...DEFAULT_EXPORT, bleed: false, mirror: false, cropMarks: false, background: 'white' as const };

/** Pone en el diseño una imagen (textura) para los acabados. */
function addAsset(doc: TrazoDocument, asset: { id: string } & TrazoDocument['assets'][string]): TrazoDocument {
  return { ...doc, assets: { ...doc.assets, [asset.id]: asset } };
}

/** Si el diseño aún no tiene acabados, le pone los sugeridos (Blanco, Negro y Bronce con textura). */
export async function ensureFinishes(): Promise<Finish[]> {
  let doc = store.get().document;
  if (doc.finishes?.length) return doc.finishes;
  const bronce = await metalTexture('Bronce');
  if (bronce) doc = addAsset(doc, bronce);
  const finishes = suggestFinishes(doc, { bronce: bronce?.id });
  store.set({ document: { ...doc, finishes } });
  return finishes;
}

export function setFinishes(finishes: Finish[]): void {
  store.set({ document: { ...store.get().document, finishes }, dirty: true });
}

/** Ventana para revisar y cambiar los acabados. `onDone` al cerrar. */
export async function openFinishesDialog(onDone?: () => void): Promise<void> {
  await ensureFinishes();
  let list: Finish[] = structuredClone(store.get().document.finishes ?? []);
  let current = 0;
  const colors = documentColors(store.get().document).slice(0, 12).map((c) => c.color);

  const tabs = h('div', { class: 'fin-tabs' });
  const name = h('input', { class: 'input', maxlength: 40, 'aria-label': 'Nombre del acabado' });
  const swatch = h('input', { type: 'color', class: 'fin-color', 'aria-label': 'Color de la muestra' });
  const rows = h('div', { class: 'fin-rows' });
  const texture = h('select', { class: 'input', 'aria-label': 'Textura del fondo' }, h('option', { value: '' }, 'Sin textura'), ...Object.keys(METALS).map((m) => h('option', { value: `metal:${m}` }, `${m} cepillado`)), h('option', { value: 'file' }, 'Mi imagen…'));
  const fileInput = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', hidden: true });
  const preview = h('canvas', { class: 'fin-preview', 'aria-label': 'Vista previa del acabado' });
  const status = h('span', { class: 'export-status', role: 'status' });

  const dialog = h(
    'div',
    { class: 'modal fin-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'fin-title' },
    h('header', { class: 'modal-head' }, h('h2', { id: 'fin-title' }, 'Acabados de la plantilla'), h('span', { class: 'modal-sub' }, 'El mismo diseño en blanco, negro, bronce…')),
    tabs,
    h(
      'div',
      { class: 'fin-body' },
      h('div', { class: 'fin-left' }, preview),
      h(
        'div',
        { class: 'fin-right' },
        h('div', { class: 'fin-name' }, h('label', { class: 'field-row' }, h('span', { class: 'field-label' }, 'Nombre'), name), swatch),
        h('div', { class: 'field-label fin-sub' }, 'Colores de tu diseño → cómo quedan en este acabado'),
        rows,
        h('label', { class: 'field-row fin-tex' }, h('span', { class: 'field-label' }, 'Textura del fondo'), texture),
        h('p', { class: 'export-note' }, 'Marca "Textura" en el color del fondo para cubrirlo con metal cepillado (o con la imagen real de tu lámina).'),
        fileInput,
      ),
    ),
    h(
      'footer',
      { class: 'modal-foot' },
      h('button', { type: 'button', class: 'button', onclick: () => void reset() }, 'Volver a los sugeridos'),
      h('button', { type: 'button', class: 'button', onclick: () => removeCurrent() }, 'Quitar acabado'),
      status,
      h('button', { type: 'button', class: 'button', onclick: () => close() }, 'Cancelar'),
      h('button', { type: 'button', class: 'button primary', onclick: () => save() }, 'Guardar acabados'),
    ),
  );
  const backdrop = h('div', { class: 'modal-backdrop' }, dialog);
  document.body.append(backdrop);
  backdrop.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') close();
  });
  function close() {
    backdrop.remove();
    onDone?.();
  }
  function save() {
    setFinishes(list.filter((f) => f.name.trim()));
    store.set({ hint: `Acabados guardados: ${list.map((f) => f.name).join(', ')}` });
    close();
  }
  async function reset() {
    const doc = store.get().document;
    const bronce = await metalTexture('Bronce');
    if (bronce) store.set({ document: addAsset(doc, bronce) });
    list = suggestFinishes(store.get().document, { bronce: bronce?.id });
    current = 0;
    paint();
  }
  function removeCurrent() {
    if (list.length <= 1) return;
    list.splice(current, 1);
    current = Math.max(0, current - 1);
    paint();
  }

  const f = () => list[current]!;
  name.addEventListener('input', () => {
    f().name = name.value;
    paintTabs();
  });
  swatch.addEventListener('input', () => {
    f().swatch = swatch.value.toUpperCase();
    paintTabs();
  });
  texture.addEventListener('change', async () => {
    const v = texture.value;
    if (v === 'file') {
      fileInput.click();
      return;
    }
    if (!v) delete f().texture;
    else {
      const asset = await metalTexture(v.slice(6) as Metal);
      if (asset) {
        store.set({ document: addAsset(store.get().document, asset) });
        f().texture = { assetId: asset.id, colors: f().texture?.colors ?? colors.filter((c) => luma(c) >= 200).slice(0, 1) };
      }
    }
    paint();
  });
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    try {
      const asset = await createAsset(file.name, file.type, new Uint8Array(await file.arrayBuffer()));
      store.set({ document: addAsset(store.get().document, asset) });
      f().texture = { assetId: asset.id, colors: f().texture?.colors ?? colors.filter((c) => luma(c) >= 200).slice(0, 1) };
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error);
    }
    paint();
  });

  function paintTabs() {
    tabs.replaceChildren(
      ...list.map((fin, i) =>
        h(
          'button',
          { type: 'button', class: 'fin-tab', 'aria-pressed': String(i === current), onclick: () => ((current = i), paint()) },
          css(h('i', { class: 'sw' }), fin.texture ? `background-image:url(data:${store.get().document.assets[fin.texture.assetId]?.mime};base64,${store.get().document.assets[fin.texture.assetId]?.data})` : `background:${fin.swatch}`),
          fin.name || 'Sin nombre',
        ),
      ),
      h(
        'button',
        {
          type: 'button',
          class: 'fin-tab add',
          onclick: () => {
            list.push({ name: `Acabado ${list.length + 1}`, swatch: '#C4A052', colors: [] });
            current = list.length - 1;
            paint();
          },
        },
        '+ Agregar',
      ),
    );
  }

  let token = 0;
  function paint() {
    paintTabs();
    const fin = f();
    name.value = fin.name;
    swatch.value = fin.swatch;
    const tex = fin.texture ? store.get().document.assets[fin.texture.assetId] : undefined;
    texture.value = tex ? (Object.keys(METALS).find((m) => tex.name === `${m} cepillado`) ? `metal:${tex.name.replace(' cepillado', '')}` : 'file') : '';
    if (texture.value === 'file' && tex) texture.options[texture.options.length - 1]!.textContent = `Mi imagen: ${tex.name}`;
    rows.replaceChildren(
      ...colors.map((c) => {
        const m = fin.colors.find((x) => x.from.toUpperCase() === c);
        const to = h('input', { type: 'color', class: 'fin-color', value: (m?.to ?? c).toLowerCase(), 'aria-label': `Color que reemplaza a ${c}` });
        to.addEventListener('input', () => {
          const value = to.value.toUpperCase();
          fin.colors = fin.colors.filter((x) => x.from.toUpperCase() !== c);
          if (value !== c) fin.colors.push({ from: c, to: value });
          void draw();
        });
        const tx = h('input', { type: 'checkbox', checked: !!fin.texture?.colors.includes(c), disabled: !fin.texture, 'aria-label': `Textura en ${c}` });
        tx.addEventListener('change', () => {
          if (!fin.texture) return;
          fin.texture.colors = tx.checked ? [...fin.texture.colors, c] : fin.texture.colors.filter((x) => x !== c);
          void draw();
        });
        return h('div', { class: 'fin-row' }, css(h('i', { class: 'sw big' }), `background:${c}`), h('span', { class: 'fin-hex' }, c), h('span', { class: 'fin-arrow' }, '→'), to, h('label', { class: 'check fin-check' }, tx, h('span', {}, 'Textura')));
      }),
    );
    void draw();
  }
  async function draw() {
    const mine = ++token;
    const doc = store.get().document;
    const out = applyFinish(doc, f(), newShapeId);
    await renderPreview(preview, out, PREVIEW, 300, 380);
    if (mine !== token) return;
  }
  paint();
}

import { removeBackground, type BackgroundOptions } from '../../engine/background';
import type { ImageShape, Shape } from '../../engine/shapes';
import type { RasterImage } from '../../engine/trace';
import * as editor from '../editor';
import { createAsset, decodedImage } from '../images';
import { store } from '../state';
import { h } from './dom';

/**
 * Mapas de bits › Quitar fondo: para logos y escudos con fondo blanco (o de un
 * color) que llegan por WhatsApp o correo. Sin internet: se quita el color de
 * la orilla. Vista previa en vivo; al aplicar, la imagen se reemplaza por un
 * PNG con transparencia (se puede deshacer).
 */

const PREVIEW_SIDE = 360;
const FINAL_SIDE = 3000;

function pixels(image: HTMLImageElement, side: number): RasterImage & { canvas: HTMLCanvasElement } {
  const k = Math.min(1, side / Math.max(image.naturalWidth, image.naturalHeight));
  const width = Math.max(1, Math.round(image.naturalWidth * k));
  const height = Math.max(1, Math.round(image.naturalHeight * k));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(image, 0, 0, width, height);
  return { width, height, data: ctx.getImageData(0, 0, width, height).data, canvas };
}

export async function openBackgroundDialog(): Promise<void> {
  const shape = editor.selectedShapes().find((s): s is ImageShape => s.kind === 'image');
  if (!shape || editor.selectedShapes().length !== 1) {
    store.set({ hint: 'Selecciona una imagen (un logo o escudo) para quitarle el fondo.' });
    return;
  }
  const asset = store.get().document.assets[shape.assetId];
  const image = asset ? await decodedImage(asset) : null;
  if (!image) {
    store.set({ hint: 'No se pudo leer la imagen.' });
    return;
  }
  const small = pixels(image, PREVIEW_SIDE);
  const options: BackgroundOptions = { tolerance: 18, holes: true, feather: 1 };
  const before = h('canvas', { class: 'trace-canvas bg-check', 'aria-label': 'Original' });
  const after = h('canvas', { class: 'trace-canvas bg-check', 'aria-label': 'Sin fondo' });
  before.width = after.width = small.width;
  before.height = after.height = small.height;
  before.getContext('2d')!.drawImage(small.canvas, 0, 0);
  const tolerance = h('input', { type: 'range', min: 2, max: 60, step: 1, value: options.tolerance, 'aria-label': 'Tolerancia' });
  const holes = h('input', { type: 'checkbox', checked: options.holes });
  const feather = h('input', { type: 'range', min: 0, max: 3, step: 1, value: options.feather, 'aria-label': 'Borde suave' });
  const info = h('div', { class: 'export-note' });
  const status = h('span', { class: 'export-status', role: 'status' });
  const apply = h('button', { type: 'button', class: 'button primary', onclick: () => void submit() }, 'Quitar fondo');
  const dialog = h(
    'div',
    { class: 'modal trace-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'bg-title' },
    h('header', { class: 'modal-head' }, h('h2', { id: 'bg-title' }, 'Quitar fondo'), h('span', { class: 'modal-sub' }, asset?.name ?? '')),
    h(
      'div',
      { class: 'trace-body' },
      h('div', { class: 'trace-previews' }, h('figure', {}, before, h('figcaption', {}, 'Original')), h('figure', {}, after, h('figcaption', {}, 'Sin fondo'))),
      h(
        'div',
        { class: 'trace-options' },
        h('label', { class: 'field-row' }, h('span', { class: 'field-label' }, 'Tolerancia'), tolerance),
        h('label', { class: 'field-row' }, h('span', { class: 'field-label' }, 'Borde suave'), feather),
        h('label', { class: 'check' }, holes, h('span', {}, 'Quitar también los huecos', h('small', {}, 'El blanco de adentro de las letras (la "O", la "A"…).'))),
        info,
        h('p', { class: 'export-note' }, 'Funciona con fondos lisos (blanco o de un color). Para fotos de personas con fondo revuelto, ese es para una versión con IA.'),
      ),
    ),
    h('footer', { class: 'modal-foot' }, status, h('button', { type: 'button', class: 'button', onclick: () => close() }, 'Cancelar'), apply),
  );
  const backdrop = h('div', { class: 'modal-backdrop' }, dialog);
  document.body.append(backdrop);
  backdrop.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') close();
  });
  function close() {
    backdrop.remove();
  }
  const read = () => {
    options.tolerance = Number(tolerance.value);
    options.holes = holes.checked;
    options.feather = Number(feather.value);
  };
  let timer = 0;
  function update() {
    read();
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      const r = removeBackground(small, options);
      after.getContext('2d')!.putImageData(new ImageData(r.data as Uint8ClampedArray<ArrayBuffer>, small.width, small.height), 0, 0);
      const pct = Math.round((r.removed / (small.width * small.height)) * 100);
      info.textContent = r.color ? `Fondo: rgb(${r.color.map(Math.round).join(', ')}) · se quita el ${pct} %` : 'La orilla ya es transparente: no hay fondo que quitar.';
    }, 60);
  }
  for (const el of [tolerance, holes, feather]) el.addEventListener('input', update);
  update();

  async function submit() {
    read();
    apply.disabled = true;
    status.textContent = 'Quitando fondo…';
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
    const big = pixels(image!, FINAL_SIDE);
    const r = removeBackground(big, options);
    const ctx = big.canvas.getContext('2d')!;
    ctx.putImageData(new ImageData(r.data as Uint8ClampedArray<ArrayBuffer>, big.width, big.height), 0, 0);
    const blob = await new Promise<Blob | null>((resolve) => big.canvas.toBlob(resolve, 'image/png'));
    if (!blob) {
      status.textContent = 'No se pudo generar la imagen.';
      apply.disabled = false;
      return;
    }
    const next = await createAsset(`${(asset!.name || 'imagen').replace(/\.[a-z0-9]+$/i, '')} sin fondo.png`, 'image/png', new Uint8Array(await blob.arrayBuffer()));
    const doc = store.get().document;
    store.set({ document: { ...doc, assets: { ...doc.assets, [next.id]: next } } });
    editor.commit('Quitar fondo', store.get().document.shapes.map((s): Shape => (s.id === shape!.id && s.kind === 'image' ? { ...s, assetId: next.id } : s)));
    store.set({ hint: 'Fondo quitado. Si no quedó bien: Ctrl+Z.' });
    close();
  }
}

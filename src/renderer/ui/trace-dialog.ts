import { createPath } from '../../engine/path';
import { traceSubpaths, type Subpath } from '../../engine/path-geom';
import { newShapeId, type ImageShape, type Shape } from '../../engine/shapes';
import { traceImage, type RasterImage, type TraceLayer, type TraceOptions } from '../../engine/trace';
import * as editor from '../editor';
import { decodedImage } from '../images';
import { store } from '../state';
import { h } from './dom';

/**
 * Vectorizar imagen (Mapas de bits › Vectorizar…): un logo escaneado o en PNG
 * pasa a curvas, nítidas a cualquier tamaño. Vista previa en vivo; al aplicar,
 * las curvas quedan encima (agrupadas) y la imagen original se oculta.
 */

const PREVIEW_SIDE = 320;
const FINAL_SIDE = 900;
const STORAGE_KEY = 'trazo.trace.v1';

interface Saved extends TraceOptions {
  mode: 'bw' | 'color';
}

function load(): Saved {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<Saved> | null;
    if (raw && typeof raw === 'object') {
      return {
        mode: raw.mode === 'color' ? 'color' : 'bw',
        colors: Math.min(8, Math.max(2, Number(raw.colors) || 4)),
        threshold: Math.min(250, Math.max(5, Number(raw.threshold) || 128)),
        smoothing: Math.min(4, Math.max(0.25, Number(raw.smoothing) || 1)),
        minArea: Math.min(500, Math.max(0, Number(raw.minArea) || 8)),
        ignoreWhite: raw.ignoreWhite !== false,
      };
    }
  } catch {
    // valores por defecto
  }
  return { mode: 'bw', colors: 4, threshold: 128, smoothing: 1, minArea: 8, ignoreWhite: true };
}

/** Píxeles de la parte visible de la imagen (con su recorte), con el lado mayor ≤ `side`. */
function rasterize(image: HTMLImageElement, shape: ImageShape, side: number): RasterImage {
  const c = shape.crop ?? { x: 0, y: 0, width: 1, height: 1 };
  const sw = image.naturalWidth * c.width;
  const sh = image.naturalHeight * c.height;
  const k = Math.min(1, side / Math.max(sw, sh));
  const width = Math.max(1, Math.round(sw * k));
  const height = Math.max(1, Math.round(sh * k));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image, image.naturalWidth * c.x, image.naturalHeight * c.y, sw, sh, 0, 0, width, height);
  return { width, height, data: ctx.getImageData(0, 0, width, height).data };
}

const nodeTotal = (layers: TraceLayer[]) => layers.reduce((t, l) => t + l.subpaths.reduce((u, s) => u + s.nodes.length, 0), 0);
const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));

export async function openTraceDialog(): Promise<void> {
  const shape = editor.selectedShapes().find((s): s is ImageShape => s.kind === 'image');
  if (!shape || editor.selectedShapes().length !== 1) {
    store.set({ hint: 'Selecciona una imagen (un logo) para vectorizarla.' });
    return;
  }
  const asset = store.get().document.assets[shape.assetId];
  const image = asset ? await decodedImage(asset) : null;
  if (!image) {
    store.set({ hint: 'No se pudo leer la imagen.' });
    return;
  }
  const options = load();
  const small = rasterize(image, shape, PREVIEW_SIDE);
  const previewScale = small.width / rasterize(image, shape, FINAL_SIDE).width;

  const preview = h('canvas', { class: 'trace-canvas', 'aria-label': 'Vista previa del vectorizado' });
  const original = h('canvas', { class: 'trace-canvas', 'aria-label': 'Imagen original' });
  const stats = h('div', { class: 'export-note' });
  const modes = (['bw', 'color'] as const).map((m) => h('button', { type: 'button', class: 'segment', onclick: () => ((options.mode = m), update()) }, m === 'bw' ? 'Blanco y negro' : 'Colores'));
  const colors = h('select', { class: 'input', 'aria-label': 'Número de colores' }, ...[2, 3, 4, 5, 6, 8].map((n) => h('option', { value: n }, `${n} colores`)));
  const threshold = h('input', { type: 'range', min: 10, max: 245, step: 5, 'aria-label': 'Umbral (qué tan oscuro cuenta como tinta)' });
  const smoothing = h('input', { type: 'range', min: 0.25, max: 4, step: 0.25, 'aria-label': 'Suavizado' });
  const minArea = h('input', { type: 'range', min: 0, max: 300, step: 4, 'aria-label': 'Quitar manchas menores a' });
  const ignoreWhite = h('input', { type: 'checkbox', 'aria-label': 'Ignorar el fondo blanco' });
  const thresholdRow = h('label', { class: 'field-row' }, h('span', { class: 'field-label' }, 'Umbral'), threshold);
  const colorsRow = h('label', { class: 'field-row' }, h('span', { class: 'field-label' }, 'Colores'), colors);
  const status = h('div', { class: 'export-status', role: 'status' });
  const apply = h('button', { type: 'button', class: 'button primary', onclick: () => void submit() }, 'Vectorizar');

  const dialog = h(
    'div',
    { class: 'modal trace-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'trace-title' },
    h('header', { class: 'modal-head' }, h('h2', { id: 'trace-title' }, 'Vectorizar imagen'), h('span', { class: 'modal-sub' }, asset?.name ?? '')),
    h(
      'div',
      { class: 'trace-body' },
      h('div', { class: 'trace-previews' }, h('figure', {}, original, h('figcaption', {}, 'Original')), h('figure', {}, preview, h('figcaption', {}, 'Curvas'))),
      h(
        'div',
        { class: 'trace-options' },
        h('div', { class: 'segments two' }, ...modes),
        thresholdRow,
        colorsRow,
        h('label', { class: 'field-row' }, h('span', { class: 'field-label' }, 'Suavizado'), smoothing),
        h('label', { class: 'field-row' }, h('span', { class: 'field-label' }, 'Quitar manchas'), minArea),
        h('label', { class: 'check' }, ignoreWhite, h('span', {}, 'Ignorar el fondo blanco', h('small', {}, 'Así el logo queda sin el cuadro blanco de atrás.'))),
        stats,
        h('p', { class: 'export-note' }, 'Funciona mejor con logos, escudos y dibujos de colores planos. Las fotos se ven mejor como imagen.'),
      ),
    ),
    h('footer', { class: 'modal-foot' }, status, h('button', { type: 'button', class: 'button', onclick: () => close() }, 'Cancelar'), apply),
  );
  const backdrop = h('div', { class: 'modal-backdrop' }, dialog);
  document.body.append(backdrop);
  backdrop.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key === 'Escape') close();
  });
  backdrop.addEventListener('pointerdown', (event) => {
    if (event.target === backdrop) close();
  });
  function close() {
    backdrop.remove();
  }

  // Original (sobre cuadrícula, para ver la transparencia)
  original.width = small.width;
  original.height = small.height;
  original.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(small.data), small.width, small.height), 0, 0);

  colors.value = String(options.colors);
  threshold.value = String(options.threshold);
  smoothing.value = String(options.smoothing);
  minArea.value = String(options.minArea);
  ignoreWhite.checked = options.ignoreWhite;
  for (const el of [colors, threshold, smoothing, minArea, ignoreWhite]) el.addEventListener('input', () => update());

  const traceOptions = (scale: number): TraceOptions => ({
    colors: options.mode === 'bw' ? 1 : options.colors,
    threshold: options.threshold,
    smoothing: options.smoothing * scale,
    minArea: options.minArea * scale * scale,
    ignoreWhite: options.ignoreWhite,
  });

  let timer = 0;
  function update() {
    options.colors = Number(colors.value);
    options.threshold = Number(threshold.value);
    options.smoothing = Number(smoothing.value);
    options.minArea = Number(minArea.value);
    options.ignoreWhite = ignoreWhite.checked;
    modes.forEach((b, i) => b.setAttribute('aria-pressed', String((i === 0 ? 'bw' : 'color') === options.mode)));
    thresholdRow.hidden = options.mode !== 'bw';
    colorsRow.hidden = options.mode !== 'color';
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(options));
    } catch {
      // no se recuerda
    }
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      const layers = traceImage(small, traceOptions(previewScale));
      drawPreview(layers);
      stats.textContent = layers.length ? `${layers.length} ${layers.length === 1 ? 'capa' : 'capas'} · unos ${Math.round(nodeTotal(layers) / previewScale)} nodos` : 'No quedó nada: prueba con otro umbral o desactiva "Ignorar el fondo blanco".';
    }, 120);
  }

  function drawPreview(layers: TraceLayer[]) {
    preview.width = small.width;
    preview.height = small.height;
    const ctx = preview.getContext('2d')!;
    ctx.clearRect(0, 0, preview.width, preview.height);
    for (const layer of layers) {
      ctx.beginPath();
      traceSubpaths(ctx, layer.subpaths, true);
      ctx.fillStyle = layer.color;
      ctx.fill('evenodd');
    }
  }

  async function submit() {
    apply.disabled = true;
    status.textContent = 'Vectorizando…';
    await nextFrame();
    const big = rasterize(image!, shape!, FINAL_SIDE);
    const layers = traceImage(big, traceOptions(1));
    if (layers.length === 0) {
      status.textContent = 'No quedó nada que vectorizar con estas opciones.';
      apply.disabled = false;
      return;
    }
    const sx = shape!.width / big.width;
    const sy = shape!.height / big.height;
    const scale = (sub: Subpath): Subpath => ({
      closed: sub.closed,
      nodes: sub.nodes.map((n) => ({ ...n, x: n.x * sx, y: n.y * sy, in: n.in && { x: n.in.x * sx, y: n.in.y * sy }, out: n.out && { x: n.out.x * sx, y: n.out.y * sy } })),
    });
    const groupId = layers.length > 1 ? `g${newShapeId()}` : undefined;
    const paths: Shape[] = layers.map((layer, i) => ({
      ...createPath(layer.subpaths.map(scale), { fill: layer.color, stroke: null, strokeWidth: 0.2 }, shape!.transform),
      name: layers.length > 1 ? `Vectorizado ${i + 1} (${layer.color})` : 'Vectorizado',
      ...(groupId ? { groupId } : {}),
    }));
    const doc = store.get().document.shapes;
    const at = doc.findIndex((s) => s.id === shape!.id);
    const next = [...doc.slice(0, at), { ...doc[at]!, hidden: true }, ...paths, ...doc.slice(at + 1)];
    close();
    editor.commit('Vectorizar imagen', next, paths.map((p) => p.id));
    store.set({ hint: `Vectorizado: ${layers.length} ${layers.length === 1 ? 'capa' : 'capas de color'}, ${nodeTotal(layers)} nodos. La imagen original quedó oculta (administrador de objetos).` });
  }

  update();
}

import type { ImageAsset } from '../engine/document';

/**
 * Imágenes: de bytes a "asset" del documento (base64 + tamaño en píxeles) y de
 * asset a imagen decodificada para dibujar. La decodificación se guarda en caché
 * por asset: duplicar una foto no la vuelve a decodificar.
 */

const decoded = new Map<string, HTMLImageElement>();
let onReady: () => void = () => undefined;

export function onImageReady(listener: () => void): void {
  onReady = listener;
}

/** Imagen lista para dibujar, o null mientras se decodifica (empieza a decodificar si hace falta). */
export function imageFor(asset: ImageAsset | undefined): HTMLImageElement | null {
  if (!asset) return null;
  let image = decoded.get(asset.id);
  if (!image) {
    image = new Image();
    image.decoding = 'async';
    image.onload = () => onReady();
    // Blob en vez de data: URL: no copia el texto base64 otra vez en memoria del DOM.
    image.src = URL.createObjectURL(new Blob([base64ToBytes(asset.data)], { type: asset.mime }));
    decoded.set(asset.id, image);
  }
  return image.complete && image.naturalWidth > 0 ? image : null;
}

export function base64ToBytes(data: string): Uint8Array<ArrayBuffer> {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Bytes → base64 sin bloquear con fotos grandes (lo hace el navegador). */
function bytesToBase64(bytes: Uint8Array<ArrayBuffer>, mime: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error ?? new Error('No se pudo leer la imagen'));
    reader.readAsDataURL(new Blob([bytes], { type: mime }));
  });
}

let counter = 0;

/** Crea el asset de una imagen. Lanza un Error con mensaje para el usuario si no se puede leer. */
export async function createAsset(name: string, mime: string, bytes: Uint8Array<ArrayBuffer>): Promise<ImageAsset> {
  const size = mime === 'image/svg+xml' ? svgSize(new TextDecoder().decode(bytes)) : await rasterSize(bytes, mime);
  if (!size) throw new Error(`“${name}” no es una imagen válida.`);
  return { id: `a${Date.now().toString(36)}${(counter++).toString(36)}`, name, mime, data: await bytesToBase64(bytes, mime), widthPx: size.width, heightPx: size.height };
}

async function rasterSize(bytes: Uint8Array<ArrayBuffer>, mime: string): Promise<{ width: number; height: number } | null> {
  try {
    // createImageBitmap respeta la orientación EXIF de las fotos de celular.
    const bitmap = await createImageBitmap(new Blob([bytes], { type: mime }), { imageOrientation: 'from-image' });
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  } catch {
    return null;
  }
}

const SVG_UNITS: Record<string, number> = { '': 1, px: 1, pt: 96 / 72, pc: 16, mm: 96 / 25.4, cm: 96 / 2.54, in: 96 };

/** Tamaño de un SVG en px CSS (96 por pulgada) a partir de width/height o viewBox. */
export function svgSize(text: string): { width: number; height: number } | null {
  const tag = /<svg\b[^>]*>/i.exec(text)?.[0];
  if (!tag) return null;
  const attr = (name: string) => new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(tag)?.[1];
  const length = (value: string | undefined) => {
    const m = value ? /^\s*([\d.]+)\s*(px|pt|pc|mm|cm|in)?\s*$/i.exec(value) : null;
    return m ? Number(m[1]) * (SVG_UNITS[(m[2] ?? '').toLowerCase()] ?? 1) : null;
  };
  const viewBox = attr('viewBox')?.trim().split(/[\s,]+/).map(Number);
  const vbW = viewBox && viewBox.length === 4 ? viewBox[2]! : null;
  const vbH = viewBox && viewBox.length === 4 ? viewBox[3]! : null;
  let width = length(attr('width'));
  let height = length(attr('height'));
  if (width && !height && vbW && vbH) height = (width * vbH) / vbW;
  if (height && !width && vbW && vbH) width = (height * vbW) / vbH;
  width ??= vbW;
  height ??= vbH;
  return width && height && width > 0 && height > 0 ? { width, height } : null;
}

/** Tamaño natural en la página (mm): fotos a 300 ppp, SVG a su tamaño real. */
export function naturalSizeMm(asset: ImageAsset): { width: number; height: number } {
  const perPx = asset.mime === 'image/svg+xml' ? 25.4 / 96 : 25.4 / 300;
  return { width: asset.widthPx * perPx, height: asset.heightPx * perPx };
}

/** La resolución efectiva se calcula en el motor (también la usa la revisión previa). */
export { effectiveDpi } from '../engine/preflight';

/** Espera a que una imagen esté decodificada (para exportar sin recuadros grises). */
export async function decodedImage(asset: ImageAsset): Promise<HTMLImageElement | null> {
  imageFor(asset);
  const image = decoded.get(asset.id);
  if (!image) return null;
  try {
    await image.decode();
    return image;
  } catch {
    return null;
  }
}

/** Libera una imagen decodificada (fotos de placas en serie, una vez generada su placa). */
export function forgetImage(assetId: string): void {
  const image = decoded.get(assetId);
  if (!image) return;
  URL.revokeObjectURL(image.src);
  image.src = '';
  decoded.delete(assetId);
}

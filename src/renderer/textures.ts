import type { ImageAsset } from '../engine/document';
import { createAsset } from './images';

/**
 * Texturas de metal cepillado para los acabados (bronce, dorado, plata),
 * dibujadas aquí mismo: ruido + rayitas horizontales. Si el usuario tiene la
 * imagen real de su lámina, la puede usar en su lugar.
 */

export const METALS = {
  Bronce: { base: [122, 90, 48], spread: 26 },
  Dorado: { base: [196, 160, 82], spread: 30 },
  Plata: { base: [190, 194, 198], spread: 26 },
  Cobre: { base: [168, 98, 62], spread: 26 },
} as const;
export type Metal = keyof typeof METALS;

const cache = new Map<Metal, Promise<ImageAsset | null>>();

export function metalTexture(metal: Metal): Promise<ImageAsset | null> {
  let job = cache.get(metal);
  if (!job) {
    job = draw(metal).catch(() => null);
    cache.set(metal, job);
  }
  return job;
}

async function draw(metal: Metal): Promise<ImageAsset | null> {
  const W = 900;
  const H = 900;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const { base, spread } = METALS[metal];
  const img = ctx.createImageData(W, H);
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  // Cepillado: cada fila tiene un tono que cambia despacio a lo largo, más grano fino.
  for (let y = 0; y < H; y++) {
    const rowTone = (rnd() - 0.5) * spread * 0.9;
    let drift = 0;
    for (let x = 0; x < W; x++) {
      drift = drift * 0.985 + (rnd() - 0.5) * spread * 0.12;
      const t = rowTone + drift + (rnd() - 0.5) * spread * 0.5;
      const i = (y * W + x) * 4;
      img.data[i] = base[0] + t;
      img.data[i + 1] = base[1] + t * 0.95;
      img.data[i + 2] = base[2] + t * 0.85;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  // Suaviza a lo largo (el cepillado) y agrega un brillo suave en diagonal.
  ctx.globalAlpha = 0.5;
  ctx.drawImage(canvas, 3, 0);
  ctx.drawImage(canvas, -3, 0);
  ctx.globalAlpha = 1;
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, 'rgba(255,255,255,0.10)');
  g.addColorStop(0.45, 'rgba(255,255,255,0)');
  g.addColorStop(0.7, 'rgba(0,0,0,0.12)');
  g.addColorStop(1, 'rgba(255,255,255,0.06)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
  canvas.width = 0;
  return blob ? createAsset(`${metal} cepillado`, 'image/jpeg', new Uint8Array(await blob.arrayBuffer())) : null;
}

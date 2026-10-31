/**
 * Escribe la resolución (ppp) dentro de los archivos PNG y JPG. Sin esto,
 * Photoshop, Word o el programa de la impresora suponen 72 o 96 ppp y la placa
 * sale de otro tamaño al imprimir.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

/** PNG: inserta (o reemplaza) el bloque pHYs con los píxeles por metro. */
export function setPngDpi(png: Uint8Array, dpi: number): Uint8Array<ArrayBuffer> {
  if (!PNG_SIGNATURE.every((b, i) => png[i] === b)) throw new Error('No es un PNG');
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const chunks: Array<{ type: string; start: number; end: number }> = [];
  for (let pos = 8; pos < png.length; ) {
    const length = view.getUint32(pos);
    const type = String.fromCharCode(...png.subarray(pos + 4, pos + 8));
    chunks.push({ type, start: pos, end: pos + 12 + length });
    pos += 12 + length;
    if (type === 'IEND') break;
  }
  const ppm = Math.round(dpi / 0.0254);
  const phys = new Uint8Array(21);
  const pv = new DataView(phys.buffer);
  pv.setUint32(0, 9);
  phys.set([112, 72, 89, 115], 4); // "pHYs"
  pv.setUint32(8, ppm);
  pv.setUint32(12, ppm);
  phys[16] = 1; // unidad: metro
  pv.setUint32(17, crc32(phys.subarray(4, 17)));

  const parts: Uint8Array[] = [png.subarray(0, 8)];
  for (const chunk of chunks) {
    if (chunk.type === 'pHYs') continue;
    parts.push(png.subarray(chunk.start, chunk.end));
    if (chunk.type === 'IHDR') parts.push(phys); // va justo después de la cabecera
  }
  return concat(parts);
}

/** JPG: ajusta la densidad en la cabecera JFIF (la que escribe Chromium). */
export function setJpegDpi(jpeg: Uint8Array, dpi: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(jpeg);
  const isJfif = out[0] === 0xff && out[1] === 0xd8 && out[2] === 0xff && out[3] === 0xe0 && String.fromCharCode(...out.subarray(6, 10)) === 'JFIF';
  if (!isJfif) throw new Error('No es un JPG con cabecera JFIF');
  const v = Math.min(65535, Math.round(dpi));
  out[13] = 1; // unidad: puntos por pulgada
  out[14] = v >> 8;
  out[15] = v & 0xff;
  out[16] = v >> 8;
  out[17] = v & 0xff;
  return out;
}

export function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

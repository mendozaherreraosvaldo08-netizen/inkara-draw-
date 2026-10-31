import { concat } from './raster-meta';

/**
 * PDF de una página con la placa como imagen sin pérdida (FlateDecode), al
 * tamaño exacto en milímetros. Es lo que piden los programas de impresión
 * (RIP) y las imprentas: la página mide lo que mide la placa más el sangrado.
 */
export interface PdfImagePage {
  title: string;
  widthMm: number;
  heightMm: number;
  /** Tamaño de la imagen en píxeles. */
  imageWidth: number;
  imageHeight: number;
  /** Píxeles RGB (3 bytes por píxel) ya comprimidos con zlib (deflate). */
  deflatedRgb: Uint8Array;
}

/** Una página: imagen comprimida sin pérdida (deflate) o un JPG tal cual. */
export interface PdfPage {
  widthMm: number;
  heightMm: number;
  imageWidth: number;
  imageHeight: number;
  data: Uint8Array;
  filter: 'FlateDecode' | 'DCTDecode';
}

const MM_TO_PT = 72 / 25.4;

export function buildPdf(page: PdfImagePage): Uint8Array<ArrayBuffer> {
  return buildPdfPages(page.title, [{ widthMm: page.widthMm, heightMm: page.heightMm, imageWidth: page.imageWidth, imageHeight: page.imageHeight, data: page.deflatedRgb, filter: 'FlateDecode' }]);
}

/** PDF con una placa por página (placas en serie: un solo archivo para imprimir todas). */
export function buildPdfPages(title: string, pages: PdfPage[]): Uint8Array<ArrayBuffer> {
  const enc = new TextEncoder();
  // Objetos: 1 catálogo, 2 páginas, 3 info; luego 3 por página (página, imagen, contenido).
  const objects: Uint8Array[][] = [];
  const pageIds = pages.map((_, i) => 4 + i * 3);
  objects[0] = [enc.encode('<< /Type /Catalog /Pages 2 0 R >>')];
  objects[1] = [enc.encode(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`)];
  objects[2] = [enc.encode(`<< /Title ${pdfString(title)} /Creator (Inkara Draw) /Producer (Inkara Draw) >>`)];
  pages.forEach((page, i) => {
    const id = pageIds[i]!;
    const w = (page.widthMm * MM_TO_PT).toFixed(3);
    const h = (page.heightMm * MM_TO_PT).toFixed(3);
    const content = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`;
    objects[id - 1] = [enc.encode(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /TrimBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 ${id + 1} 0 R >> >> /Contents ${id + 2} 0 R >>`)];
    objects[id] = [
      enc.encode(`<< /Type /XObject /Subtype /Image /Width ${page.imageWidth} /Height ${page.imageHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /${page.filter} /Length ${page.data.length} >>\nstream\n`),
      page.data,
      enc.encode('\nendstream'),
    ];
    objects[id + 1] = [enc.encode(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`)];
  });
  // El comentario binario de la 2.ª línea indica a los programas que el archivo es binario.
  const parts: Uint8Array[] = [concat([enc.encode('%PDF-1.4\n%'), new Uint8Array([0xe2, 0xe3, 0xcf, 0xd3]), enc.encode('\n')])];
  const offsets: number[] = [];
  let length = parts[0]!.length;
  objects.forEach((body, i) => {
    offsets.push(length);
    const obj = concat([enc.encode(`${i + 1} 0 obj\n`), ...body, enc.encode('\nendobj\n')]);
    parts.push(obj);
    length += obj.length;
  });
  const xref = [`xref\n0 ${objects.length + 1}\n`, '0000000000 65535 f \n', ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)].join('');
  parts.push(enc.encode(`${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${length}\n%%EOF\n`));
  return concat(parts);
}

/** Texto PDF en UTF-16 (acentos y ñ en el título). */
function pdfString(text: string): string {
  const hex = ['FEFF', ...[...text.slice(0, 200)].flatMap((ch) => {
    const code = ch.codePointAt(0)!;
    if (code <= 0xffff) return [code.toString(16).padStart(4, '0')];
    const c = code - 0x10000;
    return [(0xd800 + (c >> 10)).toString(16), (0xdc00 + (c & 0x3ff)).toString(16)];
  })].join('');
  return `<${hex.toUpperCase()}>`;
}

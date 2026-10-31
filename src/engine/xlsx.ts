import { tableFromRecords } from './merge';

/**
 * Lee la primera hoja de un Excel (.xlsx) sin librerías: un .xlsx es un ZIP
 * con archivos XML. Solo se leen los valores (texto y números), no formatos.
 * `inflate` descomprime "deflate" sin encabezado (el navegador lo hace con
 * DecompressionStream; así el motor no depende del navegador).
 */

export type Inflate = (data: Uint8Array) => Promise<Uint8Array>;

export class XlsxError extends Error {}

/** Archivos dentro de un ZIP: nombre → función que da su contenido. */
export function readZip(bytes: Uint8Array, inflate: Inflate): Map<string, () => Promise<Uint8Array>> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new XlsxError('El archivo no es un Excel (.xlsx) válido.');
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const files = new Map<string, () => Promise<Uint8Array>>();
  const decoder = new TextDecoder();
  for (let k = 0; k < count && p + 46 <= bytes.length; k++) {
    if (view.getUint32(p, true) !== 0x02014b50) break;
    const method = view.getUint16(p + 10, true);
    const size = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    files.set(name, async () => {
      if (view.getUint32(local, true) !== 0x04034b50) throw new XlsxError('El Excel está dañado.');
      const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
      const data = bytes.subarray(start, start + size);
      if (method === 0) return data;
      if (method === 8) return inflate(data);
      throw new XlsxError('El Excel usa una compresión que no se puede leer.');
    });
  }
  return files;
}

const decodeXml = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) => {
    const k = e.toLowerCase();
    if (k === 'amp') return '&';
    if (k === 'lt') return '<';
    if (k === 'gt') return '>';
    if (k === 'quot') return '"';
    if (k === 'apos') return "'";
    const code = k.startsWith('#x') ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : '';
  });

/** Todo el texto de las etiquetas <t> (textos con formato vienen en varias). */
const textRuns = (xml: string) => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => decodeXml(m[1]!)).join('');

/** "B12" → columna 1 (A = 0). */
function columnIndex(ref: string): number {
  let n = 0;
  for (const ch of ref.replace(/\d+$/, '').toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Un número de Excel como texto legible (2022 y no 2022.0000000001). */
function numberText(v: string): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  return Number.isInteger(n) ? String(n) : String(Number(n.toPrecision(12)));
}

export async function readXlsx(bytes: Uint8Array, inflate: Inflate): Promise<{ columns: string[]; rows: string[][]; sheet: string }> {
  const files = readZip(bytes, inflate);
  const decoder = new TextDecoder();
  const text = async (name: string) => {
    const f = files.get(name);
    return f ? decoder.decode(await f()) : null;
  };
  // Primera hoja del libro (en el orden de las pestañas).
  const workbook = (await text('xl/workbook.xml')) ?? '';
  const first = /<sheet\b[^>]*?name="([^"]*)"[^>]*?r:id="([^"]*)"/.exec(workbook) ?? /<sheet\b[^>]*?r:id="([^"]*)"[^>]*?name="([^"]*)"/.exec(workbook);
  let sheetPath = 'xl/worksheets/sheet1.xml';
  let sheetName = 'Hoja 1';
  if (first) {
    const [name, rid] = first[0].indexOf('name=') < first[0].indexOf('r:id=') ? [first[1]!, first[2]!] : [first[2]!, first[1]!];
    sheetName = decodeXml(name);
    const rels = (await text('xl/_rels/workbook.xml.rels')) ?? '';
    const rel = [...rels.matchAll(/<Relationship\b[^>]*>/g)].map((m) => m[0]).find((r) => r.includes(`Id="${rid}"`));
    const target = rel ? /Target="([^"]*)"/.exec(rel)?.[1] : undefined;
    if (target) sheetPath = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
  }
  if (!files.has(sheetPath)) sheetPath = [...files.keys()].filter((n) => /^xl\/worksheets\/[^/]+\.xml$/.test(n)).sort()[0] ?? sheetPath;
  const sheet = await text(sheetPath);
  if (!sheet) throw new XlsxError('No se encontró ninguna hoja en el Excel.');

  const shared = [...((await text('xl/sharedStrings.xml')) ?? '').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) => textRuns(m[1]!));

  const grid: string[][] = [];
  for (const rowMatch of sheet.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const r = Number(/\br="(\d+)"/.exec(rowMatch[1]!)?.[1] ?? grid.length + 1) - 1;
    const cells: string[] = [];
    let next = 0;
    for (const c of rowMatch[2]!.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1]!;
      const ref = /\br="([A-Z]+\d+)"/i.exec(attrs)?.[1];
      const col = ref ? columnIndex(ref) : next;
      next = col + 1;
      const type = /\bt="([^"]*)"/.exec(attrs)?.[1] ?? 'n';
      const body = c[2] ?? '';
      const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      let value = '';
      if (type === 's') value = shared[Number(v)] ?? '';
      else if (type === 'inlineStr') value = textRuns(body);
      else if (type === 'b') value = v === '1' ? 'Sí' : 'No';
      else if (type === 'str' || type === 'e') value = decodeXml(v ?? '');
      else if (v !== undefined) value = numberText(decodeXml(v));
      if (col < 200) cells[col] = value;
    }
    if (r >= 0 && r < 20_000) grid[r] = Array.from(cells, (x) => x ?? '');
  }
  const records = Array.from(grid, (row) => row ?? []);
  const { columns, rows } = tableFromRecords(records);
  if (columns.length === 0) throw new XlsxError('La primera hoja del Excel está vacía.');
  return { columns, rows, sheet: sheetName };
}

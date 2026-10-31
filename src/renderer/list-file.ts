import { parseTable } from '../engine/merge';
import { readXlsx, XlsxError } from '../engine/xlsx';

/**
 * Abrir la lista de una placa en serie: Excel (.xlsx), CSV o TSV (por ejemplo,
 * descargado de Google Sheets), o texto pegado.
 */

export const LIST_EXTENSIONS = /\.(xlsx|csv|tsv|txt)$/i;
export const isListFile = (f: { name: string }) => /\.(xlsx|csv|tsv)$/i.test(f.name);

/** Descomprime "deflate" con el descompresor del navegador. */
async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export interface ListTable {
  columns: string[];
  rows: string[][];
  source: string;
}

export async function readListFile(file: File): Promise<ListTable> {
  if (/\.xls$/i.test(file.name)) throw new Error('Ese es un Excel antiguo (.xls). En Excel: Archivo › Guardar como › "Libro de Excel (.xlsx)" y vuelve a intentarlo.');
  if (/\.xlsx$/i.test(file.name)) {
    try {
      const t = await readXlsx(new Uint8Array(await file.arrayBuffer()), inflate);
      return { columns: t.columns, rows: t.rows, source: `${file.name} · hoja “${t.sheet}”` };
    } catch (error) {
      throw new Error(error instanceof XlsxError ? error.message : `No se pudo leer el Excel (${error instanceof Error ? error.message : String(error)}).`);
    }
  }
  const t = parseTable(await file.text());
  if (t.columns.length === 0 || t.rows.length === 0) throw new Error('El archivo no tiene datos (la primera fila deben ser los títulos).');
  return { ...t, source: file.name };
}

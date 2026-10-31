import type { ImageAsset, MergeData, PageSetup, TrazoDocument } from './document';
import { multiply, translate } from './matrix';
import { shapeBounds, type ImageShape, type Shape, type TextShape } from './shapes';
import { layoutText, relayoutText, visualScale } from './text';

/**
 * Placas en serie ("combinar correspondencia"): un diseño con campos y una
 * tabla de datos. Cada fila de la tabla es una placa.
 *  - Textos: {{Nombre}}, {{Generación}}… se reemplazan por el valor de la fila.
 *  - Fotos: una imagen con `field` toma la foto de esa columna (nombre de archivo)
 *    y la recorta para llenar el marco sin deformarla.
 */

export const FIELD_PATTERN = /\{\{\s*([^{}]+?)\s*\}\}/g;
/** ¿El texto tiene algún campo? (sin la bandera g: no guarda estado entre llamadas) */
const HAS_FIELD = /\{\{\s*[^{}]+?\s*\}\}/;

const norm = (s: string) => s.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

// ---- Leer tablas ----

/**
 * Lee una tabla pegada desde Excel / Google Sheets (separada por tabuladores) o
 * un CSV (comas o punto y coma, con comillas). La primera fila son los títulos.
 */
export function parseTable(text: string): { columns: string[]; rows: string[][] } {
  const clean = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').replace(/\n+$/, '');
  if (!clean.trim()) return { columns: [], rows: [] };
  const firstLine = clean.split('\n')[0]!;
  // El separador que más aparece en la primera línea (fuera de comillas).
  const counts = ['\t', ';', ','].map((sep) => ({ sep, n: firstLine.replace(/"[^"]*"/g, '').split(sep).length - 1 }));
  const sep = counts.sort((a, b) => b.n - a.n)[0]!.n > 0 ? counts[0]!.sep : '\t';

  const records: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i]!;
    if (quoted) {
      if (ch === '"') {
        if (clean[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"' && cell === '') {
      quoted = true;
    } else if (ch === sep) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      records.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  row.push(cell);
  records.push(row);
  return tableFromRecords(records);
}

// Nombres de columna que se entienden aunque no se llamen igual que el campo.
const ALIASES: Record<string, string[]> = {
  nombre: ['nombre', 'nombres', 'nombre completo', 'nombre del alumno', 'alumno', 'alumna', 'alumnos', 'estudiante', 'egresado', 'egresada', 'graduado', 'graduada'],
  carrera: ['carrera', 'licenciatura', 'programa', 'programa educativo', 'especialidad', 'ingenieria', 'facultad', 'grado'],
  generacion: ['generacion', 'gen', 'periodo', 'ciclo', 'ciclo escolar'],
  acabado: ['acabado', 'acabados', 'color', 'colores', 'fondo', 'color de placa', 'tipo de placa', 'material'],
};
/** A qué campo conocido corresponde un título ("Alumno" → nombre), o null. */
export function canonicalField(name: string): string | null {
  const n = norm(name).replace(/[:.]/g, '').trim();
  for (const [key, list] of Object.entries(ALIASES)) if (list.includes(n)) return key;
  return null;
}
const CANON_TITLE: Record<string, string> = { nombre: 'Nombre', carrera: 'Carrera', generacion: 'Generación', acabado: 'Acabado' };

const FINISH_WORDS = new Set(['blanco', 'blanca', 'negro', 'negra', 'bronce', 'dorado', 'dorada', 'oro', 'plata', 'plateado', 'plateada', 'cobre', 'cafe', 'gris']);
const CAREER = /^(lic|lcda?|licenciatura|ing|ingenier|arq|arquitect|mtr|maestr|doctor|dr|tec|tecnic|contador|quimic|medic|enfermer|psicolog|derecho|admin)/;
const YEARS = /\b(19|20)\d{2}\b|generaci/;

/** Sin títulos: adivina cada columna por lo que tiene (nombres, carreras, años, acabados). */
function guessColumns(rows: string[][], width: number): string[] {
  const share = (i: number, test: (v: string) => boolean) => {
    const vals = rows.map((r) => norm(r[i] ?? '')).filter(Boolean);
    return vals.length ? vals.filter(test).length / vals.length : 0;
  };
  const used = new Set<string>();
  const roles: (string | null)[] = Array.from({ length: width }, () => null);
  const pick = (key: string, test: (v: string) => boolean, min: number) => {
    let best = -1, bestScore = min;
    for (let i = 0; i < width; i++) if (!roles[i]) { const sc = share(i, test); if (sc >= bestScore) { best = i; bestScore = sc; } }
    if (best >= 0 && !used.has(key)) { roles[best] = key; used.add(key); }
  };
  pick('acabado', (v) => FINISH_WORDS.has(v.replace(/\s+/g, ' ').trim()), 0.6);
  pick('generacion', (v) => YEARS.test(v), 0.6);
  pick('carrera', (v) => CAREER.test(v), 0.5);
  pick('nombre', (v) => /^[a-zñ'. -]+$/.test(v) && v.trim().split(/\s+/).length >= 2, 0.6);
  return roles.map((r, i) => (r ? CANON_TITLE[r]! : `Columna ${i + 1}`));
}

/**
 * Tabla a partir de filas de celdas. Los títulos son la primera fila que tiene un
 * título conocido (Nombre, Alumno, Carrera…), aunque arriba haya un renglón con el
 * nombre del grupo. Si la lista no tiene títulos, las columnas se adivinan.
 */
export function tableFromRecords(input: string[][]): { columns: string[]; rows: string[][] } {
  const records = input.filter((r) => r.some((c) => (c ?? '').trim() !== ''));
  if (records.length === 0) return { columns: [], rows: [] };
  const width = Math.max(...records.map((r) => r.length));
  let headerAt = records.slice(0, 10).findIndex((r) => r.some((c) => canonicalField(c ?? '') !== null));
  // Una sola celda en la primera fila (p. ej. "Lista UNICEQ") y títulos normales abajo: también cuenta.
  if (headerAt < 0 && records.length > 1 && records[0]!.filter((c) => (c ?? '').trim()).length >= 2 && guessColumns(records.slice(1, 30), width).every((c) => c.startsWith('Columna'))) headerAt = 0;
  let header: string[];
  let body: string[][];
  if (headerAt >= 0) {
    header = records[headerAt]!.map((c) => (c ?? '').trim());
    body = records.slice(headerAt + 1);
  } else {
    header = guessColumns(records.slice(0, 50), width);
    body = records;
  }
  const seen = new Set<string>();
  const columns = Array.from({ length: width }, (_, i) => {
    let name = header[i] || `Columna ${i + 1}`;
    // Títulos repetidos: "Nombre", "Nombre 2"
    let k = 2;
    const base = name;
    while (seen.has(norm(name))) name = `${base} ${k++}`;
    seen.add(norm(name));
    return name;
  });
  const rows = body
    .map((r) => columns.map((_, i) => (r[i] ?? '').trim()))
    .filter((r) => r.some((c) => c !== '')); // filas vacías fuera
  return { columns, rows };
}

// ---- Campos ----

/** Campos {{…}} que usa el diseño y las columnas de foto. */
export function fieldsInDocument(doc: TrazoDocument): { text: string[]; photos: string[] } {
  const text = new Set<string>();
  const photos = new Set<string>();
  for (const s of doc.shapes) {
    if (s.kind === 'text') for (const m of s.text.matchAll(FIELD_PATTERN)) text.add(m[1]!.trim());
    if (s.kind === 'image' && s.field) photos.add(s.field);
  }
  return { text: [...text], photos: [...photos] };
}

/** Valor de una columna (sin importar mayúsculas ni acentos en el nombre del campo). */
function columnIndex(columns: string[], field: string): number {
  const i = columns.findIndex((c) => norm(c) === norm(field));
  if (i >= 0) return i;
  // "Nombre" también encuentra la columna "Alumno", "Carrera" la de "Licenciatura"…
  const key = canonicalField(field);
  return key ? columns.findIndex((c) => canonicalField(c) === key) : -1;
}
function valueOf(merge: MergeData, row: string[], field: string): string | undefined {
  const i = columnIndex(merge.columns, field);
  return i < 0 ? undefined : (row[i] ?? '');
}

/** Campos del diseño que no existen en la tabla (para avisar). */
export function unknownFields(doc: TrazoDocument): string[] {
  if (!doc.merge) return [];
  const { text, photos } = fieldsInDocument(doc);
  return [...text, ...photos].filter((f) => columnIndex(doc.merge!.columns, f) < 0);
}

export function fillText(template: string, merge: MergeData, row: string[]): string {
  // Si la plantilla ya dice "Generación:" y la celda también ("generacion 2022-2026"), no se repite.
  const fixed = template.replace(FIELD_PATTERN, '');
  return template.replace(FIELD_PATTERN, (whole, field: string) => {
    const v = valueOf(merge, row, field);
    if (v === undefined) return whole;
    if (canonicalField(field) === 'generacion' && /generaci[oó]n/i.test(fixed)) return v.replace(/^\s*generaci[oó]n\s*:?\s*/i, '');
    return v;
  });
}

/** Nombre de archivo de una placa (sin extensión), seguro para Windows. */
export function fileNameFor(merge: MergeData, row: string[], index: number): string {
  const name = fillText(merge.fileName || `Placa {{#}}`, merge, row)
    .replace(/\{\{\s*#\s*\}\}/g, String(index + 1).padStart(3, '0'))
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  return name.slice(0, 120) || `Placa ${String(index + 1).padStart(3, '0')}`;
}

/**
 * Recorte para que una foto llene el marco sin deformarse ("cubrir"). Lo que
 * sobra se corta por los lados o, en fotos verticales, un poco más por abajo
 * (las caras suelen estar arriba).
 */
export function coverCrop(frame: ImageShape, photo: { widthPx: number; heightPx: number }): NonNullable<ImageShape['crop']> {
  const [a, b, c, d] = frame.transform;
  const frameAspect = (frame.width * Math.hypot(a, b)) / (frame.height * Math.hypot(c, d));
  const photoAspect = photo.widthPx / photo.heightPx;
  if (photoAspect > frameAspect) {
    const w = frameAspect / photoAspect;
    return { x: (1 - w) / 2, y: 0, width: w, height: 1 };
  }
  const h = photoAspect / frameAspect;
  return { x: 0, y: (1 - h) * 0.35, width: 1, height: h };
}

/**
 * El documento de una fila: textos con sus valores y fotos en sus marcos.
 * `photos` da el asset de la foto de cada valor (o null si no se encontró:
 * entonces el marco conserva la imagen de ejemplo).
 */
export function applyRow(doc: TrazoDocument, row: string[], photos: (value: string) => ImageAsset | null = () => null): { doc: TrazoDocument; missingPhotos: string[] } {
  const merge = doc.merge;
  if (!merge) return { doc, missingPhotos: [] };
  const assets = { ...doc.assets };
  const missingPhotos: string[] = [];
  const shapes = doc.shapes.map((s): Shape => {
    if (s.showWhen && !conditionHolds(s.showWhen, merge, row)) return { ...s, hidden: true };
    if (s.kind === 'text' && HAS_FIELD.test(s.text)) {
      const filled = relayoutText({ ...s, text: fillText(s.text, merge, row) });
      return merge.fit === false ? filled : fitFieldText(s, filled, doc.page);
    }
    if (s.kind === 'image' && s.field) {
      const value = valueOf(merge, row, s.field);
      if (!value) return s;
      const asset = photos(value);
      if (!asset) {
        missingPhotos.push(value);
        return s;
      }
      assets[asset.id] = asset;
      return { ...s, assetId: asset.id, crop: coverCrop(s, asset) };
    }
    return s;
  });
  return { doc: { ...doc, shapes, assets }, missingPhotos };
}

/** ¿La fila cumple "mostrar solo si"? La celda contiene alguno de los valores (sin importar mayúsculas ni acentos). */
export function conditionHolds(cond: { column: string; value: string }, merge: MergeData, row: string[]): boolean {
  const cell = valueOf(merge, row, cond.column);
  if (cell === undefined) return true; // columna que no está en la lista: no se oculta nada
  const v = norm(cell);
  return cond.value
    .split('|')
    .map((x) => norm(x))
    .filter(Boolean)
    .some((x) => v.includes(x));
}

/** Lo más que se puede achicar un nombre para que quepa (70 % del tamaño original). */
export const MIN_FIT = 0.7;

/**
 * Nombres que caben solos: si el texto ya con el dato se sale del espacio
 * (el ancho máximo del texto o la placa menos el margen seguro, según dónde
 * está anclado), primero se parte en dos líneas por el espacio más parejo y,
 * si aun así no cabe, se achica la letra hasta un 70 %. Se conserva el ancla
 * (izquierda, centro o derecha) y el centro vertical del texto.
 */
export function fitFieldText(template: TextShape, filled: TextShape, page: PageSetup): TextShape {
  if (filled.arc || filled.frameWidth || filled.text.includes('\n')) return filled;
  const [a, b] = filled.transform;
  if (Math.abs(b) > 1e-6 * Math.abs(a || 1)) return filled; // girado: se deja como está
  const k = visualScale(filled);
  // Espacio disponible en la página según el ancla del texto (sin el dato todavía).
  const box = shapeBounds(template);
  const m = page.safeMarginMm;
  const anchorX = template.align === 'center' ? box.x + box.width / 2 : template.align === 'right' ? box.x + box.width : box.x;
  const room = template.align === 'center' ? 2 * Math.min(anchorX - m, page.widthMm - m - anchorX) : template.align === 'right' ? anchorX - m : page.widthMm - m - anchorX;
  const limit = Math.min(room / k, template.maxWidthMm ?? Infinity);
  if (!(limit > 0)) return filled;
  const plain: TextShape = { ...filled };
  delete plain.maxWidthMm;
  const widest = (t: TextShape) => Math.max(0, ...layoutText(t).widths);
  if (widest(plain) <= limit + 1e-6) return filled;

  // 1. En dos líneas, cortando en el espacio que deja las líneas más parejas.
  let best: TextShape = plain;
  let bestW = widest(plain);
  const text = plain.text;
  for (let i = text.indexOf(' '); i > 0; i = text.indexOf(' ', i + 1)) {
    const two: TextShape = { ...plain, text: `${text.slice(0, i).trimEnd()}\n${text.slice(i + 1).trimStart()}` };
    const w = widest(two);
    if (w < bestW) {
      best = two;
      bestW = w;
    }
  }
  // 2. Si aún no cabe, se achica la letra (hasta el 70 %).
  if (bestW > limit) best = { ...best, fontSizePt: best.fontSizePt * Math.max(MIN_FIT, limit / bestW) };
  const out = relayoutText({ ...best, width: plain.width, height: plain.height, transform: plain.transform });
  // Centro vertical: si creció hacia abajo, se sube la mitad.
  const dh = out.height - plain.height;
  return Math.abs(dh) > 1e-9 ? { ...out, transform: multiply(out.transform, translate(0, -dh / 2)) } : out;
}

/** Busca la foto de un valor entre nombres de archivo (sin importar mayúsculas, acentos ni extensión). */
export function matchPhoto(value: string, fileNames: string[]): string | null {
  const v = norm(value);
  const stem = (n: string) => norm(n).replace(/\.[a-z0-9]+$/, '');
  return fileNames.find((f) => norm(f) === v) ?? fileNames.find((f) => stem(f) === v.replace(/\.[a-z0-9]+$/, '')) ?? null;
}

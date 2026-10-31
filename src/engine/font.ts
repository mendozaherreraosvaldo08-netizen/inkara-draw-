/**
 * Lector de fuentes TrueType (.ttf), OpenType con contornos CFF (.otf) y
 * colecciones (.ttc). Solo lo necesario para convertir texto a curvas: elegir
 * el glifo de cada letra, su avance, el interletrado (tabla kern) y su contorno.
 *
 * Los contornos salen en unidades de la fuente, con Y hacia arriba.
 */

export type OutlineCommand =
  | { type: 'M'; x: number; y: number }
  | { type: 'L'; x: number; y: number }
  | { type: 'Q'; cx: number; cy: number; x: number; y: number }
  | { type: 'C'; c1x: number; c1y: number; c2x: number; c2y: number; x: number; y: number }
  | { type: 'Z' };

export interface Font {
  family: string;
  subfamily: string;
  unitsPerEm: number;
  ascender: number;
  descender: number;
  /** Índice de glifo de un carácter (0 = no existe en la fuente). */
  glyphIndex(codePoint: number): number;
  /** Avance horizontal en unidades de la fuente. */
  advance(glyph: number): number;
  /** Ajuste entre dos glifos (tabla kern clásica), en unidades de la fuente. */
  kerning(left: number, right: number): number;
  outline(glyph: number): OutlineCommand[];
}

export class FontError extends Error {}

class Reader {
  readonly view: DataView;
  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  u8 = (o: number) => this.view.getUint8(o);
  i8 = (o: number) => this.view.getInt8(o);
  u16 = (o: number) => this.view.getUint16(o);
  i16 = (o: number) => this.view.getInt16(o);
  u32 = (o: number) => this.view.getUint32(o);
  i32 = (o: number) => this.view.getInt32(o);
  tag = (o: number) => String.fromCharCode(this.u8(o), this.u8(o + 1), this.u8(o + 2), this.u8(o + 3));
}

interface Tables {
  [tag: string]: { offset: number; length: number };
}

function readTables(r: Reader, offset: number): Tables {
  const count = r.u16(offset + 4);
  const tables: Tables = {};
  for (let i = 0; i < count; i++) {
    const rec = offset + 12 + i * 16;
    tables[r.tag(rec)] = { offset: r.u32(rec + 8), length: r.u32(rec + 12) };
  }
  return tables;
}

/** Nombres de la fuente (tabla name): familia y estilo. Prefiere los "tipográficos" (16/17). */
function readNames(r: Reader, t: Tables): { family: string; subfamily: string; full: string } {
  const name = t.name;
  const found: Record<number, string> = {};
  if (name) {
    const count = r.u16(name.offset + 2);
    const strings = name.offset + r.u16(name.offset + 4);
    let best: Record<number, number> = {};
    for (let i = 0; i < count; i++) {
      const rec = name.offset + 6 + i * 12;
      const platform = r.u16(rec);
      const encoding = r.u16(rec + 2);
      const language = r.u16(rec + 4);
      const id = r.u16(rec + 6);
      if (![1, 2, 4, 16, 17].includes(id)) continue;
      const length = r.u16(rec + 8);
      const start = strings + r.u16(rec + 10);
      let text = '';
      // Windows Unicode (UTF-16BE): preferido, inglés de EE. UU. primero.
      if (platform === 3 && (encoding === 1 || encoding === 10)) {
        for (let k = 0; k + 1 < length; k += 2) text += String.fromCharCode(r.u16(start + k));
      } else if (platform === 1 && encoding === 0) {
        for (let k = 0; k < length; k++) text += String.fromCharCode(r.u8(start + k));
      } else continue;
      const score = (platform === 3 ? 2 : 0) + (language === 0x409 || language === 0 ? 1 : 0);
      if (best[id] === undefined || score > best[id]!) {
        best = { ...best, [id]: score };
        found[id] = text;
      }
    }
  }
  return { family: found[16] ?? found[1] ?? '', subfamily: found[17] ?? found[2] ?? '', full: found[4] ?? '' };
}

/**
 * Lee una fuente. En una colección (.ttc) elige la que mejor coincide con la
 * familia y el estilo pedidos (p. ej. "Cambria Math" dentro de cambria.ttc).
 */
export function parseFont(bytes: Uint8Array, want: { family?: string; bold?: boolean; italic?: boolean } = {}): Font {
  const r = new Reader(bytes);
  if (bytes.length < 12) throw new FontError('Archivo de fuente vacío o dañado');
  const signature = r.tag(0);
  let offsets: number[];
  if (signature === 'ttcf') {
    const n = r.u32(8);
    offsets = Array.from({ length: n }, (_, i) => r.u32(12 + i * 4));
  } else if (signature === '\0\u0001\0\0' || signature === 'OTTO' || signature === 'true') {
    offsets = [0];
  } else if (signature === 'wOFF' || signature === 'wOF2') {
    throw new FontError('Las fuentes WOFF no se pueden convertir a curvas');
  } else {
    throw new FontError('No es un archivo de fuente reconocido');
  }

  const candidates = offsets.map((offset) => {
    const tables = readTables(r, offset);
    return { tables, names: readNames(r, tables) };
  });
  const wantFamily = want.family?.trim().toLowerCase();
  const score = (c: (typeof candidates)[number]) => {
    const sub = c.names.subfamily.toLowerCase();
    let s = 0;
    if (wantFamily && c.names.family.toLowerCase() === wantFamily) s += 10;
    if (/bold/.test(sub) === !!want.bold) s += 2;
    if (/italic|oblique/.test(sub) === !!want.italic) s += 2;
    return s;
  };
  const chosen = candidates.reduce((a, b) => (score(b) > score(a) ? b : a));
  return buildFont(r, chosen.tables, chosen.names);
}

function buildFont(r: Reader, t: Tables, names: { family: string; subfamily: string }): Font {
  const need = (tag: string) => {
    const table = t[tag];
    if (!table) throw new FontError(`A la fuente le falta la tabla ${tag.trim()}`);
    return table.offset;
  };
  const head = need('head');
  const unitsPerEm = r.u16(head + 18) || 1000;
  const indexToLocFormat = r.i16(head + 50);
  const hhea = need('hhea');
  const ascender = r.i16(hhea + 4);
  const descender = r.i16(hhea + 6);
  const numberOfHMetrics = r.u16(hhea + 34);
  const hmtx = need('hmtx');
  const numGlyphs = t.maxp ? r.u16(t.maxp.offset + 4) : 65535;

  const cmap = readCmap(r, need('cmap'));
  const kern = readKern(r, t.kern?.offset);

  let outline: (glyph: number) => OutlineCommand[];
  if (t.glyf && t.loca) {
    const glyf = t.glyf.offset;
    const loca = t.loca.offset;
    const glyphOffset = (g: number): [number, number] => {
      if (g < 0 || g >= numGlyphs) return [0, 0];
      return indexToLocFormat === 0 ? [r.u16(loca + g * 2) * 2, r.u16(loca + g * 2 + 2) * 2] : [r.u32(loca + g * 4), r.u32(loca + g * 4 + 4)];
    };
    outline = (g) => glyfOutline(r, glyf, glyphOffset, g, 0);
  } else if (t['CFF ']) {
    const cff = readCff(r, t['CFF '].offset);
    outline = (g) => cff.outline(g);
  } else {
    throw new FontError('La fuente no tiene contornos que se puedan leer');
  }

  return {
    family: names.family,
    subfamily: names.subfamily,
    unitsPerEm,
    ascender,
    descender,
    glyphIndex: (cp) => cmap(cp),
    advance: (g) => r.u16(hmtx + Math.min(g, numberOfHMetrics - 1) * 4),
    kerning: (a, b) => kern.get(a * 65536 + b) ?? 0,
    outline: (g) => {
      try {
        return outline(g);
      } catch {
        return []; // un glifo dañado no rompe todo el texto
      }
    },
  };
}

// ---- cmap: carácter → glifo ----

function readCmap(r: Reader, cmap: number): (cp: number) => number {
  const count = r.u16(cmap + 2);
  let format4 = -1;
  let format12 = -1;
  for (let i = 0; i < count; i++) {
    const rec = cmap + 4 + i * 8;
    const platform = r.u16(rec);
    const encoding = r.u16(rec + 2);
    const offset = cmap + r.u32(rec + 4);
    const format = r.u16(offset);
    const unicode = platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10));
    if (!unicode) continue;
    if (format === 12) format12 = offset;
    if (format === 4 && format4 < 0) format4 = offset;
  }
  if (format12 >= 0) {
    const groups = r.u32(format12 + 12);
    return (cp) => {
      let lo = 0;
      let hi = groups - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const g = format12 + 16 + mid * 12;
        const start = r.u32(g);
        const end = r.u32(g + 4);
        if (cp < start) hi = mid - 1;
        else if (cp > end) lo = mid + 1;
        else return r.u32(g + 8) + (cp - start);
      }
      return 0;
    };
  }
  if (format4 >= 0) {
    const segX2 = r.u16(format4 + 6);
    const ends = format4 + 14;
    const starts = ends + segX2 + 2;
    const deltas = starts + segX2;
    const ranges = deltas + segX2;
    return (cp) => {
      if (cp > 0xffff) return 0;
      for (let i = 0; i < segX2; i += 2) {
        if (cp > r.u16(ends + i)) continue;
        const start = r.u16(starts + i);
        if (cp < start) return 0;
        const delta = r.i16(deltas + i);
        const rangeOffset = r.u16(ranges + i);
        if (rangeOffset === 0) return (cp + delta) & 0xffff;
        const glyph = r.u16(ranges + i + rangeOffset + (cp - start) * 2);
        return glyph === 0 ? 0 : (glyph + delta) & 0xffff;
      }
      return 0;
    };
  }
  throw new FontError('La fuente no tiene tabla de caracteres Unicode');
}

// ---- kern (formato 0) ----

function readKern(r: Reader, kern: number | undefined): Map<number, number> {
  const pairs = new Map<number, number>();
  if (kern === undefined) return pairs;
  try {
    const nTables = r.u16(kern + 2);
    let offset = kern + 4;
    for (let i = 0; i < nTables; i++) {
      const length = r.u16(offset + 2);
      const coverage = r.u16(offset + 4);
      // Formato 0, horizontal
      if (coverage >> 8 === 0 && (coverage & 1) === 1) {
        const n = r.u16(offset + 6);
        for (let k = 0; k < n; k++) {
          const p = offset + 14 + k * 6;
          pairs.set(r.u16(p) * 65536 + r.u16(p + 2), r.i16(p + 4));
        }
      }
      offset += length;
    }
  } catch {
    // Tabla kern rara: se ignora.
  }
  return pairs;
}

// ---- glyf (TrueType: curvas cuadráticas) ----

function glyfOutline(r: Reader, glyf: number, locate: (g: number) => [number, number], glyph: number, depth: number): OutlineCommand[] {
  const [start, end] = locate(glyph);
  if (end <= start || depth > 8) return []; // glifo vacío (espacio) o composición demasiado anidada
  const at = glyf + start;
  const contours = r.i16(at);
  if (contours >= 0) return simpleGlyph(r, at, contours);

  // Glifo compuesto: piezas de otros glifos con desplazamiento/escala.
  const out: OutlineCommand[] = [];
  let p = at + 10;
  let flags: number;
  do {
    flags = r.u16(p);
    const component = r.u16(p + 2);
    p += 4;
    let dx: number;
    let dy: number;
    if (flags & 1) {
      dx = r.i16(p);
      dy = r.i16(p + 2);
      p += 4;
    } else {
      dx = r.i8(p);
      dy = r.i8(p + 1);
      p += 2;
    }
    if (!(flags & 2)) {
      dx = 0; // anclado por puntos (raro): se coloca sin desplazamiento
      dy = 0;
    }
    let [a, b, c, d] = [1, 0, 0, 1];
    const f2 = (o: number) => r.i16(o) / 16384;
    if (flags & 8) {
      a = d = f2(p);
      p += 2;
    } else if (flags & 0x40) {
      a = f2(p);
      d = f2(p + 2);
      p += 4;
    } else if (flags & 0x80) {
      a = f2(p);
      b = f2(p + 2);
      c = f2(p + 4);
      d = f2(p + 6);
      p += 8;
    }
    const tx = (x: number, y: number) => ({ x: a * x + c * y + dx, y: b * x + d * y + dy });
    for (const cmd of glyfOutline(r, glyf, locate, component, depth + 1)) out.push(transformCommand(cmd, tx));
  } while (flags & 0x20);
  return out;
}

function transformCommand(cmd: OutlineCommand, t: (x: number, y: number) => { x: number; y: number }): OutlineCommand {
  switch (cmd.type) {
    case 'Z':
      return cmd;
    case 'M':
    case 'L':
      return { type: cmd.type, ...t(cmd.x, cmd.y) };
    case 'Q': {
      const c = t(cmd.cx, cmd.cy);
      return { type: 'Q', cx: c.x, cy: c.y, ...t(cmd.x, cmd.y) };
    }
    case 'C': {
      const c1 = t(cmd.c1x, cmd.c1y);
      const c2 = t(cmd.c2x, cmd.c2y);
      return { type: 'C', c1x: c1.x, c1y: c1.y, c2x: c2.x, c2y: c2.y, ...t(cmd.x, cmd.y) };
    }
  }
}

function simpleGlyph(r: Reader, at: number, contours: number): OutlineCommand[] {
  const endPts: number[] = [];
  for (let i = 0; i < contours; i++) endPts.push(r.u16(at + 10 + i * 2));
  const count = (endPts[contours - 1] ?? -1) + 1;
  let p = at + 10 + contours * 2;
  p += 2 + r.u16(p); // saltar instrucciones de hinting
  const flags: number[] = [];
  while (flags.length < count) {
    const f = r.u8(p++);
    flags.push(f);
    if (f & 8) {
      let repeat = r.u8(p++);
      while (repeat-- > 0 && flags.length < count) flags.push(f);
    }
  }
  const xs: number[] = [];
  let x = 0;
  for (const f of flags) {
    if (f & 2) {
      const v = r.u8(p++);
      x += f & 16 ? v : -v;
    } else if (!(f & 16)) {
      x += r.i16(p);
      p += 2;
    }
    xs.push(x);
  }
  const ys: number[] = [];
  let y = 0;
  for (const f of flags) {
    if (f & 4) {
      const v = r.u8(p++);
      y += f & 32 ? v : -v;
    } else if (!(f & 32)) {
      y += r.i16(p);
      p += 2;
    }
    ys.push(y);
  }

  const out: OutlineCommand[] = [];
  let first = 0;
  for (const last of endPts) {
    const pts = [];
    for (let i = first; i <= last; i++) pts.push({ x: xs[i]!, y: ys[i]!, on: (flags[i]! & 1) === 1 });
    first = last + 1;
    if (pts.length === 0) continue;
    // El contorno empieza en un punto "sobre la curva"; si no hay, en el medio de dos de control.
    let startIndex = pts.findIndex((q) => q.on);
    let start: { x: number; y: number };
    if (startIndex < 0) {
      start = { x: (pts[0]!.x + pts[1 % pts.length]!.x) / 2, y: (pts[0]!.y + pts[1 % pts.length]!.y) / 2 };
      startIndex = 0;
    } else {
      start = pts[startIndex]!;
    }
    out.push({ type: 'M', x: start.x, y: start.y });
    let control: { x: number; y: number } | null = null;
    const n = pts.length;
    const allOff = pts.every((q) => !q.on);
    for (let k = 1; k <= n; k++) {
      const q = pts[(startIndex + k) % n]!;
      if (k === n && !allOff) {
        // De vuelta al punto inicial (que está sobre la curva).
        if (control) out.push({ type: 'Q', cx: control.x, cy: control.y, x: start.x, y: start.y });
        else out.push({ type: 'L', x: start.x, y: start.y });
        break;
      }
      if (q.on) {
        if (control) out.push({ type: 'Q', cx: control.x, cy: control.y, x: q.x, y: q.y });
        else out.push({ type: 'L', x: q.x, y: q.y });
        control = null;
      } else if (control) {
        // Dos puntos de control seguidos: hay uno sobre la curva implícito en medio.
        const mid = { x: (control.x + q.x) / 2, y: (control.y + q.y) / 2 };
        out.push({ type: 'Q', cx: control.x, cy: control.y, x: mid.x, y: mid.y });
        control = q;
      } else {
        control = q;
      }
    }
    // Contorno sin ningún punto sobre la curva (algunas "O"): se cierra en el punto medio inicial.
    if (allOff && control) out.push({ type: 'Q', cx: control.x, cy: control.y, x: start.x, y: start.y });
    out.push({ type: 'Z' });
  }
  return out;
}

// ---- CFF (OpenType .otf: curvas cúbicas, Type 2) ----

interface CffIndex {
  count: number;
  /** Desplazamiento absoluto y largo de cada elemento. */
  item(i: number): { start: number; end: number };
  /** Fin del INDEX (donde empieza lo siguiente). */
  end: number;
}

function readIndex(r: Reader, at: number): CffIndex {
  const count = r.u16(at);
  if (count === 0) return { count: 0, item: () => ({ start: at, end: at }), end: at + 2 };
  const offSize = r.u8(at + 2);
  const offsetAt = (i: number) => {
    let v = 0;
    for (let k = 0; k < offSize; k++) v = v * 256 + r.u8(at + 3 + i * offSize + k);
    return v;
  };
  const dataStart = at + 3 + (count + 1) * offSize - 1;
  return { count, item: (i) => ({ start: dataStart + offsetAt(i), end: dataStart + offsetAt(i + 1) }), end: dataStart + offsetAt(count) };
}

function readDict(r: Reader, start: number, end: number): Map<number, number[]> {
  const dict = new Map<number, number[]>();
  let operands: number[] = [];
  let p = start;
  while (p < end) {
    const b0 = r.u8(p);
    if (b0 <= 21) {
      let op = b0;
      p++;
      if (b0 === 12) op = 1200 + r.u8(p++);
      dict.set(op, operands);
      operands = [];
    } else if (b0 === 28) {
      operands.push(r.i16(p + 1));
      p += 3;
    } else if (b0 === 29) {
      operands.push(r.i32(p + 1));
      p += 5;
    } else if (b0 === 30) {
      // Número real (nibbles)
      let s = '';
      p++;
      for (;;) {
        const byte = r.u8(p++);
        const nibbles = [byte >> 4, byte & 15];
        let done = false;
        for (const nb of nibbles) {
          if (nb === 15) {
            done = true;
            break;
          }
          s += nb <= 9 ? String(nb) : ['.', 'E', 'E-', '', '-'][nb - 10];
        }
        if (done) break;
      }
      operands.push(Number(s));
    } else if (b0 >= 32 && b0 <= 246) {
      operands.push(b0 - 139);
      p++;
    } else if (b0 >= 247 && b0 <= 250) {
      operands.push((b0 - 247) * 256 + r.u8(p + 1) + 108);
      p += 2;
    } else if (b0 >= 251 && b0 <= 254) {
      operands.push(-(b0 - 251) * 256 - r.u8(p + 1) - 108);
      p += 2;
    } else {
      p++;
    }
  }
  return dict;
}

const subrBias = (count: number) => (count < 1240 ? 107 : count < 33900 ? 1131 : 32768);

function readCff(r: Reader, cff: number): { outline(g: number): OutlineCommand[] } {
  const headerSize = r.u8(cff + 2);
  const names = readIndex(r, cff + headerSize);
  const topDicts = readIndex(r, names.end);
  const strings = readIndex(r, topDicts.end);
  const globalSubrs = readIndex(r, strings.end);
  const top = topDicts.item(0);
  const topDict = readDict(r, top.start, top.end);
  const charStringsOffset = topDict.get(17)?.[0];
  if (charStringsOffset === undefined) throw new FontError('Fuente CFF sin glifos');
  const charStrings = readIndex(r, cff + charStringsOffset);

  const privateSubrs = (dict: Map<number, number[]>): CffIndex | null => {
    const priv = dict.get(18);
    if (!priv || priv.length < 2) return null;
    const [size, offset] = priv as [number, number];
    const privDict = readDict(r, cff + offset, cff + offset + size);
    const subrs = privDict.get(19)?.[0];
    return subrs === undefined ? null : readIndex(r, cff + offset + subrs);
  };

  // Fuentes CID (p. ej. japonesas): cada glifo tiene su diccionario privado.
  let subrsFor: (g: number) => CffIndex | null;
  const fdArrayOffset = topDict.get(1236)?.[0];
  const fdSelectOffset = topDict.get(1237)?.[0];
  if (fdArrayOffset !== undefined && fdSelectOffset !== undefined) {
    const fdArray = readIndex(r, cff + fdArrayOffset);
    const fdSubrs = Array.from({ length: fdArray.count }, (_, i) => {
      const it = fdArray.item(i);
      return privateSubrs(readDict(r, it.start, it.end));
    });
    const sel = cff + fdSelectOffset;
    const format = r.u8(sel);
    const fdOf = (g: number): number => {
      if (format === 0) return r.u8(sel + 1 + g);
      if (format === 3) {
        const nRanges = r.u16(sel + 1);
        for (let i = 0; i < nRanges; i++) {
          const first = r.u16(sel + 3 + i * 3);
          const next = i + 1 < nRanges ? r.u16(sel + 3 + (i + 1) * 3) : r.u16(sel + 3 + nRanges * 3);
          if (g >= first && g < next) return r.u8(sel + 3 + i * 3 + 2);
        }
      }
      return 0;
    };
    subrsFor = (g) => fdSubrs[fdOf(g)] ?? null;
  } else {
    const local = privateSubrs(topDict);
    subrsFor = () => local;
  }

  return {
    outline(g) {
      if (g < 0 || g >= charStrings.count) return [];
      return runType2(r, charStrings.item(g), globalSubrs, subrsFor(g));
    },
  };
}

/** Intérprete de cadenas de glifos Type 2 (solo dibujo; las pistas de hinting se saltan). */
function runType2(r: Reader, code: { start: number; end: number }, gsubrs: CffIndex, lsubrs: CffIndex | null): OutlineCommand[] {
  const out: OutlineCommand[] = [];
  const stack: number[] = [];
  let x = 0;
  let y = 0;
  let open = false;
  let stems = 0;
  let haveWidth = false;
  const gBias = subrBias(gsubrs.count);
  const lBias = lsubrs ? subrBias(lsubrs.count) : 0;

  const moveTo = (dx: number, dy: number) => {
    if (open) out.push({ type: 'Z' });
    x += dx;
    y += dy;
    out.push({ type: 'M', x, y });
    open = true;
  };
  const lineTo = (dx: number, dy: number) => {
    x += dx;
    y += dy;
    out.push({ type: 'L', x, y });
  };
  const curveTo = (a: number, b: number, c: number, d: number, e: number, f: number) => {
    const c1x = x + a;
    const c1y = y + b;
    const c2x = c1x + c;
    const c2y = c1y + d;
    x = c2x + e;
    y = c2y + f;
    out.push({ type: 'C', c1x, c1y, c2x, c2y, x, y });
  };
  /** El primer número puede ser el ancho del glifo (se descarta). */
  const takeWidth = (expected: number) => {
    if (!haveWidth && stack.length > expected) stack.shift();
    haveWidth = true;
  };
  const stemHint = () => {
    if (!haveWidth && stack.length % 2 === 1) stack.shift();
    haveWidth = true;
    stems += stack.length >> 1;
    stack.length = 0;
  };

  let depth = 0;
  const exec = (start: number, end: number): boolean => {
    if (++depth > 10) return true;
    let p = start;
    while (p < end) {
      const b0 = r.u8(p++);
      if (b0 >= 32 || b0 === 28) {
        if (b0 === 28) {
          stack.push(r.i16(p));
          p += 2;
        } else if (b0 <= 246) stack.push(b0 - 139);
        else if (b0 <= 250) stack.push((b0 - 247) * 256 + r.u8(p++) + 108);
        else if (b0 <= 254) stack.push(-(b0 - 251) * 256 - r.u8(p++) - 108);
        else {
          stack.push(r.i32(p) / 65536);
          p += 4;
        }
        continue;
      }
      switch (b0) {
        case 1: // hstem
        case 3: // vstem
        case 18: // hstemhm
        case 23: // vstemhm
          stemHint();
          break;
        case 19: // hintmask
        case 20: // cntrmask
          stemHint();
          p += (stems + 7) >> 3;
          break;
        case 21: // rmoveto
          takeWidth(2);
          moveTo(stack[stack.length - 2] ?? 0, stack[stack.length - 1] ?? 0);
          stack.length = 0;
          break;
        case 22: // hmoveto
          takeWidth(1);
          moveTo(stack[stack.length - 1] ?? 0, 0);
          stack.length = 0;
          break;
        case 4: // vmoveto
          takeWidth(1);
          moveTo(0, stack[stack.length - 1] ?? 0);
          stack.length = 0;
          break;
        case 5: // rlineto
          for (let i = 0; i + 1 < stack.length; i += 2) lineTo(stack[i]!, stack[i + 1]!);
          stack.length = 0;
          break;
        case 6: // hlineto
        case 7: {
          // vlineto: alterna horizontal/vertical
          let horizontal = b0 === 6;
          for (const v of stack) {
            if (horizontal) lineTo(v, 0);
            else lineTo(0, v);
            horizontal = !horizontal;
          }
          stack.length = 0;
          break;
        }
        case 8: // rrcurveto
          for (let i = 0; i + 5 < stack.length; i += 6) curveTo(stack[i]!, stack[i + 1]!, stack[i + 2]!, stack[i + 3]!, stack[i + 4]!, stack[i + 5]!);
          stack.length = 0;
          break;
        case 24: {
          // rcurveline
          let i = 0;
          for (; i + 5 < stack.length - 2; i += 6) curveTo(stack[i]!, stack[i + 1]!, stack[i + 2]!, stack[i + 3]!, stack[i + 4]!, stack[i + 5]!);
          lineTo(stack[i]!, stack[i + 1]!);
          stack.length = 0;
          break;
        }
        case 25: {
          // rlinecurve
          let i = 0;
          for (; i + 1 < stack.length - 6; i += 2) lineTo(stack[i]!, stack[i + 1]!);
          curveTo(stack[i]!, stack[i + 1]!, stack[i + 2]!, stack[i + 3]!, stack[i + 4]!, stack[i + 5]!);
          stack.length = 0;
          break;
        }
        case 26: {
          // vvcurveto
          let i = 0;
          let dx1 = 0;
          if (stack.length % 2) dx1 = stack[i++]!;
          for (; i + 3 < stack.length; i += 4) {
            curveTo(dx1, stack[i]!, stack[i + 1]!, stack[i + 2]!, 0, stack[i + 3]!);
            dx1 = 0;
          }
          stack.length = 0;
          break;
        }
        case 27: {
          // hhcurveto
          let i = 0;
          let dy1 = 0;
          if (stack.length % 2) dy1 = stack[i++]!;
          for (; i + 3 < stack.length; i += 4) {
            curveTo(stack[i]!, dy1, stack[i + 1]!, stack[i + 2]!, stack[i + 3]!, 0);
            dy1 = 0;
          }
          stack.length = 0;
          break;
        }
        case 30: // vhcurveto
        case 31: {
          // hvcurveto
          let horizontal = b0 === 31;
          let i = 0;
          while (i + 3 < stack.length) {
            const last = stack.length - i === 5;
            const extra = last ? stack[i + 4]! : 0;
            if (horizontal) curveTo(stack[i]!, 0, stack[i + 1]!, stack[i + 2]!, extra, stack[i + 3]!);
            else curveTo(0, stack[i]!, stack[i + 1]!, stack[i + 2]!, stack[i + 3]!, extra);
            i += last ? 5 : 4;
            horizontal = !horizontal;
          }
          stack.length = 0;
          break;
        }
        case 10: {
          // callsubr
          const idx = (stack.pop() ?? 0) + lBias;
          if (lsubrs && idx >= 0 && idx < lsubrs.count) {
            const it = lsubrs.item(idx);
            if (exec(it.start, it.end)) return true;
          }
          break;
        }
        case 29: {
          // callgsubr
          const idx = (stack.pop() ?? 0) + gBias;
          if (idx >= 0 && idx < gsubrs.count) {
            const it = gsubrs.item(idx);
            if (exec(it.start, it.end)) return true;
          }
          break;
        }
        case 11: // return
          depth--;
          return false;
        case 14: // endchar
          takeWidth(0);
          if (open) out.push({ type: 'Z' });
          open = false;
          return true;
        case 12: {
          const op = r.u8(p++);
          const s = stack;
          if (op === 35) {
            // flex
            curveTo(s[0]!, s[1]!, s[2]!, s[3]!, s[4]!, s[5]!);
            curveTo(s[6]!, s[7]!, s[8]!, s[9]!, s[10]!, s[11]!);
          } else if (op === 34) {
            // hflex
            const y0 = y;
            curveTo(s[0]!, 0, s[1]!, s[2]!, s[3]!, 0);
            curveTo(s[4]!, 0, s[5]!, y0 - y, s[6]!, 0);
          } else if (op === 36) {
            // hflex1
            curveTo(s[0]!, s[1]!, s[2]!, s[3]!, s[4]!, 0);
            // El segundo tramo termina a la misma altura donde empezó el primero.
            curveTo(s[5]!, 0, s[6]!, s[7]!, s[8]!, -(s[1]! + s[3]! + s[7]!));
          } else if (op === 37) {
            // flex1
            const x0 = x;
            const y0 = y;
            const dx = s[0]! + s[2]! + s[4]! + s[6]! + s[8]!;
            const dy = s[1]! + s[3]! + s[5]! + s[7]! + s[9]!;
            curveTo(s[0]!, s[1]!, s[2]!, s[3]!, s[4]!, s[5]!);
            const last = s[10]!;
            if (Math.abs(dx) > Math.abs(dy)) curveTo(s[6]!, s[7]!, s[8]!, s[9]!, last, y0 - (y + s[7]! + s[9]!));
            else curveTo(s[6]!, s[7]!, s[8]!, s[9]!, x0 - (x + s[6]! + s[8]!), last);
          }
          stack.length = 0;
          break;
        }
        default:
          stack.length = 0;
      }
    }
    depth--;
    return false;
  };
  exec(code.start, code.end);
  if (open) out.push({ type: 'Z' });
  return out;
}

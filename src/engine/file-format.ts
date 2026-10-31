import { allPages, createDocument, pruneAssets, withPages, type PageData, type Guide, type ImageAsset, type MergeData, type PageSetup, type TrazoDocument } from './document';
import type { Matrix } from './matrix';
import type { NodeType, PathNode, Subpath } from './path-geom';
import type { Shape, ShapeExtras, TextAlign } from './shapes';
import type { Unit } from './units';
import type { Finish } from './finishes';

/**
 * Formato de archivo .trz: JSON legible, con las imágenes dentro (base64), así un
 * diseño se puede mandar por WhatsApp o USB sin que se pierdan las fotos.
 *
 *   { "format": "trazo", "version": 1, "app": "Trazo 0.4.0", "document": { … } }
 *
 * Al abrir se valida TODO: un archivo dañado o manipulado no puede romper la app
 * ni meter datos raros. Lo que no se entiende se descarta y se avisa.
 */

export const FILE_FORMAT = 'trazo';
/** 2: curvas en forma compacta (`packed`). Los archivos de la versión 1 se siguen abriendo. */
export const FILE_VERSION = 2;
export const FILE_EXTENSION = 'ink';

export const IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml'] as const;

export function serializeDocument(doc: TrazoDocument, appVersion = ''): string {
  // Las páginas se guardan todas al día (la actual vive en `shapes`).
  const synced = doc.pages ? { ...doc, pages: allPages(doc) } : doc;
  // Las curvas van compactas (un PDF de Corel importado trae miles): ver packSubpath.
  return JSON.stringify({ format: FILE_FORMAT, version: FILE_VERSION, app: `Inkara Draw ${appVersion}`.trim(), document: pruneAssets(synced) }, (key, value) => (key === 'subpaths' && Array.isArray(value) ? (value as Subpath[]).map(packSubpath) : value));
}

export interface ParseResult {
  document: TrazoDocument;
  /** Avisos para el usuario (objetos o imágenes que no se pudieron leer). */
  warnings: string[];
}

export class FileFormatError extends Error {}

/** Lee un .trz. Lanza FileFormatError con un mensaje para el usuario si no es válido. */
export function parseDocument(text: string, fallbackName = 'Sin título'): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new FileFormatError('El archivo no es un diseño de Inkara Draw o está dañado.');
  }
  if (!isObject(raw) || raw.format !== FILE_FORMAT || !isObject(raw.document)) {
    throw new FileFormatError('El archivo no es un diseño de Inkara Draw.');
  }
  if (typeof raw.version !== 'number' || raw.version > FILE_VERSION) {
    throw new FileFormatError('Este diseño se hizo con una versión más nueva de Inkara Draw. Actualiza la app para abrirlo.');
  }

  const warnings: string[] = [];
  const d = raw.document;
  const base = createDocument(str(d.name, fallbackName, 200) || fallbackName);
  const page = isObject(d.page) ? d.page : {};
  let document: TrazoDocument = {
    name: base.name,
    page: {
      widthMm: num(page.widthMm, base.page.widthMm, 1, 10_000),
      heightMm: num(page.heightMm, base.page.heightMm, 1, 10_000),
      bleedMm: num(page.bleedMm, base.page.bleedMm, 0, 100),
      safeMarginMm: num(page.safeMarginMm, base.page.safeMarginMm, 0, 1_000),
    } satisfies PageSetup,
    unit: (['mm', 'cm', 'in', 'px'] as Unit[]).includes(d.unit as Unit) ? (d.unit as Unit) : base.unit,
    exportDpi: num(d.exportDpi, base.exportDpi, 72, 2400),
    assets: {},
    shapes: [],
    ...(readMerge(d.merge) ? { merge: readMerge(d.merge)! } : {}),
    ...(readGuides(d.guides).length ? { guides: readGuides(d.guides) } : {}),
  };

  // Imágenes
  let badAssets = 0;
  for (const value of Object.values(isObject(d.assets) ? d.assets : {})) {
    const asset = readAsset(value);
    if (asset) document.assets[asset.id] = asset;
    else badAssets++;
  }

  // Acabados (sus texturas tienen que existir)
  const finishes = readFinishes(d.finishes, document.assets);
  if (finishes.length) document.finishes = finishes;

  // Objetos (de cada página)
  let badShapes = 0;
  const readShapes = (list: unknown): Shape[] => {
    const ids = new Set<string>();
    const shapes: Shape[] = [];
    for (const value of Array.isArray(list) ? list.slice(0, 50_000) : []) {
      const shape = readShape(value, document.assets);
      if (shape && !ids.has(shape.id)) {
        ids.add(shape.id);
        shapes.push(shape);
      } else badShapes++;
    }
    // PowerClip: un contenido cuyo contenedor no existe queda suelto.
    const present = new Set(shapes.map((s) => s.id));
    return shapes.map((s) => (s.clipId && (!present.has(s.clipId) || s.clipId === s.id) ? (({ clipId: _drop, ...rest }) => rest as Shape)(s) : s));
  };
  if (Array.isArray(d.pages) && d.pages.length > 0) {
    const seen = new Set<string>();
    const pages: PageData[] = d.pages.slice(0, 500).filter(isObject).map((p, i) => {
      let id = str(p.id, '', 64) || `p${i + 1}`;
      if (seen.has(id)) id = `${id}-${i}`;
      seen.add(id);
      return { id, name: str(p.name, `Página ${i + 1}`, 100) || `Página ${i + 1}`, shapes: readShapes(p.shapes) };
    });
    if (pages.length > 0) document = withPages(document, pages, typeof d.pageIndex === 'number' ? Math.floor(d.pageIndex) : 0);
    else document.shapes = readShapes(d.shapes);
  } else {
    document.shapes = readShapes(d.shapes);
  }
  if (badShapes) warnings.push(badShapes === 1 ? 'Un objeto no se pudo leer y se omitió.' : `${badShapes} objetos no se pudieron leer y se omitieron.`);
  if (badAssets) warnings.push(badAssets === 1 ? 'Una imagen está dañada y se omitió.' : `${badAssets} imágenes están dañadas y se omitieron.`);
  return { document, warnings };
}

function readAsset(value: unknown): ImageAsset | null {
  if (!isObject(value)) return null;
  const id = str(value.id, '', 64);
  const mime = str(value.mime, '', 40);
  const data = typeof value.data === 'string' ? value.data : '';
  if (!id || !(IMAGE_MIME_TYPES as readonly string[]).includes(mime) || !data || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return null;
  return {
    id,
    name: str(value.name, 'imagen', 200),
    mime,
    data,
    widthPx: num(value.widthPx, 1, 1, 100_000),
    heightPx: num(value.heightPx, 1, 1, 100_000),
  };
}

function readShape(value: unknown, assets: Record<string, ImageAsset>): Shape | null {
  if (!isObject(value)) return null;
  const id = str(value.id, '', 64);
  const transform = matrix(value.transform);
  if (!id || !transform) return null;
  const base = {
    id,
    width: num(value.width, 1, 0.001, 100_000),
    height: num(value.height, 1, 0.001, 100_000),
    transform,
    fill: color(value.fill),
    stroke: color(value.stroke),
    strokeWidth: num(value.strokeWidth, 0.2, 0, 1_000),
    ...extras(value),
  };
  switch (value.kind) {
    case 'rectangle':
      return { ...base, kind: 'rectangle', cornerRadius: num(value.cornerRadius, 0, 0, 100_000) };
    case 'ellipse':
      return { ...base, kind: 'ellipse' };
    case 'polygon':
      return { ...base, kind: 'polygon', sides: Math.round(num(value.sides, 5, 3, 100)) };
    case 'text': {
      if (typeof value.text !== 'string') return null;
      const align: TextAlign = value.align === 'center' || value.align === 'right' ? value.align : 'left';
      return {
        ...base,
        kind: 'text',
        text: value.text.slice(0, 100_000),
        fontFamily: str(value.fontFamily, 'Arial', 200) || 'Arial',
        fontSizePt: num(value.fontSizePt, 24, 0.1, 10_000),
        bold: value.bold === true,
        italic: value.italic === true,
        align,
        ...(typeof value.maxWidthMm === 'number' && value.maxWidthMm > 0 ? { maxWidthMm: num(value.maxWidthMm, 0, 0.1, 100_000) } : {}),
        ...(typeof value.lineSpacing === 'number' && value.lineSpacing > 0 ? { lineSpacing: num(value.lineSpacing, 1.2, 0.5, 5) } : {}),
        ...(typeof value.frameWidth === 'number' && value.frameWidth > 0 ? { frameWidth: num(value.frameWidth, 50, 0.5, 100_000) } : {}),
        ...(typeof value.arc === 'number' && Number.isFinite(value.arc) && Math.abs(value.arc) >= 1 && !(typeof value.frameWidth === 'number' && value.frameWidth > 0) ? { arc: num(value.arc, 0, -359, 359) } : {}),
      };
    }
    case 'path': {
      const subpaths = readSubpaths(value.subpaths);
      return subpaths ? { ...base, kind: 'path', subpaths, ...(value.fillRule === 'nonzero' ? { fillRule: 'nonzero' as const } : {}) } : null;
    }
    case 'image': {
      const assetId = str(value.assetId, '', 64);
      if (!assetId || !assets[assetId]) return null;
      const c = isObject(value.crop) ? value.crop : null;
      const crop = c ? { x: num(c.x, 0, 0, 1), y: num(c.y, 0, 0, 1), width: num(c.width, 1, 0.0001, 1), height: num(c.height, 1, 0.0001, 1) } : undefined;
      const field = str(value.field, '', 200);
      return { ...base, kind: 'image', assetId, ...(crop ? { crop } : {}), ...(field ? { field } : {}) };
    }
    default:
      return null;
  }
}

const MAX_NODES = 200_000;

/** Grupo, contenedor, degradado y transparencias (todo opcional y validado). */
function extras(v: Record<string, unknown>): ShapeExtras {
  const out: ShapeExtras = {};
  if (v.hidden === true) out.hidden = true;
  if (v.locked === true) out.locked = true;
  const name = str(v.name, '', 120);
  if (name) out.name = name;
  if (isObject(v.showWhen)) {
    const column = str(v.showWhen.column, '', 200);
    const value = str(v.showWhen.value, '', 300);
    if (column && value) out.showWhen = { column, value };
  }
  if (isObject(v.shadow) && color(v.shadow.color)) {
    out.shadow = { dx: num(v.shadow.dx, 1, -500, 500), dy: num(v.shadow.dy, 1, -500, 500), blur: num(v.shadow.blur, 1, 0, 200), color: color(v.shadow.color)!, opacity: num(v.shadow.opacity, 0.5, 0, 1) };
  }
  const groupId = str(v.groupId, '', 64);
  if (groupId) out.groupId = groupId;
  const clipId = str(v.clipId, '', 64);
  if (clipId) out.clipId = clipId;
  if (typeof v.opacity === 'number' && Number.isFinite(v.opacity) && v.opacity < 1) out.opacity = num(v.opacity, 1, 0, 1);
  if (isObject(v.fade)) out.fade = { angle: num(v.fade.angle, 270, -3600, 3600), from: num(v.fade.from, 1, 0, 1), to: num(v.fade.to, 0, 0, 1) };
  if (isObject(v.gradient) && Array.isArray(v.gradient.stops)) {
    const stops = v.gradient.stops
      .slice(0, 16)
      .filter(isObject)
      .map((st) => ({ offset: num(st.offset, 0, 0, 1), color: color(st.color) ?? '' }))
      .filter((st) => st.color);
    if (stops.length >= 2) out.gradient = { type: v.gradient.type === 'radial' ? 'radial' : 'linear', angle: num(v.gradient.angle, 0, -3600, 3600), stops };
  }
  return out;
}

/** Guías: hasta 200 líneas horizontales o verticales. */
function readGuides(v: unknown): Guide[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  const out: Guide[] = [];
  for (const g of v.slice(0, 200)) {
    if (!isObject(g) || (g.axis !== 'x' && g.axis !== 'y') || typeof g.pos !== 'number' || !Number.isFinite(g.pos)) continue;
    let id = str(g.id, '', 64) || `g${out.length}`;
    if (seen.has(id)) id = `${id}-${out.length}`;
    seen.add(id);
    out.push({ id, axis: g.axis, pos: num(g.pos, 0, -100_000, 100_000) });
  }
  return out;
}

/** Datos de placas en serie: hasta 10 000 filas y 100 columnas de texto. */
function readMerge(v: unknown): MergeData | null {
  if (!isObject(v) || !Array.isArray(v.columns) || !Array.isArray(v.rows)) return null;
  const columns = v.columns.slice(0, 100).map((c, i) => str(c, `Columna ${i + 1}`, 200) || `Columna ${i + 1}`);
  if (columns.length === 0) return null;
  const rows = v.rows.slice(0, 10_000).filter(Array.isArray).map((r) => columns.map((_, i) => str((r as unknown[])[i], '', 2000)));
  const finishColumn = str(v.finishColumn, '', 200);
  return { columns, rows, fileName: str(v.fileName, `{{${columns[0]}}}`, 300) || `{{${columns[0]}}}`, ...(finishColumn && columns.includes(finishColumn) ? { finishColumn } : {}), ...(v.fit === false ? { fit: false } : {}) };
}

const HEX = /^#[0-9a-f]{6}$/i;
/** Acabados: hasta 20, cada uno con sus cambios de color y su textura opcional. */
function readFinishes(v: unknown, assets: Record<string, ImageAsset>): Finish[] {
  if (!Array.isArray(v)) return [];
  const out: Finish[] = [];
  for (const f of v.slice(0, 20)) {
    if (!isObject(f)) continue;
    const name = str(f.name, '', 60);
    if (!name || out.some((o) => o.name === name)) continue;
    const colors = (Array.isArray(f.colors) ? f.colors.slice(0, 200) : [])
      .filter(isObject)
      .map((m) => ({ from: str(m.from, '', 7), to: str(m.to, '', 7) }))
      .filter((m) => HEX.test(m.from) && HEX.test(m.to));
    const finish: Finish = { name, swatch: HEX.test(str(f.swatch, '', 7)) ? str(f.swatch, '', 7) : '#888888', colors };
    if (isObject(f.texture) && typeof f.texture.assetId === 'string' && assets[f.texture.assetId] && Array.isArray(f.texture.colors)) {
      finish.texture = { assetId: f.texture.assetId, colors: f.texture.colors.map((c) => str(c, '', 7)).filter((c) => HEX.test(c)) };
    }
    out.push(finish);
  }
  return out;
}

/**
 * Curva compacta: por nodo, un código (tipo + qué manijas tiene) y sus números,
 * con millonésimas de mm. Un PDF de Corel con miles de curvas pesa ~4 veces menos.
 *   código = tipo (0 esquina, 1 suave, 2 simétrico) + 4 si tiene manija de entrada + 8 si de salida
 */
const NODE_TYPES: NodeType[] = ['cusp', 'smooth', 'symmetric'];
/** Millonésimas de mm: sin pérdida real (un nanómetro) y sin los 15 decimales de JavaScript. */
const r3 = (v: number) => Math.round(v * 1e6) / 1e6;
function packSubpath(s: Subpath): { closed: boolean; packed: number[] } {
  const packed: number[] = [];
  for (const n of s.nodes) {
    packed.push(Math.max(0, NODE_TYPES.indexOf(n.type)) + (n.in ? 4 : 0) + (n.out ? 8 : 0), r3(n.x), r3(n.y));
    if (n.in) packed.push(r3(n.in.x), r3(n.in.y));
    if (n.out) packed.push(r3(n.out.x), r3(n.out.y));
  }
  return { closed: s.closed, packed };
}

function unpackNodes(packed: unknown[]): PathNode[] | null {
  const nodes: PathNode[] = [];
  const num = (i: number) => (typeof packed[i] === 'number' && Number.isFinite(packed[i]) && Math.abs(packed[i] as number) < 1e6 ? (packed[i] as number) : NaN);
  for (let i = 0; i < packed.length; ) {
    const code = num(i);
    if (!(code >= 0 && code <= 14)) return null;
    const node: PathNode = { x: num(i + 1), y: num(i + 2), in: null, out: null, type: NODE_TYPES[code & 3] ?? 'cusp' };
    i += 3;
    if (code & 4) {
      node.in = { x: num(i), y: num(i + 1) };
      i += 2;
    }
    if (code & 8) {
      node.out = { x: num(i), y: num(i + 1) };
      i += 2;
    }
    if ([node.x, node.y, node.in?.x ?? 0, node.in?.y ?? 0, node.out?.x ?? 0, node.out?.y ?? 0].some((v) => Number.isNaN(v))) return null;
    nodes.push(node);
  }
  return nodes;
}

function readSubpaths(v: unknown): Subpath[] | null {
  if (!Array.isArray(v)) return null;
  let total = 0;
  const out: Subpath[] = [];
  for (const s of v) {
    if (isObject(s) && Array.isArray(s.packed)) {
      if (s.packed.length > MAX_NODES * 7) return null;
      const nodes = unpackNodes(s.packed);
      if (!nodes) return null;
      total += nodes.length;
      if (total > MAX_NODES) return null;
      if (nodes.length >= 2) out.push({ nodes, closed: s.closed === true && nodes.length >= 3 });
      continue;
    }
    if (!isObject(s) || !Array.isArray(s.nodes)) return null;
    const nodes: PathNode[] = [];
    for (const n of s.nodes) {
      const p = point(n);
      if (!p || !isObject(n)) return null;
      const type: NodeType = n.type === 'smooth' || n.type === 'symmetric' ? n.type : 'cusp';
      nodes.push({ ...p, in: n.in == null ? null : point(n.in), out: n.out == null ? null : point(n.out), type });
    }
    total += nodes.length;
    if (total > MAX_NODES) return null;
    if (nodes.length >= 2) out.push({ nodes, closed: s.closed === true && nodes.length >= 3 });
  }
  return out.length ? out : null;
}

function point(v: unknown): { x: number; y: number } | null {
  if (!isObject(v) || typeof v.x !== 'number' || typeof v.y !== 'number' || !Number.isFinite(v.x) || !Number.isFinite(v.y) || Math.abs(v.x) > 1e7 || Math.abs(v.y) > 1e7) return null;
  return { x: v.x, y: v.y };
}

// ---- Validadores ----

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function num(v: unknown, fallback: number, min: number, max: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
}

function str(v: unknown, fallback: string, maxLength: number): string {
  return typeof v === 'string' ? v.slice(0, maxLength) : fallback;
}

function color(v: unknown): string | null {
  return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v : null;
}

function matrix(v: unknown): Matrix | null {
  if (!Array.isArray(v) || v.length !== 6 || !v.every((n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) < 1e7)) return null;
  const [a, b, c, d] = v as number[];
  if (Math.abs(a! * d! - b! * c!) < 1e-12) return null; // sin ancho o sin alto
  return v as unknown as Matrix;
}

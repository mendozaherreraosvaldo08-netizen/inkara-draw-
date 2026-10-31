import type { Shape } from './shapes';
import type { Finish } from './finishes';
import type { Unit } from './units';

/** Tamaños de página listos para usar. Medidas en milímetros (vertical). */
export interface PagePreset {
  id: string;
  label: string;
  widthMm: number;
  heightMm: number;
}

/**
 * Formatos comunes de placas de aluminio para sublimar, más los de papel.
 * Las medidas de placa varían por proveedor: "Personalizado" permite cualquiera.
 */
export const PAGE_PRESETS: PagePreset[] = [
  { id: 'placa-13x18', label: 'Placa 13 × 18 cm', widthMm: 130, heightMm: 180 },
  { id: 'placa-15x20', label: 'Placa 15 × 20 cm', widthMm: 150, heightMm: 200 },
  { id: 'placa-20x25', label: 'Placa 20 × 25 cm', widthMm: 200, heightMm: 250 },
  { id: 'placa-20x30', label: 'Placa 20 × 30 cm', widthMm: 200, heightMm: 300 },
  { id: 'placa-28x35', label: 'Placa 28 × 35 cm', widthMm: 280, heightMm: 350 },
  { id: 'carta', label: 'Carta', widthMm: 215.9, heightMm: 279.4 },
  { id: 'oficio', label: 'Oficio', widthMm: 215.9, heightMm: 340 },
  { id: 'tabloide', label: 'Tabloide', widthMm: 279.4, heightMm: 431.8 },
  { id: 'a4', label: 'A4', widthMm: 210, heightMm: 297 },
];

export interface PageSetup {
  widthMm: number;
  heightMm: number;
  /** Sangrado: lo que se imprime fuera del corte para que no queden bordes blancos. */
  bleedMm: number;
  /** Margen seguro: textos y logos importantes van dentro, lejos del borde. */
  safeMarginMm: number;
}

/** Imagen guardada dentro del documento (el archivo .trz no depende de otros archivos). */
export interface ImageAsset {
  id: string;
  /** Nombre del archivo original (para mostrarlo). */
  name: string;
  /** image/png, image/jpeg, image/webp, image/gif o image/svg+xml. */
  mime: string;
  /** Contenido en base64. */
  data: string;
  /** Tamaño en píxeles (para calcular la resolución al imprimir). */
  widthPx: number;
  heightPx: number;
}

/**
 * Placas en serie: la tabla de datos (por ejemplo, pegada desde Excel). Cada
 * fila es una placa; los textos usan {{Columna}} y las fotos, una columna.
 */
export interface MergeData {
  columns: string[];
  rows: string[][];
  /** Nombre de cada archivo generado, con campos: "{{Nombre}}". */
  fileName: string;
  /** Columna que dice el acabado de cada placa (Blanco, Negro, Bronce…). */
  finishColumn?: string;
  /** false = no acomodar los nombres largos (por omisión sí se acomodan). */
  fit?: boolean;
}

/** Guía: línea vertical (axis 'x', en x = pos) u horizontal (axis 'y'), en mm. No se imprime. */
export interface Guide {
  id: string;
  axis: 'x' | 'y';
  pos: number;
}

/** El documento: página y objetos (en orden de apilado: el último queda encima). */
export interface TrazoDocument {
  name: string;
  page: PageSetup;
  shapes: Shape[];
  /** Imágenes usadas por los objetos imagen, por id. */
  assets: Record<string, ImageAsset>;
  unit: Unit;
  /** Resolución para exportar a imagen (sublimación: 300 ppp). */
  exportDpi: number;
  merge?: MergeData;
  /** Acabados del diseño (el mismo diseño en blanco, negro, bronce…). */
  finishes?: Finish[];
  /** Guías arrastradas desde las reglas. */
  guides?: Guide[];
  /**
   * Varias páginas (anverso y reverso, o varias placas en un archivo). `shapes`
   * siempre son los objetos de la página que se está viendo (`pageIndex`); en
   * `pages` esa entrada puede estar desactualizada: usa allPages().
   */
  pages?: PageData[];
  pageIndex?: number;
}

export interface PageData {
  id: string;
  name: string;
  shapes: Shape[];
}

/** Todas las páginas, con la actual al día. Un documento de una página da una sola. */
export function allPages(doc: TrazoDocument): PageData[] {
  if (!doc.pages || doc.pages.length === 0) return [{ id: 'p1', name: 'Página 1', shapes: doc.shapes }];
  const index = currentPageIndex(doc);
  return doc.pages.map((p, i) => (i === index ? { ...p, shapes: doc.shapes } : p));
}

export function currentPageIndex(doc: TrazoDocument): number {
  const count = doc.pages?.length ?? 1;
  return Math.max(0, Math.min(count - 1, doc.pageIndex ?? 0));
}

/** El documento mostrando la página `index` de `pages`. Con una sola página sin nombre propio, sin lista. */
export function withPages(doc: TrazoDocument, pages: PageData[], index: number): TrazoDocument {
  const i = Math.max(0, Math.min(pages.length - 1, index));
  const next: TrazoDocument = { ...doc, shapes: pages[i]!.shapes };
  if (pages.length === 1 && pages[0]!.name === 'Página 1') {
    delete next.pages;
    delete next.pageIndex;
  } else {
    next.pages = pages;
    next.pageIndex = i;
  }
  return next;
}

/** Documento para exportar o imprimir una página concreta. */
export function pageDocument(doc: TrazoDocument, index: number): TrazoDocument {
  const pages = allPages(doc);
  return { ...doc, shapes: pages[Math.max(0, Math.min(pages.length - 1, index))]!.shapes };
}

export function createDocument(name = 'Sin título'): TrazoDocument {
  return {
    name,
    page: { widthMm: 200, heightMm: 250, bleedMm: 3, safeMarginMm: 5 },
    shapes: [],
    assets: {},
    unit: 'cm',
    exportDpi: 300,
  };
}

export function presetFor(page: PageSetup): PagePreset | undefined {
  const [short, long] = [Math.min(page.widthMm, page.heightMm), Math.max(page.widthMm, page.heightMm)];
  return PAGE_PRESETS.find((p) => Math.abs(p.widthMm - short) < 0.05 && Math.abs(p.heightMm - long) < 0.05);
}

/** Quita las imágenes que ya no usa ningún objeto (al guardar). */
export function pruneAssets(doc: TrazoDocument): TrazoDocument {
  // Las imágenes de todas las páginas (no solo la que se ve).
  const used = new Set(allPages(doc).flatMap((p) => p.shapes.flatMap((s) => (s.kind === 'image' ? [s.assetId] : []))));
  // Y las texturas de los acabados.
  for (const f of doc.finishes ?? []) if (f.texture) used.add(f.texture.assetId);
  const assets = Object.fromEntries(Object.entries(doc.assets).filter(([id]) => used.has(id)));
  return Object.keys(assets).length === Object.keys(doc.assets).length ? doc : { ...doc, assets };
}

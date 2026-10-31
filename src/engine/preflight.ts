import type { ImageAsset, TrazoDocument } from './document';
import { shapeBounds, type ImageShape, type Shape } from './shapes';

/**
 * Revisión antes de imprimir: lo que suele arruinar una placa sublimada.
 *  - Fotos con poca resolución (salen borrosas).
 *  - Textos fuera del margen seguro (el corte o el borde de la prensa los come).
 *  - Fondos que tocan el borde pero no llegan al sangrado (filo blanco al cortar).
 *  - Objetos fuera de la página (no se imprimen).
 */
export type IssueLevel = 'error' | 'warning' | 'info';

export interface PreflightIssue {
  level: IssueLevel;
  message: string;
  shapeId?: string;
}

/** Resolución a la que se imprimirá una imagen con su tamaño actual (ppp); null si es SVG. */
export function effectiveDpi(shape: ImageShape, asset: ImageAsset | undefined): number | null {
  if (!asset || asset.mime === 'image/svg+xml') return null;
  const [a, b, c, d] = shape.transform;
  const widthIn = (shape.width * Math.hypot(a, b)) / 25.4;
  const heightIn = (shape.height * Math.hypot(c, d)) / 25.4;
  // Con recorte, solo esa parte de la foto llena el marco.
  const crop = shape.crop ?? { width: 1, height: 1 };
  return Math.round(Math.min((asset.widthPx * crop.width) / widthIn, (asset.heightPx * crop.height) / heightIn));
}

/** Nombre corto del objeto para los mensajes. */
export function describeShape(shape: Shape, doc: TrazoDocument): string {
  if (shape.kind === 'text') {
    const first = shape.text.split('\n')[0]!.trim();
    return `el texto «${first.length > 24 ? `${first.slice(0, 24)}…` : first}»`;
  }
  if (shape.kind === 'image') return `la imagen «${doc.assets[shape.assetId]?.name ?? 'sin nombre'}»`;
  return { rectangle: 'un rectángulo', ellipse: 'una elipse', polygon: 'un polígono', path: 'una curva' }[shape.kind];
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function preflight(doc: TrazoDocument): PreflightIssue[] {
  const issues: PreflightIssue[] = [];
  const { widthMm: W, heightMm: H, bleedMm: B, safeMarginMm: M } = doc.page;
  if (doc.shapes.length === 0) issues.push({ level: 'warning', message: 'La página está vacía.' });

  const ids = new Set(doc.shapes.map((s) => s.id));
  for (const shape of doc.shapes) {
    // Lo que va dentro de un PowerClip solo se ve dentro de su contenedor: el
    // contenedor es el que se revisa (bordes, sangrado). Las fotos sí: resolución.
    if (shape.hidden || (shape.clipId && doc.shapes.find((c) => c.id === shape.clipId)?.hidden)) continue; // no se imprime
    const clipped = !!(shape.clipId && ids.has(shape.clipId));
    if (clipped && shape.kind !== 'image') continue;
    const name = describeShape(shape, doc);
    const box = shapeBounds(shape);
    const right = box.x + box.width;
    const bottom = box.y + box.height;

    // Completamente fuera de lo que se imprime
    if (!clipped && (right <= -B || bottom <= -B || box.x >= W + B || box.y >= H + B)) {
      issues.push({ level: 'info', message: `${cap(name)} está fuera de la página: no se imprimirá.`, shapeId: shape.id });
      continue;
    }

    if (shape.kind === 'image') {
      const dpi = effectiveDpi(shape, doc.assets[shape.assetId]);
      if (dpi !== null && dpi < 150) issues.push({ level: 'error', message: `${cap(name)} quedará a ${dpi} ppp: se verá borrosa. Hazla más chica o usa una foto más grande (ideal: 300 ppp).`, shapeId: shape.id });
      else if (dpi !== null && dpi < 250) issues.push({ level: 'warning', message: `${cap(name)} quedará a ${dpi} ppp: aceptable, aunque lo ideal son 300.`, shapeId: shape.id });
    }

    if (shape.kind === 'text' && (box.x < M || box.y < M || right > W - M || bottom > H - M)) {
      issues.push({ level: 'warning', message: `${cap(name)} se sale del margen seguro (línea azul): podría quedar cortado.`, shapeId: shape.id });
    }

    // Fondos y figuras que tocan o pasan un borde sin llegar al sangrado → filo
    // blanco al cortar. (Los textos no: no se usan como fondo.)
    if (B > 0 && shape.kind !== 'text' && !clipped) {
      const past = [-box.x, -box.y, right - W, bottom - H]; // cuánto pasa de cada borde (negativo: no llega)
      if (past.some((d) => d > -0.5 && d < B - 0.05)) {
        issues.push({ level: 'warning', message: `${cap(name)} llega al borde pero no cubre el sangrado (línea roja): al cortar podría quedar un filo blanco. Estíralo hasta la línea roja.`, shapeId: shape.id });
      }
    }
  }
  const order: Record<IssueLevel, number> = { error: 0, warning: 1, info: 2 };
  return issues.sort((a, b) => order[a.level] - order[b.level]);
}

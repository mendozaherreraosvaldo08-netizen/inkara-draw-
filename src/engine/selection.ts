import type { Rect } from './shapes';
import type { Point } from './viewport';

/** Tiradores de escala (8, en la caja de la selección) y de rotación (4 esquinas). */
export type ScaleHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
export type RotateHandle = 'rot-nw' | 'rot-ne' | 'rot-se' | 'rot-sw';
export type Handle = ScaleHandle | RotateHandle;

/** Modo de los tiradores: un segundo clic sobre lo seleccionado alterna entre ambos. */
export type TransformMode = 'scale' | 'rotate';

/** Separación (px de pantalla) entre la caja y los tiradores, para que no tapen el objeto. */
export const HANDLE_GAP = 6;
export const HANDLE_SIZE = 8;

/** Posición de cada tirador de escala en una caja de pantalla. */
export function scaleHandlePoints(box: Rect): Record<ScaleHandle, Point> {
  const g = HANDLE_GAP;
  const l = box.x - g;
  const t = box.y - g;
  const r = box.x + box.width + g;
  const b = box.y + box.height + g;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  return { nw: { x: l, y: t }, n: { x: cx, y: t }, ne: { x: r, y: t }, e: { x: r, y: cy }, se: { x: r, y: b }, s: { x: cx, y: b }, sw: { x: l, y: b }, w: { x: l, y: cy } };
}

export function rotateHandlePoints(box: Rect): Record<RotateHandle, Point> {
  const g = HANDLE_GAP + 4;
  return {
    'rot-nw': { x: box.x - g, y: box.y - g },
    'rot-ne': { x: box.x + box.width + g, y: box.y - g },
    'rot-se': { x: box.x + box.width + g, y: box.y + box.height + g },
    'rot-sw': { x: box.x - g, y: box.y + box.height + g },
  };
}

/** Tirador bajo el cursor (en píxeles de pantalla), o null. */
export function handleAt(screenPoint: Point, box: Rect, mode: TransformMode, radius = 7): Handle | null {
  const points: Record<string, Point> = mode === 'scale' ? scaleHandlePoints(box) : rotateHandlePoints(box);
  for (const [handle, p] of Object.entries(points)) {
    if (Math.abs(screenPoint.x - p.x) <= radius && Math.abs(screenPoint.y - p.y) <= radius) return handle as Handle;
  }
  return null;
}

/** Punto fijo al escalar desde un tirador: el opuesto (en mm, caja del documento). */
export function scaleAnchor(handle: ScaleHandle, box: Rect): Point {
  const right = box.x + box.width;
  const bottom = box.y + box.height;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  switch (handle) {
    case 'nw': return { x: right, y: bottom };
    case 'n': return { x: cx, y: bottom };
    case 'ne': return { x: box.x, y: bottom };
    case 'e': return { x: box.x, y: cy };
    case 'se': return { x: box.x, y: box.y };
    case 's': return { x: cx, y: box.y };
    case 'sw': return { x: right, y: box.y };
    case 'w': return { x: right, y: cy };
  }
}

/** Qué ejes mueve cada tirador. */
export function handleAxes(handle: ScaleHandle): { x: boolean; y: boolean } {
  return { x: handle !== 'n' && handle !== 's', y: handle !== 'e' && handle !== 'w' };
}

/** Cursor CSS para cada tirador de escala. */
export const HANDLE_CURSORS: Record<ScaleHandle, string> = {
  nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
};

export const centerOf = (box: Rect): Point => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });

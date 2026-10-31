import { SCREEN_PX_PER_MM } from './units';

export interface Point {
  x: number;
  y: number;
}

/**
 * La "cámara" del lienzo: qué parte del documento se ve y a qué zoom.
 * Convierte entre coordenadas de pantalla (píxeles CSS del lienzo) y del
 * documento (mm, con el origen en la esquina superior izquierda de la página).
 */
export class Viewport {
  /** 1 = tamaño real en pantalla (100 %). */
  zoom = 1;
  /** Posición en pantalla del origen del documento. */
  originX = 0;
  originY = 0;
  width = 0;
  height = 0;

  static readonly MIN_ZOOM = 0.02; // 2 %
  static readonly MAX_ZOOM = 256; // 25 600 %

  /** Píxeles de pantalla por milímetro con el zoom actual. */
  get scale(): number {
    return SCREEN_PX_PER_MM * this.zoom;
  }

  resize(width: number, height: number): void {
    // Al cambiar el tamaño, el centro de la vista se mantiene en el mismo punto del documento.
    const center = this.screenToDoc({ x: this.width / 2, y: this.height / 2 });
    this.width = width;
    this.height = height;
    if (center && Number.isFinite(center.x)) this.centerOn(center);
  }

  screenToDoc(p: Point): Point {
    return { x: (p.x - this.originX) / this.scale, y: (p.y - this.originY) / this.scale };
  }

  docToScreen(p: Point): Point {
    return { x: this.originX + p.x * this.scale, y: this.originY + p.y * this.scale };
  }

  centerOn(docPoint: Point): void {
    this.originX = this.width / 2 - docPoint.x * this.scale;
    this.originY = this.height / 2 - docPoint.y * this.scale;
  }

  /** Zoom manteniendo fijo el punto bajo el cursor (como en los editores vectoriales). */
  zoomAt(factor: number, screenPoint: Point): void {
    const before = this.screenToDoc(screenPoint);
    this.zoom = Math.min(Viewport.MAX_ZOOM, Math.max(Viewport.MIN_ZOOM, this.zoom * factor));
    this.originX = screenPoint.x - before.x * this.scale;
    this.originY = screenPoint.y - before.y * this.scale;
  }

  setZoom(zoom: number): void {
    this.zoomAt(zoom / this.zoom, { x: this.width / 2, y: this.height / 2 });
  }

  pan(dx: number, dy: number): void {
    this.originX += dx;
    this.originY += dy;
  }

  /** Encaja un rectángulo del documento (mm) en la vista, con margen. */
  fit(rect: { x: number; y: number; width: number; height: number }, paddingPx = 48): void {
    if (this.width <= 0 || this.height <= 0) return;
    const zoomX = (this.width - paddingPx * 2) / (rect.width * SCREEN_PX_PER_MM);
    const zoomY = (this.height - paddingPx * 2) / (rect.height * SCREEN_PX_PER_MM);
    this.zoom = Math.min(Viewport.MAX_ZOOM, Math.max(Viewport.MIN_ZOOM, Math.min(zoomX, zoomY)));
    this.centerOn({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
  }
}

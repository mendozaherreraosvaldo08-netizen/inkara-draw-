import type { TrazoDocument } from './document';
import { centerOf, rotateHandlePoints, scaleHandlePoints, type TransformMode } from './selection';
import { drawShape, drawShapes, type DrawTarget } from './draw';
import { traceLocalPath, type Rect, type Shape } from './shapes';
import type { Point, Viewport } from './viewport';
import type { Guide } from './document';
import type { SnapLine } from './snap';

/** Lo que la interfaz quiere ver dibujado encima de los objetos. */
export interface EditorOverlay {
  selection: Shape[];
  /** Caja de la selección en mm (null si no hay nada seleccionado). */
  selectionBounds: Rect | null;
  mode: TransformMode;
  /** Marco de selección mientras se arrastra (mm). */
  marquee: Rect | null;
  /** Figura que se está dibujando (vista previa). */
  preview: Shape | null;
  /** Figura bajo el cursor (se resalta su contorno). */
  hover: Shape | null;
  /** Edición de texto: cursor (mm, en la página) y zonas seleccionadas. */
  caret: { top: Point; bottom: Point } | null;
  textSelection: Point[][];
  /** Objeto de texto que se está editando (su caja se dibuja aparte, sin tiradores). */
  editing: Shape | null;
  /** Curva en edición (herramienta Forma) o dibujándose (pluma). */
  pathEdit: PathOverlay | null;
  /** Guías (no se imprimen) y la que se está arrastrando. */
  guides?: Guide[];
  activeGuide?: string | null;
  /** Líneas de ajuste (imán) mientras algo está pegado. */
  snapLines?: SnapLine[];
  /** Herramienta Recortar: área que se conservará. */
  crop?: Rect | null;
}

/** Lo que se ve al editar una curva. Todo en mm de la página. */
export interface PathOverlay {
  outline: Array<{ points: Point[]; closed: boolean }>;
  anchors: Array<{ p: Point; selected: boolean; smooth: boolean; highlight?: boolean }>;
  handles: Array<{ from: Point; to: Point }>;
  /** Tramo que sigue al cursor mientras se dibuja con la pluma. */
  rubber: Point[] | null;
}

const EMPTY_OVERLAY: EditorOverlay = { selection: [], selectionBounds: null, mode: 'scale', marquee: null, preview: null, hover: null, caret: null, textSelection: [], editing: null, pathEdit: null };

/** Colores del área de trabajo (escritorio oscuro, página blanca). */
export interface CanvasTheme {
  desk: string;
  pageShadow: string;
  page: string;
  pageBorder: string;
  bleed: string;
  safe: string;
  guide: string;
  guideActive: string;
  /** Líneas de ajuste (imán). */
  snap: string;
  /** Tiradores y contornos de selección. */
  handle: string;
  handleBorder: string;
  selection: string;
}

export const DARK_CANVAS_THEME: CanvasTheme = {
  desk: '#3a3b40',
  pageShadow: 'rgba(0, 0, 0, 0.45)',
  page: '#ffffff',
  pageBorder: '#0e0f11',
  bleed: '#e5484d',
  safe: '#3e8ef7',
  handle: '#111214',
  handleBorder: '#ffffff',
  selection: '#4c8dff',
  guide: '#2f9bff',
  guideActive: '#ff4fd8',
  snap: '#ff4fd8',
};

/** Tema claro: escritorio gris, para que la página blanca se distinga. */
export const LIGHT_CANVAS_THEME: CanvasTheme = {
  ...DARK_CANVAS_THEME,
  desk: '#d4d7dd',
  pageShadow: 'rgba(0, 0, 0, 0.22)',
  pageBorder: '#9aa0aa',
  selection: '#2f6fe0',
};

export interface CanvasOverlays {
  showBleed: boolean;
  showSafeArea: boolean;
}

/**
 * Dibuja el lienzo con Canvas 2D acelerado por GPU.
 *  - Nítido en pantallas HiDPI (escala por devicePixelRatio).
 *  - Se redibuja como mucho una vez por fotograma: requestRender() agrupa
 *    todas las peticiones de un mismo fotograma (zoom con rueda, arrastres…).
 * Esta clase es la única que sabe de Canvas; si un día el motor pasa a Rust/WASM
 * o WebGPU, se sustituye aquí sin tocar la interfaz.
 */
export class CanvasRenderer {
  private readonly ctx: CanvasRenderingContext2D;
  private frame = 0;
  private dpr = 1;
  overlays: CanvasOverlays = { showBleed: true, showSafeArea: true };
  /** Devuelve la imagen ya decodificada de un asset, o null si aún no está lista. */
  resolveImage: (assetId: string) => CanvasImageSource | null = () => null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly viewport: Viewport,
    private readonly getDocument: () => TrazoDocument,
    private readonly getOverlay: () => EditorOverlay = () => EMPTY_OVERLAY,
    /** Colores del escritorio y tiradores (se cambia al pasar a tema claro u oscuro). */
    public theme: CanvasTheme = DARK_CANVAS_THEME,
  ) {
    const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    if (!ctx) throw new Error('El sistema no permite dibujar en Canvas 2D');
    this.ctx = ctx;
  }

  /** Ajusta el tamaño del búfer al del elemento (en píxeles físicos). */
  resize(cssWidth: number, cssHeight: number): void {
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.round(cssWidth * this.dpr));
    this.canvas.height = Math.max(1, Math.round(cssHeight * this.dpr));
    this.viewport.resize(cssWidth, cssHeight);
    this.renderNow();
  }

  requestRender(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.renderNow();
    });
  }

  renderNow(): void {
    const { ctx, viewport: vp, theme } = this;
    const doc = this.getDocument();
    const page = doc.page;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    // Escritorio
    ctx.fillStyle = theme.desk;
    ctx.fillRect(0, 0, vp.width, vp.height);

    const topLeft = vp.docToScreen({ x: 0, y: 0 });
    const w = page.widthMm * vp.scale;
    const h = page.heightMm * vp.scale;
    // Alinear a medio píxel para bordes de 1 px nítidos
    const x = Math.round(topLeft.x) + 0.5;
    const y = Math.round(topLeft.y) + 0.5;

    // Sombra y página
    ctx.save();
    ctx.shadowColor = theme.pageShadow;
    ctx.shadowBlur = 18;
    ctx.shadowOffsetY = 4;
    ctx.fillStyle = theme.page;
    ctx.fillRect(x, y, Math.round(w), Math.round(h));
    ctx.restore();
    ctx.strokeStyle = theme.pageBorder;
    ctx.lineWidth = 1;
    ctx.strokeRect(x, y, Math.round(w), Math.round(h));

    // Guías de impresión: sangrado (fuera del corte) y margen seguro (dentro).
    ctx.setLineDash([6, 4]);
    if (this.overlays.showBleed && page.bleedMm > 0) {
      const b = page.bleedMm * vp.scale;
      ctx.strokeStyle = theme.bleed;
      ctx.strokeRect(Math.round(topLeft.x - b) + 0.5, Math.round(topLeft.y - b) + 0.5, Math.round(w + b * 2), Math.round(h + b * 2));
    }
    if (this.overlays.showSafeArea && page.safeMarginMm > 0) {
      const m = page.safeMarginMm * vp.scale;
      if (w > m * 2 && h > m * 2) {
        ctx.strokeStyle = theme.safe;
        ctx.strokeRect(Math.round(topLeft.x + m) + 0.5, Math.round(topLeft.y + m) + 0.5, Math.round(w - m * 2), Math.round(h - m * 2));
      }
    }
    ctx.setLineDash([]);

    // Objetos, en orden de apilado
    drawShapes(this.target(), doc.shapes);

    const overlay = this.getOverlay();
    if (overlay.guides?.length) this.drawGuides(overlay.guides, overlay.activeGuide ?? null);
    if (overlay.crop) this.drawCrop(overlay.crop);
    if (overlay.preview) this.drawShape(overlay.preview);
    if (overlay.hover) this.outlineShape(overlay.hover, theme.selection, 1);
    for (const shape of overlay.selection) this.outlineShape(shape, theme.selection, 1, [4, 3]);
    if (overlay.selectionBounds) this.drawHandles(overlay.selectionBounds, overlay.mode);
    if (overlay.marquee) this.drawMarquee(overlay.marquee);
    if (overlay.editing) this.outlineShape(overlay.editing, theme.selection, 1, [2, 2]);
    if (overlay.textSelection.length > 0) this.drawTextSelection(overlay.textSelection);
    if (overlay.caret) this.drawCaret(overlay.caret);
    if (overlay.pathEdit) this.drawPathEdit(overlay.pathEdit);
    if (overlay.snapLines?.length) this.drawSnapLines(overlay.snapLines);
  }

  /** Guías: líneas finas de lado a lado del lienzo. */
  private drawGuides(guides: Guide[], active: string | null): void {
    const { ctx, theme, viewport: vp } = this;
    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.lineWidth = 1;
    for (const g of guides) {
      const s = vp.docToScreen({ x: g.pos, y: g.pos });
      ctx.strokeStyle = g.id === active ? theme.guideActive : theme.guide;
      ctx.beginPath();
      if (g.axis === 'x') {
        const x = Math.round(s.x) + 0.5;
        ctx.moveTo(x, 0);
        ctx.lineTo(x, vp.height);
      } else {
        const y = Math.round(s.y) + 0.5;
        ctx.moveTo(0, y);
        ctx.lineTo(vp.width, y);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawSnapLines(lines: SnapLine[]): void {
    const { ctx, theme, viewport: vp } = this;
    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.setLineDash([5, 3]);
    ctx.lineWidth = 1;
    ctx.strokeStyle = theme.snap;
    for (const l of lines) {
      const s = vp.docToScreen({ x: l.pos, y: l.pos });
      ctx.beginPath();
      if (l.axis === 'x') {
        ctx.moveTo(Math.round(s.x) + 0.5, 0);
        ctx.lineTo(Math.round(s.x) + 0.5, vp.height);
      } else {
        ctx.moveTo(0, Math.round(s.y) + 0.5);
        ctx.lineTo(vp.width, Math.round(s.y) + 0.5);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  /** Recortar: lo que se quitará queda oscurecido. */
  private drawCrop(area: Rect): void {
    const { ctx, viewport: vp } = this;
    const box = this.screenBox(area);
    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.beginPath();
    ctx.rect(0, 0, vp.width, vp.height);
    ctx.rect(box.x, box.y, box.width, box.height);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.fill('evenodd');
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(box.x) + 0.5, Math.round(box.y) + 0.5, Math.round(box.width), Math.round(box.height));
    ctx.restore();
    this.drawHandles(area, 'scale');
  }

  private drawPathEdit(edit: PathOverlay): void {
    const { ctx, theme } = this;
    const vp = this.viewport;
    const s = (p: Point) => vp.docToScreen(p);
    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    // Contorno de la curva
    ctx.beginPath();
    for (const line of edit.outline) {
      line.points.forEach((p, i) => {
        const q = s(p);
        if (i === 0) ctx.moveTo(q.x, q.y);
        else ctx.lineTo(q.x, q.y);
      });
      if (line.closed) ctx.closePath();
    }
    ctx.lineWidth = 1;
    ctx.strokeStyle = theme.selection;
    ctx.stroke();
    // Tramo que sigue al cursor (pluma)
    if (edit.rubber && edit.rubber.length > 1) {
      ctx.beginPath();
      edit.rubber.forEach((p, i) => {
        const q = s(p);
        if (i === 0) ctx.moveTo(q.x, q.y);
        else ctx.lineTo(q.x, q.y);
      });
      ctx.setLineDash([4, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // Manijas: línea y punta redonda
    for (const h of edit.handles) {
      const a = s(h.from);
      const b = s(h.to);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.strokeStyle = theme.selection;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(b.x, b.y, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = theme.selection;
      ctx.fill();
      ctx.strokeStyle = theme.handleBorder;
      ctx.stroke();
    }
    // Nodos: cuadro = cúspide (esquina), círculo = suave. Rellenos = seleccionados.
    for (const a of edit.anchors) {
      const q = s(a.p);
      const r = a.highlight ? 6 : 4;
      ctx.beginPath();
      if (a.smooth) ctx.arc(q.x, q.y, r, 0, Math.PI * 2);
      else ctx.rect(Math.round(q.x - r) + 0.5, Math.round(q.y - r) + 0.5, r * 2, r * 2);
      ctx.fillStyle = a.selected ? theme.selection : '#ffffff';
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = a.selected ? '#ffffff' : '#111214';
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawTextSelection(quads: Point[][]): void {
    const { ctx } = this;
    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = 'rgba(76, 141, 255, 0.35)';
    for (const quad of quads) {
      ctx.beginPath();
      quad.forEach((p, i) => {
        const s = this.viewport.docToScreen(p);
        if (i === 0) ctx.moveTo(s.x, s.y);
        else ctx.lineTo(s.x, s.y);
      });
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  private drawCaret(caret: { top: Point; bottom: Point }): void {
    const { ctx } = this;
    const a = this.viewport.docToScreen(caret.top);
    const b = this.viewport.docToScreen(caret.bottom);
    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    // Doble trazo: se ve sobre fondos claros y oscuros.
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.stroke();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#111214';
    ctx.stroke();
    ctx.restore();
  }

  /** Destino de dibujo en pantalla: zoom, desplazamiento y densidad de píxeles. */
  private target(): DrawTarget {
    const vp = this.viewport;
    const s = this.dpr * vp.scale;
    return { ctx: this.ctx, base: [s, 0, 0, s, this.dpr * vp.originX, this.dpr * vp.originY], pxPerMm: s, minLineWidth: this.dpr, resolveImage: this.resolveImage };
  }

  private drawShape(shape: Shape): void {
    drawShape(this.target(), shape);
  }

  /** Lleva el contexto a coordenadas de la figura (mm locales → píxeles de pantalla). */
  private enterShapeSpace(shape: Shape): void {
    const vp = this.viewport;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.ctx.translate(vp.originX, vp.originY);
    this.ctx.scale(vp.scale, vp.scale);
    const [a, b, c, d, e, f] = shape.transform;
    this.ctx.transform(a, b, c, d, e, f);
  }

  private outlineShape(shape: Shape, color: string, width: number, dash: number[] = []): void {
    const { ctx } = this;
    ctx.save();
    this.enterShapeSpace(shape);
    ctx.beginPath();
    traceLocalPath(ctx, shape);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.setLineDash(dash);
    ctx.lineWidth = width;
    ctx.strokeStyle = color;
    ctx.stroke();
    ctx.restore();
  }

  /** Caja de selección en pantalla. */
  private screenBox(rect: Rect): Rect {
    const tl = this.viewport.docToScreen({ x: rect.x, y: rect.y });
    const br = this.viewport.docToScreen({ x: rect.x + rect.width, y: rect.y + rect.height });
    return { x: tl.x, y: tl.y, width: br.x - tl.x, height: br.y - tl.y };
  }

  private drawHandles(bounds: Rect, mode: TransformMode): void {
    const { ctx, theme } = this;
    const box = this.screenBox(bounds);
    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    if (mode === 'scale') {
      for (const p of Object.values(scaleHandlePoints(box))) {
        const x = Math.round(p.x - 4) + 0.5;
        const y = Math.round(p.y - 4) + 0.5;
        ctx.fillStyle = theme.handle;
        ctx.strokeStyle = theme.handleBorder;
        ctx.lineWidth = 1;
        ctx.fillRect(x, y, 8, 8);
        ctx.strokeRect(x, y, 8, 8);
      }
    } else {
      // Flechas curvas en las esquinas: arrastrarlas rota alrededor del centro.
      const center = centerOf(box);
      for (const p of Object.values(rotateHandlePoints(box))) {
        const angle = Math.atan2(p.y - center.y, p.x - center.x);
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(angle + Math.PI / 2);
        ctx.beginPath();
        ctx.arc(0, 8, 8, -Math.PI * 0.85, -Math.PI * 0.15);
        ctx.lineWidth = 4;
        ctx.strokeStyle = theme.handleBorder;
        ctx.stroke();
        ctx.lineWidth = 2;
        ctx.strokeStyle = theme.handle;
        ctx.stroke();
        for (const side of [-1, 1]) {
          ctx.beginPath();
          const tip = { x: side * 7.6, y: 8 - 8 * Math.sin(Math.PI * 0.15) - 0.5 };
          ctx.moveTo(tip.x, tip.y - 4);
          ctx.lineTo(tip.x, tip.y);
          ctx.lineTo(tip.x - side * 4, tip.y + 1);
          ctx.stroke();
        }
        ctx.restore();
      }
      // Centro de rotación
      ctx.beginPath();
      ctx.arc(center.x, center.y, 5, 0, Math.PI * 2);
      ctx.moveTo(center.x - 3, center.y);
      ctx.lineTo(center.x + 3, center.y);
      ctx.moveTo(center.x, center.y - 3);
      ctx.lineTo(center.x, center.y + 3);
      ctx.lineWidth = 3;
      ctx.strokeStyle = theme.handleBorder;
      ctx.stroke();
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = theme.handle;
      ctx.stroke();
    }
    // Centro de la selección (una "x" pequeña)
    if (mode === 'scale') {
      const c = centerOf(box);
      ctx.beginPath();
      ctx.moveTo(c.x - 3, c.y - 3);
      ctx.lineTo(c.x + 3, c.y + 3);
      ctx.moveTo(c.x + 3, c.y - 3);
      ctx.lineTo(c.x - 3, c.y + 3);
      ctx.lineWidth = 1;
      ctx.strokeStyle = theme.handle;
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawMarquee(rect: Rect): void {
    const { ctx, theme } = this;
    const box = this.screenBox(rect);
    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = 'rgba(76, 141, 255, 0.10)';
    ctx.fillRect(box.x, box.y, box.width, box.height);
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = theme.selection;
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(box.x) + 0.5, Math.round(box.y) + 0.5, Math.round(box.width), Math.round(box.height));
    ctx.restore();
  }
}

import { fromMm, type Unit } from './units';
import type { Viewport } from './viewport';

export interface RulerTheme {
  background: string;
  tick: string;
  text: string;
  marker: string;
  border: string;
}

export const DARK_RULER_THEME: RulerTheme = {
  background: '#2b2c30',
  tick: '#8b8d94',
  text: '#b9bbc2',
  marker: '#f2c14e',
  border: '#16171a',
};

export const LIGHT_RULER_THEME: RulerTheme = {
  background: '#f7f8fa',
  tick: '#7a808a',
  text: '#4a505a',
  marker: '#d9822b',
  border: '#c9ccd3',
};

/** Pasos "bonitos" en la unidad visible: 1, 2, 5, 10, 20, 50… */
function niceStep(rawStep: number): number {
  const power = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / power;
  const nice = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return nice * power;
}

/**
 * Regla horizontal o vertical. Las marcas se calculan en la unidad del documento
 * y se espacian según el zoom: siempre hay ~80 px entre números.
 */
export class Ruler {
  private readonly ctx: CanvasRenderingContext2D;
  private dpr = 1;
  private cssWidth = 0;
  private cssHeight = 0;
  /** Posición del cursor (en pantalla) para la marca amarilla; null = fuera. */
  cursor: number | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly orientation: 'horizontal' | 'vertical',
    private readonly viewport: Viewport,
    private readonly getUnit: () => Unit,
    public theme: RulerTheme = DARK_RULER_THEME,
  ) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('El sistema no permite dibujar en Canvas 2D');
    this.ctx = ctx;
  }

  resize(cssWidth: number, cssHeight: number): void {
    this.dpr = window.devicePixelRatio || 1;
    this.cssWidth = cssWidth;
    this.cssHeight = cssHeight;
    this.canvas.width = Math.max(1, Math.round(cssWidth * this.dpr));
    this.canvas.height = Math.max(1, Math.round(cssHeight * this.dpr));
    this.render();
  }

  render(): void {
    const { ctx, theme, viewport: vp } = this;
    const horizontal = this.orientation === 'horizontal';
    const length = horizontal ? this.cssWidth : this.cssHeight;
    const thickness = horizontal ? this.cssHeight : this.cssWidth;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = theme.background;
    ctx.fillRect(0, 0, this.cssWidth, this.cssHeight);

    const unit = this.getUnit();
    const pxPerUnit = vp.scale / fromMm(1, unit); // píxeles de pantalla por unidad visible
    const major = niceStep(80 / pxPerUnit); // un número cada ~80 px
    const minorCount = String(major).startsWith('5') ? 5 : 10;
    const minor = major / minorCount;
    const origin = horizontal ? vp.originX : vp.originY;

    const first = Math.floor(-origin / pxPerUnit / minor) * minor;
    const last = (length - origin) / pxPerUnit;
    const decimals = major < 1 ? Math.min(3, Math.ceil(-Math.log10(major))) : 0;

    ctx.strokeStyle = theme.tick;
    ctx.fillStyle = theme.text;
    ctx.lineWidth = 1;
    ctx.font = '10px "Segoe UI", system-ui, sans-serif';
    ctx.textBaseline = 'top';
    ctx.beginPath();
    for (let i = 0, value = first; value <= last + minor; i++, value = first + i * minor) {
      const pos = Math.round(origin + value * pxPerUnit) + 0.5;
      const index = Math.round(value / minor);
      const isMajor = index % minorCount === 0;
      const isHalf = !isMajor && minorCount === 10 && index % 5 === 0;
      const tick = isMajor ? thickness : isHalf ? thickness * 0.45 : thickness * 0.25;
      if (horizontal) {
        ctx.moveTo(pos, thickness);
        ctx.lineTo(pos, thickness - tick);
      } else {
        ctx.moveTo(thickness, pos);
        ctx.lineTo(thickness - tick, pos);
      }
      if (isMajor) {
        const label = (Math.round(value / major) * major).toFixed(decimals).replace(/^-0$/, '0');
        if (horizontal) {
          ctx.fillText(label, pos + 3, 2);
        } else {
          // Texto vertical, como en los editores vectoriales
          ctx.save();
          ctx.translate(2, pos + 3);
          ctx.rotate(Math.PI / 2);
          ctx.fillText(label, 0, -thickness + 4);
          ctx.restore();
        }
      }
    }
    ctx.stroke();

    // Marca de la posición del cursor
    if (this.cursor !== null) {
      ctx.strokeStyle = theme.marker;
      ctx.beginPath();
      const pos = Math.round(this.cursor) + 0.5;
      if (horizontal) {
        ctx.moveTo(pos, 0);
        ctx.lineTo(pos, thickness);
      } else {
        ctx.moveTo(0, pos);
        ctx.lineTo(thickness, pos);
      }
      ctx.stroke();
    }

    // Borde hacia el lienzo
    ctx.strokeStyle = theme.border;
    ctx.beginPath();
    if (horizontal) {
      ctx.moveTo(0, thickness - 0.5);
      ctx.lineTo(this.cssWidth, thickness - 0.5);
    } else {
      ctx.moveTo(thickness - 0.5, 0);
      ctx.lineTo(thickness - 0.5, this.cssHeight);
    }
    ctx.stroke();
  }
}

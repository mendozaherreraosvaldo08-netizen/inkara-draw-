import type { Matrix } from './matrix';
import { traceSubpaths } from './path-geom';
import { canBeContainer, gradientLine, traceLocalPath, type ImageShape, type PathShape, type Shape, type TextShape } from './shapes';
import { cssFont, layoutText, lineOffset } from './text';

/**
 * Dibuja objetos en un Canvas 2D. Lo usan la pantalla y la exportación, así lo
 * que se imprime es exactamente lo que se ve.
 *
 * `base` lleva de mm de la página a píxeles del canvas (incluye zoom, posición,
 * densidad de pantalla o resolución de impresión y, al exportar, el espejo).
 */
export interface DrawTarget {
  ctx: CanvasRenderingContext2D;
  base: Matrix;
  /** Píxeles del canvas por mm (para el grosor de los contornos). */
  pxPerMm: number;
  /** Grosor mínimo de contorno en píxeles del canvas (en pantalla 1 px para que se vea). */
  minLineWidth: number;
  resolveImage(assetId: string): CanvasImageSource | null;
}

/** Qué partes dibujar: todo, solo el relleno o solo el contorno (para PowerClip). */
type Part = 'all' | 'fill' | 'stroke';

/** Lleva el contexto a las coordenadas locales de la figura. */
export function enterShapeSpace(target: DrawTarget, shape: Shape): void {
  const { ctx, base } = target;
  ctx.setTransform(base[0], base[1], base[2], base[3], base[4], base[5]);
  const [a, b, c, d, e, f] = shape.transform;
  ctx.transform(a, b, c, d, e, f);
}

/**
 * Dibuja una lista de objetos en orden. Los que están dentro de un contenedor
 * (PowerClip) se dibujan con su contenedor: relleno del contenedor, contenido
 * recortado a su forma y, encima, el contorno del contenedor.
 */
export function drawShapes(target: DrawTarget, shapes: Shape[]): void {
  const byId = new Map(shapes.map((s) => [s.id, s]));
  const children = new Map<string, Shape[]>();
  for (const s of shapes) {
    if (s.clipId && byId.has(s.clipId)) {
      const list = children.get(s.clipId);
      if (list) list.push(s);
      else children.set(s.clipId, [s]);
    }
  }
  const drawEntry = (s: Shape, depth: number) => {
    const inside = children.get(s.id);
    if (!inside || depth > 8 || !canBeContainer(s)) {
      drawShape(target, s);
      return;
    }
    drawShape(target, s, 'fill');
    const { ctx } = target;
    ctx.save();
    clipToShape(target, s);
    for (const c of inside) if (!c.hidden) drawEntry(c, depth + 1);
    ctx.restore();
    drawShape(target, s, 'stroke');
  };
  for (const s of shapes) {
    if (s.clipId && byId.has(s.clipId)) continue; // se dibuja con su contenedor
    if (s.hidden) continue; // oculto: no se ve ni se imprime
    drawEntry(s, 0);
  }
}

/** Recorta el lienzo a la forma de un contenedor. */
function clipToShape(target: DrawTarget, shape: Shape): void {
  const { ctx } = target;
  enterShapeSpace(target, shape);
  ctx.beginPath();
  if (shape.kind === 'path') {
    traceSubpaths(ctx, shape.subpaths, true);
    ctx.clip(shape.fillRule ?? 'evenodd');
  } else {
    traceLocalPath(ctx, shape);
    ctx.clip();
  }
}

export function drawShape(target: DrawTarget, shape: Shape, part: Part = 'all'): void {
  if (shape.fade) {
    drawFaded(target, shape, part);
    return;
  }
  const { ctx } = target;
  ctx.save();
  if (shape.opacity !== undefined) ctx.globalAlpha *= shape.opacity;
  if (part !== 'stroke') applyShadow(target, shape);
  drawRaw(target, shape, part);
  ctx.restore();
}

/**
 * Sombra paralela con la sombra de Canvas. El desplazamiento y el difuminado
 * se dan en píxeles del lienzo (no les afecta la transformación), así que se
 * pasan de mm con la escala (y el espejo, al exportar) del destino.
 */
function applyShadow(target: DrawTarget, shape: Shape): void {
  const sh = shape.shadow;
  if (!sh || sh.opacity <= 0) return;
  const { ctx, base } = target;
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(sh.color.slice(i, i + 2), 16));
  ctx.shadowColor = `rgba(${r}, ${g}, ${b}, ${sh.opacity})`;
  ctx.shadowOffsetX = base[0] * sh.dx + base[2] * sh.dy;
  ctx.shadowOffsetY = base[1] * sh.dx + base[3] * sh.dy;
  ctx.shadowBlur = sh.blur * target.pxPerMm;
}

function drawRaw(target: DrawTarget, shape: Shape, part: Part): void {
  if (shape.kind === 'text') return drawText(target, shape, part);
  if (shape.kind === 'image') return drawImage(target, shape, part);
  if (shape.kind === 'path') return drawPath(target, shape, part);
  const { ctx } = target;
  ctx.save();
  enterShapeSpace(target, shape);
  ctx.beginPath();
  traceLocalPath(ctx, shape);
  const paint = fillPaint(ctx, shape);
  if (paint && part !== 'stroke') {
    ctx.fillStyle = paint;
    ctx.fill();
  }
  if (part !== 'fill') strokeCurrent(target, shape);
  ctx.restore();
}

/** Contorno del trazado actual, con grosor en mm que no se deforma al escalar. */
function strokeCurrent(target: DrawTarget, shape: Shape): void {
  if (!shape.stroke || shape.strokeWidth <= 0) return;
  const { ctx } = target;
  // El trazado ya está en píxeles: se vuelve a la identidad para que el grosor
  // del contorno no se deforme al escalar o rotar el objeto.
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.lineWidth = Math.max(target.minLineWidth, shape.strokeWidth * target.pxPerMm);
  ctx.lineJoin = 'miter';
  ctx.lineCap = 'butt';
  ctx.strokeStyle = shape.stroke;
  ctx.stroke();
}

/**
 * Relleno: color sólido o degradado (lineal o radial) sobre la caja local de la
 * figura. `k` es la escala del espacio de dibujo (el texto se dibuja a 100 px).
 */
function fillPaint(ctx: CanvasRenderingContext2D, shape: Shape, k = 1): string | CanvasGradient | null {
  const g = shape.gradient;
  if (!g) return shape.fill;
  const w = shape.width / k;
  const h = shape.height / k;
  let gradient: CanvasGradient;
  if (g.type === 'radial') {
    gradient = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.hypot(w, h) / 2);
  } else {
    const line = gradientLine(w, h, g.angle);
    gradient = ctx.createLinearGradient(line.x0, line.y0, line.x1, line.y1);
  }
  for (const stop of g.stops) gradient.addColorStop(Math.min(1, Math.max(0, stop.offset)), stop.color);
  return gradient;
}

/**
 * Transparencia degradada ("desvanecer"): la figura se dibuja en una capa aparte
 * y se le aplica una máscara que va de opaco a transparente.
 */
let layer: HTMLCanvasElement | OffscreenCanvas | null = null;
function drawFaded(target: DrawTarget, shape: Shape, part: Part): void {
  const { ctx } = target;
  const width = ctx.canvas.width;
  const height = ctx.canvas.height;
  if (!layer || layer.width !== width || layer.height !== height) {
    layer = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(width, height) : Object.assign(document.createElement('canvas'), { width, height });
  }
  const lctx = layer.getContext('2d') as CanvasRenderingContext2D | null;
  if (!lctx) return drawRaw(target, shape, part);
  lctx.setTransform(1, 0, 0, 1, 0, 0);
  lctx.globalCompositeOperation = 'source-over';
  lctx.clearRect(0, 0, width, height);
  drawRaw({ ...target, ctx: lctx }, shape, part);
  // Máscara: conserva lo dibujado con la opacidad del degradado.
  const fade = shape.fade!;
  enterShapeSpace({ ...target, ctx: lctx }, shape);
  const line = gradientLine(shape.width, shape.height, fade.angle);
  const mask = lctx.createLinearGradient(line.x0, line.y0, line.x1, line.y1);
  mask.addColorStop(0, `rgba(0,0,0,${fade.from})`);
  mask.addColorStop(1, `rgba(0,0,0,${fade.to})`);
  lctx.globalCompositeOperation = 'destination-in';
  lctx.fillStyle = mask;
  lctx.fillRect(-1e5, -1e5, 2e5, 2e5);
  lctx.globalCompositeOperation = 'source-over';
  ctx.save();
  if (part !== 'stroke') applyShadow(target, shape);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (shape.opacity !== undefined) ctx.globalAlpha *= shape.opacity;
  ctx.drawImage(layer, 0, 0);
  ctx.restore();
}

/**
 * Curva: solo se rellenan los subtrayectos cerrados (una línea abierta no se
 * "cierra" sola) y con la regla par-impar, así los huecos quedan vacíos.
 */
function drawPath(target: DrawTarget, shape: PathShape, part: Part): void {
  const { ctx } = target;
  ctx.save();
  enterShapeSpace(target, shape);
  const paint = fillPaint(ctx, shape);
  if (paint && part !== 'stroke' && shape.subpaths.some((s) => s.closed)) {
    ctx.beginPath();
    traceSubpaths(ctx, shape.subpaths, true);
    ctx.fillStyle = paint;
    ctx.fill(shape.fillRule ?? 'evenodd');
  }
  if (part !== 'fill') {
    ctx.beginPath();
    traceSubpaths(ctx, shape.subpaths);
    strokeCurrent(target, shape);
  }
  ctx.restore();
}

function drawImage(target: DrawTarget, shape: ImageShape, part: Part): void {
  const { ctx } = target;
  ctx.save();
  enterShapeSpace(target, shape);
  if (part !== 'stroke') {
    const image = target.resolveImage(shape.assetId);
    if (image) {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      if (shape.crop && 'width' in image) {
        // Recorte: solo una parte de la imagen llena el marco (foto que "cubre" el marco).
        const iw = Number((image as HTMLImageElement).naturalWidth || (image as { width: number }).width);
        const ih = Number((image as HTMLImageElement).naturalHeight || (image as { height: number }).height);
        const c = shape.crop;
        ctx.drawImage(image, c.x * iw, c.y * ih, c.width * iw, c.height * ih, 0, 0, shape.width, shape.height);
      } else {
        ctx.drawImage(image, 0, 0, shape.width, shape.height);
      }
    } else {
      // Mientras se decodifica: un recuadro gris con una cruz.
      ctx.fillStyle = '#e4e5e8';
      ctx.fillRect(0, 0, shape.width, shape.height);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(shape.width, shape.height);
      ctx.moveTo(shape.width, 0);
      ctx.lineTo(0, shape.height);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.strokeStyle = '#a0a2a8';
      ctx.lineWidth = Math.max(1, target.minLineWidth);
      ctx.stroke();
    }
  }
  if (part !== 'fill' && shape.stroke && shape.strokeWidth > 0) {
    // Marco opcional (el contorno de una imagen).
    enterShapeSpace(target, shape);
    ctx.beginPath();
    ctx.rect(0, 0, shape.width, shape.height);
    strokeCurrent(target, shape);
  }
  ctx.restore();
}

/**
 * Texto: se dibuja a 100 px en un espacio escalado al tamaño real, porque Canvas
 * redondea los tamaños de letra muy pequeños (y aquí la unidad es el mm).
 */
function drawText(target: DrawTarget, shape: TextShape, part: Part): void {
  const { ctx } = target;
  const layout = layoutText(shape);
  const k = layout.size / 100;
  ctx.save();
  enterShapeSpace(target, shape);
  ctx.scale(k, k);
  ctx.font = cssFont({ family: shape.fontFamily, bold: shape.bold, italic: shape.italic }, 100);
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  const lh = layout.lineHeight / k;
  const paint = fillPaint(ctx, shape, k);
  if (layout.glyphs) {
    // Texto en arco: letra por letra, cada una girada sobre el círculo.
    const base = ctx.getTransform();
    for (const pass of ['stroke', 'fill'] as const) {
      if (pass === 'stroke' && (part === 'fill' || !shape.stroke || shape.strokeWidth <= 0)) continue;
      if (pass === 'fill' && (part === 'stroke' || !paint)) continue;
      for (const g of layout.glyphs) {
        ctx.setTransform(base);
        ctx.translate(g.x / k, g.y / k);
        ctx.rotate(g.rotation);
        if (pass === 'stroke') {
          ctx.lineJoin = 'round';
          ctx.lineWidth = (shape.strokeWidth * 2) / k;
          ctx.strokeStyle = shape.stroke!;
          ctx.strokeText(g.ch, -g.width / k / 2, 0);
        } else {
          // El degradado sigue a la caja entera, no a cada letra.
          ctx.fillStyle = shape.gradient ? solidOf(shape) : paint!;
          ctx.fillText(g.ch, -g.width / k / 2, 0);
        }
      }
    }
    ctx.restore();
    if (shape.gradient && part !== 'stroke') drawArcGradient(target, shape, layout);
    return;
  }
  layout.lines.forEach((line, i) => {
    if (!line) return;
    const x = lineOffset(shape.align, shape.width, layout.widths[i]!) / k;
    const y = i * lh + lh / 2;
    if (part !== 'fill' && shape.stroke && shape.strokeWidth > 0) {
      // El contorno va detrás del relleno para que no "adelgace" la letra.
      ctx.lineJoin = 'round';
      ctx.lineWidth = (shape.strokeWidth * 2) / k;
      ctx.strokeStyle = shape.stroke;
      ctx.strokeText(line, x, y);
    }
    if (part !== 'stroke' && paint) {
      ctx.fillStyle = paint;
      ctx.fillText(line, x, y);
    }
  });
  ctx.restore();
}

/** Color del primer tono del degradado (para letras sueltas, antes del degradado). */
function solidOf(shape: Shape): string {
  return shape.gradient?.stops[0]?.color ?? shape.fill ?? '#000000';
}

/**
 * Degradado en texto en arco: se pintan las letras en una capa y encima se pone
 * el degradado solo donde hay letra (source-in), así sigue la caja completa.
 */
function drawArcGradient(target: DrawTarget, shape: TextShape, layout: ReturnType<typeof layoutText>): void {
  const { ctx } = target;
  const width = ctx.canvas.width;
  const height = ctx.canvas.height;
  const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(width, height) : Object.assign(document.createElement('canvas'), { width, height });
  const lctx = canvas.getContext('2d') as CanvasRenderingContext2D | null;
  if (!lctx) return;
  const k = layout.size / 100;
  const sub: DrawTarget = { ...target, ctx: lctx };
  enterShapeSpace(sub, shape);
  lctx.scale(k, k);
  lctx.font = cssFont({ family: shape.fontFamily, bold: shape.bold, italic: shape.italic }, 100);
  lctx.textBaseline = 'middle';
  lctx.textAlign = 'left';
  const base = lctx.getTransform();
  lctx.fillStyle = '#000';
  for (const g of layout.glyphs!) {
    lctx.setTransform(base);
    lctx.translate(g.x / k, g.y / k);
    lctx.rotate(g.rotation);
    lctx.fillText(g.ch, -g.width / k / 2, 0);
  }
  enterShapeSpace(sub, shape);
  lctx.globalCompositeOperation = 'source-in';
  lctx.fillStyle = fillPaint(lctx, shape)!;
  lctx.fillRect(0, 0, shape.width, shape.height);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(canvas, 0, 0);
  ctx.restore();
}

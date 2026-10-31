import type { TrazoDocument } from './document';
import { pathData } from './path';
import { canBeContainer, gradientLine, polygonPoints, type Shape } from './shapes';
import { layoutText } from './text';

/**
 * Exporta el documento a SVG (vectorial: se abre en Illustrator, Inkscape, Corel
 * o el navegador). Medidas en mm: el SVG mide lo mismo que la placa. Las imágenes
 * van incrustadas. Incluye el sangrado si `withBleed` (lo que se imprime).
 *
 * Degradados, transparencias y PowerClip se escriben con lo estándar de SVG:
 * <linearGradient>/<radialGradient>, opacity, <mask> y <clipPath>.
 */
export function exportSvg(doc: TrazoDocument, options: { withBleed?: boolean } = {}): string {
  const { widthMm, heightMm, bleedMm } = doc.page;
  const b = options.withBleed ? bleedMm : 0;
  const w = widthMm + b * 2;
  const h = heightMm + b * 2;
  const ctx: Ctx = { defs: [], next: 0, doc };
  const body = shapesSvg(doc.shapes, ctx).join('\n  ');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${n(w)}mm" height="${n(h)}mm" viewBox="${n(-b)} ${n(-b)} ${n(w)} ${n(h)}">`,
    `  <title>${esc(doc.name)}</title>`,
    `  <!-- Hecho con Inkara Draw · ${n(widthMm)} × ${n(heightMm)} mm${b ? ` + ${n(b)} mm de sangrado` : ''} -->`,
    ctx.defs.length ? `  <defs>\n    ${ctx.defs.join('\n    ')}\n  </defs>` : '',
    body ? `  ${body}` : '',
    '</svg>',
    '',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

interface Ctx {
  defs: string[];
  next: number;
  doc: TrazoDocument;
}

type Part = 'all' | 'fill' | 'stroke';

/** Objetos en orden; los que están dentro de un contenedor van con él (PowerClip). */
function shapesSvg(shapes: Shape[], ctx: Ctx): string[] {
  const byId = new Map(shapes.map((s) => [s.id, s]));
  const children = new Map<string, Shape[]>();
  for (const s of shapes) if (s.clipId && byId.has(s.clipId)) children.set(s.clipId, [...(children.get(s.clipId) ?? []), s]);
  const entry = (s: Shape, depth: number): string[] => {
    const inside = children.get(s.id);
    if (!inside || depth > 8 || !canBeContainer(s)) return [shapeSvg(s, ctx)];
    const id = `clip${ctx.next++}`;
    ctx.defs.push(`<clipPath id="${id}" clipPathUnits="userSpaceOnUse">${geometry(s, '')}</clipPath>`);
    return [shapeSvg(s, ctx, 'fill'), `<g clip-path="url(#${id})">${inside.filter((c) => !c.hidden).flatMap((c) => entry(c, depth + 1)).join('')}</g>`, shapeSvg(s, ctx, 'stroke')];
  };
  return shapes.filter((s) => !s.hidden && !(s.clipId && byId.has(s.clipId))).flatMap((s) => entry(s, 0)).filter(Boolean);
}

/** Grosor del contorno en unidades locales (el contorno no se deforma al escalar en Trazo). */
const localStroke = (shape: Shape) => {
  const [a, b, c, d] = shape.transform;
  return shape.strokeWidth / (Math.sqrt(Math.abs(a * d - b * c)) || 1);
};

/** Atributo de relleno: color, degradado (definido en <defs>) o nada. */
function fillAttr(shape: Shape, ctx: Ctx): string {
  const g = shape.gradient;
  if (!g) return shape.fill ?? 'none';
  const id = `grad${ctx.next++}`;
  const stops = g.stops.map((s) => `<stop offset="${n(s.offset)}" stop-color="${s.color}"/>`).join('');
  if (g.type === 'radial') {
    ctx.defs.push(`<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${n(shape.width / 2)}" cy="${n(shape.height / 2)}" r="${n(Math.hypot(shape.width, shape.height) / 2)}">${stops}</radialGradient>`);
  } else {
    const l = gradientLine(shape.width, shape.height, g.angle);
    ctx.defs.push(`<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${n(l.x0)}" y1="${n(l.y0)}" x2="${n(l.x1)}" y2="${n(l.y1)}">${stops}</linearGradient>`);
  }
  return `url(#${id})`;
}

/** Opacidad y desvanecido (máscara) del objeto. */
function effectAttrs(shape: Shape, ctx: Ctx): string {
  let out = shape.opacity !== undefined && shape.opacity < 1 ? ` opacity="${n(shape.opacity)}"` : '';
  if (shape.shadow && shape.shadow.opacity > 0) {
    // La sombra va en mm de la página: se pasa al espacio local del objeto.
    const [a, b, c, d] = shape.transform;
    const det = a * d - b * c || 1;
    const lx = (d * shape.shadow.dx - c * shape.shadow.dy) / det;
    const ly = (-b * shape.shadow.dx + a * shape.shadow.dy) / det;
    const scale = Math.sqrt(Math.abs(det)) || 1;
    const id = `shadow${ctx.next++}`;
    ctx.defs.push(`<filter id="${id}" x="-50%" y="-50%" width="200%" height="200%"><feDropShadow dx="${n(lx)}" dy="${n(ly)}" stdDeviation="${n(shape.shadow.blur / 2 / scale)}" flood-color="${shape.shadow.color}" flood-opacity="${n(shape.shadow.opacity)}"/></filter>`);
    out += ` filter="url(#${id})"`;
  }
  if (shape.fade) {
    const g = `fadeg${ctx.next++}`;
    const m = `fade${ctx.next++}`;
    const l = gradientLine(shape.width, shape.height, shape.fade.angle);
    ctx.defs.push(
      `<linearGradient id="${g}" gradientUnits="userSpaceOnUse" x1="${n(l.x0)}" y1="${n(l.y0)}" x2="${n(l.x1)}" y2="${n(l.y1)}"><stop offset="0" stop-color="#fff" stop-opacity="${n(shape.fade.from)}"/><stop offset="1" stop-color="#fff" stop-opacity="${n(shape.fade.to)}"/></linearGradient>`,
      `<mask id="${m}" maskUnits="userSpaceOnUse" x="-100000" y="-100000" width="200000" height="200000"><rect x="-100000" y="-100000" width="200000" height="200000" fill="url(#${g})"/></mask>`,
    );
    out += ` mask="url(#${m})"`;
  }
  return out;
}

/** La figura sin pintura (para clipPath) o con los atributos de `extra`. */
function geometry(shape: Shape, extra: string): string {
  const t = `transform="matrix(${shape.transform.map(n).join(' ')})"`;
  switch (shape.kind) {
    case 'rectangle': {
      const r = Math.min(shape.cornerRadius, shape.width / 2, shape.height / 2);
      return `<rect ${t} width="${n(shape.width)}" height="${n(shape.height)}"${r > 0 ? ` rx="${n(r)}"` : ''}${extra}/>`;
    }
    case 'ellipse':
      return `<ellipse ${t} cx="${n(shape.width / 2)}" cy="${n(shape.height / 2)}" rx="${n(shape.width / 2)}" ry="${n(shape.height / 2)}"${extra}/>`;
    case 'polygon':
      return `<polygon ${t} points="${polygonPoints(shape).map((p) => `${n(p.x)},${n(p.y)}`).join(' ')}"${extra}/>`;
    case 'path':
      return `<path ${t} d="${pathData(shape.subpaths, n)}" clip-rule="${shape.fillRule ?? 'evenodd'}"${extra}/>`;
    default:
      return `<rect ${t} width="${n(shape.width)}" height="${n(shape.height)}"${extra}/>`;
  }
}

function shapeSvg(shape: Shape, ctx: Ctx, part: Part = 'all'): string {
  const { doc } = ctx;
  const t = `transform="matrix(${shape.transform.map(n).join(' ')})"`;
  const stroke = part !== 'fill' && shape.stroke && shape.strokeWidth > 0 ? ` stroke="${shape.stroke}" stroke-width="${n(localStroke(shape))}" stroke-linejoin="miter"` : '';
  if (part === 'stroke' && !stroke) return '';
  const fill = part === 'stroke' ? 'none' : fillAttr(shape, ctx);
  const fx = effectAttrs(shape, ctx);
  switch (shape.kind) {
    case 'rectangle':
    case 'ellipse':
    case 'polygon':
      return geometry(shape, ` fill="${fill}"${stroke}${fx}`);
    case 'path': {
      const closed = shape.subpaths.some((s) => s.closed);
      const f = closed && fill !== 'none' ? `fill="${fill}" fill-rule="${shape.fillRule ?? 'evenodd'}"` : 'fill="none"';
      return `<path ${t} d="${pathData(shape.subpaths, n)}" ${f}${stroke}${fx}/>`;
    }
    case 'image': {
      const asset = doc.assets[shape.assetId];
      if (!asset) return '';
      const frame = stroke ? `<rect ${t} width="${n(shape.width)}" height="${n(shape.height)}" fill="none"${stroke}${fx}/>` : '';
      if (part === 'stroke') return frame;
      const href = `data:${asset.mime};base64,${asset.data}`;
      let img: string;
      if (shape.crop) {
        // Recorte: un <svg> anidado muestra solo esa parte de la imagen.
        const c = shape.crop;
        const vb = `${n(c.x * asset.widthPx)} ${n(c.y * asset.heightPx)} ${n(c.width * asset.widthPx)} ${n(c.height * asset.heightPx)}`;
        img = `<g ${t}${fx}><svg width="${n(shape.width)}" height="${n(shape.height)}" viewBox="${vb}" preserveAspectRatio="none"><image width="${asset.widthPx}" height="${asset.heightPx}" href="${href}" xlink:href="${href}"/></svg></g>`;
      } else {
        img = `<image ${t} width="${n(shape.width)}" height="${n(shape.height)}" preserveAspectRatio="none" href="${href}" xlink:href="${href}"${fx}/>`;
      }
      return part === 'all' ? img + frame : img;
    }
    case 'text': {
      const layout = layoutText(shape);
      const anchor = shape.align === 'center' ? 'middle' : shape.align === 'right' ? 'end' : 'start';
      const x = shape.align === 'center' ? shape.width / 2 : shape.align === 'right' ? shape.width : 0;
      const lines = layout.lines
        .map((line, i) => (line.trimEnd() ? `<tspan x="${n(x)}" y="${n(i * layout.lineHeight + layout.lineHeight / 2)}">${esc(line.trimEnd())}</tspan>` : ''))
        .join('');
      const style = [
        `font-family="${esc(shape.fontFamily)}"`,
        `font-size="${n(layout.size)}"`,
        shape.bold ? 'font-weight="bold"' : '',
        shape.italic ? 'font-style="italic"' : '',
        `text-anchor="${anchor}"`,
        'dominant-baseline="central"',
        'xml:space="preserve"',
      ]
        .filter(Boolean)
        .join(' ');
      // Como en la app: el contorno va detrás del relleno (paint-order).
      const textStroke = shape.stroke && shape.strokeWidth > 0 ? ` stroke="${shape.stroke}" stroke-width="${n(localStroke(shape) * 2)}" stroke-linejoin="round" paint-order="stroke"` : '';
      if (layout.glyphs) {
        // Texto en arco: cada letra en su lugar, girada (se abre igual en cualquier programa).
        const arcStyle = style.replace(/text-anchor="\w+"/, 'text-anchor="middle"');
        const letters = layout.glyphs.map((g) => `<text transform="translate(${n(g.x)} ${n(g.y)}) rotate(${n((g.rotation * 180) / Math.PI)})">${esc(g.ch)}</text>`).join('');
        return `<g ${t} ${arcStyle} fill="${fill}"${textStroke}${fx}>${letters}</g>`;
      }
      return `<text ${t} ${style} fill="${fill}"${textStroke}${fx}>${lines}</text>`;
    }
  }
}

/** Número corto (sin decimales de más). */
const n = (v: number) => String(Math.round(v * 10_000) / 10_000);

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

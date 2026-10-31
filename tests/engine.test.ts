/** Pruebas del motor (sin interfaz): npm test */
import test from 'node:test';
import assert from 'node:assert/strict';
import { multiply, invert, apply, rotateAbout, scaleAbout, translate, rotationOf, isMirrored, IDENTITY } from '../src/engine/matrix';
import { createShape, shapeBounds, hitTest, insideRect, transformShape, unionBounds, type TextShape } from '../src/engine/shapes';
import { History } from '../src/engine/history';
import { caretSegment, createText, indexAtLocalPoint, layoutText, LINE_HEIGHT, lineAndColumn, PT_TO_MM, relayoutText, selectionQuads, setTextMeasurer, visualScale } from '../src/engine/text';
import { handleAt, scaleAnchor } from '../src/engine/selection';
import { createDocument } from '../src/engine/document';
import { FileFormatError, parseDocument, serializeDocument } from '../src/engine/file-format';
import { exportSvg } from '../src/engine/svg-export';
import { exportLayout, exportTooLarge } from '../src/engine/export';
import { crc32, setJpegDpi, setPngDpi } from '../src/engine/raster-meta';
import { buildPdf, buildPdfPages } from '../src/engine/pdf';
import { preflight } from '../src/engine/preflight';
import { booleanOp, DIFFERENCE, INTERSECTION, offsetRegion, ringArea, UNION } from '../src/engine/boolean';
import { contour, intersect, ShapeOpError, trim, weld } from '../src/engine/shape-ops';
import { alignOffsets, distributeOffsets, expandIds, unitsOf, visibleBounds } from '../src/engine/arrange';
import { snapPoint, snapRect, snapTargets } from '../src/engine/snap';
import { cropImage, uncropImage } from '../src/engine/crop';
import { buildObjectTree, objectName } from '../src/engine/object-tree';
import { effectiveDpi } from '../src/engine/preflight';
import { cmykToRgb, parseHex, rgbToCmyk, toHex } from '../src/engine/color';
import { allPages, pageDocument, pruneAssets, withPages } from '../src/engine/document';
import { wrapLine } from '../src/engine/text';
import { despeckle, traceImage, traceMask } from '../src/engine/trace';
import { importPdfPage, parseFontName } from '../src/engine/pdf-import';
import { applyRow, coverCrop, fieldsInDocument, fileNameFor, fillText, matchPhoto, parseTable, unknownFields } from '../src/engine/merge';
import { addNodesAfter, breakAt, closeSubpaths, deleteNodes, fitFreehand, moveHandle, moveNodes, nodeCount, normalizePath, segmentAt, setNodeType, setSegmentKind, toPath } from '../src/engine/path';
const near = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);
const style = { fill: '#ff0000', stroke: '#000000', strokeWidth: 0.2 };
/** Igual que deepEqual, pero los números pueden diferir en `eps`. */
function nearDeep(a: unknown, b: unknown, eps: number, path = '$'): void {
  if (typeof a === 'number' && typeof b === 'number') return assert.ok(Math.abs(a - b) <= eps, `${path}: ${a} ≈ ${b}`);
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) nearDeep((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], eps, `${path}.${k}`);
    return;
  }
  assert.equal(a, b, path);
}

test('matrices', () => {
  const m = multiply(rotateAbout(37, { x: 5, y: 9 }), scaleAbout(2, 3, { x: 1, y: 1 }));
  const p = apply(multiply(invert(m), m), { x: 3, y: -4 });
  near(p.x, 3); near(p.y, -4);
  const r = apply(rotateAbout(90, { x: 0, y: 0 }), { x: 1, y: 0 });
  near(r.x, 0); near(r.y, 1);
  near(rotationOf(rotateAbout(30, { x: 2, y: 2 })), 30);
  assert.equal(isMirrored(scaleAbout(-1, 1, { x: 0, y: 0 })), true);
  assert.equal(isMirrored(IDENTITY), false);
  assert.throws(() => invert([0, 0, 0, 0, 1, 1]));
});

test('cajas y transformaciones', () => {
  const r = createShape('rectangle', { x: 10, y: 20, width: 40, height: 20 }, style);
  assert.deepEqual(shapeBounds(r), { x: 10, y: 20, width: 40, height: 20 });
  const rot = transformShape(r, rotateAbout(90, { x: 30, y: 30 }));
  const b = shapeBounds(rot);
  near(b.width, 20); near(b.height, 40); near(b.x, 20); near(b.y, 10);
  const e = createShape('ellipse', { x: 0, y: 0, width: 20, height: 10 }, style);
  const eb = shapeBounds(transformShape(e, rotateAbout(90, { x: 10, y: 5 })));
  near(eb.width, 10); near(eb.height, 20);
  const moved = transformShape(r, translate(5, -5));
  assert.deepEqual(shapeBounds(moved), { x: 15, y: 15, width: 40, height: 20 });
  assert.deepEqual(unionBounds([shapeBounds(r), shapeBounds(moved)]), { x: 10, y: 15, width: 45, height: 25 });
  assert.equal(unionBounds([]), null);
  const p = createShape('polygon', { x: 0, y: 0, width: 10, height: 10 }, style, { sides: 2 });
  assert.equal(p.kind === "polygon" ? p.sides : 0, 3);
});

test('detección de clic', () => {
  const r = createShape('rectangle', { x: 0, y: 0, width: 10, height: 10 }, style);
  assert.ok(hitTest(r, { x: 5, y: 5 }, 0.1));
  assert.ok(!hitTest(r, { x: 15, y: 5 }, 0.1));
  const hollow = { ...r, fill: null };
  assert.ok(!hitTest(hollow, { x: 5, y: 5 }, 0.1), 'sin relleno: el interior no cuenta');
  assert.ok(hitTest(hollow, { x: 10.05, y: 5 }, 0.1), 'pero sí el borde');
  const e = createShape('ellipse', { x: 0, y: 0, width: 10, height: 10 }, style);
  assert.ok(!hitTest(e, { x: 0.5, y: 0.5 }, 0.1), 'la esquina de la caja no es la elipse');
  const rot = transformShape(r, rotateAbout(45, { x: 5, y: 5 }));
  assert.ok(hitTest(rot, { x: 5, y: -1.5 }, 0.1));
  assert.ok(!hitTest(rot, { x: 0.3, y: 0.3 }, 0.1));
  assert.ok(insideRect(r, { x: -1, y: -1, width: 12, height: 12 }));
  assert.ok(!insideRect(r, { x: 1, y: -1, width: 12, height: 12 }));
  const flat = { ...r, transform: [0, 0, 0, 0, 0, 0] as const };
  assert.equal(hitTest(flat, { x: 0, y: 0 }, 1), false);
});

test('historial', () => {
  const h = new History(3);
  h.record('a', 'uno'); h.record('b', 'dos');
  assert.equal(h.undoLabel, 'dos');
  assert.deepEqual(h.undo('c'), { snapshot: 'b', label: 'dos' });
  assert.equal(h.canRedo, true);
  assert.deepEqual(h.redo('b'), { snapshot: 'c', label: 'dos' });
  h.undo('c'); h.record('x', 'nuevo');
  assert.equal(h.canRedo, false, 'un cambio nuevo borra lo que se podía rehacer');
  h.record('y', '4'); h.record('z', '5');
  let n = 0; while (h.undo('q')) n++;
  assert.equal(n, 3, 'respeta el límite');
});

test('tiradores', () => {
  const box = { x: 100, y: 100, width: 200, height: 100 };
  assert.equal(handleAt({ x: 94, y: 94 }, box, 'scale'), 'nw');
  assert.equal(handleAt({ x: 306, y: 150 }, box, 'scale'), 'e');
  assert.equal(handleAt({ x: 200, y: 150 }, box, 'scale'), null);
  assert.equal(handleAt({ x: 310, y: 210 }, box, 'rotate'), 'rot-se');
  assert.deepEqual(scaleAnchor('nw', box), { x: 300, y: 200 });
  assert.deepEqual(scaleAnchor('s', box), { x: 200, y: 100 });
});

test('texto: medida, anclaje y cursor', () => {
  // Medición de pruebas: 0.5 em por letra (en la app mide Canvas con la fuente real).
  setTextMeasurer((text) => text.length * 0.5);
  const style = { fill: '#000000', stroke: null, strokeWidth: 0.2, fontFamily: 'Arial', fontSizePt: 72, bold: false, italic: false, align: 'left' as const };
  const size = 72 * PT_TO_MM; // 25.4 mm
  const t = createText({ x: 100, y: 50 }, style, 'Hola\nGeneración');
  near(t.width, 10 * 0.5 * size);
  near(t.height, 2 * size * LINE_HEIGHT);
  near(t.transform[4], 100);
  assert.deepEqual(lineAndColumn(t.text, 7), { line: 1, column: 2 });
  // Cursor al final de la primera línea: x = 4 letras
  near(caretSegment(t, 4).top.x, 100 + 4 * 0.5 * size);
  // Clic cerca de la 3.ª letra de la 2.ª línea
  assert.equal(indexAtLocalPoint(t, { x: 2.1 * 0.5 * size, y: size * 1.5 }), 7);
  // Centrado: al crecer el texto, el centro no se mueve
  const c = createText({ x: 100, y: 50 }, { ...style, align: 'center' }, 'ab');
  const centerBefore = c.transform[4] + c.width / 2;
  const grown = relayoutText({ ...c, text: 'abcdef' });
  near(grown.transform[4] + grown.width / 2, centerBefore);
  // Sin cambios devuelve el mismo objeto (el historial no ve cambios falsos)
  assert.equal(relayoutText(grown), grown);
  // Selección de texto en dos líneas → dos rectángulos
  assert.equal(selectionQuads(t, 2, 8).length, 2);
  assert.equal(selectionQuads(t, 3, 3).length, 0);
  // Se elige por su caja, aunque se haga clic entre letras
  assert.ok(hitTest(t, { x: 101, y: 50 + size }, 0.1));
  assert.ok(!hitTest(t, { x: 99, y: 40 }, 0.1));
  // Escalar el objeto agranda la letra que se ve
  near(visualScale(transformShape(t, scaleAbout(2, 2, { x: 0, y: 0 }))), 2);
  near(shapeBounds(t).width, t.width);
});

test('archivo .trz: guardar y abrir sin perder nada', () => {
  setTextMeasurer((text) => text.length * 0.5);
  const doc = createDocument('Placa Ana');
  const rect = createShape('rectangle', { x: 10, y: 10, width: 50, height: 30 }, style, { cornerRadius: 3 });
  const text = createText({ x: 20, y: 80 }, { fill: '#C9A227', stroke: null, strokeWidth: 0.2, fontFamily: 'Great Vibes', fontSizePt: 36, bold: false, italic: true, align: 'center' }, 'Generación\n2026');
  const asset = { id: 'a1', name: 'foto.png', mime: 'image/png', data: 'iVBORw0KGgo=', widthPx: 1200, heightPx: 900 };
  const unused = { ...asset, id: 'a2' };
  const image = { id: 'img1', kind: 'image' as const, assetId: 'a1', width: 100, height: 75, transform: rotateAbout(10, { x: 50, y: 50 }), fill: null, stroke: null, strokeWidth: 0.2 };
  const full = { ...doc, unit: 'mm' as const, shapes: [rect, text, image], assets: { a1: asset, a2: unused } };
  const saved = serializeDocument(full, '0.4.0');
  const { document: back, warnings } = parseDocument(saved);
  assert.deepEqual(warnings, []);
  assert.deepEqual(back.shapes, full.shapes);
  assert.deepEqual(Object.keys(back.assets), ['a1'], 'las imágenes que nadie usa no se guardan');
  assert.equal(back.unit, 'mm');
  assert.equal(back.name, 'Placa Ana');
});

test('archivo .trz: rechaza o limpia lo inválido', () => {
  assert.throws(() => parseDocument('no es json'), FileFormatError);
  assert.throws(() => parseDocument('{"format":"otro","document":{}}'), FileFormatError);
  assert.throws(() => parseDocument('{"format":"trazo","version":99,"document":{}}'), /más nueva/);
  const bad = JSON.stringify({
    format: 'trazo',
    version: 1,
    document: {
      name: 'X',
      page: { widthMm: -5, heightMm: 'abc', bleedMm: 3 },
      assets: { a: { id: 'a', mime: 'text/html', data: 'PHNjcmlwdD4=' } },
      shapes: [
        { id: 'ok', kind: 'ellipse', width: 10, height: 10, transform: [1, 0, 0, 1, 0, 0], fill: '#FF0000', stroke: 'javascript:alert(1)', strokeWidth: 1 },
        { id: 'flat', kind: 'rectangle', width: 10, height: 10, transform: [0, 0, 0, 0, 0, 0] },
        { id: 'img', kind: 'image', assetId: 'a', width: 10, height: 10, transform: [1, 0, 0, 1, 0, 0] },
        { id: 'ok', kind: 'ellipse', width: 1, height: 1, transform: [1, 0, 0, 1, 0, 0] },
        { id: 'z', kind: 'virus' },
      ],
    },
  });
  const { document, warnings } = parseDocument(bad);
  assert.equal(document.shapes.length, 1);
  assert.equal(document.shapes[0]!.stroke, null, 'colores raros se descartan');
  assert.equal(document.page.widthMm, 1, 'medidas fuera de rango se ajustan');
  assert.equal(document.page.heightMm, 250);
  assert.deepEqual(document.assets, {}, 'solo imágenes de tipos permitidos');
  assert.equal(warnings.length, 2);
});

test('exportar SVG', () => {
  setTextMeasurer((text) => text.length * 0.5);
  const doc = createDocument('Placa <Ana> & "Luis"');
  const rect = createShape('rectangle', { x: 10, y: 20, width: 50, height: 30 }, { fill: '#C9A227', stroke: '#000000', strokeWidth: 0.5 }, { cornerRadius: 2 });
  const text = createText({ x: 100, y: 50 }, { fill: '#000000', stroke: null, strokeWidth: 0.2, fontFamily: 'Arial', fontSizePt: 24, bold: true, italic: false, align: 'center' }, 'Ana & <Luis>');
  const svg = exportSvg({ ...doc, shapes: [transformShape(rect, scaleAbout(2, 2, { x: 0, y: 0 })), text] }, { withBleed: true });
  assert.match(svg, /width="206mm" height="256mm" viewBox="-3 -3 206 256"/);
  assert.match(svg, /<rect transform="matrix\(2 0 0 2 20 40\)" width="50" height="30" rx="2" fill="#C9A227" stroke="#000000" stroke-width="0.25"/, 'el contorno no se duplica al escalar');
  assert.match(svg, /text-anchor="middle"/);
  assert.match(svg, /font-weight="bold"/);
  assert.match(svg, /Ana &amp; &lt;Luis&gt;/);
  assert.match(svg, /<title>Placa &lt;Ana&gt; &amp; &quot;Luis&quot;<\/title>/);
});

test('exportar: medidas, ppp en PNG/JPG, PDF y revisión previa', () => {
  const doc = createDocument('Placa');
  const opts = { dpi: 300, bleed: true, mirror: true, cropMarks: false, background: 'white' as const };
  const layout = exportLayout(doc, opts);
  assert.equal(layout.widthPx, 2433); // (200 + 2·3) mm a 300 ppp
  assert.equal(layout.heightPx, 3024);
  assert.equal(exportLayout(doc, { ...opts, cropMarks: true }).widthMm, 200 + 2 * 9);
  assert.match(exportTooLarge(exportLayout(doc, { ...opts, dpi: 2400 })) ?? '', /demasiado grande/);

  // PNG mínimo (1×1) → se inserta pHYs después de IHDR, con CRC correcto
  const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
  const withDpi = setPngDpi(png, 300);
  const view = new DataView(withDpi.buffer);
  assert.equal(String.fromCharCode(...withDpi.subarray(37, 41)), 'pHYs');
  assert.equal(view.getUint32(41), 11811); // 300 ppp = 11 811 px/m
  assert.equal(view.getUint32(50), crc32(withDpi.subarray(37, 50)));
  assert.equal(setPngDpi(withDpi, 300).length, withDpi.length, 'no duplica el bloque');

  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const jpg = setJpegDpi(jpeg, 300);
  assert.deepEqual([...jpg.subarray(13, 18)], [1, 1, 44, 1, 44]);

  // PDF: cabecera, tamaño en puntos y tabla xref apuntando a cada objeto
  const pdf = buildPdf({ title: 'Placa Ñandú', widthMm: 206, heightMm: 256, imageWidth: 1, imageHeight: 1, deflatedRgb: new Uint8Array([120, 156, 99, 0, 0, 0, 1, 0, 1]) });
  const text = new TextDecoder('latin1').decode(pdf);
  assert.ok(text.startsWith('%PDF-1.4'));
  assert.match(text, /\/MediaBox \[0 0 583\.937 725\.669\]/);
  const xrefAt = Number(/startxref\n(\d+)/.exec(text)![1]);
  assert.ok(text.slice(xrefAt).startsWith('xref'));
  const offsets = [...text.slice(xrefAt).matchAll(/(\d{10}) 00000 n/g)].map((m) => Number(m[1]));
  offsets.forEach((o, i) => assert.ok(text.slice(o).startsWith(`${i + 1} 0 obj`)));

  // Revisión previa
  const style = { fill: '#0B1F4B', stroke: null, strokeWidth: 0 };
  const fondoJusto = createShape('rectangle', { x: 0, y: 0, width: 200, height: 250 }, style);
  const fondoBien = createShape('rectangle', { x: -3, y: -3, width: 206, height: 256 }, style);
  const fuera = createShape('ellipse', { x: 300, y: 300, width: 10, height: 10 }, style);
  const asset = { id: 'a', name: 'foto.jpg', mime: 'image/jpeg', data: 'AA==', widthPx: 500, heightPx: 500 };
  const foto = { id: 'f', kind: 'image' as const, assetId: 'a', width: 100, height: 100, transform: [1, 0, 0, 1, 50, 50] as const, fill: null, stroke: null, strokeWidth: 0 };
  const issues = preflight({ ...doc, shapes: [fondoJusto, fondoBien, fuera, foto], assets: { a: asset } });
  assert.equal(issues[0]!.level, 'error', 'los errores van primero');
  assert.match(issues[0]!.message, /quedará a 127 ppp/);
  assert.ok(issues.some((i) => i.shapeId === fondoJusto.id && /sangrado/.test(i.message)));
  assert.ok(!issues.some((i) => i.shapeId === fondoBien.id), 'un fondo que cubre el sangrado está bien');
  assert.ok(issues.some((i) => i.shapeId === fuera.id && i.level === 'info'));
  assert.equal(preflight({ ...doc, shapes: [fondoBien] }).length, 0);
});

test('curvas: convertir, cajas exactas, clic y nodos', () => {
  const style = { fill: '#FF0000', stroke: '#000000', strokeWidth: 0.2 };
  // Elipse → curva: misma caja (4 nodos simétricos)
  const ellipse = transformShape(createShape('ellipse', { x: 10, y: 20, width: 40, height: 20 }, style), rotateAbout(30, { x: 30, y: 30 }));
  const curve = toPath(ellipse)!;
  assert.equal(curve.kind, 'path');
  assert.equal(curve.id, ellipse.id, 'conserva el id (deshacer, selección)');
  assert.equal(nodeCount(curve), 4);
  const a = shapeBounds(ellipse);
  const b = shapeBounds(curve);
  near(a.x, b.x, 0.05); near(a.y, b.y, 0.05); near(a.width, b.width, 0.1); near(a.height, b.height, 0.1);
  // Rectángulo redondeado → 8 nodos; sin redondeo → 4 esquinas
  assert.equal(nodeCount(toPath(createShape('rectangle', { x: 0, y: 0, width: 50, height: 30 }, style, { cornerRadius: 4 }))!), 8);
  const square = toPath(createShape('rectangle', { x: 0, y: 0, width: 10, height: 10 }, style))!;
  assert.equal(nodeCount(square), 4);
  // Clic: dentro (relleno), en el borde y fuera
  assert.ok(hitTest(square, { x: 5, y: 5 }, 0.1));
  assert.ok(!hitTest(square, { x: 15, y: 5 }, 0.1));
  // Mover un nodo (esquina inferior derecha) 5 mm a la derecha
  const moved = normalizePath(moveNodes(square, [{ sub: 0, node: 2 }], { x: 5, y: 0 }));
  assert.deepEqual(shapeBounds(moved), { x: 0, y: 0, width: 15, height: 10 });
  // Añadir un nodo a la mitad de un tramo no cambia la figura
  const more = addNodesAfter(square, [{ sub: 0, node: 0 }]);
  assert.equal(nodeCount(more), 5);
  assert.deepEqual(shapeBounds(more), shapeBounds(square));
  // Tramo a curva y nodo suave crean manijas; a línea las quita
  const curved = setSegmentKind(square, [{ sub: 0, node: 0 }], 'curve');
  assert.ok(curved.subpaths[0]!.nodes[0]!.out && curved.subpaths[0]!.nodes[1]!.in);
  const smooth = setNodeType(square, [{ sub: 0, node: 1 }], 'symmetric');
  const n1 = smooth.subpaths[0]!.nodes[1]!;
  near(Math.hypot(n1.in!.x - n1.x, n1.in!.y - n1.y), Math.hypot(n1.out!.x - n1.x, n1.out!.y - n1.y));
  assert.equal(setSegmentKind(curved, [{ sub: 0, node: 0 }], 'line').subpaths[0]!.nodes[0]!.out, null);
  // Manija de un nodo simétrico: la opuesta la sigue en espejo
  const mh = moveHandle(smooth, { sub: 0, node: 1 }, 'out', { x: n1.x + 4, y: n1.y + 3 });
  const m1 = mh.subpaths[0]!.nodes[1]!;
  near(m1.in!.x, n1.x - 4); near(m1.in!.y, n1.y - 3);
  // Borrar nodos: queda un triángulo; borrando 3 de 4 desaparece
  assert.equal(nodeCount(deleteNodes(square, [{ sub: 0, node: 0 }])!), 3);
  assert.equal(deleteNodes(square, [{ sub: 0, node: 0 }, { sub: 0, node: 1 }, { sub: 0, node: 2 }]), null);
  // Separar una curva cerrada la abre; cerrar la vuelve a cerrar
  const open = breakAt(square, { sub: 0, node: 0 });
  assert.equal(open.subpaths[0]!.closed, false);
  assert.equal(nodeCount(open), 5);
  assert.equal(closeSubpaths(open, [{ sub: 0, node: 0 }]).subpaths[0]!.closed, true);
  // Una curva abierta no se rellena al hacer clic dentro
  assert.ok(!hitTest(open, { x: 5, y: 5 }, 0.1));
  // Doble clic sobre la línea: encuentra el tramo
  const at = segmentAt(square, { x: 5, y: 0.05 }, 0.5);
  assert.equal(at?.index, 0);
  near(at!.t, 0.5, 0.05);
  // Mano alzada: 200 puntos de una línea casi recta → pocos nodos
  const raw = Array.from({ length: 200 }, (_, i) => ({ x: i * 0.5, y: Math.sin(i / 200) * 0.01 }));
  assert.ok(fitFreehand(raw, 0.3, false).nodes.length <= 3);
  // Círculo a mano alzada → curva cerrada con nodos suaves
  const circle = Array.from({ length: 120 }, (_, i) => ({ x: 50 + 20 * Math.cos((i / 120) * Math.PI * 2), y: 50 + 20 * Math.sin((i / 120) * Math.PI * 2) }));
  const fit = fitFreehand(circle, 0.3, true);
  assert.ok(fit.closed && fit.nodes.length >= 6 && fit.nodes.length <= 40 && fit.nodes.every((n) => n.type === 'smooth'));
  // Guardar y abrir conserva la curva; SVG con "d"
  const doc = { ...createDocument('c'), shapes: [curve, open] };
  // Los nodos de las curvas se guardan con millonésimas de mm (sin pérdida real).
  nearDeep(parseDocument(serializeDocument(doc)).document.shapes, doc.shapes, 1e-6);
  const svg = exportSvg(doc);
  assert.match(svg, /<path transform="matrix\([^"]+\)" d="M[\d.-]+ [\d.-]+ C/);
  assert.match(svg, /fill-rule="evenodd"/);
});

test('operaciones: soldar, recortar, intersectar y contorno', () => {
  const sq = (x: number, y: number, w: number, h: number) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
  const R = (rings: { x: number; y: number }[][]) => ({ rings, rule: 'evenodd' as const });
  const area = (rings: { x: number; y: number }[][]) => Math.abs(rings.reduce((t, r) => t + ringArea(r), 0));
  near(area(booleanOp([R([sq(0, 0, 10, 10)]), R([sq(5, 0, 10, 10)])], UNION)), 150, 1e-6);
  near(area(booleanOp([R([sq(0, 0, 10, 10)]), R([sq(5, 0, 10, 10)])], INTERSECTION)), 50, 1e-6);
  near(area(booleanOp([R([sq(0, 0, 10, 10)]), R([sq(5, 0, 10, 10)])], DIFFERENCE)), 50, 1e-6);
  // Pegados por un lado → un solo anillo; idénticos restados → nada
  assert.equal(booleanOp([R([sq(0, 0, 10, 10)]), R([sq(10, 0, 10, 10)])], UNION).length, 1);
  assert.equal(booleanOp([R([sq(0, 0, 10, 10)]), R([sq(0, 0, 10, 10)])], DIFFERENCE).length, 0);
  // Con hueco: dos anillos
  assert.equal(booleanOp([R([sq(0, 0, 10, 10)]), R([sq(3, 3, 4, 4)])], DIFFERENCE).length, 2);
  // Contorno de un cuadrado 10×10 a 2 mm: 100 + 4·20 + π·4 (esquinas redondas), interior: 6×6
  near(area(offsetRegion(R([sq(0, 0, 10, 10)]), 2, 'outside')), 180 + Math.PI * 4, 0.1);
  near(area(offsetRegion(R([sq(0, 0, 10, 10)]), 2, 'inside')), 36, 1e-6);

  // Con figuras de Trazo; el resultado se reajusta a pocas curvas
  const st = { fill: '#FF0000', stroke: null, strokeWidth: 0.2 };
  const c = createShape('ellipse', { x: 0, y: 0, width: 40, height: 40 }, st);
  const q = createShape('rectangle', { x: 20, y: 10, width: 40, height: 20 }, st);
  const w = weld([c, q])!;
  assert.equal(w.subpaths.length, 1);
  assert.ok(nodeCount(w) <= 20, `pocos nodos (${nodeCount(w)})`);
  const b = shapeBounds(w);
  near(b.x, 0, 0.02); near(b.width, 60, 0.02); near(b.height, 40, 0.02);
  const t = trim([c, q])!;
  assert.equal(t.id, c.id, 'recortar conserva el objeto de atrás');
  near(shapeBounds(t).width, 20 + Math.sqrt(300), 0.05); // el círculo llega hasta y = 10, donde x = 20 + √(20² − 10²)
  assert.ok(intersect([c, q]));
  assert.throws(() => weld([c]), ShapeOpError);
  assert.throws(() => weld([c, { ...q, kind: 'image', assetId: 'x' } as never]), /imágenes/);
  const ring = contour([c], 3, 'outside', '#FFFFFF')!;
  near(shapeBounds(ring).width, 46, 0.05);
  assert.equal(ring.fill, '#FFFFFF');
  assert.equal(contour([c], 25, 'inside', null), null, 'un contorno interior más grueso que la figura no deja nada');
});

test('placas en serie: tabla, campos, foto y nombres de archivo', () => {
  setTextMeasurer((text) => text.length * 0.5);
  // Pegado desde Excel (tabuladores), con fila vacía y comillas
  const excel = 'Nombre\tGeneración\tFoto\nAna Sofía Pérez\t2023-2026\tana.jpg\n\n"Luis ""Lucho"" Gómez"\t2023-2026\tLUIS.JPG\n';
  const t = parseTable(excel);
  assert.deepEqual(t.columns, ['Nombre', 'Generación', 'Foto']);
  assert.equal(t.rows.length, 2);
  assert.equal(t.rows[1]![0], 'Luis "Lucho" Gómez');
  // CSV con punto y coma (Excel en español) y títulos repetidos o vacíos
  const csv = parseTable('﻿Nombre;Nombre;\r\nA;B;C\r\n');
  assert.deepEqual(csv.columns, ['Nombre', 'Nombre 2', 'Columna 3']);
  assert.deepEqual(csv.rows, [['A', 'B', 'C']]);
  assert.deepEqual(parseTable('a,b\n1,"x, y"').rows, [['1', 'x, y']]);

  const merge = { columns: t.columns, rows: t.rows, fileName: '{{#}} - {{nombre}}' };
  // Campos sin importar mayúsculas ni acentos
  assert.equal(fillText('Felicidades {{ Nombre }}, generación {{generacion}} {{Escuela}}', merge, t.rows[0]!), 'Felicidades Ana Sofía Pérez, generación 2023-2026 {{Escuela}}');
  assert.equal(fileNameFor(merge, t.rows[1]!, 1), '002 - Luis Lucho Gómez', 'sin comillas ni caracteres prohibidos');
  assert.equal(matchPhoto('luis.jpg', ['ana.jpg', 'LUIS.JPG']), 'LUIS.JPG');
  assert.equal(matchPhoto('ana', ['Ana.png']), 'Ana.png', 'sin extensión también');
  assert.equal(matchPhoto('pedro', ['ana.jpg']), null);

  // Foto que cubre el marco: horizontal en marco vertical → se recortan los lados
  const frame = { id: 'f', kind: 'image' as const, assetId: 'x', width: 30, height: 40, transform: [1, 0, 0, 1, 0, 0] as const, fill: null, stroke: null, strokeWidth: 0, field: 'Foto' };
  const c1 = coverCrop(frame, { widthPx: 4000, heightPx: 3000 });
  near(c1.width, (30 / 40) / (4000 / 3000)); near(c1.x, (1 - c1.width) / 2); near(c1.height, 1);
  const c2 = coverCrop(frame, { widthPx: 1000, heightPx: 3000 });
  near(c2.width, 1); near(c2.height, (1000 / 3000) / (30 / 40)); assert.ok(c2.y < (1 - c2.height) / 2, 'en fotos altas se recorta más abajo (caras arriba)');

  // Aplicar una fila: textos y foto
  const name = createText({ x: 100, y: 50 }, { fill: '#000000', stroke: null, strokeWidth: 0.2, fontFamily: 'Arial', fontSizePt: 36, bold: false, italic: false, align: 'center' }, '{{Nombre}}');
  const fixed = createText({ x: 100, y: 100 }, { fill: '#000000', stroke: null, strokeWidth: 0.2, fontFamily: 'Arial', fontSizePt: 12, bold: false, italic: false, align: 'left' }, 'Sin campos');
  const doc = { ...createDocument('P'), shapes: [frame, name, fixed], assets: { x: { id: 'x', name: 'ejemplo.jpg', mime: 'image/jpeg', data: 'AA==', widthPx: 300, heightPx: 400 } }, merge };
  assert.deepEqual(fieldsInDocument(doc), { text: ['Nombre'], photos: ['Foto'] });
  assert.deepEqual(unknownFields({ ...doc, shapes: [...doc.shapes, { ...fixed, text: '{{Escuela}}' }] }), ['Escuela']);
  const photo = { id: 'p1', name: 'ana.jpg', mime: 'image/jpeg', data: 'AA==', widthPx: 4000, heightPx: 3000 };
  const r = applyRow(doc, t.rows[0]!, (v) => (v === 'ana.jpg' ? photo : null));
  const filled = r.doc.shapes[1] as typeof name;
  assert.equal(filled.text, 'Ana Sofía Pérez');
  near(filled.transform[4] + filled.width / 2, name.transform[4] + name.width / 2, 1e-6); // centrado: el centro no se mueve
  assert.equal(r.doc.shapes[2], fixed, 'lo que no tiene campos no cambia');
  const img = r.doc.shapes[0] as typeof frame & { crop?: object };
  assert.equal(img.assetId, 'p1');
  assert.ok(img.crop);
  assert.ok(r.doc.assets.p1);
  assert.deepEqual(applyRow(doc, t.rows[1]!).missingPhotos, ['LUIS.JPG']);
  assert.equal(doc.shapes[1], name, 'el diseño original no se modifica');

  // Ancho máximo: un nombre largo se achica para caber
  const long = relayoutText({ ...name, id: 'largo', text: 'María Guadalupe de los Ángeles Hernández', maxWidthMm: 80 });
  assert.ok(long.width <= 80 + 1e-9);
  near(layoutText(long).size / (36 * PT_TO_MM), 80 / layoutText({ ...long, maxWidthMm: undefined }).width, 1e-9);
  assert.equal(layoutText({ ...name, text: 'Ana', maxWidthMm: 80 }).size, 36 * PT_TO_MM, 'si cabe, no cambia');

  // Guardar y abrir conserva datos, ancho máximo, campo y recorte
  const saved = parseDocument(serializeDocument({ ...r.doc, shapes: [...r.doc.shapes, long] })).document;
  assert.deepEqual(saved.merge, merge);
  assert.equal((saved.shapes[3] as typeof long).maxWidthMm, 80);
  assert.deepEqual((saved.shapes[0] as typeof img).crop, img.crop);
  assert.equal((saved.shapes[0] as typeof img).field, 'Foto');

  // PDF de varias páginas: 3 páginas y referencias bien armadas
  const pdf = new TextDecoder('latin1').decode(buildPdfPages('Placas', [1, 2, 3].map(() => ({ widthMm: 206, heightMm: 256, imageWidth: 1, imageHeight: 1, data: new Uint8Array([255, 216, 255, 217]), filter: 'DCTDecode' as const }))));
  assert.match(pdf, /\/Count 3/);
  assert.equal((pdf.match(/\/Type \/Page /g) ?? []).length, 3);
  const xrefAt = Number(/startxref\n(\d+)/.exec(pdf)![1]);
  [...pdf.slice(xrefAt).matchAll(/(\d{10}) 00000 n/g)].forEach((m, i) => assert.ok(pdf.slice(Number(m[1])).startsWith(`${i + 1} 0 obj`)));
});

test('organizar: grupos, PowerClip, alinear, degradados y transparencia', () => {
  const r = (id: string, x: number, y: number, w: number, h: number, extra: object = {}) => ({ ...createShape('rectangle', { x, y, width: w, height: h }, style), id, ...extra });
  const a = r('a', 0, 0, 10, 10, { groupId: 'g' });
  const b = r('b', 20, 0, 10, 10, { groupId: 'g' });
  const circle = { ...createShape('ellipse', { x: 50, y: 50, width: 40, height: 40 }, style), id: 'c' };
  const photo = r('p', 30, 30, 100, 100, { clipId: 'c' }); // más grande que el círculo
  const loose = r('d', 150, 0, 10, 20);
  const shapes = [a, b, circle, photo, loose];
  // Elegir uno del grupo trae al grupo; elegir el contenido trae a su contenedor
  assert.deepEqual([...expandIds(shapes, ['a'])].sort(), ['a', 'b']);
  assert.deepEqual([...expandIds(shapes, ['p'])].sort(), ['c', 'p']);
  // Lo que se ve de un PowerClip es el contenedor (la foto sobrante no cuenta)
  assert.deepEqual(visibleBounds([circle, photo]), { x: 50, y: 50, width: 40, height: 40 });
  const units = unitsOf(shapes, shapes);
  assert.equal(units.length, 3);
  // Alinear a la izquierda: todos a x = 0
  const left = alignOffsets(units, 'left', { x: 0, y: 0, width: 200, height: 250 });
  assert.deepEqual(left.map((o) => o.dx), [0, -50, -150]);
  // Un solo objeto se centra en la página
  const one = alignOffsets([units[2]!], 'center-x', { x: 0, y: 0, width: 200, height: 250 });
  near(one[0]!.dx, 100 - 155);
  near(alignOffsets(units, 'page-center', { x: 0, y: 0, width: 200, height: 250 })[1]!.dy, 125 - 70);
  // Distribuir: mismo espacio entre las cajas (30 de ancho, 40 y 10 → huecos de 40)
  const dist = distributeOffsets(units, 'x');
  assert.deepEqual(dist.map((o) => o.dx), [0, 20, 0]);
  assert.deepEqual(distributeOffsets(units.slice(0, 2), 'x'), [{ dx: 0, dy: 0 }, { dx: 0, dy: 0 }], 'con dos no se distribuye');

  // SVG: PowerClip, degradado, opacidad y desvanecido
  const gold = { ...circle, gradient: { type: 'linear' as const, angle: 90, stops: [{ offset: 0, color: '#A67C00' }, { offset: 1, color: '#E9CF7A' }] }, opacity: 0.5 };
  const faded = { ...photo, fade: { angle: 270, from: 1, to: 0 } };
  const svg = exportSvg({ ...createDocument('P'), shapes: [gold, faded] });
  assert.match(svg, /<clipPath id="clip\d+" clipPathUnits="userSpaceOnUse"><ellipse /);
  assert.match(svg, /<g clip-path="url\(#clip\d+\)"><rect [^>]*mask="url\(#fade\d+\)"/);
  assert.match(svg, /<linearGradient id="grad\d+" gradientUnits="userSpaceOnUse" x1="20" y1="40" x2="20" y2="0"><stop offset="0" stop-color="#A67C00"\/>/, '90° = de abajo hacia arriba');
  assert.match(svg, /fill="url\(#grad\d+\)"[^>]*opacity="0.5"/);
  assert.equal((svg.match(/<ellipse /g) ?? []).length, 3, 'relleno, recorte y contorno');

  // Guardar y abrir conserva todo; limpia lo inválido
  const saved = parseDocument(serializeDocument({ ...createDocument('P'), shapes: [a, b, gold, faded] })).document;
  assert.equal(saved.shapes[0]!.groupId, 'g');
  assert.deepEqual(saved.shapes[2]!.gradient, gold.gradient);
  assert.equal(saved.shapes[2]!.opacity, 0.5);
  assert.equal(saved.shapes[3]!.clipId, 'c');
  assert.deepEqual(saved.shapes[3]!.fade, faded.fade);
  const raw = JSON.parse(serializeDocument({ ...createDocument('P'), shapes: [a, faded] }));
  raw.document.shapes[0].gradient = { type: 'linear', angle: 0, stops: [{ offset: 0, color: 'rojo' }] };
  raw.document.shapes[0].opacity = 7;
  const cleaned = parseDocument(JSON.stringify(raw)).document;
  assert.equal(cleaned.shapes[0]!.gradient, undefined, 'degradado inválido se descarta');
  assert.equal(cleaned.shapes[0]!.opacity, undefined);
  assert.equal(cleaned.shapes[1]!.clipId, undefined, 'contenedor que no existe');

  // Revisión previa: la foto que sobresale del círculo no avisa de "fuera de página"
  const page = createDocument('P');
  const bigPhoto = { ...r('ph', -50, -50, 400, 400, { clipId: 'c' }) };
  const issues = preflight({ ...page, shapes: [circle, bigPhoto] });
  assert.ok(!issues.some((i) => i.shapeId === 'ph'), JSON.stringify(issues));
});

test('guías, imán, recortar fotos y administrador de objetos', () => {
  const doc = createDocument('P'); // 200 × 250 mm, sangrado 3
  const box = (id: string, x: number, y: number, w: number, h: number, extra: object = {}) => ({ ...createShape('rectangle', { x, y, width: w, height: h }, style), id, ...extra });
  const a = box('a', 50, 50, 20, 10);
  const hiddenOne = box('h', 120, 120, 10, 10, { hidden: true });
  const withGuides = { ...doc, shapes: [a, hiddenOne], guides: [{ id: 'g1', axis: 'x' as const, pos: 100.4 }, { id: 'g2', axis: 'y' as const, pos: 30 }] };
  const all = { guides: true, objects: true, page: true };
  const t = snapTargets(withGuides, new Set(['moving']), all);
  assert.ok(t.x.some((x) => x.pos === 100.4 && x.source === 'guide'));
  assert.ok(t.x.some((x) => x.pos === -3 && x.source === 'page'), 'línea de sangrado');
  assert.ok(t.x.some((x) => x.pos === 60 && x.source === 'object'), 'centro del objeto');
  assert.ok(!t.x.some((x) => x.pos === 125), 'lo oculto no atrae');
  assert.ok(!snapTargets(withGuides, new Set(['a']), all).x.some((x) => x.pos === 60), 'no se pega a sí mismo');
  // Caja de 10 mm de ancho cerca de la guía: su borde izquierdo se pega (100.4)
  const r = snapRect({ x: 101, y: 200, width: 10, height: 10 }, t, 1);
  near(r.dx, -0.6, 1e-9);
  assert.equal(r.lines[0]!.source, 'guide');
  // Su centro (106) no está cerca de nada en y=200..210 → dy pegado a nada
  assert.equal(snapRect({ x: 0.5, y: 140, width: 10, height: 10 }, t, 1).dx, -0.5, 'borde de la página');
  assert.equal(snapRect({ x: 150, y: 140, width: 10, height: 13 }, t, 1).dy, 0);
  assert.deepEqual(snapPoint({ x: 99.9, y: 29.2 }, t, 1).point, { x: 100, y: 30 }, 'centro de la página (100) gana a la guía (100.4): está más cerca');
  assert.deepEqual(snapPoint({ x: 40, y: 40 }, t, 1).point, { x: 40, y: 40 });
  // Guías: se guardan y abren; las inválidas se descartan
  const raw = JSON.parse(serializeDocument(withGuides));
  raw.document.guides.push({ axis: 'z', pos: 1 }, { axis: 'y', pos: 'x' });
  assert.deepEqual(parseDocument(JSON.stringify(raw)).document.guides, withGuides.guides);
  // Oculto: no se exporta ni se revisa; nombre y candado se guardan
  const named = { ...a, name: 'Fondo azul', locked: true };
  const svg = exportSvg({ ...doc, shapes: [named, hiddenOne] });
  assert.equal((svg.match(/<rect /g) ?? []).length, 1);
  assert.ok(!preflight({ ...doc, shapes: [box('x', -50, -50, 30, 30, { hidden: true })] }).some((i) => i.shapeId === 'x'));
  const reopened = parseDocument(serializeDocument({ ...doc, shapes: [named, hiddenOne] })).document;
  assert.equal(reopened.shapes[0]!.name, 'Fondo azul');
  assert.equal(reopened.shapes[0]!.locked, true);
  assert.equal(reopened.shapes[1]!.hidden, true);

  // Recortar una foto: 100 × 80 mm en (10, 20), se conserva un área de 40 × 30
  const photo = { ...createShape('rectangle', { x: 10, y: 20, width: 100, height: 80 }, style), kind: 'image' as const, assetId: 'x', id: 'f' };
  const asset = { id: 'x', name: 'foto.jpg', mime: 'image/jpeg', data: '', widthPx: 2000, heightPx: 1600 };
  const cut = cropImage(photo as never, { x: 30, y: 40, width: 40, height: 30 })!;
  assert.deepEqual(shapeBounds(cut), { x: 30, y: 40, width: 40, height: 30 });
  assert.deepEqual(cut.crop, { x: 0.2, y: 0.25, width: 0.4, height: 0.375 });
  assert.equal(effectiveDpi(cut, asset), effectiveDpi(photo as never, asset), 'recortar no cambia la resolución');
  // Un segundo recorte se combina con el primero; quitar recorte devuelve la foto completa
  const cut2 = cropImage(cut, { x: 0, y: 0, width: 50, height: 55 })!;
  assert.deepEqual(shapeBounds(cut2), { x: 30, y: 40, width: 20, height: 15 });
  const back = uncropImage(cut2);
  for (const [k, v] of Object.entries(shapeBounds(back))) near(v, (shapeBounds(photo) as unknown as Record<string, number>)[k]!, 1e-9);
  assert.equal(back.crop, undefined);
  assert.equal(cropImage(photo as never, { x: 300, y: 300, width: 5, height: 5 }), null, 'fuera de la foto');
  // Rotada 90°: el recorte sigue cayendo donde se dibujó
  const turned = transformShape(photo as never, rotateAbout(90, { x: 60, y: 60 }));
  const cutTurned = cropImage(turned as never, { x: 40, y: 40, width: 20, height: 10 })!;
  const b = shapeBounds(cutTurned);
  near(b.x, 40); near(b.y, 40); near(b.width, 20); near(b.height, 10);

  // Árbol del administrador: de adelante hacia atrás, grupos y PowerClip anidados
  const g1 = box('g1', 0, 0, 5, 5, { groupId: 'G' });
  const g2 = box('g2', 10, 0, 5, 5, { groupId: 'G' });
  const frame = { ...createShape('ellipse', { x: 0, y: 0, width: 30, height: 30 }, style), id: 'c' };
  const inside = box('in', 0, 0, 40, 40, { clipId: 'c' });
  const text = createText({ x: 0, y: 0 }, { fill: '#000000', stroke: null, strokeWidth: 0.2, fontFamily: 'Arial', fontSizePt: 24, bold: false, italic: false, align: 'left' }, 'Ana Sofía Pérez Gómez de la Torre');
  const tree = buildObjectTree([g1, g2, frame, inside, text]);
  assert.deepEqual(tree.map((n) => n.key), [text.id, 'c', 'grupo:G']);
  assert.deepEqual(tree[1]!.ids, ['c', 'in']);
  assert.deepEqual(tree[2]!.children.map((n) => n.key), ['g2', 'g1']);
  assert.equal(objectName(text, {}), 'Texto «Ana Sofía Pérez Gómez de la…»');
  assert.equal(objectName({ ...text, name: 'Nombre' }, {}), 'Nombre');
});

test('texto de párrafo, texto en arco, varias páginas y color CMYK', () => {
  setTextMeasurer((text) => text.length * 0.5); // cada letra mide media "em"
  const style = { fill: '#000000', stroke: null, strokeWidth: 0.2, fontFamily: 'Arial', fontSizePt: 72 / 25.4 * 10, bold: false, italic: false, align: 'left' as const }; // 10 mm de letra: 5 mm por letra
  // Párrafo de 60 mm (12 letras por línea): corta entre palabras y conserva el texto
  const font = { family: 'Arial', bold: false, italic: false };
  assert.deepEqual(wrapLine('Generación 2023 2026', 12 * 0.5, font), ['Generación ', '2023 2026']);
  assert.deepEqual(wrapLine('Supercalifragilístico', 10 * 0.5, font), ['Supercalif', 'ragilístic', 'o'], 'palabra más larga que el marco: por letras');
  const para = relayoutText({ ...createText({ x: 0, y: 0 }, style, 'Felicidades a la generación 2026\nGracias'), frameWidth: 60 });
  const pl = layoutText(para);
  assert.deepEqual(pl.lines, ['Felicidades ', 'a la ', 'generación ', '2026', 'Gracias']);
  assert.deepEqual(pl.starts, [0, 12, 17, 28, 33]);
  near(pl.width, 60);
  near(pl.widths[0]!, 55, 1e-9); // sin el espacio del final
  // El cursor al final de "generación " va a la línea 3; el índice 28 empieza la línea 4
  const caretA = caretSegment(para, 27);
  const caretB = caretSegment(para, 28);
  const top0 = caretSegment(para, 0).top.y;
  near(caretA.top.y - top0, 2 * pl.lineHeight, 1e-9);
  near(caretB.top.y - top0, 3 * pl.lineHeight, 1e-9);
  assert.equal(indexAtLocalPoint(para, { x: 0, y: 3.5 * pl.lineHeight }), 28);
  assert.equal(indexAtLocalPoint(para, { x: 59, y: 0.5 * pl.lineHeight }), 11, 'no después del espacio de corte');

  // Arco: simétrico, letras giradas hacia afuera, caja más alta que la línea
  const straight = createText({ x: 0, y: 0 }, style, 'ESCUELA');
  const arcUp = relayoutText({ ...straight, arc: 120 });
  const al = layoutText(arcUp);
  assert.equal(al.glyphs!.length, 7);
  near(al.glyphs![0]!.rotation, -al.glyphs![6]!.rotation, 1e-9);
  assert.ok(al.glyphs![0]!.rotation < 0, 'a la izquierda se inclina hacia la izquierda');
  near(al.glyphs![3]!.rotation, 0, 1e-9);
  assert.ok(al.glyphs![0]!.y > al.glyphs![3]!.y, '∩: los extremos quedan más abajo que el centro');
  assert.ok(al.height > layoutText(straight).height + 5, "el arco ocupa más alto que la línea");
  const arcDown = layoutText({ ...straight, arc: -120 });
  assert.ok(arcDown.glyphs![0]!.y < arcDown.glyphs![3]!.y, '∪: los extremos más arriba');
  // El arco abarca los grados pedidos (letra 0 a 6: 6/7 del ángulo)
  near(al.glyphs![6]!.rotation - al.glyphs![0]!.rotation, (120 * Math.PI) / 180 * (6 / 7), 1e-9);
  const svgArc = exportSvg({ ...createDocument('P'), shapes: [arcUp] });
  assert.equal((svgArc.match(/<text transform="translate/g) ?? []).length, 7);
  assert.match(svgArc, /rotate\(-/);
  // Guardar y abrir conserva arco y párrafo
  const round = parseDocument(serializeDocument({ ...createDocument('P'), shapes: [arcUp, para] })).document;
  assert.equal((round.shapes[0] as typeof arcUp).arc, 120);
  assert.equal((round.shapes[1] as typeof para).frameWidth, 60);

  // Varias páginas: la actual vive en shapes; se guardan todas; las imágenes de todas se conservan
  const imgShape = (id: string, assetId: string) => ({ ...createShape('rectangle', { x: 0, y: 0, width: 10, height: 10 }, { fill: null, stroke: null, strokeWidth: 0 }), id, kind: 'image' as const, assetId });
  const asset = (id: string) => ({ id, name: `${id}.jpg`, mime: 'image/jpeg', data: 'AA==', widthPx: 10, heightPx: 10 });
  const base = { ...createDocument('Doble'), assets: { a1: asset('a1'), a2: asset('a2'), a3: asset('a3') } };
  const pages = [
    { id: 'p1', name: 'Frente', shapes: [imgShape('i1', 'a1')] },
    { id: 'p2', name: 'Reverso', shapes: [imgShape('i2', 'a2')] },
  ];
  const doc2 = withPages(base, pages, 1);
  assert.equal(doc2.shapes[0]!.id, 'i2');
  assert.deepEqual(Object.keys(pruneAssets(doc2).assets).sort(), ['a1', 'a2'], 'no se borra la foto de la otra página');
  // Cambios en la página actual + guardar → al abrir, las dos páginas al día
  const edited = { ...doc2, shapes: [...doc2.shapes, imgShape('i3', 'a3')] };
  assert.deepEqual(allPages(edited).map((p) => p.shapes.length), [1, 2]);
  const reopened = parseDocument(serializeDocument(edited)).document;
  assert.deepEqual(allPages(reopened).map((p) => [p.name, p.shapes.map((x) => x.id).join(',')]), [['Frente', 'i1'], ['Reverso', 'i2,i3']]);
  assert.equal(reopened.pageIndex, 1);
  assert.equal(pageDocument(reopened, 0).shapes[0]!.id, 'i1');
  // Un documento de una página no guarda lista de páginas
  assert.equal(withPages(base, [{ id: 'p1', name: 'Página 1', shapes: [] }], 0).pages, undefined);

  // Color
  assert.deepEqual(cmykToRgb({ c: 100, m: 0, y: 0, k: 0 }), { r: 0, g: 255, b: 255 });
  assert.deepEqual(cmykToRgb({ c: 0, m: 0, y: 0, k: 100 }), { r: 0, g: 0, b: 0 });
  assert.deepEqual(rgbToCmyk({ r: 255, g: 255, b: 255 }), { c: 0, m: 0, y: 0, k: 0 });
  assert.deepEqual(rgbToCmyk({ r: 0, g: 0, b: 0 }), { c: 0, m: 0, y: 0, k: 100 });
  const navy = parseHex('#0B1F4B')!;
  const back = cmykToRgb(rgbToCmyk(navy));
  for (const k of ['r', 'g', 'b'] as const) assert.ok(Math.abs(back[k] - navy[k]) <= 2, `${k}: ${back[k]} ≈ ${navy[k]}`);
  assert.equal(toHex(parseHex('fa3')!), '#FFAA33');
  assert.equal(parseHex('#12345'), null);
});

test('vectorizar logos y sombras', () => {
  // Máscaras: un cuadro da un anillo; dos píxeles que se tocan en diagonal dan dos manchas
  const sq = new Uint8Array(16);
  for (const p of [5, 6, 9, 10]) sq[p] = 1;
  assert.equal(traceMask(sq, 4, 4).length, 1);
  const diag = new Uint8Array([1, 0, 0, 1]);
  assert.equal(traceMask(diag, 2, 2).length, 2);
  // Una dona da dos anillos (borde y hueco)
  const donut = new Uint8Array(25).fill(0);
  for (let y = 1; y < 4; y++) for (let x = 1; x < 4; x++) donut[y * 5 + x] = 1;
  donut[12] = 0;
  assert.equal(traceMask(donut, 5, 5).length, 2);
  // Motas: un píxel suelto se borra; un huequito se rellena
  const specks = new Uint8Array(100);
  specks[0] = 1;
  for (let y = 3; y < 8; y++) for (let x = 3; x < 8; x++) specks[y * 10 + x] = 1;
  specks[55] = 0;
  despeckle(specks, 10, 10, 4);
  assert.equal(specks[0], 0);
  assert.equal(specks[55], 1);

  // Imagen: círculo negro de radio 12 sobre blanco (40 × 40)
  const W = 40;
  const data = new Uint8ClampedArray(W * W * 4);
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const inside = (x + 0.5 - 20) ** 2 + (y + 0.5 - 20) ** 2 < 144;
      const v = inside ? 0 : 255;
      data.set([v, v, v, 255], (y * W + x) * 4);
    }
  }
  const bw = traceImage({ width: W, height: W, data }, { colors: 1 });
  assert.equal(bw.length, 1);
  assert.equal(bw[0]!.subpaths.length, 1, 'un solo contorno');
  const nodes = bw[0]!.subpaths[0]!.nodes;
  assert.ok(nodes.length >= 2 && nodes.length <= 16, `círculo con pocos nodos (${nodes.length})`);
  // La curva (no solo los nodos) sigue el círculo
  nodes.forEach((a, i) => {
    const b = nodes[(i + 1) % nodes.length]!;
    const p1 = a.out ?? a;
    const p2 = b.in ?? b;
    for (let t = 0; t <= 1; t += 0.125) {
      const u = 1 - t;
      const x = u * u * u * a.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * b.x;
      const y = u * u * u * a.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * b.y;
      near(Math.hypot(x - 20, y - 20), 12, 1.2);
    }
  });

  // Dos colores: mitad roja, mitad azul (con fondo transparente arriba)
  const two = new Uint8ClampedArray(20 * 20 * 4);
  for (let y = 0; y < 20; y++) for (let x = 0; x < 20; x++) two.set(y < 4 ? [0, 0, 0, 0] : x < 10 ? [220, 20, 30, 255] : [20, 40, 200, 255], (y * 20 + x) * 4);
  const layers = traceImage({ width: 20, height: 20, data: two }, { colors: 2, minArea: 2 });
  assert.equal(layers.length, 2);
  // Capas apiladas: la de abajo cubre todo lo visible (sin rendija entre colores)
  const xs = layers[0]!.subpaths[0]!.nodes.map((n) => n.x);
  assert.ok(Math.min(...xs) < 1.5 && Math.max(...xs) > 18.5, 'la capa de abajo abarca las dos mitades');
  assert.ok(layers.every((l) => /^#[0-9A-F]{6}$/.test(l.color)));
  // Sin "ignorar blanco", el fondo blanco del círculo también sale como capa
  assert.equal(traceImage({ width: W, height: W, data }, { colors: 2, ignoreWhite: false }).length, 2);
  assert.equal(traceImage({ width: W, height: W, data }, { colors: 2, ignoreWhite: true }).length, 1);

  // Sombra: se guarda y se exporta a SVG (en el espacio del objeto)
  const r = { ...createShape('rectangle', { x: 0, y: 0, width: 10, height: 10 }, style), shadow: { dx: 2, dy: 2, blur: 1, color: '#000000', opacity: 0.5 } };
  const scaled = transformShape(r, scaleAbout(2, 2, { x: 0, y: 0 }));
  const svg = exportSvg({ ...createDocument('P'), shapes: [scaled] });
  assert.match(svg, /<feDropShadow dx="1" dy="1" stdDeviation="0.25" flood-color="#000000" flood-opacity="0.5"\/>/);
  assert.deepEqual(parseDocument(serializeDocument({ ...createDocument('P'), shapes: [r] })).document.shapes[0]!.shadow, r.shadow);
});

test('abrir PDF exportado de Corel: curvas, texto y fuentes', async () => {
  setTextMeasurer((text) => text.length * 0.5);
  assert.deepEqual(parseFontName('UTTGLL+CalistoMT'), { family: 'Calisto MT', bold: false, italic: false });
  assert.deepEqual(parseFontName('ZWFMSD+LucidaHandwriting-Italic'), { family: 'Lucida Handwriting', bold: false, italic: true });
  assert.deepEqual(parseFontName('JTDFKC+CalifornianFB-Bold'), { family: 'Californian FB', bold: true, italic: false });
  assert.equal(parseFontName('NIADVX+EdwardianScriptITC').family, 'Edwardian Script ITC');
  assert.equal(parseFontName('THCKLP+ChopinScript').family, 'ChopinScript');
  // Códigos de pdf.js (los reales los da pdf.js; aquí unos de prueba)
  const names = ['save', 'restore', 'transform', 'setGState', 'setLineWidth', 'setFillRGBColor', 'setStrokeRGBColor', 'constructPath', 'fill', 'eoFill', 'stroke', 'closeStroke', 'fillStroke', 'eoFillStroke', 'closeFillStroke', 'closeEOFillStroke', 'endPath', 'clip', 'eoClip', 'beginText', 'endText', 'setTextMatrix', 'moveText', 'setLeadingMoveText', 'nextLine', 'setLeading', 'setCharSpacing', 'setWordSpacing', 'setHScale', 'setTextRise', 'setTextRenderingMode', 'setFont', 'showText', 'showSpacedText', 'nextLineShowText', 'nextLineSetSpacingShowText', 'paintImageXObject'] as const;
  const OPS = Object.fromEntries(names.map((n, i) => [n, i + 1])) as Record<(typeof names)[number], number>;
  const glyphs = (t: string) => [...t].map((c) => ({ unicode: c, width: 500, isSpace: c === ' ' }));
  const fn: number[] = [];
  const args: unknown[] = [];
  const op = (name: (typeof names)[number], a: unknown = null) => (fn.push(OPS[name]), args.push(a));
  // Página A4 horizontal (842 × 595 pt). Fondo negro: rectángulo 100..400 × 50..550 pt
  op('setFillRGBColor', ['#000000']);
  op('constructPath', [OPS.eoFill, [new Float32Array([0, 100, 50, 1, 400, 50, 1, 400, 550, 1, 100, 550, 4])], null]);
  // Nombre en dos líneas centradas, con borde, a 30 pt (línea 2 a 40 pt de distancia)
  op('beginText');
  op('setTextRenderingMode', [2]);
  op('setFillRGBColor', ['#ffffff']);
  op('setStrokeRGBColor', ['#ffffff']);
  op('setFont', ['f1', 30]);
  op('setLeadingMoveText', [182.5, 300]); // "Ana Sofía" (9 letras × 15 pt = 135 pt) centrada en 250
  op('showText', [glyphs('Ana Sofía')]);
  op('setLeadingMoveText', [-15, -40]); // "Pérez López" (11 × 15 = 165 pt) centrada en 250
  op('showText', [glyphs('Pérez López')]);
  op('endText');
  // Texto de una línea pegado a la izquierda de la placa (no centrado)
  op('beginText');
  op('setTextRenderingMode', [0]);
  op('setFont', ['f2', 12]);
  op('setTextMatrix', [[1, 0, 0, 1, 110, 100]]);
  op('showText', [glyphs('Generación')]);
  op('endText');
  const page = await importPdfPage(
    { view: [0, 0, 842, 595], fnArray: fn, argsArray: args, fontName: (id) => (id === 'f1' ? 'ZWFMSD+LucidaHandwriting-Italic' : 'UTTGLL+CalistoMT'), image: async () => null },
    OPS,
    { baselineOffset: () => 0.3 },
  );
  const [bg, name, small] = page.shapes;
  assert.equal(bg!.kind, 'path');
  assert.equal(bg!.fill, '#000000');
  const pt = 25.4 / 72;
  const box = shapeBounds(bg!);
  near(box.x, 100 * pt, 1e-3); near(box.y, (595 - 550) * pt, 1e-3); near(box.width, 300 * pt, 1e-3);
  assert.equal(name!.kind, 'text');
  const t = name as TextShape;
  assert.equal(t.text, 'Ana Sofía\nPérez López');
  assert.equal(t.align, 'center');
  assert.equal(t.fontFamily, 'Lucida Handwriting');
  assert.ok(t.italic);
  assert.equal(t.fill, '#FFFFFF');
  assert.equal(t.stroke, '#FFFFFF');
  near(t.fontSizePt, 30, 1e-9);
  near(t.lineSpacing!, 40 / 30, 1e-3);
  // Centro horizontal del texto = centro del PDF (250 pt)
  const tb = shapeBounds(t);
  near(tb.x + tb.width / 2, 250 * pt, 1e-6);
  // Línea base de la primera línea en y = 595 − 300 pt
  const layout = layoutText(t);
  near(t.transform[5] + layout.lineHeight / 2 + 0.3 * layout.size, (595 - 300) * pt, 1e-6);
  const s = small as TextShape;
  assert.equal(s.align, 'left', 'no centrado en la placa');
  near(s.transform[4], 110 * pt, 1e-6);
  assert.equal(s.fontFamily, 'Calisto MT');
});

test('Excel (.xlsx) y acabados por fila', async () => {
  const { readFileSync } = await import('node:fs');
  const { inflateRawSync } = await import('node:zlib');
  const { readXlsx } = await import('../src/engine/xlsx');
  const { applyFinish, matchFinish, findFinishColumn, suggestFinishes, documentColors } = await import('../src/engine/finishes');

  const bytes = new Uint8Array(readFileSync(new URL('../tests/fixtures/lista.xlsx', import.meta.url)));
  const table = await readXlsx(bytes, async (d) => new Uint8Array(inflateRawSync(d)));
  assert.equal(table.sheet, 'Alumnos');
  assert.deepEqual(table.columns, ['Nombre', 'Carrera', 'Acabado', 'Generación']);
  assert.equal(table.rows.length, 4); // la fila vacía no cuenta
  assert.deepEqual(table.rows[2], ['Jorge Iván Medina Hernández', 'Lic. en Contaduría y Finanzas', 'Bronce', '2025']);
  assert.equal(table.rows[3]![0], 'Jaime Tello Gil & Cía <prueba>');
  assert.equal(findFinishColumn(table.columns), 'Acabado');

  // Una placa blanca con letras negras y marco.
  const doc = createDocument('Placa');
  const bg = { ...createShape('rectangle', { x: 0, y: 0, width: 100, height: 150 }, { fill: '#FFFFFF', stroke: null, strokeWidth: 0 }), id: 'bg' };
  const title = { ...createText({ x: 10, y: 20 }, { fill: '#000000', stroke: null, strokeWidth: 0, fontFamily: 'Arial', fontSizePt: 20, bold: false, italic: false, align: 'left' }, 'Nombre'), id: 't' } as TextShape;
  doc.shapes = [bg, title];
  doc.assets = { tex: { id: 'tex', name: 'bronce', mime: 'image/png', data: 'AAAA', widthPx: 200, heightPx: 200 } };
  assert.equal(documentColors(doc)[0]!.color, '#FFFFFF');
  const finishes = suggestFinishes(doc, { bronce: 'tex' });
  assert.deepEqual(finishes.map((f) => f.name), ['Blanco', 'Negro', 'Bronce']);
  assert.equal(matchFinish(finishes, 'Negra')!.name, 'Negro');
  assert.equal(matchFinish(finishes, 'BRONCE ')!.name, 'Bronce');
  assert.equal(matchFinish(finishes, 'Plateado'), null);

  let n = 0;
  const negro = applyFinish(doc, matchFinish(finishes, 'negro'), () => `x${n++}`);
  assert.equal(negro.shapes[0]!.fill, '#000000');
  assert.equal(negro.shapes[1]!.fill, '#FFFFFF');
  const bronce = applyFinish(doc, finishes[2], () => `x${n++}`);
  assert.equal(bronce.shapes.length, 3); // textura dentro del fondo
  assert.equal(bronce.shapes[1]!.kind, 'image');
  assert.equal(bronce.shapes[1]!.clipId, 'bg');
  assert.equal(bronce.shapes[2]!.fill, '#FFFFFF');
  assert.equal(applyFinish(doc, finishes[0], () => 'z'), doc); // Blanco: sin cambios

  // Se guardan con el diseño (y la textura no se borra aunque ningún objeto la use).
  const back = parseDocument(serializeDocument({ ...doc, finishes, merge: { columns: table.columns, rows: table.rows, fileName: '{{Nombre}}', finishColumn: 'Acabado' } })).document;
  assert.equal(back.finishes!.length, 3);
  assert.equal(back.finishes![2]!.texture!.assetId, 'tex');
  assert.ok(back.assets.tex);
  assert.equal(back.merge!.finishColumn, 'Acabado');
});

test('nombres que caben solos: dos líneas y luego más chico', async () => {
  const { applyRow, MIN_FIT } = await import('../src/engine/merge');
  setTextMeasurer((text) => text.length * 0.5); // cada letra mide medio "em"
  const doc = createDocument('Placa');
  doc.page = { widthMm: 100, heightMm: 150, bleedMm: 0, safeMarginMm: 5 };
  const style = { fill: '#000000', stroke: null, strokeWidth: 0, fontFamily: 'Arial', fontSizePt: 20, bold: false, italic: false, align: 'center' as const };
  const name = { ...createText({ x: 50, y: 40 }, style, '{{Nombre}}'), id: 'n' } as TextShape;
  doc.shapes = [name];
  const size = 20 * PT_TO_MM; // ~7 mm por "em": 90 mm caben ~25 letras
  const run = (value: string) => applyRow({ ...doc, merge: { columns: ['Nombre'], rows: [[value]], fileName: '{{Nombre}}' } }, [value]).doc.shapes[0] as TextShape;
  const centerX = (t: TextShape) => shapeBounds(t).x + shapeBounds(t).width / 2;
  const centerY = (t: TextShape) => shapeBounds(t).y + shapeBounds(t).height / 2;

  const short = run('Ana López');
  assert.equal(short.text, 'Ana López');
  assert.equal(short.fontSizePt, 20);

  const long = run('Daniela Fernanda Campos Herrera'); // 31 letras: no cabe en una línea
  assert.equal(long.text, 'Daniela Fernanda\nCampos Herrera');
  assert.equal(long.fontSizePt, 20);
  assert.ok(Math.abs(centerX(long) - 50) < 1e-6);
  assert.ok(Math.abs(centerY(long) - centerY(short)) < 1e-6, 'conserva el centro vertical');
  assert.ok(shapeBounds(long).width <= 90 + 1e-6);

  const huge = run('María Guadalupe Hernández de la Cruz Villaseñor Altamirano'); // ni en dos líneas
  assert.ok(huge.text.includes('\n'));
  assert.ok(huge.fontSizePt < 20 && huge.fontSizePt >= 20 * MIN_FIT - 1e-9);
  assert.ok(size > 0);

  // Se puede apagar.
  const off = applyRow({ ...doc, merge: { columns: ['Nombre'], rows: [['Daniela Fernanda Campos Herrera']], fileName: '', fit: false } }, ['Daniela Fernanda Campos Herrera']).doc.shapes[0] as TextShape;
  assert.equal(off.text, 'Daniela Fernanda Campos Herrera');
});

test('mostrar solo si: logo según carrera', async () => {
  const { applyRow } = await import('../src/engine/merge');
  const doc = createDocument('Placa');
  const style = { fill: '#000000', stroke: null, strokeWidth: 0 };
  const admin = { ...createShape('rectangle', { x: 0, y: 0, width: 10, height: 10 }, style), id: 'admin', showWhen: { column: 'carrera', value: 'Contaduría|Administración' } };
  const ing = { ...createShape('rectangle', { x: 0, y: 0, width: 10, height: 10 }, style), id: 'ing', showWhen: { column: 'Carrera', value: 'industrial' } };
  doc.shapes = [admin, ing];
  const merge = { columns: ['Nombre', 'Carrera'], rows: [], fileName: '' };
  const conta = applyRow({ ...doc, merge }, ['Ana', 'Lic. en Contaduría y Finanzas']).doc.shapes;
  assert.deepEqual(conta.map((s) => !!s.hidden), [false, true]);
  const indus = applyRow({ ...doc, merge }, ['Luis', 'Ing. Industrial']).doc.shapes;
  assert.deepEqual(indus.map((s) => !!s.hidden), [true, false]);
  const back = parseDocument(serializeDocument(doc)).document;
  assert.deepEqual(back.shapes[1]!.showWhen, { column: 'Carrera', value: 'industrial' });
});

test('acomodo en hoja: cuántas placas caben', async () => {
  const { planSheet, cropMarks, DEFAULT_SHEET } = await import('../src/engine/sheet');
  const plate = { w: 127, h: 177.8 }; // 5 × 7 pulgadas
  const a4 = planSheet(plate, { ...DEFAULT_SHEET, paper: 'a4' })!;
  assert.equal(a4.perSheet, 2); // A4 horizontal, una junto a otra (como las acomoda el usuario)
  assert.equal(a4.width, 297);
  assert.equal(a4.rotated, false);
  const tab = planSheet(plate, { ...DEFAULT_SHEET, paper: 'tabloide', gapMm: 3 })!;
  assert.equal(tab.perSheet, 4);
  const roll = planSheet(plate, { ...DEFAULT_SHEET, paper: 'rollo', rollWidthMm: 610, gapMm: 2 }, 9)!;
  assert.equal(roll.cols, 4);
  assert.equal(roll.rows, 3); // 9 placas → 3 filas en el tramo
  assert.ok(roll.height < 600);
  assert.equal(planSheet({ w: 400, h: 400 }, { ...DEFAULT_SHEET, paper: 'carta' }), null);
  // Las placas quedan dentro del papel, sin encimarse.
  for (const s of tab.slots) assert.ok(s.x >= 5 - 1e-9 && s.x + tab.cell.w <= tab.width - 5 + 1e-9);
  assert.ok(cropMarks(tab).length > 0);
});

test('dividir una hoja con 2 placas en 2 páginas', async () => {
  const { splitIntoPlates } = await import('../src/engine/split');
  const style = { fill: '#000000', stroke: null, strokeWidth: 0 };
  const left = { ...createShape('rectangle', { x: 20, y: 15, width: 127, height: 178 }, style), id: 'L' };
  const right = { ...createShape('rectangle', { x: 147, y: 10, width: 127, height: 178 }, style), id: 'R' };
  const textL = { ...createShape('rectangle', { x: 40, y: 60, width: 80, height: 10 }, { ...style, fill: '#FFFFFF' }), id: 'tL' };
  const clipR = { ...createShape('rectangle', { x: 140, y: 5, width: 60, height: 60 }, style), id: 'cR', clipId: 'R' }; // contenido de R aunque se salga
  const r = splitIntoPlates([{ id: 'p1', name: 'Página 1', shapes: [left, textL, right, clipR] }], 2)!;
  assert.equal(r.pages.length, 2);
  assert.deepEqual(r.pages[0]!.shapes.map((s) => s.id), ['L', 'tL']); // el rectángulo negro ya es el fondo
  assert.deepEqual(r.pages[1]!.shapes.map((s) => s.id), ['R', 'cR']);
  const frame = { ...createShape('rectangle', { x: 0, y: 0, width: 100, height: 150 }, { fill: null, stroke: '#000000', strokeWidth: 0.5 }), id: 'F' };
  const white = splitIntoPlates([{ id: 'p', name: 'P', shapes: [frame] }], 1)!;
  assert.equal(white.pages[0]!.shapes[0]!.name, 'Fondo'); // placa sin fondo: se le pone uno blanco
  assert.ok(Math.abs(r.size.w - 127) < 1e-6 && Math.abs(r.size.h - 178) < 1e-6);
  const b = shapeBounds(r.pages[0]!.shapes[0]!);
  assert.ok(Math.abs(b.x) < 1e-6 && Math.abs(b.y) < 1e-6);
  const br = shapeBounds(r.pages[1]!.shapes[0]!);
  assert.ok(Math.abs(br.x) < 1e-6 && Math.abs(br.y) < 1e-6, 'la placa queda en la orilla de su página');
});

test('revisar nombres: acentos, mayúsculas y espacios', async () => {
  const { checkName, isNameColumn } = await import('../src/engine/names');
  assert.equal(checkName('Valeria Campos Ramírez'), null);
  assert.equal(checkName('Valeria Campos Ramirez')!.fixed, 'Valeria Campos Ramírez');
  assert.equal(checkName('ana maria lopez de la cruz')!.fixed, 'Ana María López de la Cruz');
  assert.equal(checkName('JOSE ANGEL PEREZ')!.fixed, 'José Ángel Pérez');
  assert.equal(checkName('Jorge  Iván Medina Hernandez ')!.fixed, 'Jorge Iván Medina Hernández');
  assert.equal(checkName('Jaime Tello Gil'), null);
  assert.equal(checkName('Luis Ortiz Ruiz'), null); // sin acento es lo correcto
  assert.ok(isNameColumn('Nombre') && isNameColumn('ALUMNO') && !isNameColumn('Carrera'));
});

test('quitar fondo: blanco de la orilla y huecos', async () => {
  const { removeBackground } = await import('../src/engine/background');
  // 10×10 blanco con un aro negro (con hueco blanco al centro).
  const w = 10, h = 10;
  const data = new Uint8ClampedArray(w * h * 4).fill(255);
  for (let y = 2; y < 8; y++) for (let x = 2; x < 8; x++) {
    const ring = x === 2 || x === 7 || y === 2 || y === 7;
    if (ring) data.set([0, 0, 0, 255], (y * w + x) * 4);
  }
  const img = { width: w, height: h, data };
  const outside = removeBackground(img, { holes: false, feather: 0 });
  assert.equal(outside.data[3], 0); // esquina: fondo
  assert.equal(outside.data[(5 * w + 5) * 4 + 3], 255); // centro: hueco, se queda
  assert.equal(outside.data[(2 * w + 2) * 4 + 3], 255); // el aro se queda
  const all = removeBackground(img, { holes: true, feather: 0 });
  assert.equal(all.data[(5 * w + 5) * 4 + 3], 0); // también el hueco
  assert.deepEqual(all.color, [255, 255, 255]);
});

test('dividir en automático: 2 placas o un diploma completo', async () => {
  const { splitIntoPlates } = await import('../src/engine/split');
  const st = (fill: string | null, stroke: string | null = null) => ({ fill, stroke, strokeWidth: stroke ? 0.5 : 0 });
  // Hoja 1: dos placas negras pegadas.
  const a = { ...createShape('rectangle', { x: 20, y: 15, width: 127, height: 178 }, st('#000000')), id: 'a' };
  const b = { ...createShape('rectangle', { x: 147, y: 15, width: 127, height: 178 }, st('#000000')), id: 'b' };
  const ta = { ...createShape('rectangle', { x: 140, y: 80, width: 5, height: 5 }, st('#FFFFFF')), id: 'ta' }; // cerca de la orilla, es de la placa a
  // Hoja 2: un diploma horizontal con marco y textos a los lados.
  const dip = { ...createShape('rectangle', { x: 30, y: 30, width: 230, height: 150 }, st(null, '#000000')), id: 'dip' };
  const left = { ...createShape('rectangle', { x: 40, y: 50, width: 60, height: 10 }, st('#333333')), id: 'L' };
  const right = { ...createShape('rectangle', { x: 190, y: 50, width: 60, height: 10 }, st('#333333')), id: 'R' };
  const r = splitIntoPlates([{ id: '1', name: 'H1', shapes: [a, b, ta] }, { id: '2', name: 'H2', shapes: [dip, left, right] }], 'auto')!;
  assert.equal(r.pages.length, 3);
  assert.deepEqual(r.pages[0]!.shapes.map((s) => s.id), ['a', 'ta']);
  assert.deepEqual(r.pages[1]!.shapes.map((s) => s.id), ['b']);
  assert.deepEqual(r.pages[2]!.shapes.filter((s) => s.name !== 'Fondo').map((s) => s.id), ['dip', 'L', 'R']); // el diploma no se parte
});

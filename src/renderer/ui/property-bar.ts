import { PAGE_PRESETS, presetFor } from '../../engine/document';
import { centerOf } from '../../engine/selection';
import { KIND_LABELS } from '../../engine/shapes';
import { formatLength, pixelsAtDpi, toMm, UNIT_LABELS, type Unit } from '../../engine/units';
import * as editor from '../editor';
import { visualScale } from '../../engine/text';
import type { TextAlign, TextShape } from '../../engine/shapes';
import { refocusText } from '../text-edit';
import { createFontPicker } from './font-picker';
import { effectiveDpi } from '../images';
import { nodeCount } from '../../engine/path';
import * as nodeEdit from '../node-edit';
import { canConvert, intersectSelection, trimSelection, weldSelection } from '../shape-commands';
import { openContourDialog } from './contour-dialog';
import { alignPanel, fillPanel, shadowPanel } from './arrange-popovers';
import { togglePopover } from './popover';
import { openTraceDialog } from './trace-dialog';
import { store, type ToolId } from '../state';
import { h, icon, iconButton } from './dom';
import { toolById } from './tools';

/**
 * Barra de propiedades: cambia según la herramienta activa, como en los
 * editores vectoriales. Sin nada seleccionado muestra la página (tamaño,
 * orientación, unidades), que es lo que más se toca al empezar una placa.
 */
export function createPropertyBar(onPageChanged: () => void): HTMLElement {
  const bar = h('div', { class: 'property-bar', role: 'toolbar', 'aria-label': 'Barra de propiedades' });
  let renderedSignature: string | null = null;
  let refresh: (() => void) | null = null;

  /** Qué juego de controles toca: cambia solo cuando cambia el tipo de cosa seleccionada o la herramienta. */
  const signature = (): string => {
    const { tool } = store.get();
    const selected = editor.selectedShapes();
    if (tool === 'shape') {
      if (nodeEdit.currentPath()) return 'nodes';
      if (selected.some(canConvert)) return 'convert';
      return 'tool:shape';
    }
    if (tool === 'crop') return `crop:${store.get().cropArea ? 'area' : 'none'}:${selected.length}`;
    if (selected.length > 0 && ['select', 'rectangle', 'ellipse', 'polygon', 'text'].includes(tool)) {
      const kinds = [...new Set(selected.map((s) => s.kind))];
      // Con datos de placas en serie aparece "Foto de" en las imágenes: cambia el juego de controles.
      const merge = store.get().document.merge ? `:m${store.get().document.merge!.columns.join('|')}` : '';
      const cropped = selected.some((s) => s.kind === 'image' && s.crop) ? ':crop' : '';
      return `object${cropped}:${editor.selectionKind(selected)}:${selected.length === 1 ? 'one' : 'many'}:${kinds.length === 1 ? kinds[0] : 'mixed'}${merge}`;
    }
    if (tool === 'text') return 'text';
    if (['rectangle', 'ellipse', 'polygon', 'freehand', 'pen'].includes(tool)) return `tool:${tool}`;
    return 'page';
  };

  const render = () => {
    const next = signature();
    if (next === renderedSignature) {
      refresh?.();
      return;
    }
    renderedSignature = next;
    bar.replaceChildren();
    refresh = null;
    let built: Controls;
    if (next === 'nodes') built = nodeControls();
    else if (next === 'convert') built = convertControls();
    else if (next.startsWith('object')) built = objectControls();
    else if (next.startsWith('crop:')) built = cropControls();
    else if (next === 'text') built = textControls();
    else if (next === 'tool:shape') built = { nodes: [h('span', { class: 'prop-title' }, icon('shape'), 'Forma'), h('span', { class: 'prop-info' }, 'Elige una curva para editar sus nodos. Las figuras se convierten a curvas con Ctrl+Q.')] };
    else if (next.startsWith('tool:')) built = shapeControls(store.get().tool);
    else built = pageControls(onPageChanged);
    refresh = built.refresh ?? null;
    bar.append(...built.nodes);
  };
  store.subscribe((state, previous) => {
    if (state.tool !== previous.tool || state.document !== previous.document || state.selection !== previous.selection || state.strokeWidth !== previous.strokeWidth || state.cornerRadius !== previous.cornerRadius || state.sides !== previous.sides || state.text !== previous.text || state.nodeSelection !== previous.nodeSelection || state.cropArea !== previous.cropArea) render();
  });
  render();
  return bar;
}

interface Controls {
  nodes: HTMLElement[];
  refresh?: () => void;
}

/** Escribe el valor en un campo, salvo que el usuario esté escribiendo en él. */
function setValue(input: HTMLInputElement, value: string): void {
  if (document.activeElement !== input) input.value = value;
}

function field(label: string, control: HTMLElement, suffix?: string): HTMLElement {
  return h('label', { class: 'prop-field' }, h('span', { class: 'prop-label' }, label), control, suffix ? h('span', { class: 'prop-suffix' }, suffix) : null);
}

function numberInput(value: number, onCommit: (value: number) => void, attrs: Record<string, string | number> = {}): HTMLInputElement {
  const input = h('input', { class: 'input number', type: 'number', step: 'any', value, ...attrs });
  const min = attrs.min === undefined ? -Infinity : Number(attrs.min);
  const commit = () => {
    const parsed = Number(input.value.replace(',', '.'));
    if (Number.isFinite(parsed) && parsed >= min) onCommit(parsed);
  };
  input.addEventListener('change', commit);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') input.blur();
  });
  return input;
}

function pageControls(onPageChanged: () => void): Controls {
  const preset = h(
    'select',
    {
      class: 'input preset-select',
      'aria-label': 'Tamaño de página',
      onchange: ((event: Event) => {
        const chosen = PAGE_PRESETS.find((p) => p.id === (event.target as HTMLSelectElement).value);
        if (!chosen) return;
        const landscape = isLandscape();
        store.updatePage(landscape ? { widthMm: chosen.heightMm, heightMm: chosen.widthMm } : { widthMm: chosen.widthMm, heightMm: chosen.heightMm });
        onPageChanged();
      }) as EventListener,
    },
    ...PAGE_PRESETS.map((p) => h('option', { value: p.id }, p.label)),
    h('option', { value: 'custom', disabled: true }, 'Personalizado'),
  );

  const unitOf = () => store.get().document.unit;
  const width = numberInput(0, (v) => {
    store.updatePage({ widthMm: toMm(v, unitOf()) });
    onPageChanged();
  }, { 'aria-label': 'Ancho de página', min: 1 });
  const height = numberInput(0, (v) => {
    store.updatePage({ heightMm: toMm(v, unitOf()) });
    onPageChanged();
  }, { 'aria-label': 'Alto de página', min: 1 });

  const isLandscape = () => store.get().document.page.widthMm > store.get().document.page.heightMm;
  const setOrientation = (landscape: boolean) => {
    const { widthMm, heightMm } = store.get().document.page;
    if (landscape === widthMm > heightMm) return;
    store.updatePage({ widthMm: heightMm, heightMm: widthMm });
    onPageChanged();
  };
  const portrait = iconButton('portrait', 'Vertical', () => setOrientation(false), { class: 'icon-button toggle' });
  const landscape = iconButton('landscape', 'Horizontal', () => setOrientation(true), { class: 'icon-button toggle' });

  const units = h(
    'select',
    {
      class: 'input',
      'aria-label': 'Unidades',
      onchange: ((event: Event) => {
        const doc = store.get().document;
        store.set({ document: { ...doc, unit: (event.target as HTMLSelectElement).value as Unit } });
      }) as EventListener,
    },
    ...(['mm', 'cm', 'in', 'px'] as Unit[]).map((u) => h('option', { value: u }, UNIT_LABELS[u])),
  );

  const bleed = numberInput(0, (v) => store.updatePage({ bleedMm: v }), { 'aria-label': 'Sangrado en milímetros', min: 0, step: 0.5 });
  const output = h('span', { class: 'prop-info' });

  const refresh = () => {
    const doc = store.get().document;
    const { page, unit } = doc;
    preset.value = presetFor(page)?.id ?? 'custom';
    width.value = formatLength(page.widthMm, unit);
    height.value = formatLength(page.heightMm, unit);
    units.value = unit;
    bleed.value = String(page.bleedMm);
    portrait.setAttribute('aria-pressed', String(!isLandscape()));
    landscape.setAttribute('aria-pressed', String(isLandscape()));
    output.textContent = `${pixelsAtDpi(page.widthMm, doc.exportDpi)} × ${pixelsAtDpi(page.heightMm, doc.exportDpi)} px a ${doc.exportDpi} ppp`;
    output.title = 'Tamaño de la imagen al exportar para sublimar';
  };
  refresh();

  return {
    refresh,
    nodes: [
      preset,
      h('span', { class: 'bar-sep' }),
      field('An', width),
      field('Al', height),
      portrait,
      landscape,
      h('span', { class: 'bar-sep' }),
      field('Unidades', units),
      field('Sangrado', bleed, 'mm'),
      h('span', { class: 'bar-sep' }),
      output,
    ],
  };
}

/** Herramienta de figura sin nada seleccionado: valores para los objetos nuevos. */
function shapeControls(tool: ToolId): Controls {
  const nodes: HTMLElement[] = [h('span', { class: 'prop-title' }, icon(toolById(tool).icon), toolById(tool).label)];
  const corners = numberInput(0, (v) => store.set({ cornerRadius: v }), { 'aria-label': 'Radio de esquinas', min: 0, step: 0.5 });
  const sides = numberInput(5, (v) => store.set({ sides: Math.min(100, Math.max(3, Math.round(v))) }), { 'aria-label': 'Número de lados', min: 3, max: 100, step: 1 });
  const stroke = numberInput(0.2, (v) => store.set({ strokeWidth: v }), { 'aria-label': 'Grosor del contorno en milímetros', min: 0, step: 0.1 });
  if (tool === 'rectangle') nodes.push(field('Esquinas', corners, 'mm'));
  if (tool === 'polygon') nodes.push(field('Lados', sides));
  nodes.push(h('span', { class: 'bar-sep' }), field('Contorno', stroke, 'mm'), h('span', { class: 'prop-info' }, toolById(tool).hint));
  const refresh = () => {
    const state = store.get();
    setValue(corners, String(state.cornerRadius));
    setValue(sides, String(state.sides));
    setValue(stroke, String(state.strokeWidth));
  };
  refresh();
  return { nodes, refresh };
}

/** Con objetos seleccionados: posición, tamaño, ángulo, espejo, forma, contorno y orden. */
function objectControls(): Controls {
  const unitOf = () => store.get().document.unit;
  const mm = (v: number) => toMm(v, unitOf());
  let keepRatio = true;

  const x = numberInput(0, (v) => editor.setCenter(mm(v), null), { 'aria-label': 'Posición X del centro' });
  const y = numberInput(0, (v) => editor.setCenter(null, mm(v)), { 'aria-label': 'Posición Y del centro' });
  const width = numberInput(0, (v) => editor.setSize(mm(v), null, keepRatio), { 'aria-label': 'Ancho del objeto', min: 0.001 });
  const height = numberInput(0, (v) => editor.setSize(null, mm(v), keepRatio), { 'aria-label': 'Alto del objeto', min: 0.001 });
  const lock = iconButton('lock', 'Mantener proporción', () => {
    keepRatio = !keepRatio;
    paintLock();
  }, { class: 'icon-button toggle' });
  const paintLock = () => {
    lock.setAttribute('aria-pressed', String(keepRatio));
    lock.replaceChildren(icon(keepRatio ? 'lock' : 'unlock'));
  };
  paintLock();
  // En pantalla el ángulo se muestra en sentido antihorario (positivo = a la izquierda), como en los editores vectoriales.
  const angle = numberInput(0, (v) => editor.setAngle(-v), { 'aria-label': 'Ángulo de rotación en grados', step: 1 });

  const selected = editor.selectedShapes();
  const kinds = new Set(selected.map((s) => s.kind));
  const only = kinds.size === 1 ? [...kinds][0] : null;
  const kindOfSelection = editor.selectionKind(selected);
  const title = selected.length === 1 ? KIND_LABELS[selected[0]!.kind] : kindOfSelection === 'group' ? `Grupo (${selected.length})` : kindOfSelection === 'powerclip' ? 'PowerClip' : `${selected.length} objetos`;

  const corners = numberInput(0, (v) => editor.setCornerRadius(v), { 'aria-label': 'Radio de esquinas', min: 0, step: 0.5 });
  const sides = numberInput(5, (v) => editor.setSides(v), { 'aria-label': 'Número de lados', min: 3, max: 100, step: 1 });
  const stroke = numberInput(0.2, (v) => editor.setStrokeWidth(v), { 'aria-label': 'Grosor del contorno en milímetros', min: 0, step: 0.1 });
  const unitLabels = [x, y, width, height].map(() => h('span', { class: 'prop-suffix' }));

  const nodes: HTMLElement[] = [
    h('span', { class: 'prop-title' }, title),
    h('label', { class: 'prop-field', title: 'Centro del objeto' }, h('span', { class: 'prop-label' }, 'X'), x, unitLabels[0]!),
    h('label', { class: 'prop-field', title: 'Centro del objeto' }, h('span', { class: 'prop-label' }, 'Y'), y, unitLabels[1]!),
    h('span', { class: 'bar-sep' }),
    h('label', { class: 'prop-field' }, h('span', { class: 'prop-label' }, 'An'), width, unitLabels[2]!),
    h('label', { class: 'prop-field' }, h('span', { class: 'prop-label' }, 'Al'), height, unitLabels[3]!),
    lock,
    h('span', { class: 'bar-sep' }),
    field('Ángulo', angle, '°'),
    iconButton('mirrorH', 'Reflejar horizontalmente', () => editor.mirror(true)),
    iconButton('mirrorV', 'Reflejar verticalmente', () => editor.mirror(false)),
    ...(selected.some(canConvert) ? [iconButton('toCurves', 'Convertir a curvas (Ctrl+Q): para editar sus nodos', () => void nodeEdit.convertSelectionToCurves())] : []),
    h('span', { class: 'bar-sep' }),
    ...(selected.length > 1
      ? [
          iconButton('weld', 'Soldar: unir en una sola figura', () => void weldSelection()),
          iconButton('trim', 'Recortar: al de atrás se le quita la forma de los de delante', () => void trimSelection()),
          iconButton('intersect', 'Intersectar: lo que tienen en común', () => void intersectSelection()),
        ]
      : []),
    iconButton('contour', 'Contorno… (Ctrl+F9): borde alrededor del texto o logo', openContourDialog),
    h('span', { class: 'bar-sep' }),
    ...arrangeButtons(),
    h('span', { class: 'bar-sep' }),
  ];
  const textFields = only === 'text' ? textFieldControls('selection') : null;
  if (textFields) nodes.push(...textFields.nodes, h('span', { class: 'bar-sep' }));
  // Imagen: a qué resolución se imprimirá con el tamaño actual.
  const dpi = only === 'image' && selected.length === 1 ? h('span', { class: 'prop-info' }) : null;
  if (dpi) nodes.push(dpi, h('span', { class: 'bar-sep' }));
  // Imagen: recortar con la herramienta Recortar y volver a la foto completa.
  if (only === 'image') {
    nodes.push(iconButton('crop', 'Recortar foto (K): arrastra el área que quieres conservar', () => store.set({ tool: 'crop', hint: toolById('crop').hint })));
    if (selected.length === 1) nodes.push(iconButton('trace', 'Vectorizar: convertir el logo en curvas', () => void openTraceDialog()));
    if (selected.some((s) => s.kind === 'image' && s.crop)) nodes.push(iconButton('uncrop', 'Quitar recorte: volver a la foto completa', () => editor.uncropSelection()));
    nodes.push(h('span', { class: 'bar-sep' }));
  }
  // Placas en serie: de qué columna sale la foto de cada placa.
  const merge = store.get().document.merge;
  if (only === 'image' && selected.length === 1 && merge) {
    const img = selected[0]!;
    const photoField = h(
      'select',
      { class: 'input', 'aria-label': 'Foto de cada placa', title: 'Placas en serie: la foto de cada placa sale de esta columna (nombre del archivo de la foto)', onchange: ((e: Event) => editor.setImageField((e.target as HTMLSelectElement).value || null)) as EventListener },
      h('option', { value: '' }, '(fija)'),
      ...merge.columns.map((c) => h('option', { value: c }, c)),
    );
    photoField.value = img.kind === 'image' ? (img.field ?? '') : '';
    nodes.push(h('label', { class: 'prop-field' }, h('span', { class: 'prop-label' }, 'Foto de'), photoField), h('span', { class: 'bar-sep' }));
  }
  if (only === 'rectangle') nodes.push(field('Esquinas', corners, 'mm'));
  if (only === 'polygon') nodes.push(field('Lados', sides));
  nodes.push(
    field('Contorno', stroke, 'mm'),
    h('span', { class: 'bar-sep' }),
    iconButton('toFront', 'Al frente (Mayús+RePág)', () => editor.reorder('front')),
    iconButton('forward', 'Adelante uno (Ctrl+RePág)', () => editor.reorder('forward')),
    iconButton('backward', 'Atrás uno (Ctrl+AvPág)', () => editor.reorder('backward')),
    iconButton('toBack', 'Al fondo (Mayús+AvPág)', () => editor.reorder('back')),
    h('span', { class: 'bar-sep' }),
    iconButton('trash', 'Eliminar (Supr)', () => editor.deleteSelection()),
  );

  const refresh = () => {
    const box = editor.selectionBounds();
    const shapes = editor.selectedShapes();
    if (!box || shapes.length === 0) return;
    const unit = unitOf();
    const c = centerOf(box);
    setValue(x, formatLength(c.x, unit));
    setValue(y, formatLength(c.y, unit));
    setValue(width, formatLength(box.width, unit));
    setValue(height, formatLength(box.height, unit));
    for (const label of unitLabels) label.textContent = unit;
    const degrees = -editor.selectionAngle();
    setValue(angle, String(Math.round((Object.is(degrees, -0) ? 0 : degrees) * 10) / 10));
    const first = shapes[0]!;
    setValue(stroke, String(first.stroke ? Math.round(first.strokeWidth * 1000) / 1000 : 0));
    if (first.kind === 'rectangle') setValue(corners, String(Math.round(first.cornerRadius * 100) / 100));
    if (first.kind === 'polygon') setValue(sides, String(first.sides));
    textFields?.refresh?.();
    if (dpi && first.kind === 'image') {
      const asset = store.get().document.assets[first.assetId];
      const value = effectiveDpi(first, asset);
      if (value === null) {
        dpi.className = 'prop-info dpi-good';
        dpi.textContent = 'Vectorial (nítido a cualquier tamaño)';
        dpi.title = asset?.name ?? '';
      } else {
        const level = value >= 250 ? 'good' : value >= 150 ? 'ok' : 'low';
        dpi.className = `prop-info dpi-${level}`;
        dpi.textContent = `${value} ppp · ${level === 'good' ? 'buena para sublimar' : level === 'ok' ? 'aceptable' : 'baja: se verá borrosa'}`;
        dpi.title = `${asset?.name ?? ''}: ${asset?.widthPx} × ${asset?.heightPx} px. Para sublimar se recomiendan 300 ppp; si es baja, hazla más chica o usa una foto más grande.`;
      }
    }
  };
  refresh();
  return { nodes, refresh };
}

/** Herramienta Recortar: aplicar o cancelar el recorte elegido. */
function cropControls(): Controls {
  const area = store.get().cropArea;
  const info = h('span', { class: 'prop-info' });
  const refresh = () => {
    const now = store.get().cropArea;
    const unit = store.get().document.unit;
    const selected = editor.selectedShapes().filter((s) => s.kind === 'image');
    info.textContent = now
      ? `Área: ${formatLength(now.width, unit)} × ${formatLength(now.height, unit)} ${unit}. Ajústala con los tiradores o muévela arrastrando.`
      : selected.length
        ? `Arrastra sobre ${selected.length === 1 ? 'la foto elegida' : 'las fotos elegidas'} el área que quieres conservar.`
        : 'Arrastra sobre una foto el área que quieres conservar.';
  };
  refresh();
  return {
    refresh,
    nodes: [
      h('span', { class: 'prop-title' }, icon('crop'), 'Recortar'),
      info,
      ...(area
        ? [
            h('button', { type: 'button', class: 'button primary', onclick: () => editor.applyCropArea() }, 'Aplicar recorte (Enter)'),
            h('button', { type: 'button', class: 'button', onclick: () => store.set({ cropArea: null, hint: 'Recorte cancelado' }) }, 'Cancelar (Esc)'),
          ]
        : []),
    ],
  };
}

/** Agrupar, PowerClip, alinear y relleno/transparencia (según lo seleccionado). */
function arrangeButtons(): HTMLElement[] {
  const kind = editor.selectionKind();
  const out: HTMLElement[] = [];
  if (kind === 'group') out.push(iconButton('ungroup', 'Desagrupar (Ctrl+U)', () => editor.ungroupSelection()));
  else if (kind === 'mixed') out.push(iconButton('group', 'Agrupar (Ctrl+G): se mueven juntos', () => editor.groupSelection()));
  if (kind === 'powerclip') out.push(iconButton('extract', 'Sacar el contenido del PowerClip', () => editor.extractContents()));
  else if (kind === 'mixed') out.push(iconButton('powerclip', 'PowerClip: meter lo de atrás dentro de la figura de arriba (p. ej. una foto dentro de un círculo)', () => editor.powerClipSelection()));
  const alignBtn = iconButton('align', 'Alinear y distribuir', undefined, { 'aria-haspopup': 'dialog', 'aria-expanded': 'false' });
  alignBtn.addEventListener('click', () => togglePopover(alignBtn, alignPanel));
  const fillBtn = iconButton('fillStyle', 'Relleno y transparencia: degradados, opacidad y desvanecer', undefined, { 'aria-haspopup': 'dialog', 'aria-expanded': 'false' });
  fillBtn.addEventListener('click', () => togglePopover(fillBtn, () => fillPanel(), 'fill-pop'));
  const shadowBtn = iconButton('shadow', 'Sombra paralela', undefined, { 'aria-haspopup': 'dialog', 'aria-expanded': 'false', class: 'icon-button toggle' });
  shadowBtn.setAttribute('aria-pressed', String(editor.selectedShapes().some((s) => s.shadow)));
  shadowBtn.addEventListener('click', () => togglePopover(shadowBtn, () => shadowPanel(), 'fill-pop'));
  out.push(alignBtn, fillBtn, shadowBtn);
  return out;
}

/** Herramienta Texto sin nada seleccionado: la letra de los textos nuevos. */
function textControls(): Controls {
  const fields = textFieldControls('defaults');
  return {
    nodes: [h('span', { class: 'prop-title' }, icon('text'), 'Texto'), ...fields.nodes, h('span', { class: 'prop-info' }, 'Clic en la página para escribir · Esc para terminar')],
    refresh: fields.refresh,
  };
}

/**
 * Fuente, tamaño, negrita, cursiva y alineación. Con `selection` cambian los
 * textos seleccionados (o el que se está escribiendo); con `defaults`, los nuevos.
 */
function textFieldControls(target: 'selection' | 'defaults'): Controls {
  const firstText = (): TextShape | null => {
    const shape = editor.selectedShapes().find((s) => s.kind === 'text');
    return shape?.kind === 'text' ? shape : null;
  };
  const value = () => {
    const shape = target === 'selection' ? firstText() : null;
    if (shape) return { fontFamily: shape.fontFamily, fontSizePt: shape.fontSizePt * visualScale(shape), bold: shape.bold, italic: shape.italic, align: shape.align };
    return store.get().text;
  };
  const change = (patch: Partial<ReturnType<typeof value>>) => {
    if (target === 'defaults') {
      store.set({ text: { ...store.get().text, ...patch } });
      return;
    }
    if (patch.fontFamily !== undefined) editor.setFontFamily(patch.fontFamily);
    if (patch.fontSizePt !== undefined) editor.setFontSize(patch.fontSizePt);
    if (patch.bold !== undefined) editor.setTextStyle({ bold: patch.bold });
    if (patch.italic !== undefined) editor.setTextStyle({ italic: patch.italic });
    if (patch.align !== undefined) editor.setTextAlign(patch.align);
    // Si se estaba escribiendo, el cursor vuelve al texto.
    refocusText();
  };

  const picker = createFontPicker(() => value().fontFamily, (fontFamily) => change({ fontFamily }));
  // Ancho máximo (solo con un texto seleccionado): el texto se achica si no cabe.
  const unitOf = () => store.get().document.unit;
  const maxWidth = h('input', { class: 'input number', type: 'number', min: 0, step: 'any', placeholder: '—', 'aria-label': 'Ancho máximo del texto', title: 'Ancho máximo: si el texto es más largo, la letra se achica para caber (ideal para nombres en placas en serie). Vacío = sin límite.' });
  maxWidth.addEventListener('change', () => {
    const v = Number(maxWidth.value.replace(',', '.'));
    editor.setTextMaxWidth(maxWidth.value.trim() && v > 0 ? toMm(v, unitOf()) : null);
    refocusText();
  });
  maxWidth.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') maxWidth.blur();
  });
  const maxUnit = h('span', { class: 'prop-suffix' });
  // Texto en arco: grados (positivo = ∩, negativo = ∪). La barrita lo cambia en vivo.
  const arc = numberInput(0, (v) => (editor.setTextArc(v), refocusText()), { 'aria-label': 'Arco del texto en grados', step: 5, min: -359, max: 359, title: 'Texto en arco: positivo = hacia arriba (∩), negativo = hacia abajo (∪), 0 = derecho' });
  const arcSlider = h('input', { type: 'range', class: 'arc-slider', min: -180, max: 180, step: 5, 'aria-label': 'Curvar el texto', title: 'Curvar el texto (arrastra; al centro = derecho)' });
  arcSlider.addEventListener('change', () => editor.setTextArc(Number(arcSlider.value)));
  arcSlider.addEventListener('input', () => (arc.value = arcSlider.value));
  // Párrafo: ancho del marco; vacío = texto artístico.
  const paragraph = h('input', { class: 'input number', type: 'number', min: 0, step: 'any', placeholder: '—', 'aria-label': 'Ancho del párrafo', title: 'Texto de párrafo: las líneas se cortan solas para caber en este ancho. Vacío = texto artístico (una línea por Enter).' });
  paragraph.addEventListener('change', () => {
    const v = Number(paragraph.value.replace(',', '.'));
    editor.setParagraphWidth(paragraph.value.trim() && v > 0 ? toMm(v, unitOf()) : null);
    refocusText();
  });
  paragraph.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') paragraph.blur();
  });
  const paragraphUnit = h('span', { class: 'prop-suffix' });
  const size = numberInput(24, (v) => change({ fontSizePt: v }), { 'aria-label': 'Tamaño de letra en puntos', min: 1, step: 1, list: 'trazo-font-sizes' });
  const sizes = h('datalist', { id: 'trazo-font-sizes' }, ...[8, 10, 12, 14, 18, 24, 32, 36, 48, 60, 72, 96, 120, 150, 200].map((n) => h('option', { value: n })));
  const bold = iconButton('bold', 'Negrita', () => change({ bold: !value().bold }), { class: 'icon-button toggle' });
  const italic = iconButton('italic', 'Cursiva', () => change({ italic: !value().italic }), { class: 'icon-button toggle' });
  const aligns: Array<[TextAlign, HTMLButtonElement]> = [
    ['left', iconButton('alignLeft', 'Alinear a la izquierda', () => change({ align: 'left' }), { class: 'icon-button toggle' })],
    ['center', iconButton('alignCenter', 'Centrar', () => change({ align: 'center' }), { class: 'icon-button toggle' })],
    ['right', iconButton('alignRight', 'Alinear a la derecha', () => change({ align: 'right' }), { class: 'icon-button toggle' })],
  ];

  // Arco, párrafo y ancho máximo en una ventanita (la barra no da para todo).
  const layoutRows = [
    h('div', { class: 'field-label' }, 'Texto en arco'),
    h('label', { class: 'pop-row' }, arcSlider, arc, h('span', { class: 'prop-suffix' }, '°')),
    h('div', { class: 'export-note' }, 'Positivo: arco hacia arriba (∩), como el nombre de la escuela. Negativo: hacia abajo (∪). 0: derecho.'),
    h('div', { class: 'field-label' }, 'Texto de párrafo'),
    h('label', { class: 'pop-row' }, h('span', { class: 'prop-label' }, 'Ancho'), paragraph, paragraphUnit),
    h('div', { class: 'export-note' }, 'Las líneas se cortan solas para caber. Vacío: texto artístico (una línea por Enter). También: arrastra con la herramienta Texto.'),
    h('div', { class: 'field-label' }, 'Ancho máximo'),
    h('label', { class: 'pop-row' }, h('span', { class: 'prop-label' }, 'Máx.'), maxWidth, maxUnit),
    h('div', { class: 'export-note' }, 'Si el texto es más largo, la letra se achica para caber (nombres en placas en serie).'),
  ];
  const layoutButton = iconButton('textArc', 'Arco, párrafo y ancho máximo del texto', undefined, { 'aria-haspopup': 'dialog', 'aria-expanded': 'false', class: 'icon-button toggle' });
  layoutButton.addEventListener('click', () => togglePopover(layoutButton, () => h('div', { class: 'pop-form' }, ...layoutRows)));

  const refresh = () => {
    const v = value();
    picker.refresh();
    const t = target === 'selection' ? firstText() : null;
    maxUnit.textContent = unitOf();
    if (document.activeElement !== maxWidth) maxWidth.value = t?.maxWidthMm ? formatLength(t.maxWidthMm * visualScale(t), unitOf()) : '';
    paragraphUnit.textContent = unitOf();
    if (document.activeElement !== paragraph) paragraph.value = t?.frameWidth ? formatLength(t.frameWidth * visualScale(t), unitOf()) : '';
    setValue(arc, String(t?.arc ?? 0));
    if (document.activeElement !== arcSlider) arcSlider.value = String(t?.arc ?? 0);
    maxWidth.disabled = !!t?.frameWidth;
    layoutButton.setAttribute('aria-pressed', String(!!(t?.arc || t?.frameWidth || t?.maxWidthMm)));
    setValue(size, String(Math.round(v.fontSizePt * 10) / 10));
    bold.setAttribute('aria-pressed', String(v.bold));
    italic.setAttribute('aria-pressed', String(v.italic));
    for (const [align, button] of aligns) button.setAttribute('aria-pressed', String(v.align === align));
  };
  refresh();
  return {
    nodes: [
      picker.element,
      field('', size, 'pt'),
      sizes,
      bold,
      italic,
      h('span', { class: 'bar-sep' }),
      ...aligns.map(([, b]) => b),
      ...(target === 'selection' ? [layoutButton] : []),
    ],
    refresh,
  };
}

/** Herramienta Forma con una figura que aún no es curva. */
function convertControls(): Controls {
  return {
    nodes: [
      h('span', { class: 'prop-title' }, icon('shape'), 'Forma'),
      h('button', { type: 'button', class: 'button', onclick: () => void nodeEdit.convertSelectionToCurves() }, icon('toCurves'), ' Convertir a curvas (Ctrl+Q)'),
      h('span', { class: 'prop-info' }, 'Para mover sus esquinas o deformarla, primero conviértela a curvas.'),
    ],
  };
}

/** Herramienta Forma sobre una curva: botones para los nodos elegidos. */
function nodeControls(): Controls {
  const info = h('span', { class: 'prop-info' });
  const needNodes: HTMLButtonElement[] = [];
  const button = (name: Parameters<typeof iconButton>[0], label: string, action: () => void) => {
    const b = iconButton(name, label, action);
    needNodes.push(b);
    return b;
  };
  const cusp = button('nodeCusp', 'Cúspide: esquina, manijas independientes', () => nodeEdit.setTypeOfSelected('cusp'));
  const smooth = button('nodeSmooth', 'Suave: manijas alineadas', () => nodeEdit.setTypeOfSelected('smooth'));
  const symmetric = button('nodeSymmetric', 'Simétrico: manijas alineadas y del mismo largo', () => nodeEdit.setTypeOfSelected('symmetric'));
  [cusp, smooth, symmetric].forEach((b) => b.classList.add('toggle'));
  const stroke = numberInput(0.2, (v) => editor.setStrokeWidth(v), { 'aria-label': 'Grosor del contorno en milímetros', min: 0, step: 0.1 });

  const refresh = () => {
    const shape = nodeEdit.currentPath();
    if (!shape) return;
    const refs = nodeEdit.selectedRefs(shape);
    info.textContent = `${nodeCount(shape)} nodos · ${refs.length ? `${refs.length} elegido${refs.length === 1 ? '' : 's'}` : 'clic o marco para elegir; doble clic en la línea añade uno'}`;
    for (const b of needNodes) b.disabled = refs.length === 0;
    const types = new Set(refs.map((r) => shape.subpaths[r.sub]!.nodes[r.node]!.type));
    cusp.setAttribute('aria-pressed', String(types.size === 1 && types.has('cusp')));
    smooth.setAttribute('aria-pressed', String(types.size === 1 && types.has('smooth')));
    symmetric.setAttribute('aria-pressed', String(types.size === 1 && types.has('symmetric')));
    setValue(stroke, String(shape.stroke ? Math.round(shape.strokeWidth * 1000) / 1000 : 0));
  };
  const nodesList: HTMLElement[] = [
    h('span', { class: 'prop-title' }, icon('shape'), 'Curva'),
    button('nodeAdd', 'Añadir nodo (a la mitad del tramo siguiente)', nodeEdit.addNodesToSelected),
    button('nodeDelete', 'Eliminar nodos (Supr)', nodeEdit.deleteSelectedNodes),
    h('span', { class: 'bar-sep' }),
    button('toLine', 'Tramo recto', () => nodeEdit.segmentsTo('line')),
    button('toCurve', 'Tramo curvo (aparecen manijas)', () => nodeEdit.segmentsTo('curve')),
    h('span', { class: 'bar-sep' }),
    cusp,
    smooth,
    symmetric,
    h('span', { class: 'bar-sep' }),
    button('closePath', 'Cerrar curva (une el último nodo con el primero)', nodeEdit.closeSelectedPaths),
    button('breakPath', 'Separar la curva en el nodo', nodeEdit.breakAtSelected),
    h('span', { class: 'bar-sep' }),
    field('Contorno', stroke, 'mm'),
    info,
  ];
  refresh();
  return { nodes: nodesList, refresh };
}

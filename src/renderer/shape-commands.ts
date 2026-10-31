import { toPath } from '../engine/path';
import { contour, intersect, ShapeOpError, trim, weld } from '../engine/shape-ops';
import type { Shape } from '../engine/shapes';
import * as editor from './editor';
import { store } from './state';
import { stopTextEditing } from './text-edit';
import { textToPath } from './text-curves';

/**
 * Soldar, recortar, intersectar, contorno y convertir a curvas, sobre la
 * selección. El texto se convierte a curvas primero (con su fuente real).
 * Cada operación es un paso del historial.
 */

const hint = (text: string) => store.set({ hint: text });

/** ¿Se puede convertir a curvas? Figuras y texto (las imágenes no). */
export const canConvert = (s: Shape) => s.kind === 'rectangle' || s.kind === 'ellipse' || s.kind === 'polygon' || s.kind === 'text';

/** Deja que la interfaz pinte el aviso "Calculando…" antes del cálculo pesado. */
const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));

/** Selección en orden de apilado, con el texto ya convertido a curvas. */
async function selectionAsCurves(): Promise<{ originals: Shape[]; shapes: Shape[]; notes: string[] }> {
  stopTextEditing();
  // El contenido de un PowerClip no participa: se opera con su contenedor.
  const selected = editor.selectedShapes();
  const ids = new Set(selected.map((s) => s.id));
  const originals = selected.filter((s) => !(s.clipId && ids.has(s.clipId)));
  const notes: string[] = [];
  const shapes: Shape[] = [];
  for (const s of originals) {
    if (s.kind === 'text') {
      const r = await textToPath(s);
      if (r.missing.length) notes.push(`La fuente no tiene: ${r.missing.join(' ')}`);
      if (r.simulated.length) notes.push(`${r.simulated.join(' y ')} simulada${r.simulated.length > 1 ? 's' : ''}`);
      shapes.push(r.path);
    } else shapes.push(s);
  }
  return { originals, shapes, notes };
}

/** El contenido de los contenedores que desaparecen pasa a la figura nueva (sigue recortado). */
function moveContents(shapes: Shape[], removed: Set<string>, to: string | null): Shape[] {
  return shapes.map((s) => {
    if (!s.clipId || !removed.has(s.clipId)) return s;
    if (to) return { ...s, clipId: to };
    const free = { ...s };
    delete free.clipId;
    return free;
  });
}

async function run(label: string, work: () => Promise<void>): Promise<void> {
  hint(`${label}: calculando…`);
  await nextFrame();
  const started = performance.now();
  try {
    await work();
  } catch (error) {
    hint(error instanceof ShapeOpError || error instanceof Error ? error.message : String(error));
    return;
  }
  const ms = performance.now() - started;
  if (ms > 1500) console.info(`${label}: ${Math.round(ms)} ms`);
}

/** Rectángulos, elipses, polígonos y textos seleccionados → curvas (Ctrl+Q). */
export function convertToCurves(): Promise<void> {
  return run('Convertir a curvas', async () => {
    const ids = new Set(store.get().selection);
    const targets = editor.selectedShapes().filter(canConvert);
    if (targets.length === 0) {
      hint(ids.size ? 'Solo figuras y textos se pueden convertir a curvas (las imágenes no).' : 'Selecciona una figura o un texto para convertirlo a curvas.');
      return;
    }
    stopTextEditing();
    const converted = new Map<string, Shape>();
    const notes: string[] = [];
    for (const s of targets) {
      if (s.kind === 'text') {
        const r = await textToPath(s);
        if (r.missing.length) notes.push(`la fuente no tiene: ${r.missing.join(' ')}`);
        if (r.simulated.length) notes.push(`${r.simulated.join(' y ')} simulada`);
        converted.set(s.id, r.path);
      } else {
        const p = toPath(s);
        if (p) converted.set(s.id, p);
      }
    }
    editor.commit('Convertir a curvas', store.get().document.shapes.map((s) => converted.get(s.id) ?? s));
    hint(`Convertido a curvas${notes.length ? ` (${notes.join('; ')})` : ''}. Edita sus nodos con la herramienta Forma (F10).`);
  });
}

/** Soldar: la selección se vuelve una sola figura, donde estaba la de más atrás. */
export function weldSelection(): Promise<void> {
  return run('Soldar', async () => {
    const { originals, shapes, notes } = await selectionAsCurves();
    const result = weld(shapes);
    const ids = new Set(originals.map((s) => s.id));
    const doc = store.get().document.shapes;
    const at = doc.findIndex((s) => ids.has(s.id));
    const rest = doc.filter((s) => !ids.has(s.id));
    const next = moveContents(result ? [...rest.slice(0, at), result, ...rest.slice(at)] : rest, ids, result?.id ?? null);
    editor.commit('Soldar', next, result ? [result.id] : []);
    hint(`Soldado: ${originals.length} objetos en uno${notes.length ? ` (${notes.join('; ')})` : ''}.`);
  });
}

/** Recortar: al de más atrás se le quita la forma de los de delante (estos se conservan). */
export function trimSelection(): Promise<void> {
  return run('Recortar', async () => {
    const { originals, shapes } = await selectionAsCurves();
    const result = trim(shapes);
    const target = originals[0]!;
    const doc = store.get().document.shapes;
    const next = moveContents(result ? doc.map((s) => (s.id === target.id ? result : s)) : doc.filter((s) => s.id !== target.id), new Set([target.id]), result?.id ?? null);
    editor.commit('Recortar', next, result ? [result.id] : []);
    hint(result ? 'Recortado: el objeto de atrás quedó con la forma de los de delante.' : 'El recorte no dejó nada del objeto de atrás.');
  });
}

/** Intersectar: figura nueva con lo que tienen en común, encima de la selección. */
export function intersectSelection(): Promise<void> {
  return run('Intersectar', async () => {
    const { originals, shapes } = await selectionAsCurves();
    const result = intersect(shapes);
    if (!result) {
      hint('Los objetos no se tocan: no hay nada en común.');
      return;
    }
    const doc = store.get().document.shapes;
    const top = Math.max(...originals.map((o) => doc.findIndex((s) => s.id === o.id)));
    editor.commit('Intersectar', [...doc.slice(0, top + 1), result, ...doc.slice(top + 1)], [result.id]);
    hint('Intersección creada (los originales se conservan).');
  });
}

export interface ContourOptions {
  distance: number;
  direction: 'outside' | 'inside';
  fill: string | null;
}

/** Contorno: figura nueva alrededor (detrás) o dentro (encima) de la selección. */
export function contourSelection(options: ContourOptions): Promise<void> {
  return run('Contorno', async () => {
    const { originals, shapes } = await selectionAsCurves();
    const result = contour(shapes, options.distance, options.direction, options.fill);
    if (!result) {
      hint('Con esa distancia el contorno interior no deja nada. Prueba con menos milímetros.');
      return;
    }
    const doc = store.get().document.shapes;
    const indexes = originals.map((o) => doc.findIndex((s) => s.id === o.id));
    const at = options.direction === 'outside' ? Math.min(...indexes) : Math.max(...indexes) + 1;
    editor.commit('Contorno', [...doc.slice(0, at), result, ...doc.slice(at)], [result.id]);
    hint(`Contorno ${options.direction === 'outside' ? 'exterior' : 'interior'} de ${options.distance} mm creado.`);
  });
}

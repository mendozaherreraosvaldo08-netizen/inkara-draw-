import type { Rect, Shape } from './shapes';
import { shapeBounds, unionBounds } from './shapes';

/**
 * Agrupar, PowerClip, alinear y distribuir.
 *
 * Una "unidad" es lo que se mueve junto: un objeto suelto, un grupo (mismo
 * groupId) o un contenedor de PowerClip con todo su contenido.
 */

export type AlignMode = 'left' | 'center-x' | 'right' | 'top' | 'center-y' | 'bottom' | 'page-center';

/** Ids de todo lo que va junto con `ids`: miembros de sus grupos y contenido de sus contenedores. */
export function expandIds(shapes: Shape[], ids: Iterable<string>): Set<string> {
  const out = new Set(ids);
  const byId = new Map(shapes.map((s) => [s.id, s]));
  // El contenido de un contenedor no se elige suelto: se elige su contenedor.
  for (const id of [...out]) {
    let s = byId.get(id);
    while (s?.clipId && byId.has(s.clipId)) {
      out.delete(s.id);
      s = byId.get(s.clipId);
      if (s) out.add(s.id);
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    const groups = new Set(shapes.filter((s) => out.has(s.id) && s.groupId).map((s) => s.groupId!));
    for (const s of shapes) {
      const join = (s.groupId && groups.has(s.groupId)) || (s.clipId && out.has(s.clipId));
      if (join && !out.has(s.id)) {
        out.add(s.id);
        changed = true;
      }
    }
  }
  return out;
}

/** ¿Este objeto está dentro de un contenedor que también está en la lista? */
export const isClipChild = (s: Shape, ids: Set<string>) => !!s.clipId && ids.has(s.clipId);

/** Caja de un conjunto: sin contar lo que está dentro de un contenedor (lo que sobresale no se ve). */
export function visibleBounds(shapes: Shape[]): Rect | null {
  const ids = new Set(shapes.map((s) => s.id));
  return unionBounds(shapes.filter((s) => !isClipChild(s, ids)).map(shapeBounds));
}

/** Parte la selección en unidades (cada una se alinea como un bloque). */
export function unitsOf(all: Shape[], selected: Shape[]): Array<{ ids: Set<string>; bounds: Rect }> {
  const remaining = new Set(selected.map((s) => s.id));
  const units: Array<{ ids: Set<string>; bounds: Rect }> = [];
  for (const s of selected) {
    if (!remaining.has(s.id)) continue;
    const ids = expandIds(all, [s.id]);
    for (const id of ids) remaining.delete(id);
    const members = all.filter((x) => ids.has(x.id));
    const bounds = visibleBounds(members);
    if (bounds) units.push({ ids, bounds });
  }
  return units;
}

/**
 * Cuánto mover cada unidad para alinearla. Con una sola unidad (o con
 * "page-center") se alinea a la página; con varias, a la caja de todas.
 */
export function alignOffsets(units: Array<{ bounds: Rect }>, mode: AlignMode, page: Rect): Array<{ dx: number; dy: number }> {
  const ref = mode === 'page-center' || units.length === 1 ? page : unionBounds(units.map((u) => u.bounds))!;
  return units.map(({ bounds: b }) => {
    switch (mode) {
      case 'left':
        return { dx: ref.x - b.x, dy: 0 };
      case 'right':
        return { dx: ref.x + ref.width - (b.x + b.width), dy: 0 };
      case 'center-x':
        return { dx: ref.x + ref.width / 2 - (b.x + b.width / 2), dy: 0 };
      case 'top':
        return { dx: 0, dy: ref.y - b.y };
      case 'bottom':
        return { dx: 0, dy: ref.y + ref.height - (b.y + b.height) };
      case 'center-y':
        return { dx: 0, dy: ref.y + ref.height / 2 - (b.y + b.height / 2) };
      case 'page-center':
        return { dx: ref.x + ref.width / 2 - (b.x + b.width / 2), dy: ref.y + ref.height / 2 - (b.y + b.height / 2) };
    }
  });
}

/** Distribuir: mismo espacio entre unidades (de la primera a la última, sin moverlas a ellas). */
export function distributeOffsets(units: Array<{ bounds: Rect }>, axis: 'x' | 'y'): Array<{ dx: number; dy: number }> {
  const out = units.map(() => ({ dx: 0, dy: 0 }));
  if (units.length < 3) return out;
  const pos = (r: Rect) => (axis === 'x' ? r.x : r.y);
  const size = (r: Rect) => (axis === 'x' ? r.width : r.height);
  const order = units.map((u, i) => i).sort((a, b) => pos(units[a]!.bounds) - pos(units[b]!.bounds));
  const first = units[order[0]!]!.bounds;
  const last = units[order[order.length - 1]!]!.bounds;
  const total = pos(last) + size(last) - pos(first);
  const used = units.reduce((t, u) => t + size(u.bounds), 0);
  const gap = (total - used) / (units.length - 1);
  let cursor = pos(first);
  for (const i of order) {
    const b = units[i]!.bounds;
    const d = cursor - pos(b);
    out[i] = axis === 'x' ? { dx: d, dy: 0 } : { dx: 0, dy: d };
    cursor += size(b) + gap;
  }
  return out;
}

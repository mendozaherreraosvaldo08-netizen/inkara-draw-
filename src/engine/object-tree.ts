import type { ImageAsset } from './document';
import { KIND_LABELS, type Shape } from './shapes';

/**
 * Árbol del administrador de objetos: de adelante (arriba en la lista) hacia
 * atrás. Los grupos son una fila con sus piezas dentro; el contenido de un
 * PowerClip cuelga de su contenedor.
 */
export interface ObjectNode {
  key: string;
  type: 'shape' | 'group';
  /** El objeto (en filas de objeto). */
  shape?: Shape;
  /** Todo lo que representa la fila: el objeto, su contenido o las piezas del grupo. */
  ids: string[];
  children: ObjectNode[];
}

export function buildObjectTree(shapes: Shape[]): ObjectNode[] {
  const byId = new Map(shapes.map((s) => [s.id, s]));
  const inside = new Map<string, Shape[]>();
  for (const s of shapes) if (s.clipId && byId.has(s.clipId)) inside.set(s.clipId, [...(inside.get(s.clipId) ?? []), s]);
  const isChild = (s: Shape) => !!(s.clipId && byId.has(s.clipId));

  const shapeNode = (s: Shape, depth = 0): ObjectNode => {
    const children = depth > 8 ? [] : [...(inside.get(s.id) ?? [])].reverse().map((c) => shapeNode(c, depth + 1));
    return { key: s.id, type: 'shape', shape: s, ids: [s.id, ...children.flatMap((c) => c.ids)], children };
  };

  const out: ObjectNode[] = [];
  const doneGroups = new Set<string>();
  for (let i = shapes.length - 1; i >= 0; i--) {
    const s = shapes[i]!;
    if (isChild(s)) continue;
    if (!s.groupId) {
      out.push(shapeNode(s));
      continue;
    }
    if (doneGroups.has(s.groupId)) continue;
    doneGroups.add(s.groupId);
    const members = shapes.filter((m) => m.groupId === s.groupId && !isChild(m)).reverse();
    if (members.length === 1) {
      out.push(shapeNode(s));
      continue;
    }
    const children = members.map((m) => shapeNode(m));
    out.push({ key: `grupo:${s.groupId}`, type: 'group', ids: children.flatMap((c) => c.ids), children });
  }
  return out;
}

/** Nombre que se muestra: el que puso el usuario o uno descriptivo. */
export function objectName(shape: Shape, assets: Record<string, ImageAsset>): string {
  if (shape.name) return shape.name;
  if (shape.kind === 'text') {
    const first = shape.text.split('\n')[0]!.trim();
    return first ? `Texto «${first.length > 28 ? `${first.slice(0, 28).trimEnd()}…` : first}»` : 'Texto';
  }
  if (shape.kind === 'image') return `Imagen ${assets[shape.assetId]?.name ?? ''}`.trim();
  return KIND_LABELS[shape.kind];
}

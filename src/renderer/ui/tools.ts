import type { IconName } from './icons';
import type { ToolId } from '../state';

export interface ToolDef {
  id: ToolId;
  label: string;
  icon: IconName;
  /** Atajo de teclado (los habituales en editores vectoriales). */
  shortcut?: string;
  /** Lo que muestra la barra de estado al elegirla. */
  hint: string;
  /** Tiene variantes agrupadas (se marcan con un triángulo, como un menú desplegable). */
  flyout?: boolean;
}

/** Grupos separados por una línea en la caja de herramientas. */
export const TOOL_GROUPS: ToolDef[][] = [
  [
    { id: 'select', label: 'Selección', icon: 'select', shortcut: 'V', hint: 'Haz clic en un objeto para seleccionarlo; arrastra para seleccionar varios', flyout: true },
    { id: 'shape', label: 'Forma', icon: 'shape', shortcut: 'F10', hint: 'Edita los nodos y curvas de un objeto', flyout: true },
    { id: 'crop', label: 'Recortar', icon: 'crop', shortcut: 'K', hint: 'Arrastra sobre una foto el área que quieres conservar; Enter o doble clic para aplicar', flyout: true },
    { id: 'zoom', label: 'Zoom', icon: 'zoom', shortcut: 'Z', hint: 'Clic para acercar, Mayús + clic para alejar', flyout: true },
    { id: 'pan', label: 'Mano', icon: 'pan', shortcut: 'H', hint: 'Arrastra para mover la vista (también: barra espaciadora o rueda del ratón)' },
  ],
  [
    { id: 'freehand', label: 'Mano alzada', icon: 'freehand', shortcut: 'F5', hint: 'Dibuja líneas y curvas a mano alzada', flyout: true },
    { id: 'pen', label: 'Pluma', icon: 'pen', shortcut: 'P', hint: 'Dibuja curvas Bézier nodo por nodo', flyout: true },
  ],
  [
    { id: 'rectangle', label: 'Rectángulo', icon: 'rectangle', shortcut: 'F6', hint: 'Arrastra para dibujar un rectángulo; Ctrl para un cuadrado', flyout: true },
    { id: 'ellipse', label: 'Elipse', icon: 'ellipse', shortcut: 'F7', hint: 'Arrastra para dibujar una elipse; Ctrl para un círculo', flyout: true },
    { id: 'polygon', label: 'Polígono', icon: 'polygon', shortcut: 'Y', hint: 'Dibuja polígonos y estrellas', flyout: true },
    { id: 'text', label: 'Texto', icon: 'text', shortcut: 'F8', hint: 'Clic para texto artístico; arrastra para un párrafo' },
  ],
  [
    { id: 'transparency', label: 'Transparencia', icon: 'transparency', hint: 'Aplica transparencia uniforme o degradada', flyout: true },
    { id: 'eyedropper', label: 'Cuentagotas', icon: 'eyedropper', shortcut: 'I', hint: 'Clic: pone ese color de relleno a lo seleccionado (Mayús+clic: al contorno). Sin selección, queda para los objetos nuevos', flyout: true },
    { id: 'fill', label: 'Relleno interactivo', icon: 'fill', shortcut: 'G', hint: 'Aplica rellenos uniformes, degradados o de patrón', flyout: true },
  ],
];

export const ALL_TOOLS = TOOL_GROUPS.flat();

export const toolById = (id: ToolId): ToolDef => ALL_TOOLS.find((tool) => tool.id === id) ?? ALL_TOOLS[0]!;

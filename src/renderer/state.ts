import { createDocument, type TrazoDocument } from '../engine/document';
import type { TransformMode } from '../engine/selection';
import type { TextAlign } from '../engine/shapes';

/** Letra por defecto de los textos nuevos. */
export interface TextDefaults {
  fontFamily: string;
  fontSizePt: number;
  bold: boolean;
  italic: boolean;
  align: TextAlign;
}

export type ToolId =
  | 'select'
  | 'shape'
  | 'crop'
  | 'zoom'
  | 'pan'
  | 'freehand'
  | 'pen'
  | 'rectangle'
  | 'ellipse'
  | 'polygon'
  | 'text'
  | 'fill'
  | 'transparency'
  | 'eyedropper';

/** Color con nombre (el de la paleta) o null = "sin color". */
export interface Swatch {
  name: string;
  hex: string;
}

export interface AppState {
  document: TrazoDocument;
  tool: ToolId;
  fill: Swatch | null;
  outline: Swatch | null;
  zoom: number;
  /** Posición del cursor en el documento (mm); null si está fuera del lienzo. */
  cursorMm: { x: number; y: number } | null;
  showBleed: boolean;
  showSafeArea: boolean;
  /** Mensaje temporal de la barra de estado. */
  hint: string;
  /** Ids de los objetos seleccionados (en orden de apilado). */
  selection: string[];
  /** Tiradores de escala o de rotación (un segundo clic alterna). */
  transformMode: TransformMode;
  /** Estilo por defecto de los objetos nuevos. */
  strokeWidth: number;
  cornerRadius: number;
  sides: number;
  text: TextDefaults;
  /** Archivo .trz del documento (null = aún no se guardó). */
  filePath: string | null;
  /** Hay cambios sin guardar. */
  dirty: boolean;
  /** Placas en serie: fila que se ve en el lienzo (null = el diseño con sus campos). */
  mergePreview: number | null;
  /** Nodos elegidos con la herramienta Forma ("subtrayecto:nodo"). */
  nodeSelection: string[];
  /** Texto que se está escribiendo (con cursor), o null. */
  editingTextId: string | null;
  /** Imán: a qué se pegan los objetos al moverlos, dibujarlos o escalarlos. */
  snap: { enabled: boolean; guides: boolean; objects: boolean; page: boolean };
  showGuides: boolean;
  /** Tema de la interfaz: oscuro o claro (área de trabajo blanca). */
  uiTheme: 'dark' | 'light';
  /** Panel del administrador de objetos abierto. */
  showObjectManager: boolean;
  /** Herramienta Recortar: rectángulo elegido, aún sin aplicar (mm). */
  cropArea: { x: number; y: number; width: number; height: number } | null;
  /** Estado del historial, para habilitar Deshacer / Rehacer. */
  history: { canUndo: boolean; canRedo: boolean; undoLabel: string | null; redoLabel: string | null };
}

/** Tema guardado de la vez anterior (por defecto, oscuro). */
function savedTheme(): 'dark' | 'light' {
  try {
    return localStorage.getItem('trazo.theme') === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

type Listener = (state: AppState, previous: AppState) => void;

/**
 * Estado global mínimo con suscripciones (sin librerías). Cada parte de la
 * interfaz se suscribe y se repinta solo cuando cambia lo que le importa.
 */
class Store {
  private state: AppState = {
    document: createDocument('Placa graduación 2026'),
    tool: 'select',
    // Como en los editores vectoriales: los objetos nuevos nacen sin relleno y con contorno negro fino.
    fill: null,
    outline: { name: 'Negro', hex: '#000000' },
    zoom: 1,
    cursorMm: null,
    showBleed: true,
    showSafeArea: true,
    hint: 'Listo',
    selection: [],
    transformMode: 'scale',
    strokeWidth: 0.2,
    cornerRadius: 0,
    sides: 5,
    text: { fontFamily: 'Arial', fontSizePt: 24, bold: false, italic: false, align: 'left' },
    editingTextId: null,
    nodeSelection: [],
    mergePreview: null,
    filePath: null,
    dirty: false,
    history: { canUndo: false, canRedo: false, undoLabel: null, redoLabel: null },
    snap: { enabled: true, guides: true, objects: true, page: true },
    showGuides: true,
    showObjectManager: false,
    uiTheme: savedTheme(),
    cropArea: null,
  };
  private readonly listeners = new Set<Listener>();

  get(): AppState {
    return this.state;
  }

  set(patch: Partial<AppState>): void {
    const previous = this.state;
    this.state = { ...previous, ...patch };
    for (const listener of this.listeners) listener(this.state, previous);
  }

  /** Cambia la página del documento (tamaño, sangrado…) creando un objeto nuevo. */
  updatePage(patch: Partial<AppState['document']['page']>): void {
    const doc = this.state.document;
    this.set({ document: { ...doc, page: { ...doc.page, ...patch } } });
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export const store = new Store();

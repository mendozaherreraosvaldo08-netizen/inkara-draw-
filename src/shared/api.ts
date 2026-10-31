/**
 * Contrato entre el proceso principal y la interfaz. La interfaz NUNCA tiene
 * acceso directo a Node ni a Electron: solo a lo que el preload expone aquí,
 * como `window.trazo`.
 */
export const IPC = {
  appInfo: 'app:info',
  captureWindow: 'app:capture',
  windowState: 'window:state',
  fontsSystem: 'fonts:system',
  fontsCatalog: 'fonts:catalog',
  fontsDownloaded: 'fonts:downloaded',
  fontsDownload: 'fonts:download',
  fontsRead: 'fonts:read',
  fontsInstall: 'fonts:install',
  fontsFile: 'fonts:file',
  fileOpenDialog: 'file:open-dialog',
  fileOpenPath: 'file:open-path',
  fileSave: 'file:save',
  fileImport: 'file:import',
  fileExport: 'file:export',
  printImage: 'print:image',
  folderChoose: 'folder:choose',
  folderWrite: 'folder:write',
  fileRecent: 'file:recent',
  fileAutosave: 'file:autosave',
  fileRecovery: 'file:recovery',
  fileOpenRequest: 'file:open-request',
  docState: 'doc:state',
  confirmUnsaved: 'doc:confirm-unsaved',
  saveThenClose: 'app:save-then-close',
  closeWindow: 'app:close',
  setTheme: 'app:theme',
  templatesList: 'templates:list',
  templatesSave: 'templates:save',
  templatesRead: 'templates:read',
  templatesRemove: 'templates:remove',
  templatesSetCategory: 'templates:set-category',
  elementsList: 'elements:list',
  elementsSave: 'elements:save',
  elementsRead: 'elements:read',
  elementsRemove: 'elements:remove',
} as const;

/** Plantilla guardada en la biblioteca. */
export interface LibraryApi {
  list(): Promise<TemplateInfo[]>;
  save(name: string, content: string, thumbnail: Uint8Array<ArrayBuffer> | null, category?: string): Promise<Result<string>>;
  read(name: string): Promise<Result<string>>;
  remove(name: string): Promise<Result<void>>;
}

export interface TemplateInfo {
  name: string;
  modified: number;
  /** Miniatura PNG en base64 (o null). */
  thumbnail: string | null;
  /** Categoría (Diplomas, Graduación…); vacía = sin categoría. */
  category: string;
}

/** Familia del catálogo de Google Fonts (libres para uso comercial). */
export interface CatalogFamily {
  family: string;
  /** "Serif", "Sans Serif", "Display", "Handwriting", "Monospace". */
  category: string;
  popularity: number;
}

/** Un archivo de fuente descargado (una variante: normal, negrita, cursiva…). */
export interface FontFile {
  weight: number;
  style: 'normal' | 'italic';
  path: string;
}

export interface DownloadedFamily {
  family: string;
  source: 'google';
  files: FontFile[];
  /** Si ya se instaló en Windows (para el usuario actual). */
  installed: boolean;
}

export interface FontFileData {
  bytes: Uint8Array<ArrayBuffer>;
  /** Si el archivo ya es negrita / cursiva (si no, hay que simularlo). */
  bold: boolean;
  italic: boolean;
}

/** Resultado de una operación que puede fallar con un mensaje para el usuario. */
export type Result<T> = { ok: true; value: T } | { ok: false; error: string; canceled?: boolean };

/** Un diseño leído del disco. */
export interface OpenedFile {
  path: string;
  /** Nombre sin extensión (para la pestaña y el título). */
  name: string;
  content: string;
}

/** Un archivo importado (imagen o SVG). */
export interface ImportedFile {
  name: string;
  mime: string;
  bytes: Uint8Array<ArrayBuffer>;
}

export interface RecentFile {
  path: string;
  name: string;
}

export type ExportExtension = 'svg' | 'png' | 'jpg' | 'pdf' | 'html' | 'inkpack';

export interface PrintRequest {
  /** PNG ya listo (con espejo, sangrado… según las opciones). */
  png: Uint8Array<ArrayBuffer>;
  widthMm: number;
  heightMm: number;
  title: string;
}

/** Lo que el usuario eligió al avisarle de cambios sin guardar. */
export type UnsavedChoice = 'save' | 'discard' | 'cancel';

export interface AppInfo {
  name: string;
  version: string;
  platform: NodeJS.Platform;
  /** Versiones del motor, para la ventana "Acerca de". */
  versions: { electron: string; chrome: string; node: string };
}

export interface WindowState {
  maximized: boolean;
  fullscreen: boolean;
}

export interface TrazoApi {
  getAppInfo(): Promise<AppInfo>;
  /** Captura de la ventana (PNG), para reportar un problema. */
  captureWindow?(): Promise<Uint8Array<ArrayBuffer> | null>;
  /** Tema de la interfaz: también pinta los botones nativos de la ventana. */
  setTheme?(theme: UiTheme): void;
  /** Avisa cuando la ventana se maximiza, restaura o pasa a pantalla completa. */
  onWindowState(listener: (state: WindowState) => void): () => void;
  files: {
    /** Diálogo "Abrir". */
    openDialog(): Promise<Result<OpenedFile>>;
    /** Abre un archivo reciente (o el que se abrió con doble clic en el Explorador). */
    openPath(path: string): Promise<Result<OpenedFile>>;
    /** Guarda. Sin `path` (o con `saveAs`) pregunta dónde. */
    save(options: { content: string; path: string | null; suggestedName: string; saveAs: boolean }): Promise<Result<{ path: string; name: string }>>;
    /** Diálogo "Importar": imágenes y SVG. */
    importDialog(): Promise<Result<ImportedFile[]>>;
    /** Diálogo "Exportar": SVG (texto) o PNG / JPG / PDF (bytes). */
    exportFile(options: { content: string | Uint8Array<ArrayBuffer>; suggestedName: string; extension: ExportExtension }): Promise<Result<string>>;
    /** Elige una carpeta para guardar varias placas. Devuelve una clave para escribir en ella. */
    chooseFolder(title: string): Promise<Result<{ token: string; path: string }>>;
    /** Guarda un archivo en la carpeta elegida (sin pisar otro: añade "(2)"). Devuelve el nombre final. */
    writeToFolder(token: string, name: string, bytes: Uint8Array<ArrayBuffer>): Promise<Result<string>>;
    /** Imprime una imagen al tamaño exacto (mm), con el diálogo de impresión de Windows. */
    printImage(options: PrintRequest): Promise<Result<void>>;
    recent(): Promise<RecentFile[]>;
    /** Copia de seguridad automática del trabajo sin guardar (null = borrarla). */
    autosave(content: string | null): Promise<void>;
    /** Al arrancar: si quedó trabajo sin guardar (cierre inesperado), pregunta si recuperarlo. */
    takeRecovery(): Promise<string | null>;
    /** El proceso principal pide abrir un archivo (doble clic en el Explorador). */
    onOpenRequest(listener: (path: string) => void): () => void;
  };
  /** Biblioteca de plantillas (en la carpeta de datos de Trazo). */
  /** Biblioteca de elementos (logos, escudos, marcos, adornos): misma forma que las plantillas. */
  elements?: LibraryApi;
  templates: {
    list(): Promise<TemplateInfo[]>;
    save(name: string, content: string, thumbnail: Uint8Array<ArrayBuffer> | null, category?: string): Promise<Result<string>>;
    setCategory(name: string, category: string): Promise<Result<void>>;
    read(name: string): Promise<Result<string>>;
    remove(name: string): Promise<Result<void>>;
  };
  document: {
    /** Informa si hay cambios sin guardar (para avisar al cerrar) y el nombre. */
    reportState(state: { dirty: boolean; name: string }): void;
    /** Pregunta qué hacer con los cambios sin guardar. */
    confirmUnsaved(name: string): Promise<UnsavedChoice>;
    /** Al cerrar con cambios y elegir "Guardar": la interfaz guarda y luego llama a closeWindow. */
    onSaveThenClose(listener: () => void): () => void;
    closeWindow(): void;
  };
  fonts: {
    /** Familias instaladas en el sistema. */
    listSystem(): Promise<string[]>;
    /** Catálogo de Google Fonts (se guarda en caché una semana). */
    catalog(): Promise<Result<CatalogFamily[]>>;
    /** Fuentes que Trazo ya descargó (se cargan al abrir la app). */
    listDownloaded(): Promise<DownloadedFamily[]>;
    /** Descarga una familia del catálogo (normal, cursiva, negrita y negrita cursiva si existen). */
    download(family: string): Promise<Result<DownloadedFamily>>;
    read(path: string): Promise<Uint8Array<ArrayBuffer>>;
    /**
     * El archivo de una fuente (para convertir texto a curvas). Si no existe la
     * variante negrita/cursiva, devuelve la normal e indica qué falta simular.
     */
    fontFile(request: { family: string; bold: boolean; italic: boolean }): Promise<Result<FontFileData>>;
    /** Instala una fuente descargada en Windows para el usuario actual (sin permisos de administrador). */
    install(family: string): Promise<Result<DownloadedFamily>>;
  };
}

/**
 * Alto de la barra de título integrada (la de los menús). En Windows los botones
 * minimizar / maximizar / cerrar se dibujan encima, a la derecha (titleBarOverlay).
 */
export const TITLE_BAR_HEIGHT = 34;

/** Colores del tema oscuro que también usa el proceso principal (fondo y botones nativos). */
export const THEME = {
  background: '#1e1f22',
  titleBar: '#26272b',
  titleBarSymbols: '#d6d7db',
} as const;

/** Tema claro (área de trabajo blanca). */
export const LIGHT_THEME = {
  background: '#eef0f3',
  titleBar: '#e3e5e9',
  titleBarSymbols: '#1f2328',
} as const;

export type UiTheme = 'dark' | 'light';

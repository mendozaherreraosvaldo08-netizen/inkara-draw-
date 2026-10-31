import path from 'node:path';
import { app, BrowserWindow, ipcMain, Menu, nativeTheme, session, shell } from 'electron';
import { FileService } from './files';
import { FontService } from './fonts';
import { printImage } from './print';
import { TemplateService } from './templates';
import { IPC, LIGHT_THEME, THEME, TITLE_BAR_HEIGHT, type AppInfo, type WindowState } from '../shared/api';

/**
 * Proceso principal: crea la ventana y es el único con acceso al sistema
 * (archivos, diálogos, impresoras… en pasos siguientes). La interfaz corre
 * aislada y le pide cosas por IPC a través del preload.
 */

// Los datos (plantillas, fuentes, recientes, ajustes) siguen en la carpeta de
// siempre aunque la app ahora se llame Inkara Draw: no se pierde nada al actualizar.
app.setPath('userData', path.join(app.getPath('appData'), 'Trazo'));
// La animación de inicio suena la primera vez sin tener que hacer clic.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// Una sola instancia: abrir Inkara Draw otra vez enfoca la ventana existente.
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

// Windows: agrupa las ventanas y notificaciones bajo Inkara Draw (mismo id que el instalador).
if (process.platform === 'win32') app.setAppUserModelId('mx.trazo.editor');

// Tema oscuro nativo: diálogos, menús contextuales y barras de desplazamiento del sistema.
nativeTheme.themeSource = 'dark';

let mainWindow: BrowserWindow | null = null;
/** Estado del documento que informa la interfaz (para avisar al cerrar). */
let docState = { dirty: false, name: 'Sin título' };
/** true cuando el usuario ya decidió cerrar (guardó o eligió "No guardar"). */
let closeConfirmed = false;

/** Un diseño (.ink, o .trz de versiones anteriores) pasado al abrir la app (doble clic o "Abrir con"). */
function designFromArgs(argv: string[]): string | null {
  return argv.slice(1).find((arg) => /\.(ink|trz)$/i.test(arg) && !arg.startsWith('-')) ?? null;
}

function windowState(win: BrowserWindow): WindowState {
  return { maximized: win.isMaximized(), fullscreen: win.isFullScreen() };
}

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1600,
    height: 960,
    minWidth: 1024,
    minHeight: 640,
    show: false, // se muestra ya maximizada y pintada: sin parpadeo blanco
    backgroundColor: THEME.background,
    title: 'Inkara Draw',
    icon: path.join(__dirname, '../../assets/icon.png'),
    // Barra de título integrada: los menús de la app ocupan la franja superior y
    // Windows dibuja encima sus botones nativos (minimizar, maximizar, cerrar).
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: THEME.titleBar,
      symbolColor: THEME.titleBarSymbols,
      height: TITLE_BAR_HEIGHT,
    },
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      // Seguridad: la interfaz no puede usar Node; solo lo que expone el preload.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      // El lienzo dibuja mucho: que no se frene al quedar en segundo plano.
      backgroundThrottling: false,
    },
  });

  win.once('ready-to-show', () => {
    win.maximize();
    win.show();
  });

  // Cerrar con cambios sin guardar: Guardar / No guardar / Cancelar.
  win.on('close', (event) => {
    if (closeConfirmed || !docState.dirty) return;
    event.preventDefault();
    void files.confirmUnsaved(docState.name).then(async (choice) => {
      if (choice === 'cancel') return;
      if (choice === 'save') {
        // La interfaz guarda (puede preguntar dónde) y, si se guardó, pide cerrar.
        win.webContents.send(IPC.saveThenClose);
        return;
      }
      await files.autosave(null);
      closeConfirmed = true;
      win.close();
    });
  });

  const sendState = () => win.webContents.send(IPC.windowState, windowState(win));
  for (const event of ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen'] as const) {
    win.on(event as 'maximize', sendState);
  }

  // Los enlaces externos se abren en el navegador, nunca dentro de la app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event) => event.preventDefault());

  void win.loadFile(path.join(__dirname, '../renderer/index.html'));
  return win;
}

// ---- Archivos ----
const files = new FileService(app.getPath('userData'), () => mainWindow);
const launchFile = designFromArgs(process.argv);
if (launchFile) files.allow(launchFile);
const textArg = (value: unknown, max = 4096): string => {
  if (typeof value !== 'string' || value.length > max) throw new Error('Argumento no válido');
  return value;
};
ipcMain.handle(IPC.fileOpenDialog, () => files.openDialog());
ipcMain.handle(IPC.fileOpenPath, (_event, file: unknown) => files.openPath(textArg(file)));
ipcMain.handle(IPC.fileSave, (_event, options: unknown) => {
  const o = (options ?? {}) as Record<string, unknown>;
  return files.save({ content: textArg(o.content, 1024 * 1024 * 1024), path: o.path === null ? null : textArg(o.path), suggestedName: textArg(o.suggestedName, 300), saveAs: o.saveAs === true });
});
ipcMain.handle(IPC.fileImport, () => files.importDialog());
const bytesArg = (value: unknown): Uint8Array => {
  if (!(value instanceof Uint8Array) || value.length > 2 * 1024 * 1024 * 1024) throw new Error('Argumento no válido');
  return value;
};
ipcMain.handle(IPC.fileExport, (_event, options: unknown) => {
  const o = (options ?? {}) as Record<string, unknown>;
  const extension = o.extension;
  if (extension !== 'svg' && extension !== 'png' && extension !== 'jpg' && extension !== 'pdf' && extension !== 'html' && extension !== 'inkpack') throw new Error('Formato no válido');
  const content = extension === 'svg' || extension === 'html' || extension === 'inkpack' ? textArg(o.content, 1024 * 1024 * 1024) : bytesArg(o.content);
  return files.exportFile({ content, suggestedName: textArg(o.suggestedName, 300), extension });
});
ipcMain.handle(IPC.folderChoose, (_event, title: unknown) => files.chooseFolder(textArg(title, 200)));
ipcMain.handle(IPC.folderWrite, (_event, token: unknown, name: unknown, bytes: unknown) => files.writeToFolder(textArg(token, 100), textArg(name, 300), bytesArg(bytes)));
ipcMain.handle(IPC.printImage, (event, options: unknown) => {
  const o = (options ?? {}) as Record<string, unknown>;
  return printImage(BrowserWindow.fromWebContents(event.sender), {
    png: bytesArg(o.png) as Uint8Array<ArrayBuffer>,
    widthMm: Number(o.widthMm),
    heightMm: Number(o.heightMm),
    title: textArg(o.title, 300),
  });
});
ipcMain.handle(IPC.fileRecent, () => files.recent());
// Tema claro u oscuro: botones nativos de la ventana, fondo y diálogos del sistema.
ipcMain.on(IPC.setTheme, (event, theme: unknown) => {
  const light = theme === 'light';
  const colors = light ? LIGHT_THEME : THEME;
  nativeTheme.themeSource = light ? 'light' : 'dark';
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  win.setBackgroundColor(colors.background);
  if (process.platform === 'win32') win.setTitleBarOverlay({ color: colors.titleBar, symbolColor: colors.titleBarSymbols, height: TITLE_BAR_HEIGHT });
});
const templates = new TemplateService(path.join(app.getPath('userData'), 'plantillas'));
ipcMain.handle(IPC.templatesList, () => templates.list());
ipcMain.handle(IPC.templatesSave, (_event, name: unknown, content: unknown, thumbnail: unknown, category: unknown) => templates.save(textArg(name, 200), textArg(content, 1024 * 1024 * 1024), thumbnail === null ? null : bytesArg(thumbnail), category === undefined ? undefined : textArg(category, 40)));
ipcMain.handle(IPC.templatesSetCategory, (_event, name: unknown, category: unknown) => templates.setCategory(textArg(name, 200), textArg(category, 40)));
// Biblioteca de elementos (logos, escudos, marcos…): misma lógica que las plantillas, otra carpeta.
const elements = new TemplateService(path.join(app.getPath('userData'), 'elementos'));
ipcMain.handle(IPC.elementsList, () => elements.list());
ipcMain.handle(IPC.elementsSave, (_event, name: unknown, content: unknown, thumbnail: unknown, category: unknown) => elements.save(textArg(name, 200), textArg(content, 512 * 1024 * 1024), thumbnail === null ? null : bytesArg(thumbnail), category === undefined ? undefined : textArg(category, 40)));
ipcMain.handle(IPC.elementsRead, (_event, name: unknown) => elements.read(textArg(name, 200)));
ipcMain.handle(IPC.elementsRemove, (_event, name: unknown) => elements.remove(textArg(name, 200)));
ipcMain.handle(IPC.templatesRead, (_event, name: unknown) => templates.read(textArg(name, 200)));
ipcMain.handle(IPC.templatesRemove, (_event, name: unknown) => templates.remove(textArg(name, 200)));
ipcMain.handle(IPC.fileAutosave, (_event, content: unknown) => files.autosave(content === null ? null : textArg(content, 1024 * 1024 * 1024)));
ipcMain.handle(IPC.fileRecovery, () => files.takeRecovery());
ipcMain.handle(IPC.confirmUnsaved, (_event, name: unknown) => files.confirmUnsaved(textArg(name, 300)));
ipcMain.on(IPC.docState, (event, state: unknown) => {
  const s = (state ?? {}) as Record<string, unknown>;
  docState = { dirty: s.dirty === true, name: typeof s.name === 'string' ? s.name.slice(0, 300) : 'Sin título' };
  BrowserWindow.fromWebContents(event.sender)?.setTitle(`${docState.dirty ? '• ' : ''}${docState.name} — Inkara Draw`);
});
ipcMain.on(IPC.closeWindow, (event) => {
  closeConfirmed = true;
  BrowserWindow.fromWebContents(event.sender)?.close();
});

// ---- Fuentes ----
const fonts = new FontService(path.join(app.getPath('userData'), 'fonts'));
const text = (value: unknown, max = 200): string => {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) throw new Error('Argumento no válido');
  return value;
};
ipcMain.handle(IPC.fontsSystem, () => fonts.listSystem());
ipcMain.handle(IPC.fontsCatalog, () => fonts.catalog());
ipcMain.handle(IPC.fontsDownloaded, () => fonts.listDownloaded());
ipcMain.handle(IPC.fontsDownload, (_event, family: unknown) => fonts.download(text(family)));
ipcMain.handle(IPC.fontsRead, (_event, file: unknown) => fonts.read(text(file, 1024)));
ipcMain.handle(IPC.fontsInstall, (_event, family: unknown) => fonts.install(text(family)));
ipcMain.handle(IPC.fontsFile, (_event, request: unknown) => {
  const r = (request ?? {}) as Record<string, unknown>;
  return fonts.fontFile({ family: text(r.family), bold: r.bold === true, italic: r.italic === true });
});

// Captura de la ventana para "Reportar un problema" (solo la ventana de la app).
ipcMain.handle(IPC.captureWindow, async (event) => {
  try {
    return (await event.sender.capturePage()).toPNG();
  } catch {
    return null;
  }
});
ipcMain.handle(IPC.appInfo, (): AppInfo => ({
  name: app.getName(),
  version: app.getVersion(),
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
}));

app.on('second-instance', (_event, argv) => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
  // Doble clic en otro diseño con la app abierta: se abre en esta ventana.
  const file = designFromArgs(argv);
  if (file) {
    files.allow(file);
    mainWindow.webContents.send(IPC.fileOpenRequest, file);
  }
});

void app.whenReady().then(() => {
  // Los menús los dibuja la propia interfaz (como Corel); sin la barra de menú nativa.
  Menu.setApplicationMenu(null);
  // Permisos: solo la lista de fuentes locales (para el selector de fuentes). Todo lo
  // demás (cámara, micrófono, ubicación, notificaciones…) se niega.
  const allowed = (permission: string) => permission === 'local-fonts';
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => callback(allowed(permission)));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowed(permission));
  mainWindow = createMainWindow();
  if (launchFile) mainWindow.webContents.once('did-finish-load', () => mainWindow?.webContents.send(IPC.fileOpenRequest, launchFile));
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // macOS: volver a abrir la ventana al hacer clic en el Dock.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

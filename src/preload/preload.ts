import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IPC, type TrazoApi, type WindowState } from '../shared/api';

/**
 * Puente seguro: lo único del sistema que ve la interfaz es `window.trazo`.
 * Cada función nueva (abrir, guardar, exportar…) se añade aquí, con su canal IPC.
 */
/** Suscribe a un mensaje del proceso principal; devuelve la función para desuscribirse. */
function on<T>(channel: string, listener: (value: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, value: T) => listener(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const api: TrazoApi = {
  getAppInfo: () => ipcRenderer.invoke(IPC.appInfo),
  captureWindow: () => ipcRenderer.invoke(IPC.captureWindow),
  setTheme: (theme) => ipcRenderer.send(IPC.setTheme, theme),
  onWindowState: (listener) => {
    const handler = (_event: IpcRendererEvent, state: WindowState) => listener(state);
    ipcRenderer.on(IPC.windowState, handler);
    return () => ipcRenderer.removeListener(IPC.windowState, handler);
  },
  files: {
    openDialog: () => ipcRenderer.invoke(IPC.fileOpenDialog),
    openPath: (path) => ipcRenderer.invoke(IPC.fileOpenPath, path),
    save: (options) => ipcRenderer.invoke(IPC.fileSave, options),
    importDialog: () => ipcRenderer.invoke(IPC.fileImport),
    exportFile: (options) => ipcRenderer.invoke(IPC.fileExport, options),
    printImage: (options) => ipcRenderer.invoke(IPC.printImage, options),
    chooseFolder: (title) => ipcRenderer.invoke(IPC.folderChoose, title),
    writeToFolder: (token, name, bytes) => ipcRenderer.invoke(IPC.folderWrite, token, name, bytes),
    recent: () => ipcRenderer.invoke(IPC.fileRecent),
    autosave: (content) => ipcRenderer.invoke(IPC.fileAutosave, content),
    takeRecovery: () => ipcRenderer.invoke(IPC.fileRecovery),
    onOpenRequest: (listener) => on(IPC.fileOpenRequest, listener),
  },
  elements: {
    list: () => ipcRenderer.invoke(IPC.elementsList),
    save: (name, content, thumbnail, category) => ipcRenderer.invoke(IPC.elementsSave, name, content, thumbnail, category),
    read: (name) => ipcRenderer.invoke(IPC.elementsRead, name),
    remove: (name) => ipcRenderer.invoke(IPC.elementsRemove, name),
  },
  templates: {
    list: () => ipcRenderer.invoke(IPC.templatesList),
    save: (name, content, thumbnail, category) => ipcRenderer.invoke(IPC.templatesSave, name, content, thumbnail, category),
    setCategory: (name, category) => ipcRenderer.invoke(IPC.templatesSetCategory, name, category),
    read: (name) => ipcRenderer.invoke(IPC.templatesRead, name),
    remove: (name) => ipcRenderer.invoke(IPC.templatesRemove, name),
  },
  document: {
    reportState: (state) => ipcRenderer.send(IPC.docState, state),
    confirmUnsaved: (name) => ipcRenderer.invoke(IPC.confirmUnsaved, name),
    onSaveThenClose: (listener) => on(IPC.saveThenClose, () => listener()),
    closeWindow: () => ipcRenderer.send(IPC.closeWindow),
  },
  fonts: {
    listSystem: () => ipcRenderer.invoke(IPC.fontsSystem),
    catalog: () => ipcRenderer.invoke(IPC.fontsCatalog),
    listDownloaded: () => ipcRenderer.invoke(IPC.fontsDownloaded),
    download: (family) => ipcRenderer.invoke(IPC.fontsDownload, family),
    read: (path) => ipcRenderer.invoke(IPC.fontsRead, path),
    install: (family) => ipcRenderer.invoke(IPC.fontsInstall, family),
    fontFile: (request) => ipcRenderer.invoke(IPC.fontsFile, request),
  },
};

contextBridge.exposeInMainWorld('trazo', api);

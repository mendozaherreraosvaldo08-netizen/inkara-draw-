import { BrowserWindow, dialog } from 'electron';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ExportExtension, ImportedFile, OpenedFile, RecentFile, Result, UnsavedChoice } from '../shared/api';

const EXPORT_FILTERS: Record<ExportExtension, Electron.FileFilter> = {
  svg: { name: 'SVG (vectorial)', extensions: ['svg'] },
  png: { name: 'PNG (sin pérdida)', extensions: ['png'] },
  jpg: { name: 'JPG', extensions: ['jpg', 'jpeg'] },
  pdf: { name: 'PDF', extensions: ['pdf'] },
  html: { name: 'Reporte (página web)', extensions: ['html'] },
  inkpack: { name: 'Paquete de plantillas de Inkara', extensions: ['inkpack'] },
};

/**
 * Archivos: abrir, guardar, importar, exportar, recientes y autoguardado.
 *
 * La interfaz nunca elige rutas a ciegas: solo puede leer o sobrescribir archivos
 * que el usuario eligió en un diálogo, que están en "Recientes" o que se abrieron
 * con doble clic en el Explorador. Así un diseño malicioso no puede pedir que se
 * lea o se pise cualquier archivo del equipo.
 */

const MAX_DESIGN = 512 * 1024 * 1024; // 512 MB
const MAX_IMPORT = 100 * 1024 * 1024; // 100 MB por imagen
const RECENT_LIMIT = 10;

const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  // PDF (p. ej. exportado de CorelDRAW): se abre como diseño editable.
  '.pdf': 'application/pdf',
};

const canceled = <T>(): Result<T> => ({ ok: false, error: '', canceled: true });
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const nameOf = (file: string) => path.basename(file, path.extname(file));

export class FileService {
  /** Rutas que el usuario autorizó en esta sesión (diálogos, recientes, Explorador). */
  private readonly allowed = new Set<string>();
  /** Carpeta de la última exportación (la siguiente se propone ahí). */
  private lastExportDir: string | null = null;
  /** Carpetas elegidas para guardar varias placas: clave → ruta. */
  private readonly folders = new Map<string, string>();

  constructor(private readonly userData: string, private readonly getWindow: () => BrowserWindow | null) {}

  private get recentPath() {
    return path.join(this.userData, 'recent.json');
  }
  private get autosavePath() {
    return path.join(this.userData, 'autosave.trz');
  }

  /** Autoriza una ruta que llegó por el Explorador (doble clic en un diseño). */
  allow(file: string): void {
    this.allowed.add(path.resolve(file));
  }

  // ---- Abrir ----

  async openDialog(): Promise<Result<OpenedFile>> {
    const win = this.getWindow();
    const options: Electron.OpenDialogOptions = {
      title: 'Abrir diseño',
      properties: ['openFile'],
      filters: [{ name: 'Diseños de Inkara Draw', extensions: ['ink', 'trz'] }, { name: 'Todos los archivos', extensions: ['*'] }],
    };
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    const file = result.filePaths[0];
    if (result.canceled || !file) return canceled();
    this.allow(file);
    return this.openPath(file);
  }

  async openPath(file: string): Promise<Result<OpenedFile>> {
    const resolved = path.resolve(file);
    const recent = await this.recent();
    if (!this.allowed.has(resolved) && !recent.some((r) => path.resolve(r.path) === resolved)) {
      return { ok: false, error: 'Ese archivo no se eligió desde Inkara Draw.' };
    }
    try {
      const info = await stat(resolved);
      if (info.size > MAX_DESIGN) return { ok: false, error: 'El archivo es demasiado grande.' };
      const content = await readFile(resolved, 'utf8');
      this.allow(resolved);
      await this.addRecent(resolved);
      return { ok: true, value: { path: resolved, name: nameOf(resolved), content } };
    } catch (error) {
      await this.removeRecent(resolved);
      return { ok: false, error: `No se pudo abrir “${path.basename(resolved)}” (${message(error)}).` };
    }
  }

  // ---- Guardar ----

  async save(options: { content: string; path: string | null; suggestedName: string; saveAs: boolean }): Promise<Result<{ path: string; name: string }>> {
    let target = options.path ? path.resolve(options.path) : null;
    if (target && !this.allowed.has(target)) target = null; // ruta no autorizada: se pregunta
    if (!target || options.saveAs) {
      const win = this.getWindow();
      const dialogOptions: Electron.SaveDialogOptions = {
        title: 'Guardar diseño',
        defaultPath: target ?? `${safeFileName(options.suggestedName)}.ink`,
        filters: [{ name: 'Diseño de Inkara Draw', extensions: ['ink'] }],
      };
      const result = win ? await dialog.showSaveDialog(win, dialogOptions) : await dialog.showSaveDialog(dialogOptions);
      if (result.canceled || !result.filePath) return canceled();
      const chosen: string = result.filePath;
      target = /\.(ink|trz)$/i.test(chosen) ? chosen : `${chosen}.ink`;
    }
    try {
      await writeAtomic(target, options.content);
      this.allow(target);
      await this.addRecent(target);
      await rm(this.autosavePath, { force: true });
      return { ok: true, value: { path: target, name: nameOf(target) } };
    } catch (error) {
      return { ok: false, error: `No se pudo guardar (${message(error)}). Prueba con “Guardar como” en otra carpeta.` };
    }
  }

  // ---- Importar / exportar ----

  async importDialog(): Promise<Result<ImportedFile[]>> {
    const win = this.getWindow();
    const options: Electron.OpenDialogOptions = {
      title: 'Importar imágenes o abrir un PDF de Corel',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Imágenes, logos y PDF', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'pdf'] },
        { name: 'PDF (exportado de CorelDRAW)', extensions: ['pdf'] },
        { name: 'Todos los archivos', extensions: ['*'] },
      ],
    };
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) return canceled();
    const files: ImportedFile[] = [];
    const skipped: string[] = [];
    for (const file of result.filePaths) {
      const mime = IMAGE_TYPES[path.extname(file).toLowerCase()];
      const size = (await stat(file).catch(() => null))?.size ?? 0;
      if (!mime || size === 0 || size > MAX_IMPORT) {
        skipped.push(path.basename(file));
        continue;
      }
      files.push({ name: path.basename(file), mime, bytes: new Uint8Array(await readFile(file)) });
    }
    if (files.length === 0) return { ok: false, error: `No se pudo importar: ${skipped.join(', ')} (formato no admitido o más de 100 MB).` };
    return { ok: true, value: files };
  }

  async exportFile(options: { content: string | Uint8Array; suggestedName: string; extension: ExportExtension }): Promise<Result<string>> {
    const filter = EXPORT_FILTERS[options.extension];
    if (!filter) return { ok: false, error: 'Formato no admitido.' };
    const win = this.getWindow();
    const dialogOptions: Electron.SaveDialogOptions = {
      title: 'Exportar',
      defaultPath: path.join(this.lastExportDir ?? '', `${safeFileName(options.suggestedName)}.${options.extension}`),
      filters: [filter],
    };
    const result = win ? await dialog.showSaveDialog(win, dialogOptions) : await dialog.showSaveDialog(dialogOptions);
    if (result.canceled || !result.filePath) return canceled();
    const ext = `.${options.extension}`;
    const target = filter.extensions.some((e) => result.filePath!.toLowerCase().endsWith(`.${e}`)) ? result.filePath : `${result.filePath}${ext}`;
    try {
      await writeAtomic(target, options.content);
      this.lastExportDir = path.dirname(target);
      return { ok: true, value: target };
    } catch (error) {
      return { ok: false, error: `No se pudo exportar (${message(error)}).` };
    }
  }

  // ---- Carpeta para placas en serie ----

  async chooseFolder(title: string): Promise<Result<{ token: string; path: string }>> {
    const win = this.getWindow();
    const options: Electron.OpenDialogOptions = { title, properties: ['openDirectory', 'createDirectory'], defaultPath: this.lastExportDir ?? undefined };
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    const folder = result.filePaths[0];
    if (result.canceled || !folder) return canceled();
    const token = `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    this.folders.set(token, path.resolve(folder));
    this.lastExportDir = folder;
    return { ok: true, value: { token, path: folder } };
  }

  async writeToFolder(token: string, name: string, bytes: Uint8Array): Promise<Result<string>> {
    const folder = this.folders.get(token);
    if (!folder) return { ok: false, error: 'Carpeta no autorizada.' };
    // Solo un nombre de archivo (nada de rutas) y con una extensión de imagen o PDF.
    const ext = path.extname(name).toLowerCase();
    const base = path.basename(name, ext).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').trim().slice(0, 150) || 'Placa';
    if (!['.png', '.jpg', '.pdf'].includes(ext) || path.basename(name) !== name) return { ok: false, error: 'Nombre de archivo no válido.' };
    try {
      let final = `${base}${ext}`;
      for (let n = 2; existsSync(path.join(folder, final)); n++) final = `${base} (${n})${ext}`;
      await writeAtomic(path.join(folder, final), bytes);
      return { ok: true, value: final };
    } catch (error) {
      return { ok: false, error: `No se pudo guardar “${name}” (${message(error)}).` };
    }
  }

  // ---- Recientes ----

  async recent(): Promise<RecentFile[]> {
    try {
      const list = JSON.parse(await readFile(this.recentPath, 'utf8')) as unknown;
      if (!Array.isArray(list)) return [];
      return list.filter((p): p is string => typeof p === 'string' && existsSync(p)).map((p) => ({ path: p, name: nameOf(p) }));
    } catch {
      return [];
    }
  }

  private async addRecent(file: string): Promise<void> {
    const list = [file, ...(await this.recent()).map((r) => r.path).filter((p) => path.resolve(p) !== file)].slice(0, RECENT_LIMIT);
    await mkdir(this.userData, { recursive: true });
    await writeFile(this.recentPath, JSON.stringify(list, null, 2));
  }

  private async removeRecent(file: string): Promise<void> {
    const list = (await this.recent()).map((r) => r.path).filter((p) => path.resolve(p) !== file);
    await writeFile(this.recentPath, JSON.stringify(list, null, 2)).catch(() => undefined);
  }

  // ---- Autoguardado y recuperación ----

  async autosave(content: string | null): Promise<void> {
    if (content === null) {
      await rm(this.autosavePath, { force: true });
      return;
    }
    await mkdir(this.userData, { recursive: true });
    await writeAtomic(this.autosavePath, content);
  }

  async takeRecovery(): Promise<string | null> {
    const info = await stat(this.autosavePath).catch(() => null);
    if (!info) return null;
    const win = this.getWindow();
    const when = info.mtime.toLocaleString('es-MX', { dateStyle: 'long', timeStyle: 'short' });
    const options: Electron.MessageBoxOptions = {
      type: 'question',
      title: 'Recuperar trabajo',
      message: 'Inkara Draw se cerró sin guardar un diseño.',
      detail: `Hay una copia automática del ${when}. ¿Quieres recuperarla?`,
      buttons: ['Recuperar', 'Descartar'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    };
    const { response } = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
    const content = response === 0 ? await readFile(this.autosavePath, 'utf8').catch(() => null) : null;
    // Si se recupera, la copia sigue hasta que se guarde (por si vuelve a fallar algo).
    if (response !== 0) await rm(this.autosavePath, { force: true });
    return content;
  }

  /** Aviso de cambios sin guardar (al crear, abrir o cerrar). */
  async confirmUnsaved(name: string): Promise<UnsavedChoice> {
    const win = this.getWindow();
    const options: Electron.MessageBoxOptions = {
      type: 'warning',
      title: 'Cambios sin guardar',
      message: `¿Guardar los cambios de “${name}”?`,
      detail: 'Si no los guardas, se perderán.',
      buttons: ['Guardar', 'No guardar', 'Cancelar'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    };
    const { response } = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
    return response === 0 ? 'save' : response === 1 ? 'discard' : 'cancel';
  }
}

/** Escribe en un archivo temporal y luego lo renombra: si se va la luz a medias, el archivo anterior queda intacto. */
async function writeAtomic(file: string, content: string | Uint8Array): Promise<void> {
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, content);
  await rename(temp, file);
}

function safeFileName(name: string): string {
  return name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').trim().slice(0, 120) || 'Sin título';
}

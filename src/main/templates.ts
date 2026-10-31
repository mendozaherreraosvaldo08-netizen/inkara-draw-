import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Result, TemplateInfo } from '../shared/api';

/**
 * Biblioteca de plantillas: diseños guardados en la carpeta de datos de Trazo
 * (`plantillas/Nombre.trz` + `Nombre.png` de miniatura). La interfaz solo da
 * el nombre: nunca rutas, así no puede leer ni escribir fuera de esa carpeta.
 */
export class TemplateService {
  constructor(private readonly dir: string) {}

  /** Nombre seguro: sin separadores de carpeta, caracteres prohibidos de Windows ni ".." */
  static clean(name: string): string | null {
    const clean = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 80);
    if (!clean || /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(clean)) return null;
    return clean;
  }

  private file(name: string, ext: 'trz' | 'png'): string {
    return path.join(this.dir, `${name}.${ext}`);
  }

  /** Categoría de cada plantilla (Diplomas, Graduación…): un archivo aparte, nombre → categoría. */
  private get categoriesFile(): string {
    return path.join(this.dir, 'categorias.json');
  }

  private async categories(): Promise<Record<string, string>> {
    try {
      const raw = JSON.parse(await readFile(this.categoriesFile, 'utf8')) as unknown;
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        return Object.fromEntries(Object.entries(raw as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string').map(([k, v]) => [k, v.slice(0, 40)]));
      }
    } catch {
      // sin categorías todavía
    }
    return {};
  }

  async setCategory(name: string, category: string): Promise<Result<void>> {
    const clean = TemplateService.clean(name);
    if (!clean) return { ok: false, error: 'Plantilla no válida.' };
    const all = await this.categories();
    const value = category.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 40);
    if (value) all[clean] = value;
    else delete all[clean];
    try {
      await mkdir(this.dir, { recursive: true });
      await atomic(this.categoriesFile, JSON.stringify(all, null, 1));
      return { ok: true, value: undefined };
    } catch (error) {
      return { ok: false, error: `No se pudo guardar la categoría (${error instanceof Error ? error.message : String(error)}).` };
    }
  }

  async list(): Promise<TemplateInfo[]> {
    let entries: string[] = [];
    try {
      entries = await readdir(this.dir);
    } catch {
      return [];
    }
    const out: TemplateInfo[] = [];
    const categories = await this.categories();
    for (const entry of entries) {
      if (!entry.toLowerCase().endsWith('.trz')) continue;
      const name = entry.slice(0, -4);
      if (TemplateService.clean(name) !== name) continue;
      try {
        const info = await stat(this.file(name, 'trz'));
        let thumbnail: string | null = null;
        try {
          thumbnail = (await readFile(this.file(name, 'png'))).toString('base64');
        } catch {
          // sin miniatura
        }
        out.push({ name, modified: info.mtimeMs, thumbnail, category: categories[name] ?? '' });
      } catch {
        // se borró mientras se leía
      }
    }
    return out.sort((a, b) => b.modified - a.modified);
  }

  async save(name: string, content: string, thumbnail: Uint8Array | null, category?: string): Promise<Result<string>> {
    const clean = TemplateService.clean(name);
    if (!clean) return { ok: false, error: 'Escribe un nombre para la plantilla (sin / \\ : * ? " < > |).' };
    try {
      await mkdir(this.dir, { recursive: true });
      await atomic(this.file(clean, 'trz'), content);
      if (thumbnail) await atomic(this.file(clean, 'png'), thumbnail);
      if (category !== undefined) await this.setCategory(clean, category);
      return { ok: true, value: clean };
    } catch (error) {
      return { ok: false, error: `No se pudo guardar la plantilla (${error instanceof Error ? error.message : String(error)}).` };
    }
  }

  async read(name: string): Promise<Result<string>> {
    const clean = TemplateService.clean(name);
    if (!clean || clean !== name) return { ok: false, error: 'Plantilla no válida.' };
    try {
      return { ok: true, value: await readFile(this.file(clean, 'trz'), 'utf8') };
    } catch {
      return { ok: false, error: 'No se encontró la plantilla.' };
    }
  }

  async remove(name: string): Promise<Result<void>> {
    const clean = TemplateService.clean(name);
    if (!clean || clean !== name) return { ok: false, error: 'Plantilla no válida.' };
    await rm(this.file(clean, 'trz'), { force: true });
    await rm(this.file(clean, 'png'), { force: true });
    await this.setCategory(clean, '');
    return { ok: true, value: undefined };
  }
}

async function atomic(file: string, content: string | Uint8Array): Promise<void> {
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, content);
  await rename(temp, file);
}

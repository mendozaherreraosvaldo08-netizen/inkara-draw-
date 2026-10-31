import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { CatalogFamily, DownloadedFamily, FontFile, FontFileData, Result } from '../shared/api';

/**
 * Fuentes del sistema y de Google Fonts.
 *
 * Solo el proceso principal toca la red y el disco. Por seguridad, la interfaz
 * pide familias por NOMBRE y aquí se comprueba que existan en el catálogo; las
 * descargas solo se aceptan desde los servidores de Google Fonts.
 */

const run = promisify(execFile);

/** Servidores de Google Fonts. Se pueden cambiar con TRAZO_FONTS_API / TRAZO_FONTS_CATALOG (pruebas). */
const CATALOG_URL = process.env.TRAZO_FONTS_CATALOG ?? 'https://fonts.google.com/metadata/fonts';
const CSS_URL = process.env.TRAZO_FONTS_API ?? 'https://fonts.googleapis.com/css';
const ALLOWED_FILE_HOSTS = new Set(['fonts.gstatic.com', ...(process.env.TRAZO_FONTS_FILE_HOST ? [process.env.TRAZO_FONTS_FILE_HOST] : [])]);
const CATALOG_MAX_AGE = 7 * 24 * 60 * 60 * 1000;

export class FontService {
  private catalogCache: Array<CatalogFamily & { variants: string[] }> | null = null;

  constructor(private readonly root: string) {}

  private get manifestPath(): string {
    return path.join(this.root, 'manifest.json');
  }

  // ---- Fuentes del sistema ----

  async listSystem(): Promise<string[]> {
    try {
      if (process.platform === 'win32') return await windowsFamilies();
      if (process.platform === 'linux') {
        const { stdout } = await run('fc-list', [':', 'family'], { maxBuffer: 16 * 1024 * 1024 });
        return unique(stdout.split('\n').flatMap((line) => line.split(',')[0] ?? []).map((f) => f.trim()));
      }
    } catch {
      // Si falla, la interfaz detecta las fuentes comunes por su cuenta.
    }
    return [];
  }

  // ---- Catálogo de Google Fonts ----

  async catalog(): Promise<Result<CatalogFamily[]>> {
    try {
      const list = await this.loadCatalog();
      return { ok: true, value: list.map(({ family, category, popularity }) => ({ family, category, popularity })) };
    } catch (error) {
      return { ok: false, error: `No se pudo consultar Google Fonts (${message(error)}). Revisa la conexión a internet.` };
    }
  }

  private async loadCatalog(): Promise<Array<CatalogFamily & { variants: string[] }>> {
    if (this.catalogCache) return this.catalogCache;
    const cachePath = path.join(this.root, 'google-catalog.json');
    try {
      const cached = JSON.parse(await readFile(cachePath, 'utf8')) as { savedAt: number; list: Array<CatalogFamily & { variants: string[] }> };
      if (Date.now() - cached.savedAt < CATALOG_MAX_AGE) return (this.catalogCache = cached.list);
    } catch {
      // Sin caché o dañada: se descarga.
    }
    const response = await fetch(CATALOG_URL, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    // La respuesta puede empezar con ")]}'" para evitar que se ejecute como script.
    const text = (await response.text()).replace(/^\)\]\}'\s*/, '');
    const data = JSON.parse(text) as { familyMetadataList?: Array<{ family: string; category: string; popularity?: number; fonts?: Record<string, unknown> }> };
    const list = (data.familyMetadataList ?? [])
      .filter((f) => typeof f.family === 'string')
      .map((f) => ({ family: f.family, category: f.category ?? '', popularity: f.popularity ?? 9999, variants: Object.keys(f.fonts ?? {}) }));
    await mkdir(this.root, { recursive: true });
    await writeFile(cachePath, JSON.stringify({ savedAt: Date.now(), list }));
    return (this.catalogCache = list);
  }

  // ---- Descargas ----

  async listDownloaded(): Promise<DownloadedFamily[]> {
    try {
      const list = JSON.parse(await readFile(this.manifestPath, 'utf8')) as DownloadedFamily[];
      return list.filter((f) => f.files.every((file) => existsSync(file.path)));
    } catch {
      return [];
    }
  }

  private async saveDownloaded(entry: DownloadedFamily): Promise<void> {
    const list = (await this.listDownloaded()).filter((f) => f.family !== entry.family);
    list.push(entry);
    await mkdir(this.root, { recursive: true });
    await writeFile(this.manifestPath, JSON.stringify(list, null, 2));
  }

  async download(requested: string): Promise<Result<DownloadedFamily>> {
    try {
      const already = (await this.listDownloaded()).find((f) => f.family.toLowerCase() === requested.toLowerCase());
      if (already) return { ok: true, value: already };
      const entry = (await this.loadCatalog()).find((f) => f.family.toLowerCase() === requested.trim().toLowerCase());
      if (!entry) return { ok: false, error: `“${requested}” no está en Google Fonts.` };

      // Las 4 variantes que usa un editor: normal, cursiva, negrita y negrita cursiva.
      const wanted = ['400', '400i', '700', '700i'].filter((v) => entry.variants.includes(v));
      if (wanted.length === 0 && entry.variants[0]) wanted.push(entry.variants[0]);
      const url = `${CSS_URL}?family=${encodeURIComponent(entry.family).replace(/%20/g, '+')}:${wanted.join(',')}`;
      // Sin cabecera de navegador, Google responde con archivos TrueType (.ttf),
      // que sirven tanto para dibujar como para instalarlos en Windows.
      const css = await (await checked(fetch(url, { signal: AbortSignal.timeout(20_000) }))).text();
      const faces = parseFontFaces(css);
      if (faces.length === 0) return { ok: false, error: `Google Fonts no devolvió archivos para “${entry.family}”.` };

      const folder = path.join(this.root, 'google', safeName(entry.family));
      await mkdir(folder, { recursive: true });
      const files: FontFile[] = [];
      for (const face of faces) {
        const source = new URL(face.url);
        // Solo HTTPS y solo desde los servidores de Google Fonts (http se admite únicamente en pruebas).
        const testing = !!process.env.TRAZO_FONTS_FILE_HOST;
        if (!ALLOWED_FILE_HOSTS.has(source.host) || (source.protocol !== 'https:' && !testing)) throw new Error(`origen no permitido: ${source.host}`);
        const bytes = new Uint8Array(await (await checked(fetch(source, { signal: AbortSignal.timeout(30_000) }))).arrayBuffer());
        if (!looksLikeFont(bytes)) throw new Error('el archivo descargado no es una fuente');
        const file = path.join(folder, `${face.weight}${face.style === 'italic' ? 'i' : ''}.ttf`);
        await writeFile(file, bytes);
        files.push({ weight: face.weight, style: face.style, path: file });
      }
      const downloaded: DownloadedFamily = { family: entry.family, source: 'google', files, installed: false };
      await this.saveDownloaded(downloaded);
      return { ok: true, value: downloaded };
    } catch (error) {
      return { ok: false, error: `No se pudo descargar “${requested}” (${message(error)}).` };
    }
  }

  /** Lee un archivo de fuente, solo si está dentro de la carpeta de fuentes de Trazo. */
  async read(file: string): Promise<Uint8Array<ArrayBuffer>> {
    const resolved = path.resolve(file);
    if (!resolved.startsWith(path.resolve(this.root) + path.sep)) throw new Error('Ruta de fuente no permitida');
    return new Uint8Array(await readFile(resolved));
  }

  // ---- Archivo de una fuente (texto a curvas) ----

  private systemFiles: Promise<SystemFontFile[]> | null = null;

  async fontFile(request: { family: string; bold: boolean; italic: boolean }): Promise<Result<FontFileData>> {
    const want = request.family.trim().toLowerCase();
    type Candidate = { path: string; bold: boolean; italic: boolean; extra: number };
    const candidates: Candidate[] = [];
    // 1) Las descargadas de Google Fonts
    const downloaded = (await this.listDownloaded()).find((f) => f.family.toLowerCase() === want);
    for (const file of downloaded?.files ?? []) candidates.push({ path: file.path, bold: file.weight >= 600, italic: file.style === 'italic', extra: 0 });
    // 2) Las instaladas en el sistema
    this.systemFiles ??= systemFontFiles();
    for (const file of await this.systemFiles) {
      if (file.family.toLowerCase() === want) candidates.push({ path: file.path, bold: file.bold, italic: file.italic, extra: file.extraWords });
    }
    if (candidates.length === 0) return { ok: false, error: `No se encontró el archivo de la fuente “${request.family}”.` };
    // La mejor: misma negrita y cursiva, y sin otras palabras de estilo (Light, Semibold…).
    const score = (c: Candidate) => (c.bold === request.bold ? 4 : 0) + (c.italic === request.italic ? 2 : 0) - c.extra * 0.5 - (c.bold && !request.bold ? 4 : 0) - (c.italic && !request.italic ? 2 : 0);
    const best = candidates.reduce((a, b) => (score(b) > score(a) ? b : a));
    try {
      const bytes = new Uint8Array(await readFile(best.path));
      return { ok: true, value: { bytes, bold: best.bold, italic: best.italic } };
    } catch (error) {
      return { ok: false, error: `No se pudo leer la fuente “${request.family}” (${message(error)}).` };
    }
  }

  // ---- Instalar en Windows ----

  /**
   * Instala para el usuario actual, como hace Windows al elegir "Instalar" en una
   * fuente: copia a %LOCALAPPDATA%\Microsoft\Windows\Fonts y la registra en
   * HKCU\…\Fonts. No pide permisos de administrador; así la fuente también
   * aparece en otros programas (puede que haya que reiniciarlos).
   */
  async install(family: string): Promise<Result<DownloadedFamily>> {
    if (process.platform !== 'win32') return { ok: false, error: 'Instalar fuentes en el sistema solo está disponible en Windows.' };
    const entry = (await this.listDownloaded()).find((f) => f.family === family);
    if (!entry) return { ok: false, error: `Primero hay que descargar “${family}”.` };
    try {
      const localAppData = process.env.LOCALAPPDATA;
      if (!localAppData) throw new Error('falta LOCALAPPDATA');
      const fontsDir = path.join(localAppData, 'Microsoft', 'Windows', 'Fonts');
      await mkdir(fontsDir, { recursive: true });
      for (const file of entry.files) {
        const styleName = [file.weight >= 700 ? 'Bold' : '', file.style === 'italic' ? 'Italic' : ''].filter(Boolean).join(' ');
        const target = path.join(fontsDir, `${safeName(entry.family)}-${styleName.replace(' ', '') || 'Regular'}.ttf`);
        await copyFile(file.path, target);
        const valueName = `${entry.family}${styleName ? ` ${styleName}` : ''} (TrueType)`;
        await run('reg', ['add', 'HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts', '/v', valueName, '/t', 'REG_SZ', '/d', target, '/f'], { windowsHide: true });
      }
      const installed = { ...entry, installed: true };
      await this.saveDownloaded(installed);
      return { ok: true, value: installed };
    } catch (error) {
      return { ok: false, error: `No se pudo instalar “${family}” en Windows (${message(error)}).` };
    }
  }
}

interface SystemFontFile {
  family: string;
  path: string;
  bold: boolean;
  italic: boolean;
  /** Otras palabras de estilo en el nombre (Light, Semibold…): cuanto menos, más "normal". */
  extraWords: number;
}

/** Archivos de fuentes del sistema con su familia y estilo (Windows: registro; Linux: fc-list). */
async function systemFontFiles(): Promise<SystemFontFile[]> {
  const out: SystemFontFile[] = [];
  try {
    if (process.platform === 'win32') {
      const fontsDir = path.join(process.env.WINDIR ?? 'C:\\Windows', 'Fonts');
      for (const key of ['HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts', 'HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts']) {
        const { stdout } = await run('reg', ['query', key], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }).catch(() => ({ stdout: '' }));
        for (const line of stdout.split(/\r?\n/)) {
          const m = /^\s{4}(.+?)\s{4}REG_SZ\s{4}(.+)$/.exec(line);
          if (!m?.[1] || !m[2]) continue;
          const file = path.isAbsolute(m[2]) ? m[2] : path.join(fontsDir, m[2]);
          for (const part of m[1].replace(/\s*\((TrueType|OpenType)\)\s*$/i, '').split('&')) out.push(describeStyle(part.trim(), file));
        }
      }
    } else if (process.platform === 'linux') {
      const { stdout } = await run('fc-list', [':', 'family', 'style', 'file'], { maxBuffer: 32 * 1024 * 1024 });
      for (const line of stdout.split('\n')) {
        const [file, family, style] = line.split(':').map((s) => s.trim());
        if (!file || !family) continue;
        const st = (style ?? '').replace(/^style=/, '').split(',')[0] ?? '';
        out.push({ ...describeStyle(`${family.split(',')[0]} ${st}`.trim(), file), family: family.split(',')[0]! });
      }
    }
  } catch {
    // Sin lista: solo las fuentes descargadas.
  }
  return out;
}

const STYLE_WORDS = /\b(Bold|Italic|Oblique|Regular|Light|Semilight|SemiLight|Semibold|SemiBold|Demibold|DemiBold|Black|Heavy|Thin|ExtraLight|UltraLight|ExtraBold|UltraBold|Medium|Condensed|Narrow|Book)\b/gi;

function describeStyle(name: string, file: string): SystemFontFile {
  const words = name.match(STYLE_WORDS) ?? [];
  const lower = words.map((w) => w.toLowerCase());
  return {
    family: registryNameToFamilies(name)[0] ?? name,
    path: file,
    bold: lower.includes('bold'),
    italic: lower.includes('italic') || lower.includes('oblique'),
    extraWords: lower.filter((w) => !['bold', 'italic', 'oblique', 'regular'].includes(w)).length,
  };
}

/** Lee las fuentes registradas en Windows (de todo el equipo y del usuario). */
async function windowsFamilies(): Promise<string[]> {
  const keys = ['HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts', 'HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts'];
  const names: string[] = [];
  for (const key of keys) {
    try {
      const { stdout } = await run('reg', ['query', key], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
      for (const line of stdout.split(/\r?\n/)) {
        const match = /^\s{4}(.+?)\s{4}REG_SZ\s{4}/.exec(line);
        if (match?.[1]) names.push(...registryNameToFamilies(match[1]));
      }
    } catch {
      // La clave del usuario puede no existir.
    }
  }
  return unique(names);
}

/** "Arial Bold Italic (TrueType)" → ["Arial"]; "Cambria & Cambria Math (TrueType)" → ["Cambria", "Cambria Math"]. */
export function registryNameToFamilies(name: string): string[] {
  const STYLE = /\s+(Bold|Italic|Oblique|Regular|Light|Semilight|SemiLight|Semibold|SemiBold|Black|Heavy|Thin|ExtraLight|Extra Light|ExtraBold|Extra Bold|Medium|Condensed|Narrow)\b.*$/i;
  return name
    .replace(/\s*\((TrueType|OpenType|All res|VGA res)\)\s*$/i, '')
    .split('&')
    .map((part) => part.trim().replace(STYLE, '').trim())
    .filter((part) => part.length > 0 && !/^\d/.test(part));
}

export interface ParsedFace {
  weight: number;
  style: 'normal' | 'italic';
  url: string;
}

/** Extrae las @font-face de la hoja de estilos de Google Fonts. */
export function parseFontFaces(css: string): ParsedFace[] {
  const faces: ParsedFace[] = [];
  for (const block of css.match(/@font-face\s*\{[^}]*\}/g) ?? []) {
    const url = /src:\s*url\(([^)]+)\)/.exec(block)?.[1]?.replace(/['"]/g, '');
    if (!url) continue;
    const weight = Number(/font-weight:\s*(\d+)/.exec(block)?.[1] ?? 400);
    const style = /font-style:\s*italic/.test(block) ? 'italic' : 'normal';
    // Google puede repetir una variante por cada alfabeto (latin, cyrillic…); con una basta.
    if (!faces.some((f) => f.weight === weight && f.style === style)) faces.push({ weight, style, url });
  }
  return faces;
}

/** Firma de archivo TrueType / OpenType / WOFF. */
function looksLikeFont(bytes: Uint8Array): boolean {
  const tag = String.fromCharCode(...bytes.slice(0, 4));
  return (bytes[0] === 0 && bytes[1] === 1 && bytes[2] === 0 && bytes[3] === 0) || ['OTTO', 'true', 'wOFF', 'wOF2'].includes(tag);
}

async function checked(response: Promise<Response>): Promise<Response> {
  const r = await response;
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r;
}

const unique = (list: string[]) => [...new Set(list.filter(Boolean))].sort((a, b) => a.localeCompare(b));
const safeName = (family: string) => family.replace(/[^\p{L}\p{N} _-]/gu, '').replace(/\s+/g, '');
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

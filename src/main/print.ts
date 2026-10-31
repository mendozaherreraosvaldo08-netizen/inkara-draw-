import { BrowserWindow } from 'electron';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { PrintRequest, Result } from '../shared/api';

/**
 * Imprime la placa al tamaño exacto. Se arma una página oculta con la imagen a
 * la medida en mm (sin márgenes) y se abre el diálogo de impresión de Windows,
 * donde se elige la impresora de sublimación, el papel y la calidad.
 *
 * Importante: en el diálogo, la escala debe quedar en 100 % (no "Ajustar").
 */
export async function printImage(parent: BrowserWindow | null, request: PrintRequest): Promise<Result<void>> {
  const { widthMm, heightMm } = request;
  if (!(widthMm > 0 && heightMm > 0 && widthMm < 5000 && heightMm < 5000)) return { ok: false, error: 'Tamaño de impresión no válido.' };
  const dir = await mkdtemp(path.join(os.tmpdir(), 'trazo-print-'));
  const win = new BrowserWindow({
    show: false,
    parent: parent ?? undefined,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false },
  });
  try {
    await writeFile(path.join(dir, 'placa.png'), request.png);
    const title = request.title.replace(/[<>&"]/g, '');
    await writeFile(
      path.join(dir, 'print.html'),
      `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>
        @page { size: ${widthMm}mm ${heightMm}mm; margin: 0; }
        html, body { margin: 0; padding: 0; }
        img { display: block; width: ${widthMm}mm; height: ${heightMm}mm; }
      </style></head><body><img src="placa.png" alt=""></body></html>`,
    );
    await win.loadFile(path.join(dir, 'print.html'));
    const outcome = await new Promise<{ ok: boolean; reason: string }>((resolve) => {
      win.webContents.print(
        {
          silent: false,
          printBackground: true,
          margins: { marginType: 'none' },
          // Electron usa micras para el tamaño del papel.
          pageSize: { width: Math.round(widthMm * 1000), height: Math.round(heightMm * 1000) },
        },
        (ok, reason) => resolve({ ok, reason }),
      );
    });
    if (outcome.ok) return { ok: true, value: undefined };
    if (/cancel/i.test(outcome.reason)) return { ok: false, error: '', canceled: true };
    return { ok: false, error: `No se pudo imprimir (${outcome.reason}).` };
  } catch (error) {
    return { ok: false, error: `No se pudo imprimir (${error instanceof Error ? error.message : String(error)}).` };
  } finally {
    win.destroy();
    await rm(dir, { recursive: true, force: true });
  }
}

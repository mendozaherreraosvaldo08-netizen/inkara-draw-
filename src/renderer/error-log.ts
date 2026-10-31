/**
 * Registro de errores (para "Ayuda › Reportar un problema"): guarda los
 * últimos errores y avisos de la app, sin datos de los diseños.
 */

export interface LogEntry {
  at: string;
  kind: 'error' | 'aviso';
  text: string;
}

const MAX = 200;
const entries: LogEntry[] = [];

export function logEntry(kind: LogEntry['kind'], text: string): void {
  entries.push({ at: new Date().toISOString(), kind, text: text.slice(0, 2000) });
  if (entries.length > MAX) entries.splice(0, entries.length - MAX);
}

export const logEntries = (): LogEntry[] => [...entries];

let installed = false;
export function installErrorLog(): void {
  if (installed) return;
  installed = true;
  window.addEventListener('error', (e) => logEntry('error', `${e.message} (${e.filename?.split('/').pop() ?? ''}:${e.lineno}:${e.colno})${e.error?.stack ? `\n${String(e.error.stack).slice(0, 1500)}` : ''}`));
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason as unknown;
    logEntry('error', r instanceof Error ? `${r.message}\n${r.stack ?? ''}` : String(r));
  });
  const original = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    logEntry('error', args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack ?? ''}` : typeof a === 'string' ? a : safe(a))).join(' '));
    original(...args);
  };
  const warn = console.warn.bind(console);
  console.warn = (...args: unknown[]) => {
    logEntry('aviso', args.map((a) => (typeof a === 'string' ? a : safe(a))).join(' '));
    warn(...args);
  };
}

function safe(v: unknown): string {
  try {
    return JSON.stringify(v).slice(0, 500);
  } catch {
    return String(v);
  }
}

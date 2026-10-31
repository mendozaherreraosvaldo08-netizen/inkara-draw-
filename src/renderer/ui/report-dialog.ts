import { logEntries } from '../error-log';
import { currentContent } from '../session';
import { store } from '../state';
import { h } from './dom';

/**
 * Ayuda › Reportar un problema: junta en una sola página (.html) qué pasó, una
 * captura de la ventana y el registro de errores, para mandarla y que se
 * pueda arreglar en la siguiente versión. El diseño solo va si se marca.
 */

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

async function toBase64(bytes: Uint8Array): Promise<string> {
  const url = await new Promise<string>((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.readAsDataURL(new Blob([bytes as BlobPart]));
  });
  return url.slice(url.indexOf(',') + 1);
}

export function openReportDialog(): void {
  const what = h('textarea', { class: 'input report-text', rows: 5, maxlength: 4000, placeholder: 'Ej. "Al generar las placas en PDF, la placa 5 salió sin el logo."', 'aria-label': '¿Qué pasó?' });
  const shot = h('input', { type: 'checkbox', checked: !!window.trazo?.captureWindow });
  const log = h('input', { type: 'checkbox', checked: true });
  const design = h('input', { type: 'checkbox' });
  const status = h('span', { class: 'export-status', role: 'status' });
  const save = h('button', { type: 'button', class: 'button primary', onclick: () => void submit() }, 'Guardar reporte');
  const count = logEntries().filter((e) => e.kind === 'error').length;
  const dialog = h(
    'div',
    { class: 'modal contour-dialog report-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'rep-title' },
    h('header', { class: 'modal-head' }, h('h2', { id: 'rep-title' }, 'Reportar un problema')),
    h(
      'div',
      { class: 'contour-body' },
      h('label', { class: 'field-label' }, '¿Qué pasó? ¿Qué estabas haciendo?'),
      what,
      h('label', { class: 'check' }, shot, h('span', {}, 'Incluir captura de la ventana', h('small', {}, window.trazo?.captureWindow ? 'Así se ve lo que estabas viendo.' : 'Solo en la app de escritorio.'))),
      h('label', { class: 'check' }, log, h('span', {}, 'Incluir registro de errores', h('small', {}, count ? `${count} ${count === 1 ? 'error registrado' : 'errores registrados'} en esta sesión (sin tus diseños).` : 'No hay errores registrados en esta sesión.'))),
      h('label', { class: 'check' }, design, h('span', {}, 'Incluir el diseño abierto', h('small', {}, 'Ayuda a ver el problema tal cual. Solo si no es privado.'))),
      h('p', { class: 'export-note' }, 'Se guarda un archivo .html (se abre en cualquier navegador). Mándalo por WhatsApp o correo.'),
    ),
    h('footer', { class: 'modal-foot' }, status, h('button', { type: 'button', class: 'button', onclick: () => close() }, 'Cancelar'), save),
  );
  const backdrop = h('div', { class: 'modal-backdrop' }, dialog);
  document.body.append(backdrop);
  backdrop.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') close();
  });
  what.focus();
  function close() {
    backdrop.remove();
  }

  async function submit() {
    save.disabled = true;
    status.textContent = 'Preparando…';
    // La captura se toma sin esta ventana encima.
    backdrop.hidden = true;
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 60)));
    let png: string | null = null;
    try {
      const bytes = shot.checked ? await window.trazo?.captureWindow?.() : null;
      if (bytes) png = await toBase64(bytes);
    } catch {
      // sin captura
    }
    backdrop.hidden = false;
    const info = await window.trazo?.getAppInfo().catch(() => null);
    const when = new Date();
    const entries = log.checked ? logEntries() : [];
    const doc = store.get().document;
    const html = `<!doctype html><html lang="es"><meta charset="utf-8"><title>Reporte Inkara Draw ${when.toLocaleDateString('es-MX')}</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:900px;margin:30px auto;padding:0 16px;color:#1d1d1f}h1{font-size:22px}pre{background:#f4f4f6;padding:12px;border-radius:8px;white-space:pre-wrap;font-size:12px}img{max-width:100%;border:1px solid #ddd;border-radius:8px}.k{color:#666;font-size:13px}</style>
<h1>Reporte de problema · Inkara Draw</h1>
<p class="k">${esc(when.toLocaleString('es-MX'))} · versión ${esc(info?.version ?? '?')} · ${esc(info?.platform ?? navigator.platform)} · Electron ${esc(info?.versions?.electron ?? '?')}</p>
<h2>Qué pasó</h2><pre>${esc(what.value.trim() || '(sin descripción)')}</pre>
<h2>Estado</h2><pre>Diseño: ${esc(doc.name)} · página ${doc.page.widthMm.toFixed(1)} × ${doc.page.heightMm.toFixed(1)} mm · ${doc.shapes.length} objetos · ${doc.pages?.length ?? 1} páginas${doc.merge ? ` · lista de ${doc.merge.rows.length} filas (columnas: ${esc(doc.merge.columns.join(', '))})` : ''}${doc.finishes?.length ? ` · acabados: ${esc(doc.finishes.map((f) => f.name).join(', '))}` : ''}</pre>
${png ? `<h2>Captura</h2><img alt="Captura" src="data:image/png;base64,${png}">` : ''}
${log.checked ? `<h2>Registro (${entries.length})</h2><pre>${entries.length ? esc(entries.map((e) => `${e.at} [${e.kind}] ${e.text}`).join('\n')) : 'Sin errores registrados.'}</pre>` : ''}
${design.checked ? `<h2>Diseño</h2><p><a download="${esc(doc.name)}.ink" href="data:application/json;base64,${await toBase64(new TextEncoder().encode(currentContent()))}">Descargar el diseño (.ink)</a></p>` : ''}
</html>`;
    const name = `Reporte Inkara ${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, '0')}-${String(when.getDate()).padStart(2, '0')} ${String(when.getHours()).padStart(2, '0')}${String(when.getMinutes()).padStart(2, '0')}`;
    const files = window.trazo?.files;
    if (files) {
      const r = await files.exportFile({ content: html, suggestedName: name, extension: 'html' });
      if (!r.ok) {
        status.textContent = r.canceled ? '' : r.error;
        save.disabled = false;
        return;
      }
      store.set({ hint: `Reporte guardado: ${r.value}. Mándalo por WhatsApp o correo.` });
    } else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
      a.download = `${name}.html`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      store.set({ hint: 'Reporte descargado.' });
    }
    close();
  }
}

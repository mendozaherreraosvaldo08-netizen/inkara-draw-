// Compila los tres procesos con esbuild (rápido: menos de un segundo).
//  - main:     proceso principal de Electron (Node, CommonJS).
//  - preload:  puente seguro entre Node y la interfaz (CommonJS, sandbox).
//  - renderer: la interfaz y el motor de dibujo (navegador, un solo script).
// Uso: node scripts/build.mjs [--watch]
import { build, context } from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';

const watch = process.argv.includes('--watch');
// --production (o NODE_ENV=production): minificado y sin mapas de código, para el instalador.
const production = process.env.NODE_ENV === 'production' || process.argv.includes('--production');

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist/renderer', { recursive: true });

const common = { bundle: true, sourcemap: !production, minify: production, logLevel: 'info' };

const targets = [
  { ...common, entryPoints: ['src/main/main.ts'], outfile: 'dist/main/main.js', platform: 'node', format: 'cjs', target: 'node24', external: ['electron'] },
  { ...common, entryPoints: ['src/preload/preload.ts'], outfile: 'dist/preload/preload.js', platform: 'node', format: 'cjs', target: 'node24', external: ['electron'] },
  // IIFE (un solo script clásico): carga sin problemas desde file:// dentro de Electron.
  { ...common, entryPoints: ['src/renderer/main.ts'], outfile: 'dist/renderer/main.js', platform: 'browser', format: 'iife', target: 'chrome150' },
];

// HTML y estilos se copian tal cual.
const copyStatic = () => {
  cpSync('src/renderer/index.html', 'dist/renderer/index.html');
  // Lector de PDF (abrir diseños exportados de CorelDRAW): su "worker" va aparte.
  cpSync('node_modules/pdfjs-dist/build/pdf.worker.min.mjs', 'dist/renderer/pdf.worker.min.mjs');
  cpSync('src/renderer/styles', 'dist/renderer/styles', { recursive: true });
  // Ícono y nombre de la app (pantalla de inicio y barra de título).
  cpSync('src/renderer/brand', 'dist/renderer/brand', { recursive: true });
};

copyStatic();
if (watch) {
  for (const options of targets) await (await context(options)).watch();
  console.log('Observando cambios… (los cambios de HTML/CSS requieren volver a ejecutar)');
} else {
  await Promise.all(targets.map((options) => build(options)));
}

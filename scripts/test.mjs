// Compila las pruebas con esbuild y las ejecuta con el corredor de Node (node --test).
import { spawnSync } from 'node:child_process';
import { readdirSync, rmSync } from 'node:fs';
import { build } from 'esbuild';

const files = readdirSync('tests').filter((f) => f.endsWith('.test.ts')).map((f) => `tests/${f}`);
rmSync('dist-test', { recursive: true, force: true });
await build({ entryPoints: files, outdir: 'dist-test', bundle: true, platform: 'node', format: 'esm', target: 'node24', outExtension: { '.js': '.mjs' }, logLevel: 'warning' });
const result = spawnSync(process.execPath, ['--test', ...files.map((f) => f.replace('tests/', 'dist-test/').replace(/\.ts$/, '.mjs'))], { stdio: 'inherit' });
process.exit(result.status ?? 1);

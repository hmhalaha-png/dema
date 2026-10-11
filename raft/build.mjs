// Bundles src/ into ONE self-contained index.html (works from file://, any web host, or offline).
//   node build.mjs                 -> ./index.html
//   node build.mjs --out <file>    -> custom output path (used by the smoke test)
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const outArg = process.argv.indexOf('--out');
const out = outArg > 0 ? path.resolve(process.argv[outArg + 1]) : path.join(root, 'index.html');

const result = await esbuild.build({
  entryPoints: [path.join(root, 'src/main.js')],
  bundle: true,
  format: 'iife',
  target: ['es2020'],
  write: false,
  charset: 'utf8',
  legalComments: 'none',
  logLevel: 'error',
});
const js = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const html = fs.readFileSync(path.join(root, 'template.html'), 'utf8').replace('/*BUNDLE*/', () => js);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html);
console.log('built ' + path.relative(process.cwd(), out) + ' (' + Math.round(html.length / 1024) + ' KB)');

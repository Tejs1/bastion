// Bundle the game into one self-contained HTML file (CSS + JS inlined).
//   node tools/build.mjs            -> dist/bastion.html  (full document, open directly)
//   node tools/build.mjs --fragment -> dist/bastion.fragment.html (no <html>/<head>/<body> wrapper,
//                                      for hosts that supply their own page skeleton)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const fragment = process.argv.includes('--fragment');
let html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

html = html.replace(/<link rel="stylesheet" href="([^"]+)">/g, (_, href) =>
  `<style>\n${fs.readFileSync(path.join(root, href), 'utf8')}\n</style>`);
html = html.replace(/<script src="([^"]+)"><\/script>/g, (_, src) =>
  `<script>\n${fs.readFileSync(path.join(root, src), 'utf8').replace(/<\/script/gi, '<\\/script')}\n</script>`);

// The sim worker can't be loaded by URL from a single file (or from file://),
// so its source (core modules + worker) is embedded for a Blob worker.
const core = ['util', 'data', 'map', 'sim', 'bot', 'stress', 'snapshot'].map((f) => fs.readFileSync(path.join(root, 'js/core', `${f}.js`), 'utf8'));
const workerSrc = [...core, fs.readFileSync(path.join(root, 'js/sim-worker.js'), 'utf8')].join('\n').replace(/<\/script/gi, '<\\/script');
html = html.replace('</body>', `<script type="text/js-worker" id="simWorkerSrc">\n${workerSrc}\n</script>\n</body>`);

if (fragment) {
  const title = html.match(/<title>[\s\S]*?<\/title>/)[0];
  const style = html.match(/<style>[\s\S]*?<\/style>/)[0];
  const body = html.match(/<body>([\s\S]*)<\/body>/)[1];
  html = `${title}\n${style}\n${body}`;
}
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
const out = path.join(root, 'dist', fragment ? 'bastion.fragment.html' : 'bastion.html');
fs.writeFileSync(out, html);
console.log('wrote', path.relative(root, out), `${(html.length / 1024).toFixed(1)} KB`);

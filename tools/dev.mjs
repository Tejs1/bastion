// Zero-dependency dev server with hot reload.
//   node tools/dev.mjs [--port 8080]
// CSS edits are hot-swapped in place (game state survives); JS/HTML edits
// trigger a full page reload, since the game is plain global scripts.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const portArg = process.argv.indexOf('--port');
const port = Number(portArg > 0 ? process.argv[portArg + 1] : process.env.PORT || 8080);
const watched = ['index.html', 'analytics.html', 'css', 'js', 'analytics'];

const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.jsonl': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.wasm': 'application/wasm',
};

const client = `<script>(() => {
  const es = new EventSource('/__dev');
  es.onmessage = (e) => {
    const { type, file } = JSON.parse(e.data);
    if (type !== 'css') return location.reload();
    let hit = false;
    for (const link of document.querySelectorAll('link[rel="stylesheet"]')) {
      const url = new URL(link.href);
      if (url.pathname !== '/' + file) continue;
      url.searchParams.set('t', Date.now());
      const next = link.cloneNode();
      next.href = url.href;
      next.onload = () => link.remove();
      link.after(next);
      hit = true;
    }
    if (!hit) location.reload();
    else console.info('[dev] hot-swapped', file);
  };
})();</script>`;

const clients = new Set();
function broadcast(msg) {
  for (const res of clients) res.write(`data: ${JSON.stringify(msg)}\n\n`);
}

const pending = new Map();
for (const entry of watched) {
  const abs = path.join(root, entry);
  if (!fs.existsSync(abs)) continue;
  const isDir = fs.statSync(abs).isDirectory();
  fs.watch(abs, { recursive: isDir }, (_, name) => {
    const file = (isDir ? `${entry}/${name}` : entry).split(path.sep).join('/');
    // Editors fire several events per save; debounce per file.
    clearTimeout(pending.get(file));
    pending.set(file, setTimeout(() => {
      pending.delete(file);
      const type = file.endsWith('.css') ? 'css' : 'reload';
      console.log(`[dev] ${type === 'css' ? 'hot' : 'reload'}  ${file}`);
      broadcast({ type, file });
    }, 50));
  });
}

function resolve(urlPath) {
  const rel = decodeURIComponent(urlPath.split('?')[0]);
  const abs = path.join(root, path.normalize(rel));
  if (!abs.startsWith(root)) return null;
  const isFile = (p) => fs.existsSync(p) && fs.statSync(p).isFile();
  // Match vercel.json cleanUrls: /analytics -> analytics.html (even though analytics/ also exists)
  return [abs, path.join(abs, 'index.html'), `${abs.replace(/\/$/, '')}.html`].find(isFile) ?? null;
}

http.createServer((req, res) => {
  if (req.url === '/__dev') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(': connected\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  const file = resolve(req.url);
  if (!file) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not found');
  }
  const ext = path.extname(file);
  res.setHeader('Content-Type', types[ext] || 'application/octet-stream');
  res.setHeader('Cache-Control', 'no-store');
  if (ext === '.html') {
    const html = fs.readFileSync(file, 'utf8');
    return res.end(html.includes('</body>') ? html.replace('</body>', `${client}\n</body>`) : html + client);
  }
  fs.createReadStream(file).pipe(res);
}).listen(port, () => console.log(`[dev] http://localhost:${port}  (watching ${watched.join(', ')})`));

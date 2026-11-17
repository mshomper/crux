#!/usr/bin/env node
// Serves site/ on this machine so the page can be opened in a browser and the hero swarm seen running live.
// Nothing leaves the machine (127.0.0.1 only). The page's scripts are ES modules, so opening index.html straight
// from the folder does not work; use this.   node site-tools/serve-site.mjs [port]      then open http://127.0.0.1:4810/
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'site');
const port = Number(process.argv[2]) || 4810;
if (port === 4747 || port === 4748) { console.error('Those ports belong to the live Hub.'); process.exit(1); }
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json' };

createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const file = normalize(join(root, p));
    if (file !== root && !file.startsWith(root + sep)) throw new Error('outside');
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' }).end(body);
  } catch { res.writeHead(404, { 'content-type': 'text/plain' }).end('not found'); }
}).listen(port, '127.0.0.1', () => console.log(`The page is at http://127.0.0.1:${port}/  (Ctrl+C to stop)`));

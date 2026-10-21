// Zero-dependency static file server for local preview of public/.
// Mirrors GitHub Pages behaviour closely enough for this site:
//   - /dir      -> 301 to /dir/      (so relative links like "../gold/" resolve)
//   - /dir/     -> dir/index.html
//   - unknown   -> public/404.html (status 404)
//
// Run: node scripts/serve-local.mjs            (PORT env var, default 8080)
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUB = path.join(root, 'public');
const START_PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

if (!existsSync(PUB)) {
  console.error(`[serve] public/ not found at ${PUB}. Run "node scripts/build.mjs" first.`);
  process.exit(1);
}

function send(res, status, file, extraHeaders = {}) {
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': statSync(file).size,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  createReadStream(file).pipe(res);
}

function sendText(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

const server = createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendText(res, 405, 'Method Not Allowed');
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    return sendText(res, 400, 'Bad Request');
  }

  // Resolve inside public/ only (blocks ../ traversal).
  const filePath = path.normalize(path.join(PUB, pathname));
  if (filePath !== PUB && !filePath.startsWith(PUB + path.sep)) {
    return sendText(res, 403, 'Forbidden');
  }

  if (existsSync(filePath) && statSync(filePath).isDirectory()) {
    if (!pathname.endsWith('/')) {
      res.writeHead(301, { Location: pathname + '/' + (new URL(req.url, 'http://x').search || '') });
      return res.end();
    }
    const index = path.join(filePath, 'index.html');
    if (existsSync(index)) return send(res, 200, index);
  } else if (existsSync(filePath) && statSync(filePath).isFile()) {
    return send(res, 200, filePath);
  }

  const notFound = path.join(PUB, '404.html');
  if (existsSync(notFound)) return send(res, 404, notFound);
  return sendText(res, 404, 'Not Found');
});

// A previous run may still be using the port. In that case the browser would open
// the OLD server (old files), so we move to the next free port and say so clearly.
const MAX_TRIES = 20;
let port = START_PORT;
let tries = 0;

function listenOn(p) {
  server.removeAllListeners('error');
  server.removeAllListeners('listening');
  server.once('listening', () => onListening(server.address().port));
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && tries < MAX_TRIES) {
      if (tries === 0) {
        console.warn(`[serve] Port ${START_PORT} is already in use (an older run may still be open).`);
      }
      tries++;
      port = p + 1;
      listenOn(port);
    } else {
      console.error(`[serve] ${err.code === 'EADDRINUSE' ? 'No free port found near ' + START_PORT : err.message}`);
      process.exit(1);
    }
  });
  server.listen(p, HOST);
}

function openBrowser(url) {
  if (process.env.NO_OPEN) return;
  const [cmd, args] = process.platform === 'win32' ? ['explorer.exe', [url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
  } catch { /* browser can be opened manually */ }
}

function onListening(p) {
  const url = `http://127.0.0.1:${p}/en/`;
  console.log(`[serve] Serving public/ at ${url}   (Persian: /fa/)`);
  console.log('[serve] Press Ctrl+C to stop.');
  openBrowser(url);
}

listenOn(port);

// Keep a reference so Ctrl+C from the batch wrapper exits cleanly.
process.on('SIGINT', () => server.close(() => process.exit(0)));

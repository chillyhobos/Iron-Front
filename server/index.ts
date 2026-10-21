// Iron Front game server: hosts online matches over a WebSocket at /ws, and (after
// `npm run build`) serves the game itself, so one process is all a host needs.
//
//   npm run server            → http://localhost:8787 (set PORT to change it)
//   npm run build && npm start → the same, for hosting (Render runs exactly this)

import { createReadStream, existsSync, statSync } from 'fs';
import { createServer } from 'http';
import { networkInterfaces } from 'os';
import { extname, join, normalize, resolve } from 'path';
import { WebSocketServer, type WebSocket } from 'ws';
import { Rooms, type Conn } from './rooms';
import type { ClientMessage } from '../src/net/protocol';

const PORT = Number(process.env.PORT ?? 8787);
const DIST = resolve(process.cwd(), 'dist');
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};

const rooms = new Rooms();
setInterval(() => rooms.sweep(), 10 * 60 * 1000).unref();

// Static files from the built game (dist/), with index.html for everything else.
const http = createServer((req, res) => {
  // Hosting services poll this to check the server is up.
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    return;
  }
  if (!existsSync(DIST)) {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('Iron Front game server is running. Build the game (npm run build) to play from this address, or use the dev server.');
    return;
  }
  const url = decodeURIComponent((req.url ?? '/').split('?')[0]);
  let file = normalize(join(DIST, url));
  if (!file.startsWith(DIST) || !existsSync(file) || statSync(file).isDirectory()) file = join(DIST, 'index.html');
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
});

const wss = new WebSocketServer({ server: http, path: '/ws', maxPayload: 2 * 1024 * 1024 });

// Ping every browser now and then: hosting proxies drop connections that sit silent,
// and a browser that vanished without closing (sleep, lost Wi-Fi) gets noticed and
// shown as away instead of looking connected forever.
const alive = new WeakMap<WebSocket, boolean>();
setInterval(() => {
  for (const ws of wss.clients) {
    if (alive.get(ws) === false) { ws.terminate(); continue; }
    alive.set(ws, false);
    ws.ping();
  }
}, 30 * 1000).unref();

wss.on('connection', (ws: WebSocket) => {
  alive.set(ws, true);
  ws.on('pong', () => alive.set(ws, true));
  const conn: Conn = { send: msg => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); } };
  ws.on('message', data => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return conn.send({ t: 'error', message: 'Bad message.' });
    }
    rooms.handle(conn, msg);
  });
  ws.on('close', () => rooms.disconnect(conn));
});

// (The WebSocket server passes the HTTP server's errors on, so it needs the handler too.)
const onListenError = (e: NodeJS.ErrnoException) => {
  if (e.code !== 'EADDRINUSE') throw e;
  console.error(`Port ${PORT} is already in use: is another Iron Front server still running? (Or set PORT to use a different one.)`);
  process.exit(1);
};
http.on('error', onListenError);
wss.on('error', onListenError);
http.listen(PORT, () => {
  const lan = Object.values(networkInterfaces()).flat()
    .filter(a => a && a.family === 'IPv4' && !a.internal).map(a => `http://${a!.address}:${PORT}`);
  console.log(`Iron Front server on http://localhost:${PORT}${lan.length ? ` (same network: ${lan.join(', ')})` : ''}`);
});

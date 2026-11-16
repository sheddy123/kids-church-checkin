#!/usr/bin/env node
/*
 * Serves the phone app (the www/ folder) in a browser, no dependencies.
 *   node dev/app-server.js        -> http://localhost:5174
 *   PORT=8080 node dev/app-server.js
 *
 * Files are re-read on every request: edit, save, refresh.
 * The camera only works on http://localhost or https, so on a phone over
 * Wi-Fi the app falls back to the phone's own camera/gallery picker.
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = Number(process.env.PORT) || 5174;
const ROOT = path.join(__dirname, '..', 'www');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };

http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (p === '/') p = '/index.html';
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return; }
    // DEV_CONFIG lets the tests swap in a different js/config.js (e.g. the Firebase emulator).
    if (p === '/js/config.js' && process.env.DEV_CONFIG) buf = Buffer.from(process.env.DEV_CONFIG);
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(buf);
  });
}).listen(PORT, '0.0.0.0', () => {
  console.log('\nKids Church Check-In app (dev)');
  console.log('  This computer:  http://localhost:' + PORT);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) console.log('  Phone (same Wi-Fi): http://' + a.address + ':' + PORT);
  }
  console.log('\n  Ctrl+C to stop.\n');
});

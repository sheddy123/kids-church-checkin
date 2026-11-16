#!/usr/bin/env node
/*
 * Tiny dev server, no dependencies.
 *   node dev/server.js         -> http://localhost:5173
 *   PORT=8080 node dev/server.js
 *
 * Serves index.html with dev/mock-claude.js injected, so the app runs
 * without claude.ai. Files are re-read on every request: edit, save, refresh.
 * It also prints your network address so you can open it on a phone on
 * the same Wi-Fi.
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = Number(process.env.PORT) || 5173;
const ROOT = path.join(__dirname, '..');

function page() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const mock = fs.readFileSync(path.join(__dirname, 'mock-claude.js'), 'utf8');
  if (!html.includes('<head>')) throw new Error('index.html has no <head> tag to inject into');
  return html.replace('<head>', '<head>\n<script>/* DEV ONLY: injected by dev/server.js */\n' + mock + '\n</script>');
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/' || url.pathname === '/index.html') {
    try {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(page());
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(String(e && e.stack || e));
    }
    return;
  }
  if (url.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
}).listen(PORT, '0.0.0.0', () => {
  console.log('\nKids Church Check-In (dev)');
  console.log('  This computer:  http://localhost:' + PORT);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) console.log('  Phone (same Wi-Fi): http://' + a.address + ':' + PORT);
    }
  }
  console.log('\n  Try ?as=viewer, ?as=signedout or ?reset. Ctrl+C to stop.\n');
});

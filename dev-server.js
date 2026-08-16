/**
 * Kleiner Entwicklungs-Server, um die Seite lokal zu testen:
 *
 *   node dev-server.js      →  http://localhost:8777
 *
 * Nur fürs Testen — auf GitHub Pages wird die Datei nicht gebraucht.
 * (Direkt per Doppelklick auf index.html geht nicht: Web Worker und
 *  IndexedDB brauchen http:// statt file://.)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = process.env.PORT || 8777;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml'
};

http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = path.resolve(path.join(ROOT, p));
  if (!file.startsWith(path.resolve(ROOT))) { res.writeHead(403).end('403'); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('404 ' + p); return; }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(data);
  });
}).listen(PORT, () => console.log('WebLime läuft auf http://localhost:' + PORT));

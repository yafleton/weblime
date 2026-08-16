/**
 * WebLime API — Cloudflare Worker vor einem R2-Bucket.
 *
 * Endpunkte (alle unter /api):
 *   GET    /api/ping                          → { ok, files }
 *   GET    /api/list                          → { files: [{path,size,mtime,etag}] }
 *   GET    /api/file?path=…                   → Rohdaten
 *   PUT    /api/file?path=…&mtime=…           → { ok, path, size, etag }
 *   DELETE /api/file?path=…                   → { ok }
 *   DELETE /api/prefix?prefix=…               → { ok, deleted }
 *   POST   /api/mpu/create?path=…             → { uploadId }
 *   PUT    /api/mpu/part?path=…&uploadId=…&part=N   → { part, etag }
 *   POST   /api/mpu/complete?path=…&uploadId=… (Body: {parts})  → { ok, size }
 *   POST   /api/mpu/abort?path=…&uploadId=…   → { ok }
 *   POST   /api/search                        → dauerhafte Volltextsuche
 *   GET    /api/index/status                  → Stand des Cloud-Suchindex
 *   POST   /api/index/rebuild                 → Erstindex fortsetzen
 *
 * Authentifizierung: Header `Authorization: Bearer <AUTH_TOKEN>`.
 * AUTH_TOKEN wird als Secret gesetzt:  wrangler secret put AUTH_TOKEN
 */

const MAX_KEY = 900;
const MAX_INDEX_BYTES = 5 * 1024 * 1024;
const INDEX_CHUNK_CHARS = 64 * 1024;
const REBUILD_PAGE = 12;
const SEARCH_PAGE = 160;

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors(env, origin) });
    }

    try {
      const res = await handle(request, env, ctx);
      const h = cors(env, origin);
      for (const [k, v] of Object.entries(h)) res.headers.set(k, v);
      return res;
    } catch (err) {
      const status = Number(err && err.status) || 500;
      const message = status >= 500 ? 'Interner Serverfehler' : String(err && err.message || err);
      return json({ error: message }, status, cors(env, origin));
    }
  }
};

/* ---------------------------------------------------------- */

function cors(env, origin) {
  const allowed = (env.ALLOWED_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
  const allow = allowed.includes('*') ? '*' : (allowed.includes(origin) ? origin : '');
  const headers = {
    'Access-Control-Allow-Methods': 'GET,HEAD,PUT,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization,Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
  if (allow) headers['Access-Control-Allow-Origin'] = allow;
  return headers;
}

function json(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers }
  });
}

function authOk(request, env) {
  if (!env.AUTH_TOKEN) return false;                // Ohne Secret niemals offen starten
  const h = request.headers.get('Authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return !!m && safeEqual(m[1], env.AUTH_TOKEN);
}

function httpError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Schlüssel bereinigen: keine absoluten Pfade, kein ".." */
function cleanKey(raw) {
  if (!raw) throw httpError('Pfad fehlt');
  let k = String(raw).normalize('NFC').replace(/\\/g, '/').replace(/^\/+/, '');
  if (new TextEncoder().encode(k).length > MAX_KEY) throw httpError('Pfad zu lang');
  const parts = k.split('/').filter(p => p !== '' && p !== '.');
  if (parts.some(p => p === '..')) throw httpError('Ungültiger Pfad');
  if (parts.some(p => /[\0-\x1f\x7f]/.test(p))) throw httpError('Ungültiger Pfad');
  k = parts.join('/');
  if (!k) throw httpError('Ungültiger Pfad');
  return k;
}

function contentType(key) {
  const ext = key.split('.').pop().toLowerCase();
  const map = {
    html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript',
    json: 'application/json', svg: 'image/svg+xml', png: 'image/png',
    jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
    avif: 'image/avif', ico: 'image/x-icon', pdf: 'application/pdf',
    mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac',
    mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
    zip: 'application/zip', txt: 'text/plain', md: 'text/markdown'
  };
  return map[ext] || 'application/octet-stream';
}

/* ---------------------------------------------------------- */

async function handle(request, env, ctx) {
  const url = new URL(request.url);
  const p = url.pathname.replace(/\/+$/, '') || '/';
  const q = url.searchParams;
  const method = request.method;

  if (p === '/' || p === '/api') {
    return json({ ok: true, service: 'weblime-api' });
  }

  if (!env.AUTH_TOKEN) {
    return json({ error: 'AUTH_TOKEN ist nicht konfiguriert' }, 503);
  }
  if (!authOk(request, env)) {
    return json({ error: 'Nicht autorisiert' }, 401);
  }
  if (!env.BUCKET) {
    return json({ error: 'R2-Bucket ist nicht gebunden (BUCKET)' }, 500);
  }
  /* ---- ping ---- */
  if (p === '/api/ping') {
    const l = await env.BUCKET.list({ limit: 1000 });
    const index = env.SEARCH_DB ? await indexStatus(env) : null;
    return json({ ok: true, files: l.objects.length + (l.truncated ? '+' : ''), index });
  }

  /* ---- dauerhafte Cloud-Suche ---- */
  if (p === '/api/index/status' && method === 'GET') {
    if (!env.SEARCH_DB) return json({ error: 'D1-Datenbank ist nicht gebunden (SEARCH_DB)' }, 500);
    return json(await indexStatus(env));
  }

  if (p === '/api/index/rebuild' && method === 'POST') {
    if (!env.SEARCH_DB) return json({ error: 'D1-Datenbank ist nicht gebunden (SEARCH_DB)' }, 500);
    return json(await rebuildIndexPage(env));
  }

  if (p === '/api/search' && method === 'POST') {
    if (!env.SEARCH_DB) return json({ error: 'D1-Datenbank ist nicht gebunden (SEARCH_DB)' }, 500);
    return json(await searchIndex(request, env));
  }

  /* ---- list ---- */
  if (p === '/api/list' && method === 'GET') {
    const files = [];
    let cursor = undefined;
    do {
      const l = await env.BUCKET.list({ limit: 1000, cursor, include: ['customMetadata'] });
      for (const o of l.objects) {
        files.push({
          path: o.key,
          size: o.size,
          etag: o.etag,
          mtime: Number((o.customMetadata && o.customMetadata.mtime) || 0) || Date.parse(o.uploaded)
        });
      }
      cursor = l.truncated ? l.cursor : undefined;
    } while (cursor);
    return json({ files });
  }

  /* ---- einzelne Datei ---- */
  if (p === '/api/file') {
    const key = cleanKey(q.get('path'));

    if (method === 'GET' || method === 'HEAD') {
      const obj = method === 'HEAD'
        ? await env.BUCKET.head(key)
        : await env.BUCKET.get(key, { onlyIf: request.headers, range: request.headers });
      if (!obj) return json({ error: 'Nicht gefunden' }, 404);
      const h = new Headers();
      obj.writeHttpMetadata(h);
      h.set('Content-Type', obj.httpMetadata?.contentType || contentType(key));
      h.set('etag', obj.httpEtag);
      h.set('Cache-Control', 'no-store');
      h.set('Accept-Ranges', 'bytes');
      if (obj.range) {
        const start = obj.range.offset || 0;
        const length = obj.range.length || Math.max(0, obj.size - start);
        h.set('Content-Range', `bytes ${start}-${start + length - 1}/${obj.size}`);
      }
      const hasBody = method === 'HEAD' || 'body' in obj;
      return new Response(method === 'HEAD' ? null : (hasBody ? obj.body : null), {
        status: hasBody ? (obj.range ? 206 : 200) : 412,
        headers: h
      });
    }

    if (method === 'PUT') {
      const mtime = q.get('mtime') || String(Date.now());
      const obj = await env.BUCKET.put(key, request.body, {
        httpMetadata: { contentType: contentType(key) },
        customMetadata: { mtime }
      });
      if (env.SEARCH_DB && ctx && typeof ctx.waitUntil === 'function') {
        ctx.waitUntil(indexR2Object(env, {
          key,
          size: obj.size,
          etag: obj.etag,
          mtime: Number(mtime) || Date.now()
        }).catch(error => console.error(JSON.stringify({ event: 'search-index-upload', key, error: String(error) }))));
      }
      return json({ ok: true, path: key, size: obj.size, etag: obj.etag });
    }

    if (method === 'DELETE') {
      await Promise.all([
        env.BUCKET.delete(key),
        env.SEARCH_DB ? deleteIndexedPath(env, key, false) : Promise.resolve()
      ]);
      return json({ ok: true, path: key });
    }
    return json({ error: 'Methode nicht erlaubt' }, 405);
  }

  /* ---- Ordner löschen ---- */
  if (p === '/api/prefix' && method === 'DELETE') {
    const prefix = cleanKey(q.get('prefix'));
    let cursor, deleted = 0;
    do {
      const l = await env.BUCKET.list({ prefix: prefix + '/', limit: 1000, cursor });
      const keys = l.objects.map(o => o.key);
      if (keys.length) { await env.BUCKET.delete(keys); deleted += keys.length; }
      cursor = l.truncated ? l.cursor : undefined;
    } while (cursor);
    await env.BUCKET.delete(prefix);
    if (env.SEARCH_DB) await deleteIndexedPath(env, prefix, true);
    return json({ ok: true, deleted });
  }

  /* ---- Multipart-Upload für große Dateien ---- */
  if (p === '/api/mpu/create' && method === 'POST') {
    const key = cleanKey(q.get('path'));
    const mtime = q.get('mtime') || String(Date.now());
    const mpu = await env.BUCKET.createMultipartUpload(key, {
      httpMetadata: { contentType: contentType(key) },
      customMetadata: { mtime }
    });
    return json({ uploadId: mpu.uploadId, path: key });
  }

  if (p === '/api/mpu/part' && method === 'PUT') {
    const key = cleanKey(q.get('path'));
    const uploadId = q.get('uploadId');
    const partNumber = parseInt(q.get('part'), 10);
    if (!uploadId || !Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) {
      return json({ error: 'uploadId/part ungültig' }, 400);
    }
    const mpu = env.BUCKET.resumeMultipartUpload(key, uploadId);
    const part = await mpu.uploadPart(partNumber, request.body);
    return json({ part: part.partNumber, etag: part.etag });
  }

  if (p === '/api/mpu/complete' && method === 'POST') {
    const key = cleanKey(q.get('path'));
    const uploadId = q.get('uploadId');
    if (!uploadId) return json({ error: 'uploadId fehlt' }, 400);
    const body = await request.json();
    const parts = (body.parts || []).map(x => ({ partNumber: x.partNumber, etag: x.etag }));
    if (!parts.length || parts.some(x => !Number.isInteger(x.partNumber) || x.partNumber < 1 || !x.etag)) {
      return json({ error: 'Ungültige Multipart-Liste' }, 400);
    }
    const mpu = env.BUCKET.resumeMultipartUpload(key, uploadId);
    const obj = await mpu.complete(parts);
    if (env.SEARCH_DB && ctx && typeof ctx.waitUntil === 'function') {
      ctx.waitUntil(indexR2Object(env, {
        key,
        size: obj.size,
        etag: obj.etag,
        mtime: Number(q.get('mtime')) || Date.now()
      }).catch(error => console.error(JSON.stringify({ event: 'search-index-multipart', key, error: String(error) }))));
    }
    return json({ ok: true, path: key, size: obj.size, etag: obj.etag });
  }

  if (p === '/api/mpu/abort' && method === 'POST') {
    const key = cleanKey(q.get('path'));
    const uploadId = q.get('uploadId');
    if (!uploadId) return json({ error: 'uploadId fehlt' }, 400);
    const mpu = env.BUCKET.resumeMultipartUpload(key, uploadId);
    await mpu.abort();
    return json({ ok: true });
  }

  return json({ error: 'Unbekannter Endpunkt: ' + p }, 404);
}

/* ---------------------------------------------------------- */
/* Dauerhafter Suchindex in D1. R2 bleibt die einzige Quelle der Dateien. */

function isKnownBinary(key) {
  const ext = (key.split('.').pop() || '').toLowerCase();
  return new Set([
    '7z', 'avi', 'avif', 'bin', 'bmp', 'class', 'db', 'dll', 'doc', 'docx',
    'eot', 'exe', 'flac', 'gif', 'gz', 'ico', 'jar', 'jpeg', 'jpg', 'lockb',
    'm4a', 'mkv', 'mov', 'mp3', 'mp4', 'ogg', 'otf', 'pdf', 'png', 'rar',
    'so', 'sqlite', 'tar', 'ttf', 'wav', 'webm', 'webp', 'woff', 'woff2',
    'xls', 'xlsx', 'zip'
  ]).has(ext);
}

function looksBinary(bytes) {
  const n = Math.min(bytes.length, 8192);
  if (!n) return false;
  let controls = 0;
  for (let i = 0; i < n; i++) {
    const b = bytes[i];
    if (b === 0) return true;
    if (b < 7 || (b > 13 && b < 32)) controls++;
  }
  return controls / n > 0.08;
}

function makeChunks(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const chunks = [];
  let startLine = 0;
  let current = [];
  let length = 0;

  function flush() {
    if (!current.length) return;
    chunks.push({ startLine, text: current.join('\n') });
    startLine += current.length;
    current = [];
    length = 0;
  }

  for (const original of lines) {
    // Einzelne Minified-Zeilen dürfen die D1-Zeilengrenze nicht sprengen.
    const line = original.length > 500000 ? original.slice(0, 500000) : original;
    if (current.length && length + line.length + 1 > INDEX_CHUNK_CHARS) flush();
    current.push(line);
    length += line.length + (current.length > 1 ? 1 : 0);
  }
  flush();
  return chunks;
}

async function setMeta(env, key, value) {
  await env.SEARCH_DB.prepare(
    'INSERT INTO search_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).bind(key, String(value)).run();
}

async function getMeta(env, key, fallback = '') {
  const row = await env.SEARCH_DB.prepare('SELECT value FROM search_meta WHERE key = ?').bind(key).first();
  return row ? String(row.value) : fallback;
}

async function markSkipped(env, info, status, generation) {
  await env.SEARCH_DB.batch([
    env.SEARCH_DB.prepare('DELETE FROM search_chunks WHERE path = ?').bind(info.key),
    env.SEARCH_DB.prepare(`
      INSERT INTO search_files(path, etag, size, mtime, status, chunks, generation, updated_at)
      VALUES (?, ?, ?, ?, ?, 0, ?, ?)
      ON CONFLICT(path) DO UPDATE SET etag=excluded.etag, size=excluded.size,
        mtime=excluded.mtime, status=excluded.status, chunks=0,
        generation=excluded.generation, updated_at=excluded.updated_at
    `).bind(info.key, info.etag || '', info.size || 0, info.mtime || 0, status, generation || '', Date.now())
  ]);
}

async function indexR2Object(env, info, generation = '') {
  if (info.size > MAX_INDEX_BYTES || isKnownBinary(info.key)) {
    await markSkipped(env, info, 'skipped', generation);
    return { status: 'skipped', chunks: 0 };
  }

  const object = await env.BUCKET.get(info.key);
  if (!object) {
    await deleteIndexedPath(env, info.key, false);
    return { status: 'missing', chunks: 0 };
  }
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (looksBinary(bytes)) {
    await markSkipped(env, info, 'skipped', generation);
    return { status: 'skipped', chunks: 0 };
  }

  let text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const chunks = makeChunks(text);
  const statements = [
    env.SEARCH_DB.prepare('DELETE FROM search_chunks WHERE path = ?').bind(info.key),
    env.SEARCH_DB.prepare(`
      INSERT INTO search_files(path, etag, size, mtime, status, chunks, generation, updated_at)
      VALUES (?, ?, ?, ?, 'indexed', ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET etag=excluded.etag, size=excluded.size,
        mtime=excluded.mtime, status='indexed', chunks=excluded.chunks,
        generation=excluded.generation, updated_at=excluded.updated_at
    `).bind(info.key, info.etag || '', info.size || bytes.length, info.mtime || 0, chunks.length, generation, Date.now())
  ];
  const insert = env.SEARCH_DB.prepare(
    'INSERT INTO search_chunks(path, chunk_no, start_line, text) VALUES (?, ?, ?, ?)'
  );
  chunks.forEach((chunk, index) => statements.push(insert.bind(info.key, index, chunk.startLine, chunk.text)));
  await env.SEARCH_DB.batch(statements);
  return { status: 'indexed', chunks: chunks.length };
}

async function deleteIndexedPath(env, path, prefix) {
  if (prefix) {
    const marker = path + '/';
    await env.SEARCH_DB.batch([
      env.SEARCH_DB.prepare('DELETE FROM search_chunks WHERE path = ? OR substr(path, 1, ?) = ?')
        .bind(path, marker.length, marker),
      env.SEARCH_DB.prepare('DELETE FROM search_files WHERE path = ? OR substr(path, 1, ?) = ?')
        .bind(path, marker.length, marker)
    ]);
  } else {
    await env.SEARCH_DB.batch([
      env.SEARCH_DB.prepare('DELETE FROM search_chunks WHERE path = ?').bind(path),
      env.SEARCH_DB.prepare('DELETE FROM search_files WHERE path = ?').bind(path)
    ]);
  }
}

async function indexStatus(env) {
  const [counts, chunks, complete, processed] = await env.SEARCH_DB.batch([
    env.SEARCH_DB.prepare(`
      SELECT COUNT(*) AS known,
        SUM(CASE WHEN status='indexed' THEN 1 ELSE 0 END) AS indexed,
        SUM(CASE WHEN status='skipped' THEN 1 ELSE 0 END) AS skipped,
        SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) AS errors
      FROM search_files
    `),
    env.SEARCH_DB.prepare('SELECT COUNT(*) AS chunks FROM search_chunks'),
    env.SEARCH_DB.prepare("SELECT value FROM search_meta WHERE key = 'complete'"),
    env.SEARCH_DB.prepare("SELECT value FROM search_meta WHERE key = 'processed'")
  ]);
  return {
    complete: String(complete.results[0]?.value || '0') === '1',
    processed: Number(processed.results[0]?.value) || 0,
    known: Number(counts.results[0]?.known) || 0,
    indexed: Number(counts.results[0]?.indexed) || 0,
    skipped: Number(counts.results[0]?.skipped) || 0,
    errors: Number(counts.results[0]?.errors) || 0,
    chunks: Number(chunks.results[0]?.chunks) || 0
  };
}

async function rebuildIndexPage(env) {
  let job = await getMeta(env, 'job');
  let cursor = await getMeta(env, 'cursor');
  let processed = Number(await getMeta(env, 'processed', '0')) || 0;
  if (!job) {
    job = crypto.randomUUID();
    cursor = '';
    processed = 0;
    await env.SEARCH_DB.batch([
      env.SEARCH_DB.prepare("INSERT INTO search_meta(key,value) VALUES ('job',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(job),
      env.SEARCH_DB.prepare("INSERT INTO search_meta(key,value) VALUES ('complete','0') ON CONFLICT(key) DO UPDATE SET value='0'"),
      env.SEARCH_DB.prepare("INSERT INTO search_meta(key,value) VALUES ('processed','0') ON CONFLICT(key) DO UPDATE SET value='0'")
    ]);
  }

  const listed = await env.BUCKET.list({
    limit: REBUILD_PAGE,
    cursor: cursor || undefined,
    include: ['customMetadata']
  });

  let indexed = 0;
  let skipped = 0;
  let failed = 0;
  const queue = listed.objects.slice();
  async function runner() {
    while (queue.length) {
      const object = queue.shift();
      const info = {
        key: object.key,
        size: object.size,
        etag: object.etag || '',
        mtime: Number(object.customMetadata?.mtime) || Date.parse(object.uploaded) || 0
      };
      try {
        const existing = await env.SEARCH_DB.prepare(
          'SELECT etag, status FROM search_files WHERE path = ?'
        ).bind(info.key).first();
        if (existing && existing.etag === info.etag && existing.status !== 'error') {
          await env.SEARCH_DB.prepare('UPDATE search_files SET generation = ? WHERE path = ?').bind(job, info.key).run();
          if (existing.status === 'indexed') indexed++; else skipped++;
        } else {
          const result = await indexR2Object(env, info, job);
          if (result.status === 'indexed') indexed++; else skipped++;
        }
      } catch (error) {
        failed++;
        await markSkipped(env, info, 'error', job);
        console.error(JSON.stringify({ event: 'search-index-rebuild', key: info.key, error: String(error) }));
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, () => runner()));
  processed += listed.objects.length;

  if (listed.truncated) {
    await Promise.all([
      setMeta(env, 'cursor', listed.cursor || ''),
      setMeta(env, 'processed', processed)
    ]);
    return { done: false, processed, indexed, skipped, failed };
  }

  await env.SEARCH_DB.batch([
    env.SEARCH_DB.prepare('DELETE FROM search_chunks WHERE path IN (SELECT path FROM search_files WHERE generation <> ?)').bind(job),
    env.SEARCH_DB.prepare('DELETE FROM search_files WHERE generation <> ?').bind(job),
    env.SEARCH_DB.prepare("DELETE FROM search_meta WHERE key IN ('job','cursor')"),
    env.SEARCH_DB.prepare("INSERT INTO search_meta(key,value) VALUES ('complete','1') ON CONFLICT(key) DO UPDATE SET value='1'"),
    env.SEARCH_DB.prepare("INSERT INTO search_meta(key,value) VALUES ('processed',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(processed)
  ]);
  return { done: true, processed, indexed, skipped, failed, status: await indexStatus(env) };
}

function globToRegExp(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === '*') {
      if (glob[i + 1] === '*') { out += '.*'; i++; if (glob[i + 1] === '/') i++; }
      else out += '[^/]*';
    } else if (char === '?') out += '[^/]';
    else if ('\\^$.|+()[]{}'.includes(char)) out += '\\' + char;
    else out += char;
  }
  return new RegExp('^' + out + '$', 'i');
}

function makePathFilter(spec) {
  const patterns = String(spec || '').split(',').map(value => value.trim()).filter(Boolean).map(pattern => {
    if (/^[\w]+$/.test(pattern)) pattern = '*.' + pattern;
    if (pattern.endsWith('/')) pattern += '**';
    if (!pattern.includes('/') && !pattern.includes('*')) pattern = '**/' + pattern;
    return globToRegExp(pattern);
  });
  if (!patterns.length) return null;
  return path => patterns.some(pattern => pattern.test(path) || pattern.test(path.split('/').pop()));
}

function exactSearchRegExp(query, options) {
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let source = options.regex ? query : escaped;
  if (options.word) source = '\\b(?:' + source + ')\\b';
  return new RegExp(source, 'g' + (options.caseSensitive ? '' : 'i'));
}

function ftsLiteral(query) {
  return '"' + query.replace(/"/g, '""') + '"';
}

async function searchIndex(request, env) {
  const body = await request.json();
  const query = String(body.query || '');
  if (!query) throw httpError('Suchbegriff fehlt');
  const options = body.opts || {};
  let expression;
  try { expression = exactSearchRegExp(query, options); }
  catch (error) { throw httpError('Ungültiger regulärer Ausdruck: ' + error.message); }

  const cursor = Math.max(0, Number(body.cursor) || 0);
  const maxResults = Math.max(1, Math.min(20000, Number(body.maxResults) || 2000));
  const useFts = !options.regex && query.length >= 3;
  const statement = useFts
    ? env.SEARCH_DB.prepare(`
        SELECT c.id, c.path, c.start_line, c.text
        FROM search_fts JOIN search_chunks c ON c.id = search_fts.rowid
        WHERE search_fts MATCH ? AND c.id > ?
        ORDER BY c.id LIMIT ?
      `).bind(ftsLiteral(query), cursor, SEARCH_PAGE)
    : env.SEARCH_DB.prepare(`
        SELECT id, path, start_line, text FROM search_chunks
        WHERE id > ? ORDER BY id LIMIT ?
      `).bind(cursor, SEARCH_PAGE);
  const rows = await statement.all();
  const include = makePathFilter(body.include);
  const exclude = makePathFilter(body.exclude);
  const byPath = new Map();
  let matches = 0;

  for (const row of rows.results) {
    if (include && !include(row.path)) continue;
    if (exclude && exclude(row.path)) continue;
    const lines = String(row.text).split('\n');
    for (let index = 0; index < lines.length && matches < maxResults; index++) {
      const line = lines[index];
      if (!line) continue;
      expression.lastIndex = 0;
      const ranges = [];
      let match;
      let guard = 0;
      while ((match = expression.exec(line)) !== null && matches < maxResults) {
        if (match[0] === '') {
          expression.lastIndex++;
          if (++guard > 10000) break;
          continue;
        }
        ranges.push([match.index, match.index + match[0].length]);
        matches++;
        if (++guard > 10000) break;
      }
      if (!ranges.length) continue;
      if (!byPath.has(row.path)) byPath.set(row.path, []);
      byPath.get(row.path).push({
        line: Number(row.start_line) + index,
        text: line.length > 400 ? line.slice(0, 400) + ' …' : line,
        ranges
      });
    }
  }

  const last = rows.results.length ? Number(rows.results[rows.results.length - 1].id) : cursor;
  const results = Array.from(byPath, ([path, hits]) => ({
    path,
    name: path.split('/').pop(),
    hits,
    total: hits.length,
    capped: matches >= maxResults
  }));
  const status = cursor === 0 ? await indexStatus(env) : null;
  return {
    results,
    matches,
    cursor: last,
    done: rows.results.length < SEARCH_PAGE || matches >= maxResults,
    scannedChunks: rows.results.length,
    indexedFiles: status ? status.indexed : undefined,
    complete: status ? status.complete : undefined,
    truncated: matches >= maxResults
  };
}

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
 *
 * Authentifizierung: Header `Authorization: Bearer <AUTH_TOKEN>`.
 * AUTH_TOKEN wird als Secret gesetzt:  wrangler secret put AUTH_TOKEN
 */

const MAX_KEY = 900;

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors(env, origin) });
    }

    try {
      const res = await handle(request, env, origin);
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

async function handle(request, env, origin) {
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
    return json({ ok: true, files: l.objects.length + (l.truncated ? '+' : '') });
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
      return json({ ok: true, path: key, size: obj.size, etag: obj.etag });
    }

    if (method === 'DELETE') {
      await env.BUCKET.delete(key);
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

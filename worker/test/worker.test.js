import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';

class FakeBucket {
  constructor() { this.objects = new Map(); }
  async list() { return { objects: [], truncated: false }; }
  async put(key, body, options) {
    const bytes = new Uint8Array(await new Response(body).arrayBuffer());
    this.objects.set(key, { bytes, options });
    return { size: bytes.length, etag: 'etag-' + bytes.length };
  }
  async get(key) {
    const saved = this.objects.get(key);
    if (!saved) return null;
    return {
      body: saved.bytes,
      size: saved.bytes.length,
      httpEtag: '"etag-' + saved.bytes.length + '"',
      httpMetadata: saved.options.httpMetadata,
      writeHttpMetadata(headers) {
        if (saved.options.httpMetadata?.contentType) headers.set('Content-Type', saved.options.httpMetadata.contentType);
      }
    };
  }
  async head(key) {
    const obj = await this.get(key);
    if (!obj) return null;
    delete obj.body;
    return obj;
  }
  async delete(key) { this.objects.delete(key); }
}

function env(overrides = {}) {
  return {
    AUTH_TOKEN: 'test-secret',
    ALLOWED_ORIGIN: 'https://example.github.io',
    BUCKET: new FakeBucket(),
    ...overrides
  };
}

function request(path, options = {}) {
  const headers = new Headers(options.headers);
  headers.set('Origin', options.origin || 'https://example.github.io');
  if (options.auth !== false) headers.set('Authorization', 'Bearer test-secret');
  return new Request('https://api.example.test' + path, { ...options, headers });
}

test('verweigert Dateizugriffe ohne konfiguriertes Secret', async () => {
  const response = await worker.fetch(request('/api/list'), env({ AUTH_TOKEN: '' }));
  assert.equal(response.status, 503);
});

test('verweigert ein falsches oder fehlendes Token', async () => {
  const response = await worker.fetch(request('/api/list', { auth: false }), env());
  assert.equal(response.status, 401);
});

test('setzt CORS nur für die konfigurierte Origin', async () => {
  const allowed = await worker.fetch(request('/api/ping'), env());
  assert.equal(allowed.headers.get('Access-Control-Allow-Origin'), 'https://example.github.io');

  const denied = await worker.fetch(request('/api/ping', { origin: 'https://evil.example' }), env());
  assert.equal(denied.headers.get('Access-Control-Allow-Origin'), null);
});

test('validiert Pfade und speichert eine Datei', async () => {
  const testEnv = env();
  const invalid = await worker.fetch(request('/api/file?path=../secret.txt', { method: 'PUT', body: 'x' }), testEnv);
  assert.equal(invalid.status, 400);

  const put = await worker.fetch(request('/api/file?path=src/app.js&mtime=123', { method: 'PUT', body: 'hello' }), testEnv);
  assert.equal(put.status, 200);
  assert.equal((await put.json()).etag, 'etag-5');

  const get = await worker.fetch(request('/api/file?path=src/app.js'), testEnv);
  assert.equal(get.status, 200);
  assert.equal(await get.text(), 'hello');
  assert.equal(get.headers.get('Accept-Ranges'), 'bytes');
});

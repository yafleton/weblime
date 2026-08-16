import test from 'node:test';
import assert from 'node:assert/strict';

class MemoryStorage {
  constructor() { this.values = new Map(); }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

let active = 0;
let maxActive = 0;
let sentSizes = [];
let completedParts = [];

class FakeXMLHttpRequest {
  constructor() {
    this.upload = {};
    this.status = 0;
    this.responseText = '';
  }
  open(method, url) { this.method = method; this.url = url; }
  setRequestHeader() {}
  send(body) {
    const part = Number(new URL(this.url).searchParams.get('part')) || sentSizes.length + 1;
    sentSizes.push(body.size);
    active++;
    maxActive = Math.max(maxActive, active);
    setTimeout(() => {
      if (this.upload.onprogress) {
        this.upload.onprogress({ lengthComputable: true, loaded: Math.floor(body.size / 2), total: body.size });
        this.upload.onprogress({ lengthComputable: true, loaded: body.size, total: body.size });
      }
      active--;
      this.status = 200;
      this.responseText = JSON.stringify({ etag: 'etag-' + part });
      this.onload();
    }, 8);
  }
}

globalThis.window = {};
globalThis.localStorage = new MemoryStorage();
globalThis.sessionStorage = new MemoryStorage();
globalThis.XMLHttpRequest = FakeXMLHttpRequest;
globalThis.fetch = async (url, options = {}) => {
  if (String(url).includes('/api/mpu/create')) {
    return new Response(JSON.stringify({ uploadId: 'upload-1' }), { status: 200 });
  }
  if (String(url).includes('/api/mpu/complete')) {
    completedParts = JSON.parse(options.body).parts;
    return new Response(JSON.stringify({ etag: 'complete-etag' }), { status: 200 });
  }
  if (String(url).includes('/api/mpu/abort')) {
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }
  throw new Error('Unerwarteter Fetch: ' + url);
};

await import('../../js/backend.js');
const Remote = window.Remote;
Remote.configure({ token: 'test-token' });

function fakeFile(size) {
  return {
    size,
    lastModified: 123,
    slice(start, end) { return { size: end - start }; }
  };
}

test('lädt große Dateien in 64-MiB-Teilen mit höchstens drei parallelen Requests', async () => {
  active = 0;
  maxActive = 0;
  sentSizes = [];
  completedParts = [];
  let lastProgress = 0;
  const MiB = 1024 * 1024;

  const result = await Remote.upload('large.bin', fakeFile(200 * MiB), loaded => { lastProgress = loaded; });

  assert.equal(result.etag, 'complete-etag');
  assert.deepEqual(sentSizes.sort((a, b) => b - a), [64, 64, 64, 8].map(n => n * MiB));
  assert.equal(maxActive, 3);
  assert.equal(lastProgress, 200 * MiB);
  assert.deepEqual(completedParts.map(part => part.partNumber), [1, 2, 3, 4]);
});

test('begrenzt auch mehrere kleine Dateien gemeinsam auf drei Uploads', async () => {
  active = 0;
  maxActive = 0;
  sentSizes = [];

  await Promise.all([
    Remote.upload('1.txt', fakeFile(1)),
    Remote.upload('2.txt', fakeFile(1)),
    Remote.upload('3.txt', fakeFile(1)),
    Remote.upload('4.txt', fakeFile(1)),
    Remote.upload('5.txt', fakeFile(1))
  ]);

  assert.equal(sentSizes.length, 5);
  assert.equal(maxActive, 3);
});

/* ============================================================
   backend.js — Client für den Cloudflare Worker (R2-Speicher)
   Die Worker-URL gehört fest zur WebLime-Installation. Nur das geheime
   Zugriffstoken wird für die aktuelle Browsersitzung gespeichert.
   Große Dateien werden per Multipart-Upload in Teilen gesendet
   (Workers begrenzen den Request-Body, R2 selbst nicht).
   ============================================================ */
(function (root) {
  'use strict';

  var LS = 'weblime.remote';
  var SS_TOKEN = 'weblime.remote.token';
  var DEFAULT_BASE = 'https://weblime-api.weblimer.workers.dev';
  var PART = 20 * 1024 * 1024;   // 20 MB pro Teil
  var MPU_THRESHOLD = 40 * 1024 * 1024;

  var cfg = load();

  function load() {
    try {
      var raw = localStorage.getItem(LS);
      var saved = raw ? JSON.parse(raw) : {};
      // Alte Versionen legten das Token dauerhaft in localStorage ab. Einmalig
      // in den Sitzungsspeicher übernehmen und anschließend dort entfernen.
      var token = sessionStorage.getItem(SS_TOKEN) || saved.token || '';
      if (saved.token) {
        sessionStorage.setItem(SS_TOKEN, saved.token);
      }
      localStorage.removeItem(LS);
      return { base: DEFAULT_BASE, token: token };
    } catch (e) { /* ignorieren */ }
    return { base: DEFAULT_BASE, token: '' };
  }

  function save(c) {
    cfg = { base: DEFAULT_BASE, token: String(c.token || '') };
    localStorage.removeItem(LS);
    if (cfg.token) sessionStorage.setItem(SS_TOKEN, cfg.token);
    else sessionStorage.removeItem(SS_TOKEN);
    return cfg;
  }

  function configured() { return !!(cfg.base && cfg.token); }

  function url(p, params) {
    var u = cfg.base + p;
    if (params) {
      var q = Object.keys(params)
        .filter(function (k) { return params[k] != null; })
        .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); })
        .join('&');
      if (q) u += (u.indexOf('?') === -1 ? '?' : '&') + q;
    }
    return u;
  }

  function validBase(base) {
    try {
      var u = new URL(base);
      return u.protocol === 'https:' ||
        (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1'));
    } catch (e) { return false; }
  }

  function headers(extra) {
    var h = extra || {};
    if (cfg.token) h['Authorization'] = 'Bearer ' + cfg.token;
    return h;
  }

  function req(method, path, params, body, type) {
    return fetch(url(path, params), {
      method: method,
      headers: headers(type ? { 'Content-Type': type } : {}),
      body: body
    }).catch(function () {
      throw new Error('Worker nicht erreichbar – URL prüfen (und ob ALLOWED_ORIGIN diese Seite erlaubt)');
    }).then(function (r) {
      if (!r.ok) {
        return r.text().then(function (t) {
          throw new Error('HTTP ' + r.status + (t ? ' – ' + t.slice(0, 200) : ''));
        });
      }
      return r;
    });
  }

  function json(method, path, params, body) {
    return req(method, path, params, body ? JSON.stringify(body) : undefined,
      body ? 'application/json' : null).then(function (r) { return r.json(); });
  }

  /* ---------------- Upload mit Fortschritt ---------------- */
  function xhrPut(fullUrl, body, onProgress) {
    return new Promise(function (res, rej) {
      var x = new XMLHttpRequest();
      x.open('PUT', fullUrl, true);
      if (cfg.token) x.setRequestHeader('Authorization', 'Bearer ' + cfg.token);
      x.setRequestHeader('Content-Type', 'application/octet-stream');
      if (onProgress) {
        x.upload.onprogress = function (e) { if (e.lengthComputable) onProgress(e.loaded, e.total); };
      }
      x.onload = function () {
        if (x.status >= 200 && x.status < 300) {
          try { res(JSON.parse(x.responseText || '{}')); }
          catch (e) { res({}); }
        } else rej(new Error('HTTP ' + x.status + (x.responseText ? ' – ' + x.responseText.slice(0, 200) : '')));
      };
      x.onerror = function () { rej(new Error('Netzwerkfehler beim Upload')); };
      x.send(body);
    });
  }

  var Remote = {
    get cfg() { return cfg; },
    configure: save,
    configured: configured,
    validBase: validBase,

    /** Erreichbarkeit + Auth prüfen. */
    ping: function () {
      return req('GET', '/api/ping').then(function (r) { return r.json(); });
    },

    /** Manifest aller Dateien im Bucket. */
    list: function () {
      return json('GET', '/api/list').then(function (d) { return d.files || []; });
    },

    getBlob: function (path) {
      return req('GET', '/api/file', { path: path }).then(function (r) { return r.blob(); });
    },

    getText: function (path) {
      return req('GET', '/api/file', { path: path }).then(function (r) { return r.text(); });
    },

    del: function (path) { return json('DELETE', '/api/file', { path: path }); },

    delPrefix: function (prefix) { return json('DELETE', '/api/prefix', { prefix: prefix }); },

    /**
     * Lädt eine Datei hoch. Kleine Dateien in einem Rutsch,
     * große als Multipart-Upload.
     * @param {string} path
     * @param {Blob|File} blob
     * @param {(loaded:number,total:number)=>void} [onProgress]
     */
    upload: function (path, blob, onProgress) {
      if (blob.size <= MPU_THRESHOLD) {
        return xhrPut(url('/api/file', { path: path, mtime: blob.lastModified || Date.now() }), blob, onProgress);
      }
      return this.uploadMultipart(path, blob, onProgress);
    },

    uploadMultipart: function (path, blob, onProgress) {
      var total = blob.size;
      var uploadId, parts = [], done = 0;

      return json('POST', '/api/mpu/create', { path: path, mtime: blob.lastModified || Date.now() })
        .then(function (d) {
          uploadId = d.uploadId;
          var n = Math.ceil(total / PART);
          var chain = Promise.resolve();
          for (var i = 0; i < n; i++) {
            (function (idx) {
              chain = chain.then(function () {
                var start = idx * PART;
                var chunk = blob.slice(start, Math.min(start + PART, total));
                return xhrPut(
                  url('/api/mpu/part', { path: path, uploadId: uploadId, part: idx + 1 }),
                  chunk,
                  function (loaded) { if (onProgress) onProgress(done + loaded, total); }
                ).then(function (r) {
                  done += chunk.size;
                  if (onProgress) onProgress(done, total);
                  parts.push({ partNumber: idx + 1, etag: r.etag });
                });
              });
            })(i);
          }
          return chain;
        })
        .then(function () {
          parts.sort(function (a, b) { return a.partNumber - b.partNumber; });
          return json('POST', '/api/mpu/complete',
            { path: path, uploadId: uploadId, mtime: blob.lastModified || Date.now() },
            { parts: parts });
        })
        .catch(function (err) {
          if (uploadId) {
            json('POST', '/api/mpu/abort', { path: path, uploadId: uploadId }).catch(function () {});
          }
          throw err;
        });
    }
  };

  root.Remote = Remote;
})(window);

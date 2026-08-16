/* ============================================================
   db.js — IndexedDB-Wrapper
   Speichert Datei-Metadaten, Textinhalte und (optional) Blobs.
   Wird sowohl vom Main-Thread als auch vom Search-Worker benutzt.
   ============================================================ */
(function (root) {
  'use strict';

  var DB_NAME = 'weblime';
  var DB_VERSION = 2;
  var STORE = 'files';     // key: path
  var META = 'meta';       // key/value (Einstellungen, Sync-Stand)

  function open() {
    return new Promise(function (res, rej) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function (e) {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'path' });
        }
        if (!db.objectStoreNames.contains(META)) {
          db.createObjectStore(META);
        }
      };
      req.onsuccess = function () { res(req.result); };
      req.onerror = function () { rej(req.error); };
    });
  }

  var _db = null;
  function conn() {
    if (_db) return Promise.resolve(_db);
    return open().then(function (d) { _db = d; return d; });
  }

  function tx(store, mode) {
    return conn().then(function (db) {
      return db.transaction(store, mode).objectStore(store);
    });
  }

  function wrap(req) {
    return new Promise(function (res, rej) {
      req.onsuccess = function () { res(req.result); };
      req.onerror = function () { rej(req.error); };
    });
  }

  var DB = {
    /* ---- Dateien ---- */
    put: function (rec) { return tx(STORE, 'readwrite').then(function (s) { return wrap(s.put(rec)); }); },

    putMany: function (recs) {
      return conn().then(function (db) {
        return new Promise(function (res, rej) {
          var t = db.transaction(STORE, 'readwrite');
          var s = t.objectStore(STORE);
          recs.forEach(function (r) { s.put(r); });
          t.oncomplete = function () { res(recs.length); };
          t.onerror = function () { rej(t.error); };
        });
      });
    },

    get: function (path) { return tx(STORE, 'readonly').then(function (s) { return wrap(s.get(path)); }); },

    del: function (path) { return tx(STORE, 'readwrite').then(function (s) { return wrap(s.delete(path)); }); },

    delPrefix: function (prefix) {
      return conn().then(function (db) {
        return new Promise(function (res, rej) {
          var t = db.transaction(STORE, 'readwrite');
          var s = t.objectStore(STORE);
          var n = 0;
          s.openCursor().onsuccess = function (e) {
            var c = e.target.result;
            if (!c) return;
            if (c.key === prefix || String(c.key).indexOf(prefix + '/') === 0) { c.delete(); n++; }
            c.continue();
          };
          t.oncomplete = function () { res(n); };
          t.onerror = function () { rej(t.error); };
        });
      });
    },

    clear: function () { return tx(STORE, 'readwrite').then(function (s) { return wrap(s.clear()); }); },

    /** Alle Datensätze ohne Inhalt (leichtgewichtiger Index für Baum/Tabs). */
    index: function () {
      return conn().then(function (db) {
        return new Promise(function (res, rej) {
          var out = [];
          var t = db.transaction(STORE, 'readonly');
          t.objectStore(STORE).openCursor().onsuccess = function (e) {
            var c = e.target.result;
            if (!c) return;
            var v = c.value;
            out.push({
              path: v.path, name: v.name, size: v.size, mtime: v.mtime,
              etag: v.etag || '', lang: v.lang, binary: v.binary, lines: v.lines,
              remote: v.remote || false, cached: v.text != null
            });
            c.continue();
          };
          t.oncomplete = function () { res(out); };
          t.onerror = function () { rej(t.error); };
        });
      });
    },

    /** Streamt alle Datensätze (für die Volltextsuche im Worker). */
    each: function (cb) {
      return conn().then(function (db) {
        return new Promise(function (res, rej) {
          var t = db.transaction(STORE, 'readonly');
          t.objectStore(STORE).openCursor().onsuccess = function (e) {
            var c = e.target.result;
            if (!c) return;
            cb(c.value);
            c.continue();
          };
          t.oncomplete = function () { res(); };
          t.onerror = function () { rej(t.error); };
        });
      });
    },

    count: function () { return tx(STORE, 'readonly').then(function (s) { return wrap(s.count()); }); },

    /* ---- Meta / Einstellungen ---- */
    setMeta: function (k, v) { return tx(META, 'readwrite').then(function (s) { return wrap(s.put(v, k)); }); },
    getMeta: function (k) { return tx(META, 'readonly').then(function (s) { return wrap(s.get(k)); }); }
  };

  root.DB = DB;
})(typeof self !== 'undefined' ? self : window);

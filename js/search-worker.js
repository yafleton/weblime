/* ============================================================
   search-worker.js — Volltextsuche über alle Dateien
   Läuft in einem Web Worker, damit die UI flüssig bleibt.
   Liest direkt aus IndexedDB (kein Kopieren großer Strings).
   ============================================================ */
importScripts('db.js');

var currentJob = 0;

self.onmessage = function (e) {
  var msg = e.data;
  if (msg.type === 'cancel') { currentJob++; return; }
  if (msg.type === 'search') { run(msg, ++currentJob); }
};

/* ---------- Glob → RegExp (z. B. "*.js, src/**") ---------- */
function globToRe(glob) {
  var re = '';
  for (var i = 0; i < glob.length; i++) {
    var c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++; }
      else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if ('\\^$.|+()[]{}'.indexOf(c) !== -1) re += '\\' + c;
    else re += c;
  }
  return new RegExp('^' + re + '$', 'i');
}

function makeFilter(spec) {
  var parts = String(spec || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  if (!parts.length) return null;
  var res = parts.map(function (p) {
    // Bloße Endung ("js") oder Ordner ("src/") bequem machen
    if (/^[\w]+$/.test(p)) p = '*.' + p;
    if (p.slice(-1) === '/') p = p + '**';
    if (p.indexOf('/') === -1 && p.indexOf('*') === -1) p = '**/' + p;
    return globToRe(p);
  });
  return function (path) {
    for (var i = 0; i < res.length; i++) {
      if (res[i].test(path) || res[i].test(path.split('/').pop())) return true;
    }
    return false;
  };
}

function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function buildRe(q, o) {
  var src = o.regex ? q : escRe(q);
  if (o.word) src = '\\b(?:' + src + ')\\b';
  return new RegExp(src, 'g' + (o.caseSensitive ? '' : 'i'));
}

function run(job, id) {
  var q = job.query;
  if (!q) { self.postMessage({ type: 'done', id: id, files: 0, matches: 0, scanned: 0 }); return; }

  var re;
  try { re = buildRe(q, job.opts); }
  catch (err) { self.postMessage({ type: 'error', id: id, message: 'Ungültiger regulärer Ausdruck: ' + err.message }); return; }

  var inc = makeFilter(job.include);
  var exc = makeFilter(job.exclude);
  var maxPerFile = job.maxPerFile || 500;
  var maxTotal = job.maxTotal || 20000;

  var batch = [], totalMatches = 0, totalFiles = 0, scanned = 0, aborted = false;

  function flush(force) {
    if (batch.length && (force || batch.length >= 25)) {
      self.postMessage({ type: 'results', id: id, results: batch, matches: totalMatches, files: totalFiles });
      batch = [];
    }
  }

  DB.each(function (rec) {
    if (id !== currentJob || aborted) return;
    if (rec.binary || rec.text == null) return;
    if (inc && !inc(rec.path)) return;
    if (exc && exc(rec.path)) return;

    scanned++;
    var text = rec.text;

    // Schnell-Test: enthält die Datei den Begriff überhaupt?
    if (!job.opts.regex && !job.opts.word) {
      var hay = job.opts.caseSensitive ? text : text.toLowerCase();
      var needle = job.opts.caseSensitive ? q : q.toLowerCase();
      if (hay.indexOf(needle) === -1) return;
    }

    var lines = text.split('\n');
    var hits = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!line) continue;
      re.lastIndex = 0;
      var m, ranges = null, guard = 0;
      while ((m = re.exec(line)) !== null) {
        if (m[0] === '') { re.lastIndex++; if (++guard > 10000) break; continue; }
        (ranges || (ranges = [])).push([m.index, m.index + m[0].length]);
        totalMatches++;
        if (++guard > 10000) break;
      }
      if (ranges) {
        hits.push({
          line: i,
          text: line.length > 400 ? line.slice(0, 400) + ' …' : line,
          ranges: ranges
        });
        if (hits.length >= maxPerFile) break;
      }
      if (totalMatches >= maxTotal) { aborted = true; break; }
    }

    if (hits.length) {
      totalFiles++;
      batch.push({
        path: rec.path, name: rec.name, hits: hits,
        total: hits.length, capped: hits.length >= maxPerFile
      });
      flush(false);
    }

    if (scanned % 200 === 0) self.postMessage({ type: 'progress', id: id, scanned: scanned });
  }).then(function () {
    if (id !== currentJob) return;
    flush(true);
    self.postMessage({
      type: 'done', id: id, files: totalFiles, matches: totalMatches,
      scanned: scanned, truncated: aborted
    });
  }).catch(function (err) {
    self.postMessage({ type: 'error', id: id, message: String(err && err.message || err) });
  });
}

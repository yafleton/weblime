/* ============================================================
   app.js — WebLime
   Datei-Explorer, virtualisierter Editor, Suche (Datei + Projekt),
   Goto Anything, Befehlspalette, Cloud-Sync (Cloudflare R2).
   ============================================================ */
(function () {
  'use strict';

  var LH = 20;                       // Zeilenhöhe in px (muss zu --lh passen)
  var GUTTER_MIN = 52;
  var MAX_TEXT = 20 * 1024 * 1024;   // größer wird nicht als Text indexiert
  var OVERSCAN = 12;

  var $ = function (id) { return document.getElementById(id); };
  var el = {};
  ['sidebar', 'drag-handle', 'main', 'tree', 'side-empty', 'tree-filter', 'tabbar', 'editor-area',
    'editor-scroll', 'editor-content', 'minimap', 'welcome', 'findbar', 'find-input',
    'find-count', 'find-prev', 'find-next', 'find-close', 'fif', 'fif-query', 'fif-include',
    'fif-exclude', 'fif-run', 'fif-close', 'status', 'st-file', 'st-pos', 'st-count',
    'st-lang', 'st-progress', 'palette', 'palette-input', 'palette-list', 'dropzone',
    'toast', 'file-input', 'dir-input', 'btn-add-files', 'btn-add-folder', 'btn-menu',
    'binview', 'modal', 'modal-body', 'cloud-state', 'side-open-folder',
    'btn-mobile-sidebar', 'btn-quick-find', 'btn-quick-search', 'btn-quick-sync',
    'welcome-open-folder', 'welcome-add-files'
  ].forEach(function (id) { el[id.replace(/-(\w)/g, function (m, c) { return c.toUpperCase(); })] = $(id); });

  var state = {
    index: [],            // [{path,name,size,...}]
    byPath: Object.create(null),
    expanded: Object.create(null),
    tabs: [],             // [{key,kind,title,path}]
    active: -1,
    doc: null,            // aktuelles Dokument
    find: { q: '', opts: { caseSensitive: false, word: false, regex: false }, matches: [], cur: -1 },
    fifOpts: { caseSensitive: false, word: false, regex: false },
    lastResults: null,
    charW: 7.8,
    minimapOn: true,
    treeFilter: ''
  };

  /* ============================================================
     Hilfsfunktionen
     ============================================================ */
  function fmtSize(b) {
    if (b == null) return '';
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
    if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
    return (b / 1073741824).toFixed(2) + ' GB';
  }
  function esc(s) { return Lang.escape(String(s)); }
  function baseName(p) { return p.split('/').pop(); }
  function dirName(p) { var i = p.lastIndexOf('/'); return i === -1 ? '' : p.slice(0, i); }

  var toastTimer;
  function toast(msg, ms) {
    el.toast.textContent = msg;
    el.toast.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.toast.classList.add('hidden'); }, ms || 2600);
  }
  function progress(msg) {
    el.stProgress.textContent = msg || '';
  }

  function measureChar() {
    var s = document.createElement('span');
    s.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;font-family:var(--mono);font-size:13px';
    s.textContent = 'X'.repeat(100);
    document.body.appendChild(s);
    state.charW = s.getBoundingClientRect().width / 100 || 7.8;
    s.remove();
  }

  /* ============================================================
     Dokument-Modell
     ============================================================ */
  function scanStates(lines, langId) {
    var pairs = { javascript: ['/*', '*/'], typescript: ['/*', '*/'], java: ['/*', '*/'], c: ['/*', '*/'],
      cpp: ['/*', '*/'], csharp: ['/*', '*/'], go: ['/*', '*/'], rust: ['/*', '*/'], php: ['/*', '*/'],
      swift: ['/*', '*/'], css: ['/*', '*/'], json: ['/*', '*/'], sql: ['/*', '*/'], kotlin: ['/*', '*/'],
      powershell: ['<#', '#>'] };
    var p = pairs[langId];
    var st = new Uint8Array(lines.length + 1);
    if (!p) return st;
    var bs = p[0], be = p[1], cur = 0;
    for (var i = 0; i < lines.length; i++) {
      st[i] = cur;
      var line = lines[i], j = 0;
      for (;;) {
        if (cur === 0) {
          var a = line.indexOf(bs, j);
          if (a === -1) break;
          var lc = line.indexOf('//', j);
          if (lc !== -1 && lc < a) break;
          cur = 1; j = a + bs.length;
        } else {
          var b = line.indexOf(be, j);
          if (b === -1) break;
          cur = 0; j = b + be.length;
        }
      }
    }
    st[lines.length] = cur;
    return st;
  }

  function makeFileDoc(rec, text) {
    var lines = text.split('\n');
    if (lines.length && lines[lines.length - 1] === '' && text.length) lines.pop();
    var maxLen = 0;
    for (var i = 0; i < lines.length; i++) if (lines[i].length > maxLen) maxLen = lines[i].length;
    return {
      kind: 'file',
      path: rec.path,
      lang: rec.lang || Lang.detect(rec.path),
      lines: lines,
      states: scanStates(lines, rec.lang || Lang.detect(rec.path)),
      cache: new Array(lines.length),
      maxLen: maxLen,
      count: lines.length,
      symbols: null,
      curLine: 0
    };
  }

  function makeResultsDoc(query, results, summary) {
    var rows = [];
    results.forEach(function (f) {
      rows.push({ t: 'file', path: f.path, ln: '', cls: 'res-head',
        html: '<span class="res-file">' + esc(f.path) + '</span>' +
              '<span class="res-line">  (' + f.hits.length + (f.capped ? '+, gekürzt' : '') + ')</span>' });
      f.hits.forEach(function (h) {
        rows.push({ t: 'hit', path: f.path, line: h.line, ln: h.line + 1, cls: 'res-hit',
          html: markPlain(h.text, h.ranges) });
      });
      rows.push({ t: 'blank', ln: '', html: '' });
    });
    var maxLen = 0;
    rows.forEach(function (r) { var L = (r.t === 'hit' ? r.html.length / 2 : 60); if (L > maxLen) maxLen = L; });
    return {
      kind: 'results', query: query, rows: rows, count: rows.length,
      maxLen: Math.max(80, Math.min(400, maxLen)), summary: summary, curLine: 0
    };
  }

  function markPlain(text, ranges) {
    var out = '', pos = 0;
    ranges.forEach(function (r) {
      out += esc(text.slice(pos, r[0])) + '<mark class="hit">' + esc(text.slice(r[0], r[1])) + '</mark>';
      pos = r[1];
    });
    return out + esc(text.slice(pos));
  }

  /* ---- Treffer als <mark> in fertiges HTML einfügen ---- */
  function injectMarks(html, ranges, curRange) {
    if (!ranges || !ranges.length) return html;
    var out = '', i = 0, pos = 0, ri = 0, open = false, n = html.length;
    function openTag() {
      var r = ranges[ri];
      return (curRange && r[0] === curRange[0] && r[1] === curRange[1])
        ? '<mark class="hit cur">' : '<mark class="hit">';
    }
    while (i < n) {
      if (open && pos >= ranges[ri][1]) { out += '</mark>'; open = false; ri++; }
      if (!open && ri < ranges.length && pos >= ranges[ri][0] && pos < ranges[ri][1]) {
        out += openTag(); open = true;
      }
      var c = html[i];
      if (c === '<') {
        var j = html.indexOf('>', i);
        if (j === -1) j = n - 1;
        if (open) out += '</mark>';
        out += html.slice(i, j + 1);
        if (open) out += openTag();
        i = j + 1;
        continue;
      }
      if (c === '&') {
        var k = html.indexOf(';', i);
        if (k === -1 || k - i > 8) { out += '&amp;'; i++; pos++; continue; }
        out += html.slice(i, k + 1); i = k + 1; pos++;
        continue;
      }
      out += c; i++; pos++;
    }
    if (open) out += '</mark>';
    return out;
  }

  /* ============================================================
     Editor-Rendering (virtualisiert)
     ============================================================ */
  var matchesByLine = Object.create(null);

  function rowHtml(doc, i) {
    if (doc.kind === 'results') {
      var r = doc.rows[i];
      return { ln: r.ln, html: r.html, cls: r.cls || '' };
    }
    var html = doc.cache[i];
    if (html == null) {
      html = Lang.highlight(doc.lines[i], doc.lang, doc.states[i]).html;
      doc.cache[i] = html;
    }
    var m = matchesByLine[i];
    if (m) {
      var cur = state.find.cur >= 0 ? state.find.matches[state.find.cur] : null;
      html = injectMarks(html, m, cur && cur.line === i ? [cur.start, cur.end] : null);
    }
    return { ln: i + 1, html: html, cls: i === doc.curLine ? 'cur' : '' };
  }

  var renderQueued = false;
  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    var ran = false;
    var run = function () {
      if (ran) return;
      ran = true; renderQueued = false;
      renderView();
    };
    // rAF pausiert in Hintergrund-Tabs → Timeout als Sicherheitsnetz
    requestAnimationFrame(run);
    setTimeout(run, 60);
  }

  function renderView() {
    var doc = state.doc;
    var sc = el.editorScroll, ct = el.editorContent;
    if (!doc) { ct.innerHTML = ''; ct.style.height = '0'; return; }

    var gutterW = Math.max(GUTTER_MIN, String(doc.count).length * state.charW + 30);
    ct.style.height = (doc.count * LH + 40) + 'px';
    ct.style.width = (gutterW + doc.maxLen * state.charW + 60) + 'px';

    var top = sc.scrollTop, h = sc.clientHeight;
    var first = Math.max(0, Math.floor(top / LH) - OVERSCAN);
    var last = Math.min(doc.count - 1, Math.ceil((top + h) / LH) + OVERSCAN);

    var buf = [];
    for (var i = first; i <= last; i++) {
      var r = rowHtml(doc, i);
      buf.push('<div class="line ' + r.cls + '" data-i="' + i + '" style="top:' + (i * LH) + 'px">' +
        '<span class="ln" style="width:' + gutterW + 'px">' + r.ln + '</span>' +
        '<span class="lc">' + (r.html || ' ') + '</span></div>');
    }
    ct.innerHTML = buf.join('');
    drawMinimapViewport();
  }

  el.editorScroll.addEventListener('scroll', scheduleRender, { passive: true });
  window.addEventListener('resize', function () { scheduleRender(); drawMinimap(); });

  el.editorContent.addEventListener('click', function (e) {
    var lineEl = e.target.closest('.line');
    if (!lineEl) return;
    var i = +lineEl.dataset.i;
    var doc = state.doc;
    if (!doc) return;
    if (doc.kind === 'results') {
      var r = doc.rows[i];
      if (r && (r.t === 'hit' || r.t === 'file')) {
        openFile(r.path, r.t === 'hit' ? r.line : 0, state.lastResults && state.lastResults.query);
      }
      return;
    }
    doc.curLine = i;
    updateStatusPos();
    scheduleRender();
  });

  /* ============================================================
     Minimap
     ============================================================ */
  var mmCanvas = el.minimap, mmCtx = mmCanvas.getContext('2d');
  var mmBuffer = document.createElement('canvas');

  function drawMinimap() {
    var doc = state.doc;
    if (!doc || !state.minimapOn) return;
    var h = el.editorArea.clientHeight;
    mmCanvas.height = h; mmBuffer.height = h; mmBuffer.width = mmCanvas.width;
    var ctx = mmBuffer.getContext('2d');
    ctx.clearRect(0, 0, mmBuffer.width, h);

    var n = doc.count || 1;
    var scale = Math.min(3, h / n);
    var w = mmBuffer.width;

    for (var i = 0; i < n; i++) {
      var text = doc.kind === 'file' ? doc.lines[i] : (doc.rows[i].t === 'hit' ? 'x'.repeat(40) : '');
      if (!text) continue;
      var indent = /^\s*/.exec(text)[0].length;
      var len = Math.min(text.length, 110);
      var y = i * scale;
      var hit = doc.kind === 'file' ? matchesByLine[i] : (doc.rows[i].t === 'hit');
      ctx.fillStyle = hit ? '#c9973b' : (/^\s*(\/\/|#|\*)/.test(text) ? '#4f5046' : '#6d6e63');
      ctx.fillRect(indent / 110 * w, y, Math.max(1, (len - indent) / 110 * w), Math.max(1, scale * 0.72));
    }
    drawMinimapViewport();
  }

  function drawMinimapViewport() {
    if (!state.minimapOn || !state.doc) return;
    var h = mmCanvas.height;
    mmCtx.clearRect(0, 0, mmCanvas.width, h);
    mmCtx.drawImage(mmBuffer, 0, 0);
    var doc = state.doc, sc = el.editorScroll;
    var n = doc.count || 1;
    var scale = Math.min(3, h / n);
    var y = (sc.scrollTop / LH) * scale;
    var vh = (sc.clientHeight / LH) * scale;
    mmCtx.fillStyle = 'rgba(255,255,255,.07)';
    mmCtx.fillRect(0, y, mmCanvas.width, Math.max(6, vh));
    mmCtx.strokeStyle = 'rgba(255,255,255,.12)';
    mmCtx.strokeRect(0.5, y + 0.5, mmCanvas.width - 1, Math.max(6, vh));
  }

  mmCanvas.addEventListener('mousedown', function (e) {
    function jump(ev) {
      var doc = state.doc; if (!doc) return;
      var rect = mmCanvas.getBoundingClientRect();
      var scale = Math.min(3, mmCanvas.height / (doc.count || 1));
      var line = (ev.clientY - rect.top) / scale;
      el.editorScroll.scrollTop = Math.max(0, line * LH - el.editorScroll.clientHeight / 2);
    }
    jump(e);
    function move(ev) { jump(ev); }
    function up() { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); }
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });

  /* ============================================================
     Datei-Index / Baum
     ============================================================ */
  function refreshIndex() {
    return DB.index().then(function (list) {
      list.sort(function (a, b) { return a.path.localeCompare(b.path); });
      state.index = list;
      state.byPath = Object.create(null);
      list.forEach(function (r) { state.byPath[r.path] = r; });
      renderTree();
      updateStatusCount();
    });
  }

  function buildTree() {
    var root = { name: '', path: '', dirs: Object.create(null), files: [] };
    var filter = state.treeFilter.toLowerCase();
    state.index.forEach(function (rec) {
      if (filter && rec.path.toLowerCase().indexOf(filter) === -1) return;
      var parts = rec.path.split('/');
      var node = root;
      for (var i = 0; i < parts.length - 1; i++) {
        var seg = parts[i];
        if (!node.dirs[seg]) {
          node.dirs[seg] = { name: seg, path: (node.path ? node.path + '/' : '') + seg, dirs: Object.create(null), files: [] };
        }
        node = node.dirs[seg];
      }
      node.files.push(rec);
    });
    return root;
  }

  function renderTree() {
    var root = buildTree();
    var out = [];
    var hasAny = state.index.length > 0;
    el.sideEmpty.classList.toggle('hidden', hasAny);

    function walk(node, depth) {
      Object.keys(node.dirs).sort().forEach(function (k) {
        var d = node.dirs[k];
        var open = state.expanded[d.path] !== false && (state.treeFilter ? true : state.expanded[d.path] !== false);
        if (state.expanded[d.path] === undefined) state.expanded[d.path] = depth < 1 || !!state.treeFilter;
        open = state.treeFilter ? true : state.expanded[d.path];
        out.push('<button type="button" class="row dir" role="treeitem" aria-expanded="' + (open ? 'true' : 'false') + '" data-dir="' + esc(d.path) + '" style="padding-left:' + (6 + depth * 13) + 'px">' +
          '<span class="tw">' + (open ? '▾' : '▸') + '</span>' +
          '<span class="ico">▣</span><span class="nm">' + esc(d.name) + '</span></button>');
        if (open) walk(d, depth + 1);
      });
      node.files.sort(function (a, b) { return a.name.localeCompare(b.name); }).forEach(function (f) {
        var active = state.tabs[state.active] && state.tabs[state.active].path === f.path;
        out.push('<button type="button" class="row file' + (active ? ' active' : '') + '" role="treeitem" data-file="' + esc(f.path) + '" ' +
          'style="padding-left:' + (6 + depth * 13) + 'px" title="' + esc(f.path) + ' · ' + fmtSize(f.size) + '">' +
          '<span class="tw"></span><span class="ico">' + (f.binary ? '◆' : '≡') + '</span>' +
          '<span class="nm">' + esc(f.name) + '</span>' +
          '<span class="meta">' + fmtSize(f.size) + '</span></button>');
      });
    }
    walk(root, 0);
    el.tree.innerHTML = out.join('');
  }

  el.tree.addEventListener('click', function (e) {
    var row = e.target.closest('.row');
    if (!row) return;
    if (row.dataset.dir != null) {
      state.expanded[row.dataset.dir] = !state.expanded[row.dataset.dir];
      renderTree();
    } else if (row.dataset.file) {
      openFile(row.dataset.file);
      if (window.matchMedia('(max-width:720px)').matches) el.sidebar.classList.remove('mobile-open');
    }
  });

  el.tree.addEventListener('contextmenu', function (e) {
    var row = e.target.closest('.row');
    if (!row) return;
    e.preventDefault();
    if (row.dataset.file) {
      if (confirm('Datei löschen?\n\n' + row.dataset.file)) deletePath(row.dataset.file, false);
    } else if (row.dataset.dir != null) {
      if (confirm('Ordner mit allen Dateien löschen?\n\n' + row.dataset.dir)) deletePath(row.dataset.dir, true);
    }
  });

  el.treeFilter.addEventListener('input', function () {
    state.treeFilter = el.treeFilter.value.trim();
    renderTree();
  });

  /* ============================================================
     Tabs
     ============================================================ */
  function renderTabs() {
    el.tabbar.innerHTML = state.tabs.map(function (t, i) {
      return '<div class="tab' + (i === state.active ? ' active' : '') + '" role="tab" aria-selected="' + (i === state.active ? 'true' : 'false') + '" data-i="' + i + '" title="' + esc(t.path || t.title) + '">' +
        '<span class="tname">' + esc(t.title) + '</span>' +
        '<button type="button" class="tclose" data-close="' + i + '" aria-label="' + esc(t.title) + ' schließen">✕</button></div>';
    }).join('');
  }

  el.tabbar.addEventListener('click', function (e) {
    var c = e.target.closest('[data-close]');
    if (c) { closeTab(+c.dataset.close); return; }
    var t = e.target.closest('.tab');
    if (t) activateTab(+t.dataset.i);
  });

  function findTab(key) {
    for (var i = 0; i < state.tabs.length; i++) if (state.tabs[i].key === key) return i;
    return -1;
  }

  function closeTab(i) {
    state.tabs.splice(i, 1);
    if (state.active >= state.tabs.length) state.active = state.tabs.length - 1;
    else if (i < state.active) state.active--;
    if (state.tabs.length === 0) { state.doc = null; state.active = -1; showWelcome(true); }
    renderTabs();
    if (state.active >= 0) activateTab(state.active);
    else { el.editorContent.innerHTML = ''; renderTree(); updateStatusFile(); }
  }

  function activateTab(i) {
    state.active = i;
    renderTabs();
    var t = state.tabs[i];
    if (!t) return;
    if (t.kind === 'results') {
      showWelcome(false); showBinary(null);
      state.doc = t.doc;
      matchesByLine = Object.create(null);
      el.editorScroll.scrollTop = t.scroll || 0;
      scheduleRender(); drawMinimap();
      updateStatusFile(); renderTree();
    } else {
      openFile(t.path, t.gotoLine, t.highlight, true);
    }
  }

  function showWelcome(show) { el.welcome.classList.toggle('hidden', !show); }

  /* ============================================================
     Datei öffnen
     ============================================================ */
  var previewUrl = '', previewJob = 0;
  function clearPreview() {
    previewJob++;
    if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = ''; }
    el.binview.innerHTML = '';
  }

  function showBinary(rec) {
    clearPreview();
    if (!rec) { el.binview.classList.add('hidden'); return; }
    var job = previewJob;
    el.binview.classList.remove('hidden');
    var isImg = /^(png|jpe?g|gif|webp|bmp|ico|avif|svg)$/i.test(Lang.ext(rec.path));
    var isAudio = /^(mp3|wav|ogg|flac|m4a|aac)$/i.test(Lang.ext(rec.path));
    var isVideo = /^(mp4|webm|mkv|mov)$/i.test(Lang.ext(rec.path));
    var isPdf = /^pdf$/i.test(Lang.ext(rec.path));
    el.binview.innerHTML =
      '<div class="bin-inner">' +
        '<div class="bin-name">' + esc(rec.name) + '</div>' +
        '<div class="bin-meta">' + esc(rec.path) + ' · ' + fmtSize(rec.size) + '</div>' +
        '<div class="bin-preview" id="bin-preview"><span class="bin-load">Vorschau wird geladen…</span></div>' +
        '<button type="button" class="primary" id="bin-dl">Herunterladen</button>' +
      '</div>';
    $('bin-dl').onclick = function () { downloadFile(rec.path); };

    var box = $('bin-preview');
    if (!(isImg || isAudio || isVideo || isPdf)) { box.innerHTML = '<span class="bin-load">Keine Vorschau verfügbar</span>'; return; }
    getBlob(rec.path).then(function (blob) {
      if (job !== previewJob || !document.body.contains(box)) return;
      var u = URL.createObjectURL(blob);
      previewUrl = u;
      if (isImg) box.innerHTML = '<img src="' + u + '" alt="">';
      else if (isAudio) box.innerHTML = '<audio controls src="' + u + '"></audio>';
      else if (isVideo) box.innerHTML = '<video controls src="' + u + '"></video>';
      else box.innerHTML = '<iframe src="' + u + '" title="PDF-Vorschau"></iframe>';
    }).catch(function (e) {
      if (job !== previewJob || !document.body.contains(box)) return;
      box.innerHTML = '<span class="bin-load">Vorschau fehlgeschlagen: ' + esc(e.message) + '</span>';
    });
  }

  function getBlob(path) {
    return DB.get(path).then(function (rec) {
      if (!rec) throw new Error('Datei nicht gefunden');
      if (rec.blob) return rec.blob;
      if (rec.text != null) return new Blob([rec.text], { type: 'text/plain' });
      if (rec.remote && Remote.configured()) return Remote.getBlob(path);
      throw new Error('Kein Inhalt verfügbar');
    });
  }

  function ensureText(rec) {
    if (rec.text != null) return Promise.resolve(rec.text);
    if (rec.blob) return rec.blob.text().then(function (t) {
      return DB.get(rec.path).then(function (full) {
        full.text = t; full.lines = t.split('\n').length;
        return DB.put(full).then(function () { return t; });
      });
    });
    if (rec.remote && Remote.configured()) {
      progress('Lade ' + rec.name + ' …');
      return Remote.getText(rec.path).then(function (t) {
        progress('');
        return DB.get(rec.path).then(function (full) {
          if (full) { full.text = t; full.lines = t.split('\n').length; DB.put(full); }
          return t;
        });
      });
    }
    return Promise.reject(new Error('Kein Inhalt verfügbar'));
  }

  function openFile(path, gotoLine, highlightQuery, isReactivate) {
    return DB.get(path).then(function (rec) {
      if (!rec) { toast('Datei nicht gefunden: ' + path); return; }

      var key = 'f:' + path;
      var idx = findTab(key);
      if (idx === -1) {
        state.tabs.push({ key: key, kind: 'file', title: rec.name, path: path });
        idx = state.tabs.length - 1;
      }
      state.active = idx;
      state.tabs[idx].gotoLine = undefined;
      renderTabs();
      showWelcome(false);

      if (rec.binary) {
        state.doc = null;
        el.editorContent.innerHTML = '';
        el.minimap.classList.add('hidden');
        showBinary(rec);
        updateStatusFile();
        renderTree();
        return;
      }
      showBinary(null);
      el.minimap.classList.toggle('hidden', !state.minimapOn);

      return ensureText(rec).then(function (text) {
        state.doc = makeFileDoc(rec, text);
        matchesByLine = Object.create(null);
        state.find.matches = []; state.find.cur = -1;

        if (highlightQuery) {
          el.findInput.value = highlightQuery;
          state.find.q = highlightQuery;
          runFindInFile(false);
        } else if (state.find.q && !el.findbar.classList.contains('hidden')) {
          runFindInFile(false);
        }

        if (gotoLine != null) gotoLineNumber(gotoLine, true);
        else { el.editorScroll.scrollTop = 0; scheduleRender(); }

        drawMinimap();
        updateStatusFile();
        updateStatusPos();
        renderTree();
      }).catch(function (e) {
        toast('Fehler: ' + e.message);
        progress('');
      });
    });
  }

  function gotoLineNumber(line, center) {
    var doc = state.doc; if (!doc) return;
    line = Math.max(0, Math.min(doc.count - 1, line));
    doc.curLine = line;
    var sc = el.editorScroll;
    var y = line * LH;
    if (center || y < sc.scrollTop || y > sc.scrollTop + sc.clientHeight - LH * 2) {
      sc.scrollTop = Math.max(0, y - sc.clientHeight / 3);
    }
    scheduleRender();
    updateStatusPos();
  }

  /* ============================================================
     Statuszeile
     ============================================================ */
  function updateStatusFile() {
    var t = state.tabs[state.active];
    if (!t) { el.stFile.textContent = 'Keine Datei'; el.stLang.textContent = ''; el.stPos.textContent = ''; return; }
    if (t.kind === 'results') {
      el.stFile.textContent = t.title;
      el.stLang.textContent = 'Suchergebnisse';
      el.stPos.textContent = t.doc && t.doc.summary ? t.doc.summary : '';
      return;
    }
    var rec = state.byPath[t.path];
    el.stFile.textContent = t.path;
    el.stLang.textContent = (rec && rec.binary) ? 'binär' : (state.doc ? state.doc.lang : '');
  }
  function updateStatusPos() {
    var doc = state.doc;
    if (!doc || doc.kind !== 'file') { el.stPos.textContent = ''; return; }
    el.stPos.textContent = 'Zeile ' + (doc.curLine + 1) + ' von ' + doc.count;
  }
  function updateStatusCount() {
    var files = state.index.length;
    var bytes = state.index.reduce(function (a, r) { return a + (r.size || 0); }, 0);
    var remote = Remote.configured() ? ' · ☁ verbunden' : ' · nur lokal';
    el.stCount.textContent = files + ' Dateien · ' + fmtSize(bytes) + remote;
    el.cloudState.textContent = Remote.configured() ? 'Cloud' : 'Lokal';
    el.cloudState.classList.toggle('connected', Remote.configured());
    el.cloudState.classList.toggle('local', !Remote.configured());
  }

  /* ============================================================
     Suche in aktueller Datei
     ============================================================ */
  function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  function buildRegex(q, o) {
    var src = o.regex ? q : escRe(q);
    if (o.word) src = '\\b(?:' + src + ')\\b';
    return new RegExp(src, 'g' + (o.caseSensitive ? '' : 'i'));
  }

  function runFindInFile(jump) {
    var doc = state.doc;
    matchesByLine = Object.create(null);
    state.find.matches = [];
    state.find.cur = -1;
    var q = state.find.q;
    el.findInput.classList.remove('bad');

    if (!doc || doc.kind !== 'file' || !q) {
      el.findCount.textContent = '0 Treffer';
      scheduleRender(); drawMinimap();
      return;
    }
    var re;
    try { re = buildRegex(q, state.find.opts); }
    catch (e) { el.findInput.classList.add('bad'); el.findCount.textContent = 'Regex-Fehler'; return; }

    for (var i = 0; i < doc.lines.length; i++) {
      var line = doc.lines[i];
      if (!line) continue;
      re.lastIndex = 0;
      var m, guard = 0;
      while ((m = re.exec(line)) !== null) {
        if (m[0] === '') { re.lastIndex++; if (++guard > 5000) break; continue; }
        (matchesByLine[i] || (matchesByLine[i] = [])).push([m.index, m.index + m[0].length]);
        state.find.matches.push({ line: i, start: m.index, end: m.index + m[0].length });
        if (++guard > 5000) break;
      }
      if (state.find.matches.length > 50000) break;
    }
    el.findCount.textContent = state.find.matches.length + (state.find.matches.length === 1 ? ' Treffer' : ' Treffer');
    if (jump && state.find.matches.length) {
      var from = doc.curLine;
      var idx = 0;
      for (var k = 0; k < state.find.matches.length; k++) {
        if (state.find.matches[k].line >= from) { idx = k; break; }
      }
      state.find.cur = idx;
      gotoLineNumber(state.find.matches[idx].line, false);
    }
    scheduleRender();
    drawMinimap();
  }

  function stepMatch(dir) {
    var m = state.find.matches;
    if (!m.length) return;
    state.find.cur = (state.find.cur + dir + m.length) % m.length;
    el.findCount.textContent = (state.find.cur + 1) + ' / ' + m.length;
    gotoLineNumber(m[state.find.cur].line, false);
  }

  function openFindbar() {
    var doc = state.doc;
    if (!doc || doc.kind !== 'file') { toast('Zuerst eine Textdatei öffnen'); return; }
    el.findbar.classList.remove('hidden');
    el.findInput.focus();
    el.findInput.select();
  }
  function closeFindbar() {
    el.findbar.classList.add('hidden');
    state.find.q = '';
    matchesByLine = Object.create(null);
    state.find.matches = []; state.find.cur = -1;
    el.findCount.textContent = '0 Treffer';
    scheduleRender(); drawMinimap();
    el.editorScroll.focus();
  }

  el.findInput.addEventListener('input', function () {
    state.find.q = el.findInput.value;
    runFindInFile(true);
  });
  el.findInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); stepMatch(e.shiftKey ? -1 : 1); }
    else if (e.key === 'Escape') { e.preventDefault(); closeFindbar(); }
  });
  el.findNext.onclick = function () { stepMatch(1); };
  el.findPrev.onclick = function () { stepMatch(-1); };
  el.findClose.onclick = closeFindbar;

  document.querySelectorAll('.findbar .opt').forEach(function (b) {
    b.onclick = function () {
      var k = { case: 'caseSensitive', word: 'word', regex: 'regex' }[b.dataset.opt];
      state.find.opts[k] = !state.find.opts[k];
      b.classList.toggle('on', state.find.opts[k]);
      b.setAttribute('aria-pressed', state.find.opts[k] ? 'true' : 'false');
      runFindInFile(false);
    };
  });

  /* ============================================================
     Suche in allen Dateien
     ============================================================ */
  var worker = null, jobId = 0, jobResults = [], jobStart = 0;

  function getWorker() {
    if (worker) return worker;
    worker = new Worker('js/search-worker.js');
    worker.onmessage = function (e) {
      var m = e.data;
      if (m.type === 'results') {
        jobResults = jobResults.concat(m.results);
        progress(m.files + ' Dateien · ' + m.matches + ' Treffer…');
      } else if (m.type === 'progress') {
        progress(m.scanned + ' Dateien durchsucht…');
      } else if (m.type === 'done') {
        progress('');
        showResults(m);
      } else if (m.type === 'error') {
        progress('');
        el.fifQuery.classList.add('bad');
        toast(m.message);
      }
    };
    return worker;
  }

  function openFif() {
    el.fif.classList.remove('hidden');
    var doc = state.doc;
    el.fifQuery.focus();
    el.fifQuery.select();
  }
  function closeFif() { el.fif.classList.add('hidden'); el.editorScroll.focus(); }
  el.fifClose.onclick = closeFif;
  el.fifRun.onclick = function () { runFif(); };
  [el.fifQuery, el.fifInclude, el.fifExclude].forEach(function (inp) {
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); runFif(); }
      else if (e.key === 'Escape') { e.preventDefault(); closeFif(); }
    });
  });
  document.querySelectorAll('.fif .opt').forEach(function (b) {
    b.onclick = function () {
      var k = { case: 'caseSensitive', word: 'word', regex: 'regex' }[b.dataset.fopt];
      state.fifOpts[k] = !state.fifOpts[k];
      b.classList.toggle('on', state.fifOpts[k]);
      b.setAttribute('aria-pressed', state.fifOpts[k] ? 'true' : 'false');
    };
  });

  function runFif(preset) {
    var q = preset != null ? preset : el.fifQuery.value;
    if (preset != null) el.fifQuery.value = preset;
    el.fifQuery.classList.remove('bad');
    if (!q) { toast('Suchbegriff eingeben'); return; }
    if (!state.index.length) { toast('Noch keine Dateien geladen'); return; }

    jobResults = [];
    jobStart = performance.now();
    progress('Suche läuft…');
    getWorker().postMessage({
      type: 'search', query: q, opts: state.fifOpts,
      include: el.fifInclude.value, exclude: el.fifExclude.value
    });
  }

  function showResults(info) {
    var q = el.fifQuery.value;
    var ms = Math.round(performance.now() - jobStart);
    jobResults.sort(function (a, b) { return a.path.localeCompare(b.path); });
    var summary = info.matches + (info.matches === 1 ? ' Treffer in ' : ' Treffer in ') +
      info.files + (info.files === 1 ? ' Datei (' : ' Dateien (') +
      info.scanned + ' durchsucht, ' + ms + ' ms)' + (info.truncated ? ' – gekürzt' : '');

    var doc = makeResultsDoc(q, jobResults, summary);
    state.lastResults = { query: q, results: jobResults };

    var key = 'r:results';
    var idx = findTab(key);
    var tab = { key: key, kind: 'results', title: 'Ergebnisse: ' + q, doc: doc, scroll: 0 };
    if (idx === -1) { state.tabs.push(tab); idx = state.tabs.length - 1; }
    else state.tabs[idx] = tab;

    state.active = idx;
    state.doc = doc;
    matchesByLine = Object.create(null);
    showWelcome(false); showBinary(null);
    el.minimap.classList.toggle('hidden', !state.minimapOn);
    renderTabs();
    el.editorScroll.scrollTop = 0;
    scheduleRender();
    drawMinimap();
    updateStatusFile();
    if (!info.files) toast('Keine Treffer für "' + q + '"');
  }

  /* ============================================================
     Upload / Import
     ============================================================ */
  function normPath(p) {
    var parts = String(p || '').replace(/\\/g, '/').replace(/^\/+/, '').split('/');
    if (parts.some(function (part) { return part === '..' || /[\0-\x1f\x7f]/.test(part); })) {
      throw new Error('Ungültiger Dateipfad: ' + p);
    }
    return parts.filter(function (part) { return part && part !== '.'; }).join('/');
  }

  function looksBinary(buf) {
    var n = Math.min(buf.length, 8000), nulls = 0, ctrl = 0;
    for (var i = 0; i < n; i++) {
      var c = buf[i];
      if (c === 0) { nulls++; if (nulls > 1) return true; }
      else if (c < 9 || (c > 13 && c < 32)) ctrl++;
    }
    return n > 0 && ctrl / n > 0.3;
  }

  function readFile(file, path) {
    var rec = {
      path: path, name: baseName(path), size: file.size,
      mtime: file.lastModified || Date.now(),
      lang: Lang.detect(path), binary: false, text: null, blob: null,
      remote: false, etag: '', lines: 0
    };
    // Binär oder zu groß für den Textindex → Inhalt bleibt als Blob liegen,
    // bis der Cloud-Upload bestätigt ist (siehe addFiles).
    if (Lang.isBinaryExt(path) || file.size > MAX_TEXT) {
      rec.binary = true;
      rec.blob = file;
      return Promise.resolve(rec);
    }
    return file.arrayBuffer().then(function (ab) {
      var u8 = new Uint8Array(ab);
      if (looksBinary(u8)) {
        rec.binary = true;
        rec.blob = file;
        return rec;
      }
      var text = new TextDecoder('utf-8', { fatal: false }).decode(u8);
      if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
      rec.text = text.replace(/\r\n?/g, '\n');
      rec.lines = rec.text.split('\n').length;
      return rec;
    });
  }

  function addFiles(entries) {
    if (!entries.length) return Promise.resolve();
    var total = entries.length, done = 0, bytes = 0, totalBytes = 0;
    entries.forEach(function (e) { totalBytes += e.file.size; });

    var uploaded = 0;
    progress('0 / ' + total + ' Dateien…');

    var chain = Promise.resolve();
    var batch = [];

    entries.forEach(function (ent) {
      chain = chain.then(function () {
        return readFile(ent.file, ent.path).then(function (rec) {
          if (Remote.configured()) {
            return Remote.upload(rec.path, ent.file, function (loaded, tot) {
              progress('Hochladen ' + rec.name + ' – ' + fmtSize(bytes + loaded) + ' / ' + fmtSize(totalBytes));
            }).then(function (result) {
              rec.remote = true;
              rec.etag = result && result.etag || '';
              rec.blob = null;          // Inhalt liegt jetzt in R2
              uploaded++;
            }).catch(function (err) {
              toast('Upload fehlgeschlagen (' + rec.name + '): ' + err.message, 5000);
            }).then(function () { return rec; });
          }
          return rec;
        }).then(function (rec) {
          bytes += ent.file.size;
          batch.push(rec);
          done++;
          if (done % 5 === 0 || done === total) progress(done + ' / ' + total + ' Dateien…');
          if (batch.length >= 40) { var b = batch; batch = []; return DB.putMany(b); }
        });
      });
    });

    return chain.then(function () {
      if (batch.length) return DB.putMany(batch);
    }).then(function () {
      progress('');
      return refreshIndex();
    }).then(function () {
      toast(total + ' Datei' + (total === 1 ? '' : 'en') + ' hinzugefügt' +
        (Remote.configured() ? ' · ' + uploaded + ' in die Cloud geladen' : ''));
    }).catch(function (e) {
      progress('');
      toast('Fehler: ' + e.message, 5000);
    });
  }

  /* ---- Datei-Inputs ---- */
  el.btnAddFiles.onclick = function () { el.fileInput.click(); };
  el.btnAddFolder.onclick = function () { el.dirInput.click(); };
  el.btnMenu.onclick = function () { openPalette('cmd'); };
  el.sideOpenFolder.onclick = function () { el.dirInput.click(); };
  el.welcomeOpenFolder.onclick = function () { el.dirInput.click(); };
  el.welcomeAddFiles.onclick = function () { el.fileInput.click(); };
  el.btnQuickFind.onclick = function () { openPalette('file'); };
  el.btnQuickSearch.onclick = function () { openFif(); };
  el.btnQuickSync.onclick = function () {
    if (Remote.configured()) syncRemote();
    else openConnectDialog();
  };
  el.btnMobileSidebar.onclick = function (e) { e.stopPropagation(); el.sidebar.classList.toggle('mobile-open'); };
  el.main.addEventListener('click', function (e) {
    if (e.target.closest('#btn-mobile-sidebar')) return;
    if (window.matchMedia('(max-width:720px)').matches) el.sidebar.classList.remove('mobile-open');
  });

  el.fileInput.onchange = function () {
    var list = Array.prototype.map.call(el.fileInput.files, function (f) {
      return { file: f, path: normPath(f.webkitRelativePath || f.name) };
    });
    el.fileInput.value = '';
    addFiles(list);
  };
  el.dirInput.onchange = function () {
    var list = Array.prototype.map.call(el.dirInput.files, function (f) {
      return { file: f, path: normPath(f.webkitRelativePath || f.name) };
    });
    el.dirInput.value = '';
    addFiles(list);
  };

  /* ---- Drag & Drop (inkl. Ordner) ---- */
  var dragDepth = 0;
  window.addEventListener('dragenter', function (e) {
    if (!e.dataTransfer || Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') === -1) return;
    e.preventDefault(); dragDepth++; el.dropzone.classList.remove('hidden');
  });
  window.addEventListener('dragover', function (e) { e.preventDefault(); });
  window.addEventListener('dragleave', function (e) {
    if (--dragDepth <= 0) { dragDepth = 0; el.dropzone.classList.add('hidden'); }
  });
  window.addEventListener('drop', function (e) {
    e.preventDefault();
    dragDepth = 0;
    el.dropzone.classList.add('hidden');
    var dt = e.dataTransfer;
    if (!dt) return;
    var items = dt.items;
    if (items && items.length && items[0].webkitGetAsEntry) {
      var roots = [];
      for (var i = 0; i < items.length; i++) {
        var en = items[i].webkitGetAsEntry();
        if (en) roots.push(en);
      }
      progress('Ordner wird gelesen…');
      collectEntries(roots).then(function (list) { progress(''); addFiles(list); });
    } else {
      addFiles(Array.prototype.map.call(dt.files, function (f) { return { file: f, path: normPath(f.name) }; }));
    }
  });

  function collectEntries(entries) {
    var out = [];
    function walkEntry(entry, prefix) {
      if (entry.isFile) {
        return new Promise(function (res) {
          entry.file(function (f) { out.push({ file: f, path: normPath(prefix + entry.name) }); res(); },
            function () { res(); });
        });
      }
      if (entry.isDirectory) {
        var reader = entry.createReader();
        var kids = [];
        function readBatch() {
          return new Promise(function (res, rej) {
            reader.readEntries(function (batch) {
              if (!batch.length) return res();
              kids = kids.concat(batch);
              readBatch().then(res, rej);
            }, function () { res(); });
          });
        }
        return readBatch().then(function () {
          return kids.reduce(function (p, k) {
            return p.then(function () { return walkEntry(k, prefix + entry.name + '/'); });
          }, Promise.resolve());
        });
      }
      return Promise.resolve();
    }
    return entries.reduce(function (p, e) {
      return p.then(function () { return walkEntry(e, ''); });
    }, Promise.resolve()).then(function () { return out; });
  }

  /* ============================================================
     Löschen / Herunterladen / Export
     ============================================================ */
  function deletePath(path, isDir) {
    var remoteOp = Remote.configured()
      ? (isDir ? Remote.delPrefix(path) : Remote.del(path))
      : Promise.resolve();
    return remoteOp
      .then(function () { return isDir ? DB.delPrefix(path) : DB.del(path); })
      .then(function () {
        for (var i = state.tabs.length - 1; i >= 0; i--) {
          var t = state.tabs[i];
          if (t.path && (t.path === path || (isDir && t.path.indexOf(path + '/') === 0))) closeTab(i);
        }
        return refreshIndex();
      })
      .then(function () { toast('Gelöscht: ' + path); })
      .catch(function (e) {
        toast('Nicht gelöscht – Cloud-Fehler: ' + e.message, 5000);
        return false;
      });
  }

  function saveBlob(blob, name) {
    var u = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = u; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(u); }, 4000);
  }

  function downloadFile(path) {
    getBlob(path).then(function (b) { saveBlob(b, baseName(path)); })
      .catch(function (e) { toast('Fehler: ' + e.message); });
  }

  function exportZip() {
    var totalSize = state.index.reduce(function (sum, rec) { return sum + (rec.size || 0); }, 0);
    var MAX_ZIP = 400 * 1024 * 1024;
    if (state.index.length > 65535) {
      toast('ZIP-Export unterstützt höchstens 65.535 Dateien.', 5000);
      return Promise.resolve();
    }
    if (totalSize > MAX_ZIP) {
      toast('Für einen stabilen Browser-Export sind maximal 400 MB möglich. Bitte große Dateien einzeln laden.', 6000);
      return Promise.resolve();
    }
    progress('ZIP wird erstellt…');
    var entries = [];
    var chain = state.index.reduce(function (p, rec) {
      return p.then(function () {
        return getBlob(rec.path)
          .then(function (b) { return b.arrayBuffer(); })
          .then(function (ab) { entries.push({ name: rec.path, data: new Uint8Array(ab), date: new Date(rec.mtime || Date.now()) }); })
          .catch(function () { /* überspringen */ });
      });
    }, Promise.resolve());
    return chain.then(function () {
      progress('');
      if (!entries.length) { toast('Nichts zu exportieren'); return; }
      saveBlob(Zip.zip(entries), 'weblime-export.zip');
    }).catch(function (e) {
      progress('');
      toast('ZIP-Export fehlgeschlagen: ' + e.message, 5000);
    });
  }

  /* ============================================================
     Cloud-Sync
     ============================================================ */
  function syncRemote(silent) {
    if (!Remote.configured()) {
      if (!silent) toast('Keine Cloud konfiguriert – Befehlspalette → "Cloud: Verbinden"');
      return Promise.resolve();
    }
    progress('Synchronisiere…');
    return Remote.list().then(function (files) {
      var remoteMap = Object.create(null);
      var puts = [];
      files.forEach(function (f) {
        remoteMap[f.path] = f;
        var local = state.byPath[f.path];
        if (local && local.remote && local.etag && local.etag === f.etag) return;
        puts.push({
          path: f.path, name: baseName(f.path), size: f.size,
          mtime: f.mtime || Date.now(), etag: f.etag || '', lang: Lang.detect(f.path),
          binary: Lang.isBinaryExt(f.path), text: null, blob: null,
          remote: true, lines: 0
        });
      });

      // Lokale Einträge, die remote gelöscht wurden, entfernen
      var stale = state.index.filter(function (r) { return r.remote && !remoteMap[r.path]; });

      return (puts.length ? DB.putMany(puts) : Promise.resolve())
        .then(function () {
          return stale.reduce(function (p, r) { return p.then(function () { return DB.del(r.path); }); }, Promise.resolve());
        })
        .then(function () { return cacheRemoteTexts(remoteMap); })
        .then(function () { return refreshIndex(); })
        .then(function () {
          progress('');
          if (!silent) toast(files.length + ' Dateien in der Cloud · Index aktuell');
        });
    }).catch(function (e) {
      progress('');
      toast('Cloud-Fehler: ' + e.message, 5000);
    });
  }

  /** Holt Textinhalte, die lokal noch fehlen — sonst findet die Suche sie nicht. */
  function cacheRemoteTexts(remoteMap) {
    return DB.index().then(function (list) {
      var need = list.filter(function (r) {
        return r.remote && !r.binary && !r.cached && r.size <= 5 * 1024 * 1024;
      });
      if (!need.length) return;
      var done = 0;
      return need.reduce(function (p, r) {
        return p.then(function () {
          progress('Index: ' + (++done) + ' / ' + need.length + ' Dateien…');
          return Remote.getText(r.path).then(function (t) {
            return DB.get(r.path).then(function (full) {
              if (!full) return;
              full.text = t.replace(/\r\n?/g, '\n');
              full.lines = full.text.split('\n').length;
              return DB.put(full);
            });
          }).catch(function () { /* einzelne Fehler ignorieren */ });
        });
      }, Promise.resolve());
    });
  }

  function pushAllToRemote() {
    if (!Remote.configured()) { toast('Keine Cloud konfiguriert'); return; }
    var local = state.index.filter(function (r) { return !r.remote; });
    if (!local.length) { toast('Alles bereits in der Cloud'); return; }
    var i = 0, uploaded = 0, failed = 0;
    return local.reduce(function (p, r) {
      return p.then(function () {
        progress('Hochladen ' + (++i) + ' / ' + local.length + ' – ' + r.name);
        return getBlob(r.path)
          .then(function (b) { return Remote.upload(r.path, b); })
          .then(function (result) {
            return DB.get(r.path).then(function (full) {
              if (full) {
                full.remote = true; full.etag = result && result.etag || '';
                full.blob = null; uploaded++; return DB.put(full);
              }
            });
          })
          .catch(function (e) { failed++; toast('Fehler bei ' + r.name + ': ' + e.message, 4000); });
      });
    }, Promise.resolve()).then(function () {
      progress('');
      return refreshIndex();
    }).then(function () {
      toast(uploaded + ' Dateien hochgeladen' + (failed ? ' · ' + failed + ' fehlgeschlagen' : ''), failed ? 5000 : 2600);
    });
  }

  /* ---- Verbindungsdialog ---- */
  function openConnectDialog() {
    var c = Remote.cfg;
    el.modal.classList.remove('hidden');
    el.modalBody.innerHTML =
      '<h2>Cloud verbinden</h2>' +
      '<p class="m-sub">Die WebLime-Cloud ist bereits eingerichtet. Gib nur dein geheimes Zugriffstoken ein.</p>' +
      '<label>Zugriffs-Token</label>' +
      '<input id="m-token" type="password" placeholder="AUTH_TOKEN aus dem Worker" value="' + esc(c.token) + '">' +
      '<p class="m-sub">Das Token wird nur bis zum Schließen des Browsers gespeichert.</p>' +
      '<div class="m-actions">' +
        '<button class="tbtn wide" id="m-cancel">Abbrechen</button>' +
        '<button class="primary" id="m-save">Verbinden</button>' +
      '</div>' +
      '<div class="m-status" id="m-status"></div>';

    $('m-cancel').onclick = closeModal;
    $('m-save').onclick = function () {
      var token = $('m-token').value.trim();
      if (!token) { $('m-status').textContent = 'Bitte das Zugriffs-Token eintragen.'; return; }
      Remote.configure({ token: token });
      $('m-status').textContent = 'Verbinde…';
      Remote.ping().then(function (r) {
        $('m-status').textContent = 'Verbunden ✓ ' + (r.files != null ? r.files + ' Dateien im Bucket' : '');
        updateStatusCount();
        setTimeout(function () { closeModal(); syncRemote(); }, 700);
      }).catch(function (e) {
        Remote.configure(c);
        updateStatusCount();
        $('m-status').textContent = 'Fehlgeschlagen: ' + e.message;
      });
    };
    setTimeout(function () { $('m-token').focus(); }, 30);
  }
  function closeModal() { el.modal.classList.add('hidden'); el.modalBody.innerHTML = ''; }
  el.modal.addEventListener('mousedown', function (e) { if (e.target === el.modal) closeModal(); });

  /* ============================================================
     Palette: Goto Anything + Befehle
     ============================================================ */
  var palette = { mode: 'file', items: [], sel: 0, onPick: null };

  function fuzzy(needle, hay) {
    if (!needle) return { score: 0, pos: [] };
    var n = needle.toLowerCase(), h = hay.toLowerCase();
    var pos = [], hi = 0, score = 0, prev = -2;
    for (var i = 0; i < n.length; i++) {
      var ch = n[i];
      if (ch === ' ') continue;
      var idx = h.indexOf(ch, hi);
      if (idx === -1) return null;
      score += 10;
      if (idx === prev + 1) score += 12;
      if (idx === 0 || /[\/._\-\s]/.test(h[idx - 1])) score += 8;
      if (hay[idx] === needle[i]) score += 2;
      score -= Math.min(6, idx - hi);
      pos.push(idx);
      prev = idx; hi = idx + 1;
    }
    score -= hay.length * 0.05;
    return { score: score, pos: pos };
  }

  function hl(text, pos) {
    if (!pos || !pos.length) return esc(text);
    var out = '', p = 0;
    for (var i = 0; i < pos.length; i++) {
      out += esc(text.slice(p, pos[i])) + '<span class="fz">' + esc(text[pos[i]]) + '</span>';
      p = pos[i] + 1;
    }
    return out + esc(text.slice(p));
  }

  var COMMANDS = [
    { name: 'Dateien hochladen…', hint: 'Einzelne Dateien wählen', run: function () { el.fileInput.click(); } },
    { name: 'Ordner hochladen…', hint: 'Kompletten Ordner wählen', run: function () { el.dirInput.click(); } },
    { name: 'In allen Dateien suchen', hint: 'Strg+Shift+F', run: function () { openFif(); } },
    { name: 'In dieser Datei suchen', hint: 'Strg+F', run: function () { openFindbar(); } },
    { name: 'Gehe zu Zeile…', hint: 'Strg+G', run: function () { openPalette('line'); } },
    { name: 'Gehe zu Symbol…', hint: 'Strg+R', run: function () { openPalette('sym'); } },
    { name: 'Cloud: Verbinden…', hint: 'Cloudflare Worker + R2', run: openConnectDialog },
    { name: 'Cloud: Synchronisieren', hint: 'Dateiliste + Suchindex aktualisieren', run: function () { syncRemote(); } },
    { name: 'Cloud: Lokale Dateien hochladen', hint: 'Alles Lokale in die Cloud schieben', run: pushAllToRemote },
    { name: 'Cloud: Trennen', hint: 'Zugangsdaten aus dem Browser löschen', run: function () {
        Remote.configure({ token: '' }); updateStatusCount(); toast('Cloud getrennt');
      } },
    { name: 'Datei herunterladen', hint: 'Aktuelle Datei speichern', run: function () {
        var t = state.tabs[state.active];
        if (t && t.path) downloadFile(t.path); else toast('Keine Datei geöffnet');
      } },
    { name: 'Alles als ZIP herunterladen', hint: 'Vollständiger Export', run: exportZip },
    { name: 'Datei löschen', hint: 'Aktuelle Datei entfernen', run: function () {
        var t = state.tabs[state.active];
        if (t && t.path && confirm('Löschen?\n\n' + t.path)) deletePath(t.path, false);
      } },
    { name: 'Lokalen Cache leeren', hint: 'Cloud-Dateien bleiben erhalten', run: function () {
        if (!confirm('Lokalen Index wirklich leeren?')) return;
        DB.clear().then(function () {
          state.tabs = []; state.active = -1; state.doc = null;
          renderTabs(); el.editorContent.innerHTML = ''; showWelcome(true);
          return refreshIndex();
        }).then(function () { toast('Lokaler Cache geleert'); });
      } },
    { name: 'Seitenleiste ein/aus', hint: 'Strg+B', run: function () { el.sidebar.classList.toggle('collapsed'); scheduleRender(); } },
    { name: 'Minimap ein/aus', hint: '', run: function () {
        state.minimapOn = !state.minimapOn;
        el.minimap.classList.toggle('hidden', !state.minimapOn);
        drawMinimap();
      } },
    { name: 'Alle Tabs schließen', hint: '', run: function () {
        state.tabs = []; state.active = -1; state.doc = null;
        renderTabs(); el.editorContent.innerHTML = ''; showBinary(null); showWelcome(true); updateStatusFile();
      } }
  ];

  function openPalette(mode, prefill) {
    palette.mode = mode;
    palette.sel = 0;
    el.palette.classList.remove('hidden');
    el.paletteInput.value = prefill != null ? prefill : (mode === 'cmd' ? '>' : mode === 'line' ? ':' : mode === 'sym' ? '@' : '');
    el.paletteInput.placeholder = mode === 'cmd' ? 'Befehl…' : 'Datei suchen  (>Befehl  @Symbol  :Zeile)';
    el.paletteInput.focus();
    el.paletteInput.setSelectionRange(el.paletteInput.value.length, el.paletteInput.value.length);
    updatePalette();
  }
  function closePalette() {
    el.palette.classList.add('hidden');
    el.paletteList.innerHTML = '';
    el.editorScroll.focus();
  }

  function currentSymbols() {
    var doc = state.doc;
    if (!doc || doc.kind !== 'file') return [];
    if (!doc.symbols) doc.symbols = Lang.symbols(doc.lines, doc.lang);
    return doc.symbols;
  }

  function updatePalette() {
    var q = el.paletteInput.value;
    var items = [];

    if (q[0] === '>') {
      var cq = q.slice(1).trim();
      COMMANDS.forEach(function (c) {
        var f = cq ? fuzzy(cq, c.name) : { score: 0, pos: [] };
        if (f) items.push({ score: f.score, p1: hl(c.name, f.pos), p2: c.hint, run: c.run });
      });
      items.sort(function (a, b) { return b.score - a.score; });
    } else if (q[0] === '@') {
      var sq = q.slice(1).trim();
      currentSymbols().forEach(function (s) {
        var f = sq ? fuzzy(sq, s.name) : { score: -s.line * 0.001, pos: [] };
        if (f) items.push({
          score: f.score, p1: hl(s.name, f.pos),
          p2: s.kind + '  ·  Zeile ' + (s.line + 1),
          run: (function (line) { return function () { gotoLineNumber(line, true); }; })(s.line)
        });
      });
      items.sort(function (a, b) { return b.score - a.score; });
    } else if (q[0] === ':') {
      var ln = parseInt(q.slice(1), 10);
      items.push({
        score: 0, p1: isNaN(ln) ? 'Zeilennummer eingeben' : 'Gehe zu Zeile ' + ln,
        p2: state.doc ? state.doc.count + ' Zeilen' : '',
        run: function () { if (!isNaN(ln)) gotoLineNumber(ln - 1, true); }
      });
    } else {
      var m = /^(.*?)(?::(\d+))?$/.exec(q);
      var fq = (m[1] || '').trim(), line = m[2] ? parseInt(m[2], 10) - 1 : null;
      state.index.forEach(function (rec) {
        var f = fq ? (fuzzy(fq, rec.name) || fuzzy(fq, rec.path)) : { score: 0, pos: [] };
        if (!f) return;
        var isName = fq && fuzzy(fq, rec.name);
        items.push({
          score: f.score + (isName ? 25 : 0),
          p1: isName ? hl(rec.name, isName.pos) : esc(rec.name),
          p2: esc(dirName(rec.path) || '/') + '  ·  ' + fmtSize(rec.size) + (rec.remote ? '  ·  ☁' : ''),
          run: (function (p, l) { return function () { openFile(p, l); }; })(rec.path, line)
        });
      });
      items.sort(function (a, b) { return b.score - a.score; });
      items = items.slice(0, 200);
    }

    palette.items = items;
    if (palette.sel >= items.length) palette.sel = Math.max(0, items.length - 1);

    if (!items.length) {
      el.paletteList.innerHTML = '<div class="p-empty">Keine Treffer</div>';
      return;
    }
    el.paletteList.innerHTML = items.map(function (it, i) {
      return '<div class="p-item' + (i === palette.sel ? ' sel' : '') + '" role="option" aria-selected="' + (i === palette.sel ? 'true' : 'false') + '" data-i="' + i + '">' +
        '<span class="p1">' + it.p1 + '</span>' +
        (it.p2 ? '<span class="p2">' + it.p2 + '</span>' : '') + '</div>';
    }).join('');
    scrollPaletteIntoView();
  }

  function scrollPaletteIntoView() {
    var sel = el.paletteList.querySelector('.p-item.sel');
    if (sel) sel.scrollIntoView({ block: 'nearest' });
  }

  function pickPalette(i) {
    var it = palette.items[i != null ? i : palette.sel];
    if (!it) { closePalette(); return; }
    closePalette();
    setTimeout(function () { it.run(); }, 0);
  }

  el.paletteInput.addEventListener('input', function () { palette.sel = 0; updatePalette(); });
  el.paletteInput.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); palette.sel = Math.min(palette.items.length - 1, palette.sel + 1); updatePalette(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); palette.sel = Math.max(0, palette.sel - 1); updatePalette(); }
    else if (e.key === 'Enter') { e.preventDefault(); pickPalette(); }
    else if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
  });
  el.paletteList.addEventListener('click', function (e) {
    var it = e.target.closest('.p-item');
    if (it) pickPalette(+it.dataset.i);
  });
  el.palette.addEventListener('mousedown', function (e) { if (e.target === el.palette) closePalette(); });

  /* ============================================================
     Tastatur
     ============================================================ */
  document.addEventListener('keydown', function (e) {
    var mod = e.ctrlKey || e.metaKey;
    var inInput = /^(INPUT|TEXTAREA)$/.test(e.target.tagName);

    if (e.key === 'Escape') {
      if (!el.palette.classList.contains('hidden')) { closePalette(); return; }
      if (!el.modal.classList.contains('hidden')) { closeModal(); return; }
      if (!el.fif.classList.contains('hidden')) { closeFif(); return; }
      if (!el.findbar.classList.contains('hidden')) { closeFindbar(); return; }
    }

    if (mod && e.shiftKey && (e.key === 'P' || e.key === 'p')) { e.preventDefault(); openPalette('cmd'); return; }
    if (mod && e.shiftKey && (e.key === 'F' || e.key === 'f')) { e.preventDefault(); openFif(); return; }
    if (mod && !e.shiftKey && (e.key === 'p' || e.key === 'P')) { e.preventDefault(); openPalette('file'); return; }
    if (mod && (e.key === 'f' || e.key === 'F')) { e.preventDefault(); openFindbar(); return; }
    if (mod && (e.key === 'g' || e.key === 'G')) { e.preventDefault(); openPalette('line'); return; }
    if (mod && (e.key === 'r' || e.key === 'R')) { e.preventDefault(); openPalette('sym'); return; }
    if (mod && (e.key === 'b' || e.key === 'B')) { e.preventDefault(); el.sidebar.classList.toggle('collapsed'); scheduleRender(); return; }
    if (mod && (e.key === 'o' || e.key === 'O')) { e.preventDefault(); el.fileInput.click(); return; }
    if (mod && (e.key === 'w' || e.key === 'W')) {
      if (state.active >= 0) { e.preventDefault(); closeTab(state.active); }
      return;
    }
    if (mod && (e.key === 's' || e.key === 'S')) { e.preventDefault(); return; }

    if (e.key === 'F3') {
      e.preventDefault();
      if (el.findbar.classList.contains('hidden')) openFindbar();
      else stepMatch(e.shiftKey ? -1 : 1);
      return;
    }

    if (mod && e.key >= '1' && e.key <= '9') {
      var n = +e.key - 1;
      if (state.tabs[n]) { e.preventDefault(); activateTab(n); }
      return;
    }

    if (inInput) return;

    var doc = state.doc;
    if (!doc) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); gotoLineNumber(doc.curLine + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); gotoLineNumber(doc.curLine - 1); }
    else if (e.key === 'PageDown') { e.preventDefault(); gotoLineNumber(doc.curLine + Math.floor(el.editorScroll.clientHeight / LH)); }
    else if (e.key === 'PageUp') { e.preventDefault(); gotoLineNumber(doc.curLine - Math.floor(el.editorScroll.clientHeight / LH)); }
    else if (mod && e.key === 'Home') { e.preventDefault(); gotoLineNumber(0, true); }
    else if (mod && e.key === 'End') { e.preventDefault(); gotoLineNumber(doc.count - 1, true); }
    else if (e.key === 'Enter' && doc.kind === 'results') {
      var r = doc.rows[doc.curLine];
      if (r && r.path) openFile(r.path, r.t === 'hit' ? r.line : 0, state.lastResults && state.lastResults.query);
    }
  });

  /* ---- Seitenleiste per Maus verbreitern ---- */
  el.dragHandle.addEventListener('mousedown', function (e) {
    e.preventDefault();
    function move(ev) {
      var w = Math.max(150, Math.min(560, ev.clientX));
      el.sidebar.style.width = w + 'px';
    }
    function up() {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      scheduleRender();
    }
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });

  /* ============================================================
     Start
     ============================================================ */
  measureChar();
  showWelcome(true);
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('./sw.js').catch(function () { /* offline cache is optional */ });
    });
  }
  window.addEventListener('pagehide', clearPreview);
  refreshIndex().then(function () {
    if (Remote.configured()) return syncRemote(true);
  }).then(function () {
    updateStatusCount();
    if (state.index.length) drawMinimap();
  });

  // Debug-Zugriff
  window.WebLime = { state: state, DB: DB, openFile: openFile, sync: syncRemote };
})();

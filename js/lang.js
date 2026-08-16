/* ============================================================
   lang.js — Sprach-Erkennung, Syntax-Highlighting, Symbol-Index
   Bewusst kompakt gehalten: ein generischer Tokenizer mit
   Sprach-Konfiguration statt einer Highlighting-Bibliothek.
   ============================================================ */
(function (root) {
  'use strict';

  var KW = {
    c: 'if else for while do return break continue switch case default goto sizeof typedef struct union enum static const volatile extern inline register auto',
    js: 'var let const function return if else for while do break continue switch case default new delete typeof instanceof in of this class extends super import export from as async await yield try catch finally throw void with debugger static get set',
    ts: 'interface type implements private public protected readonly namespace declare abstract enum keyof infer satisfies override',
    py: 'def class return if elif else for while break continue import from as pass raise try except finally with lambda global nonlocal yield assert del in is not and or None True False async await match case',
    java: 'class interface extends implements public private protected static final void new return if else for while do switch case break continue import package throws throw try catch finally this super abstract synchronized volatile transient native instanceof enum assert',
    go: 'func package import var const type struct interface map chan go defer return if else for range switch case default break continue fallthrough select goroutine nil true false',
    rust: 'fn let mut const static struct enum impl trait pub use mod crate self super return if else match for while loop break continue where as dyn ref move unsafe async await type in',
    php: 'function class extends implements public private protected static final return if else elseif foreach for while do switch case break continue new echo print require include namespace use try catch finally throw global var isset unset empty array null true false',
    rb: 'def class module end return if elsif else unless while until for do begin rescue ensure raise yield require require_relative attr_accessor attr_reader attr_writer self nil true false and or not then case when',
    sh: 'if then else elif fi for while do done case esac function return in select until local export readonly declare source alias echo exit set unset trap',
    sql: 'select from where insert into update delete create table drop alter add join left right inner outer on group by order having limit offset union all as distinct values set index view primary key foreign references not null default and or in like between case when then else end'
  };

  function set(str) {
    var s = Object.create(null);
    str.split(/\s+/).forEach(function (w) { if (w) s[w] = 1; });
    return s;
  }

  var TYPES = set('int long float double char bool boolean byte short string String void unsigned signed size_t uint8_t uint16_t uint32_t uint64_t int8_t int16_t int32_t int64_t number any unknown never object symbol bigint u8 u16 u32 u64 i8 i16 i32 i64 f32 f64 usize isize Vec Option Result Box self Self');

  var C_LIKE = { line: ['//'], block: ['/*', '*/'], quotes: ['"', "'", '`'] };

  var LANGS = {
    javascript: { kw: set(KW.js), c: C_LIKE, ext: 'js mjs cjs jsx' },
    typescript: { kw: set(KW.js + ' ' + KW.ts), c: C_LIKE, ext: 'ts tsx mts cts' },
    json:       { kw: set('true false null'), c: { line: ['//'], block: ['/*', '*/'], quotes: ['"'] }, ext: 'json jsonc geojson' },
    python:     { kw: set(KW.py), c: { line: ['#'], block: null, quotes: ['"', "'"] }, ext: 'py pyw pyi' },
    java:       { kw: set(KW.java), c: C_LIKE, ext: 'java' },
    kotlin:     { kw: set(KW.java + ' fun val var when object companion'), c: C_LIKE, ext: 'kt kts' },
    csharp:     { kw: set(KW.java + ' using namespace string var partial override virtual readonly out ref async await'), c: C_LIKE, ext: 'cs' },
    c:          { kw: set(KW.c), c: C_LIKE, ext: 'c h' },
    cpp:        { kw: set(KW.c + ' class public private protected virtual template namespace using new delete this try catch throw operator friend explicit constexpr nullptr true false'), c: C_LIKE, ext: 'cpp cc cxx hpp hh hxx' },
    go:         { kw: set(KW.go), c: C_LIKE, ext: 'go' },
    rust:       { kw: set(KW.rust), c: C_LIKE, ext: 'rs' },
    php:        { kw: set(KW.php), c: { line: ['//', '#'], block: ['/*', '*/'], quotes: ['"', "'"] }, ext: 'php phtml' },
    ruby:       { kw: set(KW.rb), c: { line: ['#'], block: null, quotes: ['"', "'"] }, ext: 'rb rake gemspec' },
    swift:      { kw: set('func let var class struct enum protocol extension import return if else for in while guard switch case default break continue nil true false self init deinit override public private internal static weak lazy throws try catch async await'), c: C_LIKE, ext: 'swift' },
    shell:      { kw: set(KW.sh), c: { line: ['#'], block: null, quotes: ['"', "'"] }, ext: 'sh bash zsh fish' },
    powershell: { kw: set('function param if else elseif foreach for while do switch return break continue try catch finally throw begin process end filter class enum using Write-Host Get-ChildItem'), c: { line: ['#'], block: ['<#', '#>'], quotes: ['"', "'"] }, ext: 'ps1 psm1 psd1' },
    sql:        { kw: set(KW.sql), ci: true, c: { line: ['--'], block: ['/*', '*/'], quotes: ["'", '"'] }, ext: 'sql' },
    yaml:       { kw: set('true false null yes no on off'), c: { line: ['#'], block: null, quotes: ['"', "'"] }, ext: 'yml yaml' },
    toml:       { kw: set('true false'), c: { line: ['#'], block: null, quotes: ['"', "'"] }, ext: 'toml ini cfg conf' },
    css:        { kw: set('important media import keyframes supports from to and not only'), c: { line: ['//'], block: ['/*', '*/'], quotes: ['"', "'"] }, ext: 'css scss sass less styl', css: true },
    html:       { xml: true, ext: 'html htm xhtml vue svelte' },
    xml:        { xml: true, ext: 'xml svg xsl xsd plist rss' },
    markdown:   { md: true, ext: 'md markdown mdx rst' },
    plain:      { c: { line: [], block: null, quotes: [] }, ext: 'txt log text' }
  };

  var byExt = Object.create(null);
  Object.keys(LANGS).forEach(function (id) {
    (LANGS[id].ext || '').split(' ').forEach(function (e) { if (e) byExt[e] = id; });
  });

  var BY_NAME = {
    'dockerfile': 'shell', 'makefile': 'shell', '.gitignore': 'shell', '.env': 'shell',
    '.bashrc': 'shell', '.zshrc': 'shell', 'cmakelists.txt': 'shell'
  };

  var BINARY_EXT = set('png jpg jpeg gif bmp webp ico tif tiff avif heic mp3 wav ogg flac m4a aac mp4 mkv avi mov webm wmv flv zip rar 7z gz bz2 xz tar tgz zst pdf doc docx xls xlsx ppt pptx odt ods exe dll so dylib bin dat db sqlite sqlite3 class jar war pyc pyo o a lib obj woff woff2 ttf otf eot psd ai sketch blend fbx obj3d wasm apk ipa dmg iso img');

  function ext(path) {
    var name = path.split('/').pop();
    var i = name.lastIndexOf('.');
    return i > 0 ? name.slice(i + 1).toLowerCase() : '';
  }

  function detect(path) {
    var name = path.split('/').pop().toLowerCase();
    if (BY_NAME[name]) return BY_NAME[name];
    return byExt[ext(path)] || 'plain';
  }

  function isBinaryExt(path) { return !!BINARY_EXT[ext(path)]; }

  /* -------------------- HTML-Escaping -------------------- */
  // Wird sowohl für Textknoten als auch für dynamisch erzeugte Attribute genutzt.
  // Deshalb müssen neben Markup-Zeichen auch beide Anführungszeichen escaped werden.
  var ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function esc(s) { return s.replace(/[&<>"']/g, function (c) { return ESC[c]; }); }

  /* -------------------- Tokenizer -------------------- */
  function isWordStart(ch) { return /[A-Za-z_$À-￿]/.test(ch); }
  function isWord(ch) { return /[A-Za-z0-9_$À-￿]/.test(ch); }

  function tag(cls, text) { return '<span class="' + cls + '">' + esc(text) + '</span>'; }

  /**
   * Hebt eine Zeile hervor.
   * @param {string} line
   * @param {string} langId
   * @param {number} state  0 = normal, 1 = im Blockkommentar
   * @returns {{html:string, state:number}}
   */
  function highlight(line, langId, state) {
    var L = LANGS[langId] || LANGS.plain;
    if (L.xml) return { html: xmlLine(line), state: 0 };
    if (L.md) return { html: mdLine(line), state: 0 };
    if (L.css) return cssLine(line, state);
    return genericLine(line, L, state);
  }

  function genericLine(line, L, state) {
    var cfg = L.c || LANGS.plain.c;
    var out = '', i = 0, n = line.length;
    var bs = cfg.block && cfg.block[0], be = cfg.block && cfg.block[1];

    if (state === 1 && be) {
      var end = line.indexOf(be);
      if (end === -1) return { html: tag('t-com', line), state: 1 };
      out += tag('t-com', line.slice(0, end + be.length));
      i = end + be.length;
      state = 0;
    }

    while (i < n) {
      var ch = line[i];

      // Zeilenkommentar
      var lc = null;
      for (var k = 0; k < cfg.line.length; k++) {
        if (line.startsWith(cfg.line[k], i)) { lc = cfg.line[k]; break; }
      }
      if (lc) { out += tag('t-com', line.slice(i)); i = n; break; }

      // Blockkommentar
      if (bs && line.startsWith(bs, i)) {
        var e2 = line.indexOf(be, i + bs.length);
        if (e2 === -1) { out += tag('t-com', line.slice(i)); return { html: out, state: 1 }; }
        out += tag('t-com', line.slice(i, e2 + be.length));
        i = e2 + be.length;
        continue;
      }

      // String
      if (cfg.quotes.indexOf(ch) !== -1) {
        var j = i + 1, closed = false;
        while (j < n) {
          if (line[j] === '\\') { j += 2; continue; }
          if (line[j] === ch) { closed = true; j++; break; }
          j++;
        }
        out += tag('t-str', line.slice(i, closed ? j : n));
        i = closed ? j : n;
        continue;
      }

      // Zahl
      if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(line[i + 1] || ''))) {
        var m = /^(0[xXbBoO][0-9a-fA-F_]+|[0-9][0-9_]*\.?[0-9_]*([eE][+-]?[0-9]+)?)[a-zA-Z]*/.exec(line.slice(i));
        var num = m ? m[0] : ch;
        out += tag('t-num', num);
        i += num.length;
        continue;
      }

      // Wort
      if (isWordStart(ch)) {
        var s = i;
        while (i < n && isWord(line[i])) i++;
        var w = line.slice(s, i);
        var key = L.ci ? w.toLowerCase() : w;
        var cls = null;
        if (L.kw && L.kw[key]) cls = 't-kw';
        else if (TYPES[w]) cls = 't-typ';
        else if (line[i] === '(' || (line[i] === ' ' && line[i + 1] === '(')) cls = 't-fn';
        else if (/^[A-Z][A-Za-z0-9_]*$/.test(w)) cls = 't-typ';
        out += cls ? tag(cls, w) : esc(w);
        continue;
      }

      // Operator / Rest
      if ('+-*/%=<>!&|^~?:'.indexOf(ch) !== -1) { out += tag('t-op', ch); i++; continue; }
      out += esc(ch);
      i++;
    }
    return { html: out, state: state };
  }

  function cssLine(line, state) {
    var out = '', i = 0, n = line.length;
    if (state === 1) {
      var e = line.indexOf('*/');
      if (e === -1) return { html: tag('t-com', line), state: 1 };
      out += tag('t-com', line.slice(0, e + 2)); i = e + 2; state = 0;
    }
    var rest = line.slice(i);
    // property: value;
    var pm = /^(\s*)([-a-zA-Z_][-\w]*)(\s*:\s*)(.*)$/.exec(rest);
    if (pm && rest.indexOf('{') === -1) {
      out += esc(pm[1]) + tag('t-prop', pm[2]) + esc(pm[3]);
      out += pm[4].replace(/("[^"]*"|'[^']*')|(#[0-9a-fA-F]{3,8}|\b[0-9.]+(px|em|rem|%|vh|vw|s|ms|deg|fr)?\b)|(\/\*.*)/g,
        function (m, str, num, com) {
          if (str) return tag('t-str', str);
          if (num) return tag('t-num', num);
          if (com) return tag('t-com', com);
          return esc(m);
        });
      return { html: out, state: /\/\*(?!.*\*\/)/.test(rest) ? 1 : 0 };
    }
    out += rest.replace(/(\/\*.*?\*\/)|(\/\*.*)|([.#][-\w]+|::?[-\w]+|@[-\w]+)|("[^"]*"|'[^']*')/g,
      function (m, c1, c2, selector, str) {
        if (c1 || c2) return tag('t-com', m);
        if (selector) return tag('t-typ', selector);
        if (str) return tag('t-str', str);
        return esc(m);
      });
    return { html: out, state: /\/\*(?![\s\S]*\*\/)/.test(rest) ? 1 : 0 };
  }

  function xmlLine(line) {
    return line.replace(/(<!--.*?-->|<!--.*)|(<\/?)([\w:.-]+)|([\w:.-]+)(=)("[^"]*"|'[^']*')|(\/?>)/g,
      function (m, com, open, name, attr, eq, val, close) {
        if (com) return tag('t-com', com);
        if (open) return esc(open) + tag('t-tag', name);
        if (attr) return tag('t-atr', attr) + esc(eq) + tag('t-str', val);
        if (close) return esc(close);
        return esc(m);
      });
  }

  function mdLine(line) {
    if (/^\s{0,3}#{1,6}\s/.test(line)) return tag('t-head', line);
    if (/^\s{0,3}(```|~~~)/.test(line)) return tag('t-com', line);
    if (/^\s{0,3}>/.test(line)) return tag('t-str', line);
    if (/^\s*([-*+]|\d+\.)\s/.test(line)) {
      var m = /^(\s*([-*+]|\d+\.)\s)(.*)$/.exec(line);
      return tag('t-kw', m[1]) + mdInline(m[3]);
    }
    return mdInline(line);
  }
  function mdInline(s) {
    return s.replace(/(`[^`]*`)|(\*\*[^*]+\*\*|__[^_]+__)|(\[[^\]]*\]\([^)]*\))/g,
      function (m, code, bold, link) {
        if (code) return tag('t-str', code);
        if (bold) return tag('t-head', bold);
        if (link) return tag('t-typ', link);
        return esc(m);
      });
  }

  /* -------------------- Symbole (Strg+R) -------------------- */
  var SYM_RULES = [
    { re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([\w$]+)/, kind: 'ƒ' },
    { re: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([\w$]+)/, kind: 'class' },
    { re: /^\s*(?:export\s+)?(?:interface|type|enum|trait|struct|impl|protocol|namespace|module)\s+([\w$]+)/, kind: 'type' },
    { re: /^\s*(?:export\s+)?(?:const|let|var)\s+([\w$]+)\s*=\s*(?:async\s*)?(?:function|\([^)]*\)\s*=>|[\w$]+\s*=>)/, kind: 'ƒ' },
    { re: /^\s*(?:public|private|protected|static|final|override|pub)[\s\w<>[\],]*?\s([\w$]+)\s*\([^)]*\)\s*(?:\{|:|$)/, kind: 'ƒ' },
    { re: /^\s*(?:async\s+)?def\s+([\w$]+)/, kind: 'ƒ' },
    { re: /^\s*func\s+(?:\([^)]*\)\s*)?([\w$]+)/, kind: 'ƒ' },
    { re: /^\s*(?:pub\s+)?fn\s+([\w$]+)/, kind: 'ƒ' },
    { re: /^\s*(?:def|module)\s+([\w$.]+)/, kind: 'ƒ' },
    { re: /^\s*([\w$]+)\s*(?::|=)\s*(?:async\s*)?(?:function|\([^)]*\)\s*=>)/, kind: 'ƒ' },
    { re: /^\s*([\w$]+)\s*\([^)]*\)\s*\{\s*$/, kind: 'ƒ' },
    { re: /^\s*#{1,6}\s+(.+)$/, kind: '#', mdOnly: true },
    { re: /^\s*([.#]?[\w-][\w\s.,:#>[\]()="'-]*?)\s*\{\s*$/, kind: '{}', cssOnly: true }
  ];

  function symbols(lines, langId) {
    var out = [];
    var isMd = langId === 'markdown', isCss = langId === 'css';
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!line || line.length > 400) continue;
      for (var r = 0; r < SYM_RULES.length; r++) {
        var rule = SYM_RULES[r];
        if (rule.mdOnly && !isMd) continue;
        if (rule.cssOnly && !isCss) continue;
        if (!rule.mdOnly && isMd) continue;
        if (!rule.cssOnly && isCss && rule.kind !== '#') continue;
        var m = rule.re.exec(line);
        if (m && m[1] && m[1].length < 90) {
          out.push({ name: m[1].trim(), line: i, kind: rule.kind, indent: /^\s*/.exec(line)[0].length });
          break;
        }
      }
    }
    return out;
  }

  root.Lang = {
    detect: detect, isBinaryExt: isBinaryExt, ext: ext,
    highlight: highlight, escape: esc, symbols: symbols,
    list: Object.keys(LANGS)
  };
})(typeof self !== 'undefined' ? self : window);

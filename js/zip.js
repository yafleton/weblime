/* ============================================================
   zip.js — minimaler ZIP-Writer (Methode "store", ohne Kompression)
   Nur für den Export "Alles herunterladen".
   ============================================================ */
(function (root) {
  'use strict';

  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(buf) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function dosTime(d) {
    return ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() / 2)) & 0xFFFF;
  }
  function dosDate(d) {
    return (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xFFFF;
  }

  function W(len) {
    var b = new Uint8Array(len), v = new DataView(b.buffer), p = 0;
    return {
      buf: b,
      u16: function (x) { v.setUint16(p, x, true); p += 2; return this; },
      u32: function (x) { v.setUint32(p, x >>> 0, true); p += 4; return this; },
      raw: function (a) { b.set(a, p); p += a.length; return this; }
    };
  }

  /**
   * @param {Array<{name:string, data:Uint8Array, date?:Date}>} entries
   * @returns {Blob}
   */
  function zip(entries) {
    if (entries.length > 0xFFFF) throw new Error('Zu viele Dateien für dieses ZIP-Format');
    var enc = new TextEncoder();
    var parts = [], central = [], offset = 0;

    entries.forEach(function (e) {
      var name = enc.encode(e.name);
      var data = e.data;
      if (name.length > 0xFFFF) throw new Error('Dateiname zu lang: ' + e.name);
      if (data.length > 0xFFFFFFFF) throw new Error('Datei zu groß für ZIP32: ' + e.name);
      var crc = crc32(data);
      var d = e.date || new Date();
      var t = dosTime(d), dt = dosDate(d);

      var local = W(30 + name.length);
      local.u32(0x04034b50).u16(20).u16(0x0800).u16(0)
        .u16(t).u16(dt).u32(crc).u32(data.length).u32(data.length)
        .u16(name.length).u16(0).raw(name);

      parts.push(local.buf, data);

      var cd = W(46 + name.length);
      cd.u32(0x02014b50).u16(20).u16(20).u16(0x0800).u16(0)
        .u16(t).u16(dt).u32(crc).u32(data.length).u32(data.length)
        .u16(name.length).u16(0).u16(0).u16(0).u16(0).u32(0).u32(offset).raw(name);
      central.push(cd.buf);

      offset += local.buf.length + data.length;
      if (offset > 0xFFFFFFFF) throw new Error('Archiv zu groß für ZIP32');
    });

    var cdSize = central.reduce(function (a, b) { return a + b.length; }, 0);
    var end = W(22);
    end.u32(0x06054b50).u16(0).u16(0).u16(entries.length).u16(entries.length)
      .u32(cdSize).u32(offset).u16(0);

    return new Blob(parts.concat(central, [end.buf]), { type: 'application/zip' });
  }

  root.Zip = { zip: zip };
})(window);

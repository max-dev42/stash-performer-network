/*
 * Generated placeholder images for the demo (no photos, no real people): abstract avatars for performers
 * and simple coloured compositions for scenes, groups and galleries. PNG encoding with node's zlib only.
 */
"use strict";
var zlib = require("zlib");

var CRC = (function () {
  var t = new Int32Array(256);
  for (var n = 0; n < 256; n++) {
    var c = n;
    for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  var c = -1;
  for (var i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  var len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  var td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  var crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encode(w, h, rgb) {
  var raw = Buffer.alloc((w * 3 + 1) * h);
  for (var y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3);
  }
  var ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

function hsl(h, s, l) {
  var a = s * Math.min(l, 1 - l);
  function f(n) {
    var k = (n + h / 30) % 12;
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  }
  return [f(0), f(8), f(4)];
}

function canvas(w, h) {
  var px = Buffer.alloc(w * h * 3);
  return {
    w: w, h: h, px: px,
    set: function (x, y, c) {
      if (x < 0 || y < 0 || x >= w || y >= h) return;
      var i = (y * w + x) * 3;
      px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2];
    },
    fill: function (fn) {
      for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) this.set(x, y, fn(x, y));
    },
  };
}

// performer: soft gradient background, light silhouette (head + shoulders), seeded hue
function avatar(seed) {
  var c = canvas(240, 320), hue = (seed * 47) % 360;
  var bgA = hsl(hue, 0.45, 0.32), bgB = hsl((hue + 40) % 360, 0.5, 0.18), fg = hsl((hue + 180) % 360, 0.25, 0.82);
  c.fill(function (x, y) {
    var t = y / 320;
    var col = [0, 1, 2].map(function (i) { return Math.round(bgA[i] * (1 - t) + bgB[i] * t); });
    var dx = x - 120, dy = y - 118;
    if (dx * dx + dy * dy < 52 * 52) return fg; // head
    var sx = (x - 120) / 105, sy = (y - 330) / 140;
    if (y > 185 && sx * sx + sy * sy < 1) return fg; // shoulders
    return col;
  });
  return encode(c.w, c.h, c.px);
}

// scene / group / gallery: diagonal bands in two hues
function cover(seed, w, h) {
  var c = canvas(w, h), hue = (seed * 71) % 360;
  var a = hsl(hue, 0.55, 0.45), b = hsl((hue + 150) % 360, 0.45, 0.3), d = hsl((hue + 60) % 360, 0.5, 0.6);
  c.fill(function (x, y) {
    var v = Math.floor((x + y * 1.4) / (w / 5)) % 3;
    var cx = x - w * 0.7, cy = y - h * 0.4, r = Math.min(w, h) * 0.22;
    if (cx * cx + cy * cy < r * r) return d;
    return v === 0 ? a : v === 1 ? b : [Math.round((a[0] + b[0]) / 2), Math.round((a[1] + b[1]) / 2), Math.round((a[2] + b[2]) / 2)];
  });
  return encode(c.w, c.h, c.px);
}

module.exports = { avatar: avatar, cover: cover };

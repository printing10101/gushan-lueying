// 生成 build/icon.ico:深绿底 + 白色山峰。纯 Node 手工编码 PNG(内嵌于 ICO),零依赖。
// 用法: node scripts/make-icon.cjs
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 256; // electron-builder 要求 ICO 内至少 256x256

// 简单几何画布
const pixels = Array.from({ length: SIZE }, () => Array.from({ length: SIZE }, () => [0, 0, 0, 0]));
function fillCircle(cx, cy, r, [R, G, B]) {
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) pixels[y][x] = [R, G, B, 255];
  }
}
function fillTriangle(p1, p2, p3, color) {
  const inTriangle = (x, y) => {
    const sign = (a, b, p) => (a[0] - p[0]) * (b[1] - p[1]) - (b[0] - p[0]) * (a[1] - p[1]);
    const d1 = sign(p1, p2, [x, y]), d2 = sign(p2, p3, [x, y]), d3 = sign(p3, p1, [x, y]);
    const neg = d1 < 0 || d2 < 0 || d3 < 0, pos = d1 > 0 || d2 > 0 || d3 > 0;
    return !(neg && pos);
  };
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    if (inTriangle(x, y)) pixels[y][x] = color;
  }
}

const S = SIZE / 64; // 设计稿按 64 画,等比放大
fillCircle(32 * S, 32 * S, 30 * S, [30, 58, 47]);          // 深绿圆底
fillCircle(44 * S, 18 * S, 6 * S, [240, 198, 116]);        // 太阳
fillTriangle([14 * S, 48 * S], [30 * S, 18 * S], [46 * S, 48 * S], [235, 235, 230]); // 主峰
fillTriangle([34 * S, 48 * S], [46 * S, 28 * S], [56 * S, 48 * S], [180, 186, 182]); // 次峰

// 编码 PNG
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}
const CRC_TABLE = (() => {
  const t = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return c ^ 0xffffffff;
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0); ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; ihdr[9] = 6; // 8bit RGBA
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
pixels.forEach((row, y) => {
  raw[y * (SIZE * 4 + 1)] = 0; // filter none
  row.forEach(([r, g, b, a], x) => {
    const o = y * (SIZE * 4 + 1) + 1 + x * 4;
    raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
  });
});
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0)),
]);

// 包装成 ICO(单条 PNG 入口,Vista+ 支持)
const entry = Buffer.alloc(16);
entry[0] = SIZE === 256 ? 0 : SIZE; // ICO 规范:256 用 0 表示
entry[2] = 1; entry[4] = 1; entry[6] = 32;
entry.writeUInt32LE(png.length, 8); entry.writeUInt32LE(22, 12);
// ICONDIR:保留位 0、类型 1(图标)、条目数 1
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(1, 4);

const out = path.join(__dirname, '..', 'build', 'icon.ico');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, Buffer.concat([header, entry, png]));
console.log(`icon written: ${out}`);

// 生成 build/icon.ico:「夜山」主题 —— 深夜蓝天幕 + 金月孤峰 + 山脚帐篷足迹。
// 配色取自 src/style.css 的夜色系(--blue-deep/--glacier/--gold),替换旧版与 UI 脱节的深绿底。
// 纯 Node 手工编码 PNG,零依赖;64 网格 × 16 倍超采样做抗锯齿,
// ICO 内嵌 16~256 七档 PNG(桌面小尺寸图标不再由 256 硬缩放发糊)。
// 用法: node scripts/make-icon.cjs
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const GRID = 64;      // 设计稿坐标系 64×64,所有几何量都是网格单位
const SS = 16;        // 超采样倍率 → 母版 1024×1024
const M = GRID * SS;
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const hx = (s) => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
const solid = (hex, a = 255) => {
  const [r, g, b] = hx(hex);
  return () => [r, g, b, a];
};
// 沿 t=0..1 的多段渐变,stops: [[t, '#hex', alpha], ...](t 递增)
const ramp = (stops) => {
  const parsed = stops.map(([t, hex, a = 255]) => [t, ...hx(hex), a]);
  return (t) => {
    if (t <= parsed[0][0]) return parsed[0].slice(1);
    for (let i = 1; i < parsed.length; i++) {
      if (t <= parsed[i][0]) {
        const [t0, r0, g0, b0, a0] = parsed[i - 1], [t1, r1, g1, b1, a1] = parsed[i];
        const k = (t - t0) / (t1 - t0);
        return [r0 + (r1 - r0) * k, g0 + (g1 - g0) * k, b0 + (b1 - b0) * k, a0 + (a1 - a0) * k];
      }
    }
    return parsed[parsed.length - 1].slice(1);
  };
};

// ---- 画布(直通 alpha 的浮点 RGBA)与 source-over 混合 ----
const px = new Float32Array(M * M * 4);
function blend(mx, my, r, g, b, a) {
  const sa = a / 255;
  if (sa <= 0) return;
  const i = (my * M + mx) * 4;
  const da = px[i + 3] / 255;
  const oa = sa + da * (1 - sa);
  px[i] = (r * sa + px[i] * da * (1 - sa)) / oa;
  px[i + 1] = (g * sa + px[i + 1] * da * (1 - sa)) / oa;
  px[i + 2] = (b * sa + px[i + 2] * da * (1 - sa)) / oa;
  px[i + 3] = oa * 255;
}

// ---- SDF(网格单位,负值在内部)与填充 ----
const sdCircle = (cx, cy, r) => (x, y) => Math.hypot(x - cx, y - cy) - r;
const sdEllipse = (cx, cy, rx, ry) => (x, y) =>
  (Math.hypot((x - cx) / rx, (y - cy) / ry) - 1) * Math.min(rx, ry);
function sdRoundRect(x0, y0, x1, y1, rad) {
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, hx2 = (x1 - x0) / 2, hy2 = (y1 - y0) / 2;
  return (x, y) => {
    const qx = Math.abs(x - cx) - (hx2 - rad), qy = Math.abs(y - cy) - (hy2 - rad);
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - rad;
  };
}
function sdTriangle([ax, ay], [bx, by], [cx, cy]) {
  const segDist = (px0, py0, px1, py1) => (x, y) => {
    const abx = px1 - px0, aby = py1 - py0;
    const t = clamp(((x - px0) * abx + (y - py0) * aby) / (abx * abx + aby * aby), 0, 1);
    return Math.hypot(x - (px0 + abx * t), y - (py0 + aby * t));
  };
  const s = [segDist(ax, ay, bx, by), segDist(bx, by, cx, cy), segDist(cx, cy, ax, ay)];
  return (x, y) => {
    const cross = (x0, y0, x1, y1) => (x1 - x0) * (y - y0) - (y1 - y0) * (x - x0);
    const c = [cross(ax, ay, bx, by), cross(bx, by, cx, cy), cross(cx, cy, ax, ay)];
    const inside = c.every((v) => v >= 0) || c.every((v) => v <= 0);
    const d = Math.min(s[0](x, y), s[1](x, y), s[2](x, y));
    return inside ? -d : d;
  };
}
const strokeOf = (sdf, w) => (x, y) => Math.abs(sdf(x, y)) - w / 2;

// 在网格 bbox 内逐超采样像素填充;colorFn(网格x, 网格y) → [r,g,b,a]
function fill(sdf, x0, y0, x1, y1, colorFn) {
  const X0 = Math.max(0, Math.floor(x0 * SS)), X1 = Math.min(M, Math.ceil(x1 * SS));
  const Y0 = Math.max(0, Math.floor(y0 * SS)), Y1 = Math.min(M, Math.ceil(y1 * SS));
  for (let my = Y0; my < Y1; my++) for (let mx = X0; mx < X1; mx++) {
    const gx = (mx + 0.5) / SS, gy = (my + 0.5) / SS;
    const cov = clamp(0.5 - sdf(gx, gy) * SS, 0, 1);
    if (cov <= 0) continue;
    const [r, g, b, a] = colorFn(gx, gy);
    blend(mx, my, r, g, b, a * cov);
  }
}

// ---- 构图(自底向上按画家算法叠加) ----
const frame = sdRoundRect(0, 0, 64, 64, 13);
function render() {
  // 夜空:对角渐变,呼应 UI 背景 #0a1526 的深夜蓝
  const sky = ramp([[0, '#20477a'], [0.5, '#0e2140'], [1, '#071022']]);
  fill(frame, 0, 0, 64, 64, (x, y) => sky((0.35 * x + 0.65 * y) / 64));

  // 星子:小而克制,避开月亮与主峰
  for (const [sx, sy, sr, sa] of [
    [10, 9, 0.8, 230], [17, 16, 0.5, 140], [28, 7, 0.6, 180], [36, 13, 0.45, 130],
    [11, 19, 0.45, 130], [53, 25, 0.5, 130], [8, 32, 0.45, 110],
  ]) fill(sdCircle(sx, sy, sr), sx - 2, sy - 2, sx + 2, sy + 2, solid('#cfe2f4', sa));

  // 金月:月晕先铺,月亮主体后压
  fill(sdCircle(46, 15.5, 11.5), 34, 3, 58, 27, (x, y) => {
    const d = Math.hypot(x - 46, y - 15.5);
    const k = clamp(1 - (d - 5.2) / 6.3, 0, 1);
    return [232, 197, 122, 92 * Math.pow(k, 1.5)];
  });
  fill(sdCircle(46, 15.5, 5.2), 40, 9, 52, 21, (x, y) => {
    const k = clamp(1 - Math.hypot(x - 44.2, y - 13.6) / 9, 0, 1); // 左上微亮,做出球面感
    return [240 + 12 * k, 211 + 16 * k, 148 + 30 * k, 255];
  });

  // 远峰(右,偏蓝灰)+ 雪帽,衬出孤峰的「孤」
  fill(sdTriangle([33, 49.5], [45.5, 27], [58, 49.5]), 31, 25, 60, 51, solid('#3a5f8e'));
  fill(sdTriangle([43, 31.5], [45.5, 27], [48, 31.5]), 41, 25, 50, 33, solid('#dfe9f4'));
  fill(sdTriangle([45.5, 27], [48, 31.5], [45.5, 31.5]), 44, 25, 50, 33, solid('#b9d0e8'));

  // 主峰:亮面雪白,右侧面压冰川蓝(--glacier),一明一暗出体积
  const mainPeak = sdTriangle([23, 12.5], [3.5, 49.5], [42.5, 49.5]);
  fill(mainPeak, 1.5, 10, 44.5, 51, solid('#eef4fb'));
  fill(sdTriangle([23, 12.5], [42.5, 49.5], [27, 49.5]), 21, 10, 44.5, 51, solid('#a9cce3'));

  // 山腰雾带:三团扁椭圆,把两座峰底融进夜色
  for (const [cx2, cy2, rx, ry, a] of [[32, 50, 30, 4.8, 66], [11, 50.5, 13, 3.2, 26], [39, 51.5, 16, 3.6, 52]]) {
    fill(sdEllipse(cx2, cy2, rx, ry), cx2 - rx - 2, cy2 - ry - 2, cx2 + rx + 2, cy2 + ry + 2, (x, y) => {
      const d = sdEllipse(cx2, cy2, rx, ry)(x, y);
      const k = clamp(0.5 - d * SS, 0, 1); // 边缘再羽化一层,雾才不生硬
      return [157, 192, 226, a * k];
    });
  }

  // 底部渐暗:把帐篷和足迹从背景里衬出来
  fill((x, y) => y - 49, 0, 48, 64, 64, (x, y) => [4, 10, 20, 100 * clamp((y - 49) / 15, 0, 1)]);

  // 足迹:从帐篷蜿蜒向主峰,讲「人往山里去」
  for (const [tx, ty, tr, ta] of [
    [16.5, 57.8, 0.62, 140], [18.6, 55.6, 0.58, 128], [21, 53.6, 0.55, 115],
    [23.6, 51.7, 0.5, 102], [25.8, 50.2, 0.46, 90],
  ]) fill(sdCircle(tx, ty, tr), tx - 2, ty - 2, tx + 2, ty + 2, solid('#cfe2f4', ta));

  // 帐篷:金色(--gold)小三角,右侧面用 --gold-dim 压暗,夜间暖光源
  fill(sdEllipse(14.5, 60.7, 6.5, 1.1), 6, 58, 23, 63, solid('#02060c', 90));
  fill(sdTriangle([9.8, 60.5], [14.5, 52.8], [19.2, 60.5]), 7.8, 50.8, 21.2, 62.5, solid('#e3b96f'));
  fill(sdTriangle([14.5, 52.8], [19.2, 60.5], [14.5, 60.5]), 13, 50.8, 21.2, 62.5, solid('#c79b54'));
  fill(sdTriangle([13.2, 60.5], [14.5, 57], [15.8, 60.5]), 11.2, 55, 17.8, 62.5, solid('#0b1626'));

  // 玻璃描边:上亮下沉,呼应 UI 的 --glass-border 质感
  fill(strokeOf(frame, 1.0), 0, 0, 64, 64, (x, y) => [214, 232, 250, 12 + 40 * clamp(1 - y / 40, 0, 1)]);

  // 收边:整体裁回圆角方框,防任何图层溢出
  for (let my = 0; my < M; my++) for (let mx = 0; mx < M; mx++) {
    const cov = clamp(0.5 - frame((mx + 0.5) / SS, (my + 0.5) / SS) * SS, 0, 1);
    px[(my * M + mx) * 4 + 3] *= cov;
  }
}

// ---- 面积加权重采样(预乘 alpha 累加,避免半透明边缘渗色) ----
function resample(N) {
  const out = Buffer.alloc(N * N * 4);
  const scale = M / N;
  for (let ty = 0; ty < N; ty++) for (let tx = 0; tx < N; tx++) {
    const x0 = tx * scale, x1 = (tx + 1) * scale, y0 = ty * scale, y1 = (ty + 1) * scale;
    let sr = 0, sg = 0, sb = 0, sa = 0;
    for (let my = Math.floor(y0); my < y1; my++) for (let mx = Math.floor(x0); mx < x1; mx++) {
      const w = (Math.min(x1, mx + 1) - Math.max(x0, mx)) * (Math.min(y1, my + 1) - Math.max(y0, my));
      if (w <= 0) continue;
      const i = (my * M + mx) * 4, a = px[i + 3] / 255;
      sr += px[i] * a * w; sg += px[i + 1] * a * w; sb += px[i + 2] * a * w; sa += a * w;
    }
    const o = (ty * N + tx) * 4;
    out[o + 3] = Math.round(clamp(sa / (scale * scale), 0, 1) * 255);
    const k = sa > 0 ? 1 / sa : 0;
    out[o] = Math.round(clamp(sr * k, 0, 255));
    out[o + 1] = Math.round(clamp(sg * k, 0, 255));
    out[o + 2] = Math.round(clamp(sb * k, 0, 255));
  }
  return out;
}

// ---- PNG / ICO 编码 ----
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
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}
function encodePNG(rgba, N) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8bit RGBA
  const raw = Buffer.alloc(N * (N * 4 + 1));
  for (let y = 0; y < N; y++) {
    raw[y * (N * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (N * 4 + 1) + 1, y * N * 4, (y + 1) * N * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

function buildICO() {
  const pngs = ICO_SIZES.map((n) => encodePNG(resample(n), n));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2); header.writeUInt16LE(pngs.length, 4);
  const entries = [];
  let offset = 6 + 16 * pngs.length;
  pngs.forEach((png, i) => {
    const n = ICO_SIZES[i];
    const e = Buffer.alloc(16);
    e[0] = n === 256 ? 0 : n; e[1] = n === 256 ? 0 : n; // ICO 规范:256 用 0 表示
    e[2] = 0; e[3] = 0; e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
    e.writeUInt32LE(png.length, 8); e.writeUInt32LE(offset, 12);
    entries.push(e); offset += png.length;
  });
  return Buffer.concat([header, ...entries, ...pngs]);
}

// ---- 预览输出(临时目录,自查用) ----
function writePreviews() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gushan-icon-'));
  const on = (bg) => (rgba, N) => {
    const out = Buffer.from(rgba);
    for (let i = 0; i < N * N; i++) {
      const a = out[i * 4 + 3] / 255, o = i * 4;
      for (let c = 0; c < 3; c++) out[o + c] = Math.round(out[o + c] * a + bg[c] * (1 - a));
      out[o + 3] = 255;
    }
    return out;
  };
  const white = on([245, 245, 245]), dark = on([32, 32, 32]);
  fs.writeFileSync(path.join(dir, 'icon-256-white.png'), encodePNG(white(resample(256), 256), 256));
  fs.writeFileSync(path.join(dir, 'icon-256-dark.png'), encodePNG(dark(resample(256), 256), 256));
  for (const n of [48, 32, 16]) {
    fs.writeFileSync(path.join(dir, `icon-${n}.png`), encodePNG(white(resample(n), n), n));
  }
  return dir;
}

render();
const out = path.join(__dirname, '..', 'build', 'icon.ico');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, buildICO());
console.log(`icon written: ${out}`);
console.log(`previews: ${writePreviews()}`);

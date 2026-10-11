// GPX 双向:①解析外部轨迹 + 「实测值 vs 标称值」合并判定;②把生成的行程导成 GPX 带走。
// 纯函数,不碰文件系统,主进程/脚本/单测共用。
//
// 为什么需要:trails.json 的 distanceKm/climbM/maxAltM 没有 source 字段,是从攻略与文档抄来的。
// 两步路/六只脚/Strava 上大量线路有现成 GPX,导一次就能把这三个数从"抄来的"变成"量过的"。
// 这也是条目 4(区域真实里程字段化)的上游口径。
//
// 三条口径:
// 1) 距离按相邻点累加;两端都有高程时走 3D(坡面上 2D 会系统性低估),否则退化 2D。
// 2) 爬升与最高海拔**只在所有点都带高程时**才给。缺高程还报一个爬升数,等于报一个必然偏小的
//    假完整值——同 lib/grading.js 的 usable:false:明说不知道,不猜方向。
// 3) 合并时与标称值差超过 GPX_REVIEW_PCT 的不写盘,进 review 等人判。
//    抄来的数也可能是对的,GPX 也可能是错的(飘点、截段、环形绕行),谁覆盖谁不能由阈值以下的小
//    差异决定;差得多的恰恰是最需要人看一眼的。

const GPX_REVIEW_PCT = 10; // 与标称值差超过这个百分比 → 进 review,不静默覆盖
const EARTH_R_KM = 6371; // 与 scripts/verify-amap-routes.mjs 同一口径
const METRICS = ['distanceKm', 'climbM', 'maxAltM'];

function haversineKm(a, b) {
  const rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

function attr(attrs, name) {
  const m = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"|\\b${name}\\s*=\\s*'([^']*)'`, 'i').exec(attrs);
  return m ? (m[1] ?? m[2]) : undefined;
}

function num(v) {
  return typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null;
}

// → { ok, error?, distanceKm, climbM, maxAltM, points, eleGaps, skipped }
function parseGpx(text) {
  const empty = { distanceKm: null, climbM: null, maxAltM: null, points: 0, eleGaps: 0, skipped: 0 };
  if (typeof text !== 'string' || !text.trim()) {
    return { ok: false, error: '空内容,不是 GPX', ...empty };
  }
  const pts = [];
  let skipped = 0;
  const openRe = /<(trkpt|rtept)\b([^>]*)>/gi;
  let m;
  while ((m = openRe.exec(text))) {
    const tag = m[1];
    const attrs = m[2];
    const selfClosed = /\/\s*$/.test(attrs.trim());
    let body = '';
    if (!selfClosed) {
      const close = text.indexOf(`</${tag}>`, openRe.lastIndex);
      if (close >= 0) {
        body = text.slice(openRe.lastIndex, close);
        openRe.lastIndex = close + tag.length + 3; // 跳过整段,嵌套同名标签不会重复计数
      }
    }
    const lat = num(attr(attrs, 'lat'));
    const lon = num(attr(attrs, 'lon'));
    if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) { skipped += 1; continue; }
    const eleMatch = /<ele\b[^>]*>([^<]*)<\/ele>/i.exec(body);
    const ele = eleMatch ? num(eleMatch[1]) : null;
    pts.push({ lat, lon, ele });
  }
  if (pts.length < 2) {
    return { ok: false, error: `有效轨迹点不足 2 个(抓到 ${pts.length},丢弃 ${skipped})`,
      ...empty, skipped };
  }
  let km = 0;
  let eleGaps = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const flat = haversineKm(a, b);
    if (a.ele === null || b.ele === null) {
      eleGaps += 1;
      km += flat; // 缺高程就退化成 2D:这一段的坡面距离算不出,不猜
    } else {
      km += Math.sqrt(flat * flat + ((b.ele - a.ele) / 1000) ** 2);
    }
  }
  const fullEle = eleGaps === 0; // 爬升/最高海拔要求逐点齐高程
  let climb = 0;
  // 最高海拔用循环取,不能写 Math.max(...pts.map(...)):spread 会把每个点压进调用栈,
  // 实测 20 万点直接 RangeError: Maximum call stack size exceeded,而主进程允许导入
  // 20MB 的 GPX(带高程的 trkpt 约 62 字节/点 ≈ 30 万点)——崩在自设的允许范围内。
  let maxAlt = null;
  if (fullEle) {
    for (let i = 0; i + 1 < pts.length; i++) climb += Math.max(0, pts[i + 1].ele - pts[i].ele);
    maxAlt = pts[0].ele;
    for (let i = 1; i < pts.length; i++) if (pts[i].ele > maxAlt) maxAlt = pts[i].ele;
  }
  return {
    ok: true,
    distanceKm: Math.round(km * 1000) / 1000,
    climbM: fullEle ? Math.round(climb) : null,
    maxAltM: fullEle ? Math.round(maxAlt) : null,
    points: pts.length,
    eleGaps,
    skipped,
  };
}

// → { apply, review, rejected, appliedReason }
// apply: 可写入 trails.json 的字段;review: 差太多要人判;rejected: 提供了但非法。
// 字段在 measured 里根本不存在(undefined) → 三处都不进:没测过就是没测过,不制造记录。
function mergeMeasured(trail, measured) {
  const apply = {};
  const appliedReason = {};
  const review = [];
  const rejected = [];
  for (const field of METRICS) {
    const v = measured ? measured[field] : undefined;
    if (v === undefined) continue;
    if (v === null || !Number.isFinite(v) || v < 0) { rejected.push({ field, reason: 'no-measurement' }); continue; }
    const planned = trail ? trail[field] : undefined;
    if (!Number.isFinite(planned) || planned <= 0) {
      apply[field] = v;
      appliedReason[field] = 'no-baseline'; // 补空字段,不是纠字段——来源要分开说
      continue;
    }
    const diffPct = ((v - planned) / planned) * 100;
    if (Math.abs(diffPct) > GPX_REVIEW_PCT) {
      review.push({ field, planned, measured: v, diffPct: Math.round(diffPct) });
      continue;
    }
    apply[field] = v;
    appliedReason[field] = 'within-threshold';
  }
  return { apply, appliedReason, review, rejected };
}

// ---- 反方向:行程 → GPX ----
//
// 为什么需要:`lib/gear.js` 给多日线开的清单里写着「离线轨迹/GPS 轨迹:山区无手机信号,
// 导航不能依赖网络」,可应用此前只能导 Markdown——清单让带的东西,软件自己给不出来。
//
// 三条口径(与 parseGpx 同一套纪律:有什么写什么,不冒充):
// 1) 驾车段有高德的 polyline 就写真实轨迹点;没有(未配 Key 时 path 为空)就用环线相邻节点
//    连两点,并在该条轨迹的 <desc> 明说「节点直线骨架,非真实路线」——直线能当方向参考,
//    但不能冒充实测轨迹。
// 2) 徒步段我们没有轨迹数据,只放线路起点这一个路点。**不编一条"看起来像"的徒步轨迹。**
// 3) 坐标缺值/非法的点直接丢,不写成 NaN(导进手表会得到一个跳点的轨迹)。

function xmlEsc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]
  ));
}

// 高德 polyline("lng,lat;lng,lat;…")→ [{lat,lon}],坏点丢弃(与渲染层 polylineToPath 同口径)
function polylinePoints(str) {
  return String(str || '').split(';')
    .map((p) => p.split(',').map(Number))
    .filter((p) => p.length === 2 && p.every(Number.isFinite)
      && Math.abs(p[1]) <= 90 && Math.abs(p[0]) <= 180)
    .map((p) => ({ lat: p[1], lon: p[0] }));
}

function nodePoint(region, name) {
  const n = (region?.loop || []).find((x) => x.name === name);
  if (!n || !Number.isFinite(Number(n.lng)) || !Number.isFinite(Number(n.lat))) return null;
  return { lat: Number(n.lat), lon: Number(n.lng) };
}

function tripToGpx(trip, region) {
  const body = [];
  let realLegs = 0;
  let skeletonLegs = 0;

  for (const day of trip?.schedule || []) {
    if (day.type !== 'drive') continue;
    const segs = [];
    let dayReal = 0;
    let daySkeleton = 0;
    for (const leg of day.legs || []) {
      const pts = polylinePoints(leg.path);
      if (pts.length >= 2) {
        dayReal += 1;
        segs.push(`        ${pts.map((p) => `<trkpt lat="${p.lat}" lon="${p.lon}"/>`).join('')}`);
        continue;
      }
      // 没有 polyline:退化成节点直线,并记进 desc 让导入方知道这是什么
      const from = nodePoint(region, leg.from);
      const to = nodePoint(region, leg.to);
      if (!from || !to) continue; // 两端都定不了位就整段不写,别画到 (0,0) 去
      daySkeleton += 1;
      segs.push(`        <trkpt lat="${from.lat}" lon="${from.lon}"/><trkpt lat="${to.lat}" lon="${to.lon}"/>`);
    }
    if (!segs.length) continue;
    realLegs += dayReal;
    skeletonLegs += daySkeleton;
    body.push('      <trk>');
    body.push(`        <name>${xmlEsc(`${day.date} 自驾 ${legName(day)}`)}</name>`);
    body.push(`        <desc>${xmlEsc(driveDayDesc(day, dayReal + daySkeleton, dayReal, daySkeleton))}</desc>`);
    body.push(`        <trkseg>\n${segs.join('\n')}\n        </trkseg>`);
    body.push('      </trk>');
  }

  const trail = trip?.trail;
  const start = trail?.start && Number.isFinite(Number(trail.start.lng))
    && Number.isFinite(Number(trail.start.lat))
    ? { lat: Number(trail.start.lat), lon: Number(trail.start.lng) } : null;
  if (start) {
    body.push('      <wpt '
      + `lat="${start.lat}" lon="${start.lon}">`
      + `<name>${xmlEsc(`徒步起点 ${trail.name}`)}</name>`
      + `<desc>${xmlEsc(`★${trail.grade ?? '?'} · ${trail.days ?? '?'} 天 · 应用内无该段轨迹数据`)}</desc>`
      + '</wpt>');
  }

  const meta = [
    `      <name>${xmlEsc(`${trip?.regionName || '行程'} ${trip?.input?.days || '?'} 天`)}</name>`,
    `      <desc>${xmlEsc(gpxSummary(trip, realLegs, skeletonLegs))}</desc>`,
    `      <author><name>${xmlEsc('孤山掠影')}</name></author>`,
  ].join('\n');

  return ['<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="孤山掠影" xmlns="http://www.topografix.com/GPX/1/1">',
    '    <metadata>', meta, '    </metadata>',
    ...body,
    '</gpx>', ''].join('\n');
}

// 轨迹名:把当天各段起终点拼成 "北京→斋堂→涿鹿"
function legName(day) {
  const legs = day.legs || [];
  if (!legs.length) return day.date || '';
  return `${legs[0].from}→${legs.map((l) => l.to).join('→')}`;
}

function driveDayDesc(day, segCount, realLegs, skeletonLegs) {
  const parts = [`逐日行程 ${day.date}`, `${segCount} 段`];
  if (day.legs?.some((l) => l.estimated)) parts.push('里程为直线×1.3 估算');
  if (realLegs === 0) parts.push('本轨迹为节点直线骨架,非真实路线');
  else if (skeletonLegs > 0) parts.push('含节点直线骨架段,非真实路线');
  return parts.join(' · ');
}

// 汇总口径写进 metadata:导入方(两步路/手表)第一眼就该知道这份 GPX 有多可信。
// "未配 Key"这句只在行程本身标了 distanceEstimated 时说——有 Key 但某段没 polyline
// 是另一种情况(高德没返回 steps),不能把前者写成后者。
function gpxSummary(trip, realLegs, skeletonLegs) {
  const base = `${trip?.regionName || ''} · ${trip?.input?.days || '?'} 天 · 出发 ${trip?.input?.startDate || '?'}`
    + ` · 生成 ${String(trip?.generatedAt || '').slice(0, 10)}`;
  const noReal = trip?.distanceEstimated
    ? '未配高德 Key,全部为节点直线骨架(仅作方向参考,不能当路书用)'
    : '无真实路线数据,全部为节点直线骨架(仅作方向参考,不能当路书用)';
  if (realLegs && !skeletonLegs) return `${base};驾车轨迹来自高德真实路线`;
  if (realLegs) return `${base};${skeletonLegs} 段无真实路线,用节点直线补齐`;
  return `${base};${noReal}`;
}

// polylinePoints 一并导出:lib/map-impl.js 的 parsePathString 做的是同一件事,
// 两份实现会漂移(实测:那份不做经纬度范围校验,越界点会照收)。导出后可以用交叉断言钉住。
const api_gpx = { parseGpx, mergeMeasured, tripToGpx, GPX_REVIEW_PCT, METRICS, haversineKm, polylinePoints };
if (typeof module !== 'undefined') module.exports = api_gpx;
else (window.GushanLib = window.GushanLib || {}).gpx = api_gpx;

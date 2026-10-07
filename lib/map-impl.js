// 地图实现层:高德 与 腾讯 GL 两套 SDK,对外只给同一组动作,app.js 不直接碰任何一家的 API。
//
// 为什么要有这一层:两家的地图 API 名字与语义都不同(AMap.Map / TMap.Map、
// AMap.Polyline / TMap.MultiPolyline、setFitView / fitBounds),混在 app.js 里会变成
// 一层 if-else 林;而"画什么"其实是同一件事。分开之后,新增第三家只要实现同一组方法。
//
// 事实与限制(2026-10-08 实测,不是文档推断):
// - 腾讯 GL 官方"不再支持 file://",但 http://127.0.0.1 来源**无需白名单即可用**
//   (探针 test/gl-probe.cjs:`scriptLoaded:true, mapOk:true`,用同一把 Key)。
// - 因为腾讯拒绝 file://,腾讯地图只在 `GUSHAN_SERVE=1`(本地 http 来源)下启用;
//   仍是 file:// 时自动回退,不会白屏(GUSHAN_SERVE 那条路径见 electron/main.js)。
// - 腾讯底图是默认矢量样式,没有夜色主题(个性化样式要在控制台建),与高德那条 darkblue
//   的观感不同——这是已知差异,不拿 CSS 滤镜假装一致。
//
// 渲染进程共享作用域:导出名文件级唯一(api_mapimpl),尾部双端导出,app.js 加前缀解构。

const TENCENT_CENTER = { lng: 116.407, lat: 39.904 }; // 兜底中心(没有坐标可用时)

// "lng,lat;lng,lat;…"(高德 polyline / 我们自己导出的 GPX 都是这形状)→ [[lng,lat],…],坏点丢弃
function parsePathString(str) {
  return String(str || '').split(';')
    .map((p) => p.split(',').map(Number))
    .filter((p) => p.length === 2 && p.every(Number.isFinite));
}

function pointsOf(region) {
  return (region?.loop || [])
    .map((n) => [Number(n.lng), Number(n.lat)])
    .filter((p) => p.every(Number.isFinite));
}

// 环线节点名 → 坐标,画直线骨架时用(没有真实路线可画时的兜底)
function nodeXY(region, name) {
  const n = (region?.loop || []).find((x) => x.name === name);
  return n && Number.isFinite(Number(n.lng)) && Number.isFinite(Number(n.lat))
    ? [Number(n.lng), Number(n.lat)] : null;
}

// 逐日行程要画的线段:优先真实路线,没有就退回节点直线
function tripSegments(trip, region) {
  const segs = [];
  for (const day of trip?.schedule || []) {
    if (day.type !== 'drive') continue;
    for (const leg of day.legs || []) {
      const real = parsePathString(leg.path);
      if (real.length > 1) { segs.push({ path: real, real: true }); continue; }
      const a = nodeXY(region, leg.from);
      const b = nodeXY(region, leg.to);
      if (a && b) segs.push({ path: [a, b], real: false });
    }
  }
  return segs;
}

function centerOf(region) {
  const pts = pointsOf(region);
  if (!pts.length) return TENCENT_CENTER;
  return { lng: pts[0][0], lat: pts[0][1] };
}

// 高德:2021-12-02 之后申请的 Key 必须配安全密钥,且**必须在脚本加载前**挂到 window 上
// (不挂的后果是高德内部报 INVALID_USER_SCODE,页面只表现为地图空白)。
// 不配不算错:旧 Key 不需要它。node 下没有 window,返回 false 而不是抛错——这样单测能直接调它。
function applyAmapSecurityCode(code) {
  if (!code) return false;
  if (typeof window === 'undefined') return false;
  window._AMapSecurityConfig = { securityJsCode: String(code) };
  return true;
}

// ---------------- 高德 ----------------
const amapImpl = {
  name: 'amap',
  label: '高德',
  supportsFileOrigin: true, // 高德在有 Key 的前提下 file:// 可用(既有行为,未变)
  load(key, opts = {}) {
    applyAmapSecurityCode(opts.securityCode);
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = `https://webapi.amap.com/maps?v=2.0&key=${key}`;
      s.onload = resolve;
      s.onerror = () => reject(new Error('高德 JS API 加载失败'));
      document.head.append(s);
    });
  },
  make(el, { center, zoom = 8 }) {
    return { sdk: 'amap', map: new AMap.Map(el, { zoom, center: [center.lng, center.lat], mapStyle: 'amap://styles/darkblue' }), overlays: [] };
  },
  clear(h) {
    if (h?.overlays?.length) h.map.remove(h.overlays);
    h.overlays = [];
  },
  drawRegion(h, region) {
    this.clear(h);
    const path = pointsOf(region);
    if (!path.length) return;
    h.overlays.push(new AMap.Polyline({ path, strokeColor: '#7fb0f2', strokeWeight: 3, strokeOpacity: 0.9 }));
    for (const n of region.loop) {
      if (!Number.isFinite(Number(n.lng))) continue;
      h.overlays.push(new AMap.Marker({
        position: [Number(n.lng), Number(n.lat)], label: { content: n.name, direction: 'top' },
      }));
    }
    h.map.add(h.overlays);
    h.map.setFitView(h.overlays);
  },
  drawTrip(h, trip, region) {
    this.clear(h);
    for (const seg of tripSegments(trip, region)) {
      h.overlays.push(new AMap.Polyline({ path: seg.path, strokeColor: '#e8a54b', strokeWeight: 5, strokeOpacity: 0.85 }));
    }
    if (trip?.trail?.start && Number.isFinite(Number(trip.trail.start.lng))) {
      h.overlays.push(new AMap.Marker({
        position: [Number(trip.trail.start.lng), Number(trip.trail.start.lat)],
        label: { content: `⛰ ${trip.trail.name}`, direction: 'top' },
      }));
    }
    if (h.overlays.length) { h.map.add(h.overlays); h.map.setFitView(h.overlays); }
  },
};

// ---------------- 腾讯 GL ----------------
const tencentImpl = {
  name: 'tencent',
  label: '腾讯',
  supportsFileOrigin: false, // 官方原文:不再支持 file://;必须在 http(s) 来源下用
  load(key) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = `https://map.qq.com/api/gljs?v=1.exp&key=${key}`;
      s.onload = resolve;
      s.onerror = () => reject(new Error('腾讯 GL JS API 加载失败'));
      document.head.append(s);
    });
  },
  make(el, { center, zoom = 8 }) {
    const map = new TMap.Map(el, { center: new TMap.LatLng(center.lat, center.lng), zoom });
    return { sdk: 'tencent', map, overlays: [] };
  },
  clear(h) {
    // Multi* 图层用 setMap(null) 摘掉;TMap 没有高德那种"一次删一组"的接口
    for (const o of h?.overlays || []) {
      if (o && typeof o.setMap === 'function') o.setMap(null);
    }
    h.overlays = [];
  },
  drawRegion(h, region) {
    this.clear(h);
    const pts = pointsOf(region);
    if (!pts.length) return;
    const poly = new TMap.MultiPolyline({
      map: h.map,
      styles: { ring: new TMap.PolylineStyle({ color: '#7fb0f2', width: 3, borderWidth: 0 }) },
      geometries: [{ id: 'ring', styleId: 'ring', paths: pts.map(([lng, lat]) => new TMap.LatLng(lat, lng)) }],
    });
    const markers = new TMap.MultiMarker({
      map: h.map,
      styles: {
        node: new TMap.MarkerStyle({
          width: 14, height: 22, anchor: { x: 7, y: 22 },
          label: { color: '#dce8f7', fontSize: 12, anchor: { x: 0, y: -24 } },
        }),
      },
      geometries: (region.loop || []).filter((n) => Number.isFinite(Number(n.lng))).map((n) => ({
        id: `n-${n.name}`, styleId: 'node', position: new TMap.LatLng(Number(n.lat), Number(n.lng)),
        properties: { title: n.name },
      })),
    });
    h.overlays.push(poly, markers);
    this.fit(h, pts);
  },
  drawTrip(h, trip, region) {
    this.clear(h);
    const segs = tripSegments(trip, region);
    if (segs.length) {
      h.overlays.push(new TMap.MultiPolyline({
        map: h.map,
        styles: { leg: new TMap.PolylineStyle({ color: '#e8a54b', width: 5, borderWidth: 0 }) },
        geometries: segs.map((s, i) => ({
          id: `leg-${i}`, styleId: 'leg', paths: s.path.map(([lng, lat]) => new TMap.LatLng(lat, lng)),
        })),
      }));
    }
    const start = trip?.trail?.start;
    if (start && Number.isFinite(Number(start.lng))) {
      h.overlays.push(new TMap.MultiMarker({
        map: h.map,
        styles: {
          trail: new TMap.MarkerStyle({
            width: 18, height: 28, anchor: { x: 9, y: 28 },
            label: { color: '#dce8f7', fontSize: 13, anchor: { x: 0, y: -30 } },
          }),
        },
        geometries: [{ id: 'trail', styleId: 'trail', position: new TMap.LatLng(Number(start.lat), Number(start.lng)),
          properties: { title: `⛰ ${trip.trail?.name || '徒步起点'}` } }],
      }));
    }
    const all = segs.flatMap((s) => s.path);
    if (all.length) this.fit(h, all);
  },
  fit(h, pts) {
    if (!pts.length) return;
    const lngs = pts.map((p) => p[0]);
    const lats = pts.map((p) => p[1]);
    h.map.fitBounds(new TMap.LatLngBounds(
      new TMap.LatLng(Math.min(...lats), Math.min(...lngs)),
      new TMap.LatLng(Math.max(...lats), Math.max(...lngs)),
    ), { padding: 40 });
  },
};

// 选哪家画地图:与路线来源同一套优先级,但**受来源限制**——
// 腾讯 GL 不接受 file://,所以 file:// 下即使有腾讯 Key 也不选它(否则白屏)。
// → { impl, key, reason } | null(没有可用组合)
function pickMapImpl(cfg = {}, opts = {}) {
  // 默认值必须自己算:node 里没有 location,写成默认参数会在调用时直接 ReferenceError
  const isFileOrigin = opts.isFileOrigin !== undefined
    ? opts.isFileOrigin
    : (typeof location !== 'undefined' && location.protocol === 'file:');
  if (cfg.amapKeyJs) return { impl: amapImpl, key: cfg.amapKeyJs, reason: '高德 JS Key 已配置' };
  if (cfg.tencentKeyJs || cfg.tencentKeyWeb) {
    if (!isFileOrigin) {
      return { impl: tencentImpl, key: cfg.tencentKeyJs || cfg.tencentKeyWeb, reason: '腾讯 Key 已配置且来源非 file://' };
    }
    return {
      impl: null, key: null, blocked: 'tencent',
      reason: '腾讯 GL 不支持 file:// 来源:用 `GUSHAN_SERVE=1 npm run app` 以 http://127.0.0.1 启动即可出图',
    };
  }
  return { impl: null, key: null, reason: '未配置地图 Key(amapKeyJs 或 tencentKeyJs)' };
}

const api_mapimpl = {
  amapImpl, tencentImpl, pickMapImpl, applyAmapSecurityCode,
  parsePathString, pointsOf, tripSegments, nodeXY, centerOf,
};
if (typeof module !== 'undefined') module.exports = api_mapimpl;
else (window.GushanLib = window.GushanLib || {}).mapImpl = api_mapimpl;

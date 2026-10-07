// 高德 Web 服务 API:驾车路径规划 + 油费过路费计算。Key 在 data/config.json 的 amapKeyWeb。
const store = require('./store');
const { httpFetch } = require('./http');
const cache = require('./route-cache');

const V5_DRIVING = 'https://restapi.amap.com/v5/direction/driving';

// 没配 Key 时的里程估算口径(山区经验系数)。这一对常量以前在
// `scripts/smoke-region.mjs` 与 `scripts/verify-amap-routes.mjs` 各手抄了一份,
// 现在收进 lib:估算值与"估算 vs 真实"的对比基准必须是同一个数,否则差距表在骗人。
const LOOP_FACTOR = 1.3; // 直线距离 × 系数 = 山路实际车程,系数只保证「不低估」
const AVG_KMH = 45; // 山区平均车速,估算时长用
const EARTH_R_KM = 6371;

function hasKey() {
  return Boolean(store.read('config')?.amapKeyWeb);
}

// 球面距离(km)。与 scripts/backfill-region.mjs 的判据同源。
function haversineKm(a, b) {
  const rad = (x) => (x * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2
    + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * EARTH_R_KM * Math.asin(Math.sqrt(h));
}

function requireKey() {
  const cfg = store.read('config');
  if (!cfg?.amapKeyWeb) {
    throw new Error('缺少高德 Key:请到 lbs.amap.com 注册并在 data/config.json 填入 amapKeyWeb(Web服务类型)');
  }
  return cfg;
}

// 会话级缓存走共用的 lib/route-cache.js(腾讯那边同一套纪律:in-flight 去重、失败不缓存、
// 坏坐标不进缓存)。实现只留一份,免得两个 provider 各自漂移。
async function drivingRoute(from, to) {
  const key = cache.routeCacheKey(from, to);
  return cache.cachedRoute(module.exports, key, () => fetchDrivingRoute(from, to));
}

function clearRouteCache() {
  cache.clear(module.exports);
}
// 没配 Key 时的替代口径:直线 × 1.3 估里程、按山区均速估时长,过路费给 null
// (让 calcCosts 走它既有的「按 0.45 元/km 估 + tollsEstimated 标记」分支,不在这里另发明一套)。
// 坐标非法照样抛错:估算不能替坏数据兜底,否则 regions.json 填错会静默变成一条假里程。
function estimatedRoute(from, to) {
  const ok = (p) => p && Number.isFinite(Number(p.lng)) && Number.isFinite(Number(p.lat));
  if (!ok(from) || !ok(to)) {
    throw new Error(`里程估算坐标非法: from=${JSON.stringify(from)} to=${JSON.stringify(to)}`);
  }
  const km = haversineKm(
    { lng: Number(from.lng), lat: Number(from.lat) },
    { lng: Number(to.lng), lat: Number(to.lat) },
  ) * LOOP_FACTOR;
  return {
    distanceKm: km,
    durationHours: km / AVG_KMH,
    tolls: null,
    path: '', // 没有真实路线可画
    estimated: true,
  };
}

async function fetchDrivingRoute(from, to) {
  const cfg = requireKey();
  const point = (p) => (p && Number.isFinite(Number(p.lng)) && Number.isFinite(Number(p.lat))
    ? `${p.lng},${p.lat}` : null);
  const origin = point(from);
  const destination = point(to);
  if (!origin || !destination) {
    // 坏坐标拼进 URL 只会白耗高德配额再被拒,提前响亮报错
    throw new Error(`高德路径规划坐标非法: from=${JSON.stringify(from)} to=${JSON.stringify(to)}`);
  }
  const url = `${V5_DRIVING}?key=${cfg.amapKeyWeb}` +
    `&origin=${origin}&destination=${destination}&show_fields=cost&alternative_route=0`;
  const res = await httpFetch(url);
  if (!res.ok) throw new Error(`高德路径规划失败: HTTP ${res.status}`);
  let json;
  try { json = await res.json(); } catch { throw new Error(`高德路径规划返回非 JSON(HTTP ${res.status})`); }
  if (json.status !== '1' || !json.route?.paths?.length) {
    throw new Error(`高德路径规划失败: ${json.info || JSON.stringify(json).slice(0, 120)}`);
  }
  const p = json.route.paths[0];
  const distanceKm = Number(p.distance) / 1000;
  const tolls = p.cost && p.cost.tolls !== undefined ? Number(p.cost.tolls) : null;
  return {
    distanceKm, durationHours: Number(p.duration) / 3600, tolls,
    estimated: false,
    path: p.steps?.map((s) => s.polyline).join(';') || '', // 供地图画线
  };
}

// 油费与过路费。过路费优先用高德返回值,缺失时按高速里程估(约 0.45 元/km)
function calcCosts(distanceKm, tollsFromApi, fuelCfg) {
  const fuel = Math.round((distanceKm / 100) * fuelCfg.consumptionLPer100km * fuelCfg.pricePerL);
  const tolls = tollsFromApi !== null && Number.isFinite(tollsFromApi)
    ? Math.round(tollsFromApi)
    : Math.round(distanceKm * 0.45);
  return {
    fuel,
    tolls,
    tollsEstimated: tollsFromApi === null || !Number.isFinite(tollsFromApi),
    driveTotal: fuel + tolls,
  };
}

module.exports = {
  drivingRoute, estimatedRoute, calcCosts, clearRouteCache, hasKey, haversineKm,
  LOOP_FACTOR, AVG_KMH,
};

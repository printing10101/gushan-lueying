// 高德 Web 服务 API:驾车路径规划 + 油费过路费计算。Key 在 data/config.json 的 amapKeyWeb。
const store = require('./store');
const { httpFetch } = require('./http');

const V5_DRIVING = 'https://restapi.amap.com/v5/direction/driving';

function requireKey() {
  const cfg = store.read('config');
  if (!cfg?.amapKeyWeb) {
    throw new Error('缺少高德 Key:请到 lbs.amap.com 注册并在 data/config.json 填入 amapKeyWeb(Web服务类型)');
  }
  return cfg;
}

// 会话级缓存(含 in-flight 去重):同一对节点只查一次高德。
//
// 为什么必须有:planner 按 loop[i]→loop[i+1] 逐条查 leg,一个环线就有 5-8 条
// (yili 7 条、zangdongnan 6 条)。没有缓存时每生成一次行程都要把这些 leg
// 全部重查——个人 Key 的 QPS 通常只有 3,直接被打爆,配额也按调用次数消耗。
// 节点坐标是静态数据,路线不会变,缓存无失效风险。
//
// 失败(网络/配额/非法坐标)不缓存:留重试机会,否则一次限频会让该 leg
// 在整个会话内永久失败。缓存 key 带坐标,避免同名不同节点互相覆盖。
const routeCache = new Map();

// 缓存 key 用坐标,但**必须在参数校验之后**才读坐标。
// 踩过的坑:早先版本在缓存层直接 `from.lng`,传入 undefined 时抛
// "Cannot read properties of undefined (reading 'lng')",
// 把原本友好的「高德路径规划坐标非法」报错盖掉了。
//
// 坏坐标(key 里出现 '?')一律**不进缓存**:一是它们必然抛错、结果不可用,
// 二是不同坏值会撞同一个 '?|?' key,把真正的失败缓存住。
let badKeySeq = 0;
function routeCacheKey(from, to) {
  const c = (p) => (p && Number.isFinite(Number(p.lng)) && Number.isFinite(Number(p.lat))
    ? `${Number(p.lng)},${Number(p.lat)}` : null);
  const a = c(from);
  const b = c(to);
  if (a === null || b === null) return `bad:${badKeySeq += 1}`;
  return `${a}|${b}`;
}

function clearRouteCache() {
  routeCache.clear();
}

async function drivingRoute(from, to) {
  const key = routeCacheKey(from, to);
  if (routeCache.has(key)) return routeCache.get(key);
  const pending = fetchDrivingRoute(from, to).catch((e) => {
    routeCache.delete(key);
    throw e;
  });
  routeCache.set(key, pending);
  return pending;
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

module.exports = { drivingRoute, calcCosts, clearRouteCache };

// 高德 Web 服务 API:驾车路径规划 + 油费过路费计算。Key 在 data/config.json 的 amapKeyWeb。
const store = require('./store');

const V5_DRIVING = 'https://restapi.amap.com/v5/direction/driving';

function requireKey() {
  const cfg = store.read('config');
  if (!cfg?.amapKeyWeb) {
    throw new Error('缺少高德 Key:请到 lbs.amap.com 注册并在 data/config.json 填入 amapKeyWeb(Web服务类型)');
  }
  return cfg;
}

async function drivingRoute(from, to) {
  const cfg = requireKey();
  const url = `${V5_DRIVING}?key=${cfg.amapKeyWeb}` +
    `&origin=${from.lng},${from.lat}&destination=${to.lng},${to.lat}&show_fields=cost&alternative_route=0`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`高德路径规划失败: HTTP ${res.status}`);
  const json = await res.json();
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

module.exports = { drivingRoute, calcCosts };

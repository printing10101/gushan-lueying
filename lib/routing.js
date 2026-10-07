// 路线来源的分发:高德 / 腾讯 / 直线估算 三选一。planner 只认这一层,不直接碰具体厂商。
//
// 为什么单独一层:两家厂商的坐标顺序、单位、错误码都不同(高德 "lng,lat" + distance 米 + duration 秒:
// 腾讯 "lat,lng" + distance 米 + duration 分钟),把它们隔在各自模块里,planner 与 UI 只处理
// 一种形状:{ distanceKm, durationHours, tolls, path, estimated, provider }。
//
// 选择规则(为什么这样定):
// - config.routeProvider 显式指定时以它为准;**指定了却没填对应 Key 要响亮报错**,
//   不能静默退回估算——用户以为自己配好了、结果预算全是估的,这种幻觉比报错糟糕得多。
// - 留空 = 自动:谁有 Key 用谁(高德优先,因为它多返回过路费);都没有就用直线估算。
// - 估算这一路永远可用,是这个应用"没 Key 也能完整跑"的底线。
const amap = require('./amap');
const tencent = require('./tencent');

const PROVIDERS = { amap, tencent };
const LABELS = {
  amap: '高德真实驾车路线',
  tencent: '腾讯真实驾车路线',
  estimate: '直线×1.3 估算',
};

function activeProvider(cfg = {}) {
  const want = String(cfg.routeProvider || '').trim();
  if (want) {
    if (!Object.prototype.hasOwnProperty.call(LABELS, want)) {
      throw new Error(`routeProvider 取值非法: ${want}(可选 amap / tencent / estimate)`);
    }
    if (want !== 'estimate' && !PROVIDERS[want].hasKey()) {
      throw new Error(`config.routeProvider 指定了 ${want},但没填对应的 Key(${want === 'amap' ? 'amapKeyWeb' : 'tencentKeyWeb'})`);
    }
    return want;
  }
  if (amap.hasKey()) return 'amap';
  if (tencent.hasKey()) return 'tencent';
  return 'estimate';
}

function labelOf(provider) {
  return LABELS[provider] || provider;
}

// 只对"真实路线"的 provider 发请求;estimate 由调用方走 amap.estimatedRoute(它不碰网络)
async function drivingRoute(from, to, provider) {
  if (provider === 'estimate') return amap.estimatedRoute(from, to);
  const mod = PROVIDERS[provider];
  if (!mod) throw new Error(`未知的路线 provider: ${provider}`);
  return mod.drivingRoute(from, to);
}

function estimateRoute(from, to) {
  return amap.estimatedRoute(from, to);
}

function clearCaches() {
  amap.clearRouteCache();
  tencent.clearRouteCache();
}

module.exports = {
  activeProvider, labelOf, drivingRoute, estimateRoute, clearCaches, PROVIDERS, LABELS,
};

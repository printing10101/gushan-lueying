// 腾讯位置服务 WebService API:驾车路线规划。Key 在 data/config.json 的 tencentKeyWeb。
//
// 为什么加这个:高德把「基础服务」挂到技术服务使用许可下面(协议原文:未付款无法获得许可、
// 进而无法使用基础服务),而腾讯位置服务对个人非商业用途给的是"注册即得个人额度"。
// 两个 provider 的接口形状故意做成一致(见 lib/routing.js),planner 不关心用哪家。
//
// 规格来源(官方文档,逐条核过):
//   https://lbs.qq.com/service/webService/webServiceGuide/webServiceRoute
//   - URL: https://apis.map.qq.com/ws/direction/v1/driving/
//   - 坐标顺序:**纬度在前,经度在后**(与高德的 "lng,lat" 相反——写反了会跑到地球另一边)
//   - distance 单位米;duration 单位分钟
//   - **返回里没有过路费字段**(只有 taxi_fare),所以过路费继续走 calcCosts 的估计分支并标「(估)」
//   - polyline 是压缩数组:官方原文「第一个坐标为原始未被压缩过的,之后的使用前向差分进行压缩」,
//     公式 `for (i=2;i<coors.length;i++) coors[i] = coors[i-2] + coors[i]/1000000`
const store = require('./store');
const { httpFetch } = require('./http');
const cache = require('./route-cache');

const V1_DRIVING = 'https://apis.map.qq.com/ws/direction/v1/driving/';
const PROVIDER = 'tencent';

function keyOf() {
  const cfg = store.read('config') || {};
  return cfg.tencentKeyWeb || '';
}

function hasKey() {
  return Boolean(keyOf());
}

// 纬度在前!这是两家最容易搞混的地方,单独抽出来便于单测钉住
function pointParam(p) {
  if (!p || !Number.isFinite(Number(p.lng)) || !Number.isFinite(Number(p.lat))) return null;
  return `${Number(p.lat)},${Number(p.lng)}`;
}

// polyline 压缩数组 → "lng,lat;lng,lat;…"(与高德那边同一种字符串,画线代码不用分家)
//
// ⚠ 这段按官方文档的公式**原文**实现,但我没有真实响应可对照(拿不到 Key),所以:
// 解出来的坐标一律过范围校验,越界就整段丢弃(返回空串)——宁可退回"节点直线骨架",
// 也不画一条跑到经纬度乱码的线。首次真实调用若返回空 path,说明公式理解有偏差,
// 那时用真实数组校准后再改这里。**不猜一个"看起来对"的解码。**
// anchors = { from, to }(可缺):解出来的首尾点必须落在这两个点附近,否则整段作废。
// 为什么要这个:公式我没法在本地验证(拿不到 Key),而"解码公式写错"的后果是画出
// 一条穿过地球的线。用首尾锚点做校验,错的公式会表现为"没有轨迹线"——退回节点直线骨架,
// 而不是画错线。这是能自己判断真假的检查,不依赖我对压缩格式的理解是否正确。
function decodePolyline(coors, anchors = null) {
  if (!Array.isArray(coors) || coors.length < 4) return '';
  const a = coors.slice();
  // 官方原文:"第一个坐标为原始未被压缩过的,之后的使用前向差分进行压缩",
  // 公式 `coors[i] = coors[i-2] + coors[i]/1000000`。
  // 使这个公式自洽的唯一读法:前两个元素是**经纬度原值(度)**,后面的差分以 1e-6 度为单位,
  // 累加完就是度,**末尾不再除 1e6**。(我第一版在末尾又除了一次 1e6,按这个读法就是错的。)
  // 这条读法我无法在本地验证(没有 Key、没有真实响应),所以下面用首尾锚点做校验——
  // 万一读法不对,结果表现为"没有轨迹线",而不是在地图上画一条穿过地球的线。
  for (let i = 2; i < a.length; i++) a[i] = a[i - 2] + a[i] / 1000000;
  const pts = [];
  for (let i = 0; i + 1 < a.length; i += 2) {
    const lat = a[i];
    const lng = a[i + 1];
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      return ''; // 只要有一个点越界,整段作废(宁可没线,不要错线)
    }
    pts.push({ lat, lon: lng });
  }
  if (anchors?.from && anchors?.to) {
    const near = (p, q, tol = 0.5) => Math.abs(p.lat - Number(q.lat)) <= tol
      && Math.abs(p.lon - Number(q.lng)) <= tol;
    if (!near(pts[0], anchors.from) || !near(pts[pts.length - 1], anchors.to)) return '';
  }
  return pts.map((p) => `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
}

async function fetchDrivingRoute(from, to) {
  const key = keyOf();
  if (!key) throw new Error('缺少腾讯位置服务 Key:请在 data/config.json 填入 tencentKeyWeb');
  const f = pointParam(from);
  const t = pointParam(to);
  if (!f || !t) {
    throw new Error(`腾讯路径规划坐标非法: from=${JSON.stringify(from)} to=${JSON.stringify(to)}`);
  }
  const url = `${V1_DRIVING}?from=${f}&to=${t}&key=${key}&output=json`;
  const res = await httpFetch(url);
  if (!res.ok) throw new Error(`腾讯路径规划失败: HTTP ${res.status}`);
  let json;
  try {
    json = await res.json();
  } catch {
    throw new Error(`腾讯路径规划返回非 JSON(HTTP ${res.status})`);
  }
  if (json.status !== 0) {
    // status/message 是腾讯自己的错误码,原样带出来(如 110 请求来源未被授权、111 签名校验失败)
    throw new Error(`腾讯路径规划失败: status=${json.status} ${json.message || ''}`.trim());
  }
  const route = json.result?.routes?.[0];
  if (!route) throw new Error('腾讯路径规划返回里没有 routes');
  return {
    distanceKm: Number(route.distance) / 1000, // 米 → 公里
    durationHours: Number(route.duration) / 60, // 分钟 → 小时
    tolls: null, // 腾讯不返回过路费 → 交给 calcCosts 估并标「(估)」
    path: decodePolyline(route.polyline, { from, to }),
    estimated: false,
    provider: PROVIDER,
  };
}

// 带会话缓存(含 in-flight 去重、失败不缓存):与 amap 那边同一套纪律,共用 lib/route-cache.js
async function drivingRoute(from, to) {
  const key = cache.routeCacheKey(from, to);
  return cache.cachedRoute(module.exports, key, () => fetchDrivingRoute(from, to));
}

function clearRouteCache() {
  cache.clear(module.exports);
}

module.exports = {
  PROVIDER, hasKey, drivingRoute, decodePolyline, pointParam, clearRouteCache,
  ENDPOINT: V1_DRIVING,
};

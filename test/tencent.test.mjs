// 腾讯位置服务路线接口:坐标顺序、单位换算、错误码、以及 polyline 解码的"宁可没线不要错线"。
//
// 为什么单测要写这么细:两家的约定几乎处处相反(高德 lng,lat / duration 秒 / 有过路费;
// 腾讯 lat,lng / duration 分钟 / 无过路费),写反一处就会有"里程看着对、其实跑到别处"
// 或不报错的偏差。这里把每条差异都钉住,并用 fetch 打桩避免真打接口(个人 Key 要省配额)。
import { createRequire } from 'module';
const require = createRequire(new URL('../package.json', import.meta.url));
const test = require('node:test');
const assert = require('node:assert');

const tencent = require('./lib/tencent.js');
const store = require('./lib/store.js');

const A = { lng: 116.407, lat: 39.904 };
const B = { lng: 116.5, lat: 39.95 };

function withStub(body, { status = 200, key = 'tkey' } = {}) {
  const realFetch = globalThis.fetch;
  const realRead = store.read;
  const calls = [];
  store.read = () => ({ tencentKeyWeb: key });
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return { ok: status === 200, status, json: async () => body };
  };
  return {
    calls,
    restore() {
      globalThis.fetch = realFetch;
      store.read = realRead;
      tencent.clearRouteCache();
    },
  };
}

test('pointParam:腾讯是"纬度在前",与高德相反', () => {
  assert.equal(tencent.pointParam(A), '39.904,116.407');
  assert.equal(tencent.pointParam({ lng: 1, lat: 2 }), '2,1');
  assert.equal(tencent.pointParam({ lng: NaN, lat: 2 }), null);
  assert.equal(tencent.pointParam(undefined), null);
});

test('drivingRoute:请求 URL 与参数形状(纬度在前 + output=json)', async () => {
  const stub = withStub({ status: 0, result: { routes: [{ distance: 12345, duration: 30 }] } });
  try {
    const r = await tencent.drivingRoute(A, B);
    assert.equal(stub.calls.length, 1);
    assert.match(stub.calls[0], /^https:\/\/apis\.map\.qq\.com\/ws\/direction\/v1\/driving\//);
    assert.match(stub.calls[0], /from=39\.904,116\.407/);
    assert.match(stub.calls[0], /to=39\.95,116\.5/);
    assert.match(stub.calls[0], /key=tkey/);
    assert.match(stub.calls[0], /output=json/);
    // 单位:米 → 公里;分钟 → 小时
    assert.equal(r.distanceKm, 12.345);
    assert.equal(r.durationHours, 0.5);
    assert.equal(r.estimated, false);
    assert.equal(r.provider, 'tencent');
  } finally {
    stub.restore();
  }
});

test('drivingRoute:腾讯不返回过路费 → tolls 给 null,交给 calcCosts 估并标「(估)」', async () => {
  const stub = withStub({ status: 0, result: { routes: [{ distance: 1000, duration: 10, taxi_fare: 25 }] } });
  try {
    const r = await tencent.drivingRoute(A, B);
    assert.equal(r.tolls, null, '把 taxi_fare 当过路费是最容易犯的错——那是打车费');
    const amap = require('./lib/amap.js');
    const cost = amap.calcCosts(r.distanceKm, r.tolls, { consumptionLPer100km: 8, pricePerL: 8.2 });
    assert.equal(cost.tollsEstimated, true, '必须走估算分支并让 UI 能标「(估)」');
  } finally {
    stub.restore();
  }
});

test('drivingRoute:status≠0 时带出腾讯自己的错误码与文案(不吞成"没查到")', async () => {
  const stub = withStub({ status: 111, message: '签名校验失败' });
  try {
    await assert.rejects(tencent.drivingRoute(A, B), /status=111 签名校验失败/);
  } finally {
    stub.restore();
  }
});

test('drivingRoute:HTTP 失败/非 JSON/没有 routes 都响亮报错', async () => {
  let stub = withStub({}, { status: 500 });
  try {
    await assert.rejects(tencent.drivingRoute(A, B), /HTTP 500/);
  } finally { stub.restore(); }

  stub = withStub({ status: 0, result: {} });
  try {
    await assert.rejects(tencent.drivingRoute(A, B), /没有 routes/);
  } finally { stub.restore(); }
});

test('drivingRoute:没配 Key 直接报错,不打接口', async () => {
  const stub = withStub({ status: 0, result: { routes: [] } }, { key: '' });
  try {
    await assert.rejects(tencent.drivingRoute(A, B), /缺少腾讯位置服务 Key/);
    assert.equal(stub.calls.length, 0);
  } finally { stub.restore(); }
});

test('drivingRoute:坏坐标直接报错,不打接口(别白耗配额)', async () => {
  const stub = withStub({ status: 0, result: { routes: [] } });
  try {
    await assert.rejects(tencent.drivingRoute(undefined, B), /坐标非法/);
    await assert.rejects(tencent.drivingRoute(A, { lng: 'x', lat: 1 }), /坐标非法/);
    assert.equal(stub.calls.length, 0);
  } finally { stub.restore(); }
});

test('drivingRoute:同一对节点只查一次,反向独立,失败不缓存', async () => {
  const stub = withStub({ status: 0, result: { routes: [{ distance: 1000, duration: 10 }] } });
  try {
    await tencent.drivingRoute(A, B);
    await tencent.drivingRoute(A, B);
    assert.equal(stub.calls.length, 1, '会话内同一对节点只查一次');
    await tencent.drivingRoute(B, A);
    assert.equal(stub.calls.length, 2, '反向是独立缓存项');
  } finally { stub.restore(); }

  let n = 0;
  const realFetch = globalThis.fetch;
  const realRead = store.read;
  store.read = () => ({ tencentKeyWeb: 'k' });
  globalThis.fetch = async () => { n += 1; return { ok: false, status: 429 }; };
  try {
    tencent.clearRouteCache();
    await assert.rejects(tencent.drivingRoute(A, B));
    const before = n;
    await assert.rejects(tencent.drivingRoute(A, B));
    assert.equal(n, before + 1, '失败不能缓存,否则一次限频会让该段整个会话永久失败');
  } finally {
    globalThis.fetch = realFetch;
    store.read = realRead;
    tencent.clearRouteCache();
  }
});

// ---- polyline:宁可没线,不要错线 ----
test('decodePolyline:空/过短一律给空串,不抛错', () => {
  assert.equal(tencent.decodePolyline(null), '');
  assert.equal(tencent.decodePolyline([]), '');
  assert.equal(tencent.decodePolyline([1, 2]), '');
  assert.equal(tencent.decodePolyline([39.9, 116.4, 1]), '', '奇数长度也算不可用');
});

test('decodePolyline:按官方公式的自洽读法解(前两点是度原值,后续差分以 1e-6 度累加)', () => {
  // 这是"解读得对不对"的判据:若末尾多除一次 1e6,首点会跑到 0.0000399° 附近而不是 39.904°
  const out = tencent.decodePolyline([39.904, 116.407, 0, 0, 0, 0], { from: A, to: A });
  assert.equal(out, '116.407000,39.904000;116.407000,39.904000;116.407000,39.904000');
});

test('decodePolyline:差分累加后第二点落在预期位置', () => {
  // 差分 +10000/1e6 = +0.01°(纬度)→ 39.914;+93000/1e6 = +0.093°(经度)→ 116.500
  const out = tencent.decodePolyline([39.904, 116.407, 10000, 93000], { from: A, to: B });
  assert.match(out, /^116.407000,39.904000;116.500000,39.914000$/, out);
});

test('decodePolyline:解出越界坐标 → 整段作废', () => {
  assert.equal(tencent.decodePolyline([39.904, 116.407, 999999000, 0]), '', '纬度推到 1000° 必须丢弃');
  assert.equal(tencent.decodePolyline([39.904, 116.407, 0, 999999000]), '', '经度同理');
});

test('decodePolyline:首尾不在起终点附近 → 整段作废(公式读错也不会画出错线)', () => {
  assert.equal(tencent.decodePolyline([10, 20, 0, 0, 0, 0], { from: A, to: B }), '',
    '锚点校验是这条的判据:读法错表现为"没有轨迹线"');
  // 不带锚点时只做范围校验,(10,20) 是合法坐标,允许通过
  assert.equal(tencent.decodePolyline([10, 20, 0, 0, 0, 0]), '20.000000,10.000000;20.000000,10.000000;20.000000,10.000000');
});

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

test('drivingRoute:过路费取真实 toll 字段(文档字段表没列它,真实响应里有)', async () => {
  const stub = withStub({ status: 0, result: { routes: [{ distance: 76248, duration: 71, toll: 25, taxi_fare: { fare: 300 } }] } });
  try {
    const r = await tencent.drivingRoute(A, B);
    assert.equal(r.tolls, 25, '要用 toll;taxi_fare 是打车费,顶替它会凭空多算几百元');
    const amap = require('./lib/amap.js');
    const cost = amap.calcCosts(r.distanceKm, r.tolls, { consumptionLPer100km: 8, pricePerL: 8.2 });
    assert.equal(cost.tolls, 25);
    assert.equal(cost.tollsEstimated, false, '有实数就不该标「(估)」');
  } finally {
    stub.restore();
  }
});

test('drivingRoute:缺 toll 或 toll 非法 → null 而非 0(Number(null)===0 是陷阱)', async () => {
  // 缺字段时给 0 等于告诉用户"这条路不收费"——那是把不知道说成知道
  for (const bad of [undefined, null, '', '二十五', NaN]) {
    const stub = withStub({ status: 0, result: { routes: [{ distance: 1000, duration: 10, toll: bad }] } });
    try {
      const r = await tencent.drivingRoute(A, B);
      assert.equal(r.tolls, null, `toll=${JSON.stringify(bad)} 时必须是 null(尤其 null/'' 别被 Number() 变成 0)`);
      const amap = require('./lib/amap.js');
      const cost = amap.calcCosts(r.distanceKm, r.tolls, { consumptionLPer100km: 8, pricePerL: 8.2 });
      assert.equal(cost.tollsEstimated, true);
    } finally {
      stub.restore();
    }
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

// ---- 用真实响应夹具钉死解码读法(自造数据只能证明自洽,证明不了和厂商一致) ----
test('decodePolyline:真实响应(北京→斋堂)解出的折线长度要与接口 distance 同量级', () => {
  const fx = JSON.parse(require('fs').readFileSync(
    new URL('./fixtures/tencent-driving-real.json', import.meta.url), 'utf8'));
  const path = tencent.decodePolyline(fx.polyline, { from: fx.from, to: fx.to });
  assert.ok(path, '真实 payload 必须能解出来(解不出就说明读法/校验有问题)');
  const pts = path.split(';').map((p) => p.split(',').map(Number));
  assert.equal(pts.length, fx.polyline.length / 2);
  const R = 6371; const rad = (x) => (x * Math.PI) / 180;
  let km = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const [lng1, lat1] = pts[i]; const [lng2, lat2] = pts[i + 1];
    const h = Math.sin(rad(lat2 - lat1) / 2) ** 2
      + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2;
    km += 2 * R * Math.asin(Math.sqrt(h));
  }
  const apiKm = fx.distance / 1000;
  // 判据不依赖我对压缩格式的理解:解出来的几何长度必须和接口自己报的距离对得上
  assert.ok(Math.abs(km - apiKm) / apiKm < 0.03,
    `折线长度 ${km.toFixed(1)}km 与接口 ${apiKm.toFixed(1)}km 偏差超 3%(说明解码读法不对)`);
  // 首尾也要对得上(道路会就近吸附,所以留 0.02° ≈ 2km 的余量)
  const [fLng, fLat] = pts[0];
  assert.ok(Math.abs(fLat - fx.from.lat) < 0.02 && Math.abs(fLng - fx.from.lng) < 0.02);
  const [tLng, tLat] = pts[pts.length - 1];
  assert.ok(Math.abs(tLat - fx.to.lat) < 0.02, `末点纬度 ${tLat} 应对上终点 ${fx.to.lat}`);
  assert.ok(Math.abs(tLng - fx.to.lng) < 0.02);
});

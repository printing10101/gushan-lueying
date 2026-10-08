import { createRequire } from 'module';
const require = createRequire(new URL('../package.json', import.meta.url));
const amap = require('./lib/amap.js');
const test = require('node:test');
const assert = require('node:assert');

const fuel = { consumptionLPer100km: 8, pricePerL: 8.2 };

test('calcCosts:油费 = 里程×油耗×油价,过路费缺失时按里程估', () => {
  const c = amap.calcCosts(300, null, fuel);
  assert.equal(c.fuel, 197); // 300/100 × 8L × 8.2 = 196.8
  assert.equal(c.tolls, 135); // 300 × 0.45
  assert.equal(c.tollsEstimated, true);
  assert.equal(c.driveTotal, 332);
});

test('calcCosts:优先用高德返回的过路费', () => {
  const c = amap.calcCosts(300, 120.4, fuel);
  assert.equal(c.tolls, 120);
  assert.equal(c.tollsEstimated, false);
  assert.equal(c.driveTotal, 317);
});

// drivingRoute 会先读真实 config 拿 key;测试里 patch 同一 store 实例,注入测试 key
const store = require('./lib/store.js');

test('drivingRoute:HTTP 非 200 / 业务失败 / 非 JSON 都响亮报错', async () => {
  const realFetch = globalThis.fetch;
  const realRead = store.read;
  const okBody = { status: '1', route: { paths: [{ distance: '1000', duration: '600', cost: { tolls: 30 }, steps: [] }] } };
  try {
    store.read = () => ({ amapKeyWeb: 'test-key' });
    globalThis.fetch = async () => ({ ok: false, status: 429 });
    await assert.rejects(amap.drivingRoute({ lng: 104, lat: 30 }, { lng: 103, lat: 31 }), /HTTP 429/);
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ status: '0', info: 'INVALID_USER_KEY' }) });
    await assert.rejects(amap.drivingRoute({ lng: 104, lat: 30 }, { lng: 103, lat: 31 }), /INVALID_USER_KEY/);
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad'); } });
    await assert.rejects(amap.drivingRoute({ lng: 104, lat: 30 }, { lng: 103, lat: 31 }), /非 JSON/);
    globalThis.fetch = async () => ({ ok: true, json: async () => okBody });
    const r = await amap.drivingRoute({ lng: 104, lat: 30 }, { lng: 103, lat: 31 });
    assert.equal(r.tolls, 30);
  } finally {
    globalThis.fetch = realFetch;
    store.read = realRead;
  }
});

test('drivingRoute:坐标非法直接报错,不打高德接口', async () => {
  const realFetch = globalThis.fetch;
  const realRead = store.read;
  let called = 0;
  try {
    store.read = () => ({ amapKeyWeb: 'test-key' });
    globalThis.fetch = async () => { called++; return { ok: true, json: async () => ({}) }; };
    await assert.rejects(amap.drivingRoute({ lng: NaN, lat: 30 }, { lng: 103, lat: 31 }), /坐标非法/);
    await assert.rejects(amap.drivingRoute(undefined, { lng: 103, lat: 31 }), /坐标非法/);
    assert.equal(called, 0);
  } finally {
    globalThis.fetch = realFetch;
    store.read = realRead;
  }
});

// 会话级缓存:同一对节点只打一次高德。
//
// 这不是优化而是必需品:planner 按 loop[i]→loop[i+1] 逐条查 leg,一个环线
// 5-8 条(yili 7、zangdongnan 6)。没有缓存时每生成一次行程都要重查全部 leg,
// 个人 Key 的 QPS(通常 3)会被打爆,配额也按调用次数消耗。
test('drivingRoute:同一对节点只查一次高德,反向 leg 独立,失败不缓存', async () => {
  const realFetch = globalThis.fetch;
  const realRead = store.read;
  let calls = 0;
  const A = { lng: 104.0, lat: 30.0 };
  const B = { lng: 103.0, lat: 31.0 };
  const body = (km) => ({ ok: true, status: 200, json: async () => ({
    status: '1', route: { paths: [{ distance: String(km * 1000), duration: '600',
      cost: { tolls: 0 }, steps: [] }] } }) });
  try {
    amap.clearRouteCache();
    store.read = () => ({ amapKeyWeb: 'test-key' });
    // 每次返回不同里程:若缓存生效,多次调用必须拿到同一个值
    globalThis.fetch = async () => { calls += 1; return body(100 + calls); };

    const r1 = await amap.drivingRoute(A, B);
    const r2 = await amap.drivingRoute(A, B);
    const r3 = await amap.drivingRoute(A, B);
    assert.equal(calls, 1, '同一对节点应只请求一次高德');
    assert.equal(r2.distanceKm, r1.distanceKm, '缓存命中应返回同一结果');
    assert.equal(r3.distanceKm, r1.distanceKm);

    // 反向是不同 key,不能被误命中
    await amap.drivingRoute(B, A);
    assert.equal(calls, 2, '反向 leg 应是独立缓存项');

    // 失败不缓存:否则一次限频会让该 leg 整个会话永久失败
    amap.clearRouteCache();
    globalThis.fetch = async () => { calls += 1; return { ok: false, status: 429 }; };
    await assert.rejects(amap.drivingRoute(A, B), /HTTP 429/);
    const before = calls;
    await assert.rejects(amap.drivingRoute(A, B), /HTTP 429/);
    assert.equal(calls, before + 1,
      '失败后应重新请求高德,而不是命中失败缓存(否则一次限频会让该 leg 永久失败)');
  } finally {
    globalThis.fetch = realFetch;
    store.read = realRead;
    amap.clearRouteCache();
  }
});

// ---- 未配 Key 的估算口径(与 planner.buildLegs 共用同一个系数) ----
test('estimatedRoute:里程 = 直线×系数(量级参考,不是保守上限),过路费交回 calcCosts 估', () => {
  const A = { lng: 100, lat: 30 };
  const B = { lng: 101.5, lat: 31 };
  const flat = amap.haversineKm(A, B);
  const r = amap.estimatedRoute(A, B);
  assert.ok(r.distanceKm > flat, '估算必须不低于直线距离');
  assert.equal(r.distanceKm, flat * amap.LOOP_FACTOR);
  assert.equal(r.tolls, null, '给 null 才能走 calcCosts 既有的 0.45 元/km 估算分支');
  assert.equal(r.path, '', '没有真实路线可画');
  assert.equal(r.estimated, true);
  assert.ok(r.durationHours > 0 && Number.isFinite(r.durationHours));
  // 估算不能替坏坐标遮丑:regions.json 填错要当场炸
  assert.throws(() => amap.estimatedRoute(undefined, B), /坐标非法/);
  assert.throws(() => amap.estimatedRoute(A, { lng: NaN, lat: 1 }), /坐标非法/);
});

test('hasKey:按 config 的 amapKeyWeb 判定,空串/缺文件都算没配', () => {
  const realRead = store.read;
  try {
    store.read = () => ({ amapKeyWeb: '' });
    assert.equal(amap.hasKey(), false);
    store.read = () => ({ amapKeyWeb: 'k' });
    assert.equal(amap.hasKey(), true);
    store.read = () => null;
    assert.equal(amap.hasKey(), false);
  } finally {
    store.read = realRead;
  }
});

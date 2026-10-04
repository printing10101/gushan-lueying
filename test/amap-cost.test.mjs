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

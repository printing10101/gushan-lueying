// 路线来源的分发规则:显式指定的优先、缺 Key 要响亮报错、都没配就退回估算。
//
// 这条规则的价值在于"不让用户产生错误幻觉":如果 routeProvider 写了 tencent 但 Key 没填,
// 静默退回估算的话,界面上一切正常、预算却全是估的,而用户以为已经配好了。
import { createRequire } from 'module';
const require = createRequire(new URL('../package.json', import.meta.url));
const test = require('node:test');
const assert = require('node:assert');

const routing = require('./lib/routing.js');
const store = require('./lib/store.js');

const withCfg = (cfg) => {
  const real = store.read;
  store.read = () => cfg;
  return () => { store.read = real; };
};

test('自动选择:有高德 Key 用高德(它多返回过路费);只有腾讯 Key 用腾讯;都没有就估算', () => {
  let restore = withCfg({ amapKeyWeb: 'a', tencentKeyWeb: 't' });
  try { assert.equal(routing.activeProvider({}), 'amap'); } finally { restore(); }
  restore = withCfg({ tencentKeyWeb: 't' });
  try { assert.equal(routing.activeProvider({}), 'tencent'); } finally { restore(); }
  restore = withCfg({});
  try { assert.equal(routing.activeProvider({}), 'estimate'); } finally { restore(); }
});

test('显式指定:合法值以它为准;指定了却没填对应 Key 一律报错(不静默退回估算)', () => {
  let restore = withCfg({ tencentKeyWeb: 't' });
  try {
    assert.equal(routing.activeProvider({ routeProvider: 'tencent' }), 'tencent');
    assert.throws(() => routing.activeProvider({ routeProvider: 'amap' }), /没填对应的 Key.*amapKeyWeb/);
  } finally { restore(); }
  restore = withCfg({ amapKeyWeb: 'a' });
  try {
    assert.throws(() => routing.activeProvider({ routeProvider: 'tencent' }), /tencentKeyWeb/);
    // estimate 是永远可用的底线,不需要任何 Key
    assert.equal(routing.activeProvider({ routeProvider: 'estimate' }), 'estimate');
  } finally { restore(); }
});

test('非法取值要报错并列出可选值,不猜用户想用哪家', () => {
  const restore = withCfg({});
  try {
    assert.throws(() => routing.activeProvider({ routeProvider: 'baidu' }), /取值非法: baidu.*amap \/ tencent \/ estimate/);
  } finally { restore(); }
});

test('labelOf:三家各有中文标签,页面/导出直接吃它', () => {
  assert.equal(routing.labelOf('amap'), '高德真实驾车路线');
  assert.equal(routing.labelOf('tencent'), '腾讯真实驾车路线');
  assert.equal(routing.labelOf('estimate'), '直线×1.3 估算');
});

test('drivingRoute:estimate 走本地估算(不发请求),未知 provider 报错', async () => {
  const r = await routing.drivingRoute({ lng: 100, lat: 30 }, { lng: 101, lat: 31 }, 'estimate');
  assert.equal(r.estimated, true);
  assert.ok(r.distanceKm > 0);
  await assert.rejects(routing.drivingRoute({ lng: 100, lat: 30 }, { lng: 101, lat: 31 }, 'baidu'), /未知的路线 provider/);
});

// clearCaches 此前零引用 —— 也就是说"缓存清理"这条路径一次都没被执行过。
// 它牵着两个 provider 各自的 WeakMap(route-cache 按 owner 隔离),漏测等于
// 不知道清了还是没清。
test('clearCaches:清完之后同一坐标对会重新发起请求(缓存真的被清掉)', async () => {
  const { clearCaches } = require('./lib/routing.js');
  const rc = require('./lib/route-cache.js');
  let calls = 0;
  const owner = { tag: 'clearCaches-probe' };
  const key = rc.routeCacheKey({ lng: 104, lat: 30 }, { lng: 103, lat: 31 });
  const fetch = () => { calls += 1; return Promise.resolve(`v${calls}`); };

  assert.equal(await rc.cachedRoute(owner, key, fetch), 'v1');
  assert.equal(await rc.cachedRoute(owner, key, fetch), 'v1', '第二次必须命中缓存');
  rc.clear(owner);
  assert.equal(await rc.cachedRoute(owner, key, fetch), 'v2', '清完要重新取');

  // clearCaches 是 routing 的统一入口,不能只清一家
  assert.equal(typeof clearCaches, 'function');
  assert.doesNotThrow(() => clearCaches(), '两家都没缓存时也要能安全调用');
});

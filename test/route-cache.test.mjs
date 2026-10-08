// 路线查询的会话级缓存纪律。这个模块此前**一条直接断言都没有**,而它已经踩过三次坑
// (INSTINCTS「加缓存时踩的两个坑」+「别用印象写 README」那几节):
//   1) 缓存层比业务层更早抛错,把「高德路径规划坐标非法」那条准确报错盖成了
//      "Cannot read properties of undefined"——坏坐标的 key 现在改用自增序号;
//   2) 「失败不缓存」那条断言曾写成累计值,自己制造了假失败;
//   3) 缓存是会话级的、不失效的:节点坐标是静态数据,一旦缓存住坏结果就整会话都好不了。
// 三条纪律各对应一组断言,下面每组都做了变异验证(把实现改回坏写法 → 确认真的红)。
import { createRequire } from 'module';
const require = createRequire(new URL('../package.json', import.meta.url));
const test = require('node:test');
const assert = require('node:assert');

const C = require('./lib/route-cache.js');

const P = (lng, lat) => ({ lng, lat });

test('routeCacheKey:合法坐标进缓存键且可复现;坏坐标改用自增序号,既不误命中也不复用', () => {
  const a = C.routeCacheKey(P(100, 30), P(101, 31));
  const b = C.routeCacheKey(P(100, 30), P(101, 31));
  assert.equal(a, b, '同一对节点必须得到同一个 key,否则缓存形同虚设');
  assert.equal(a, '100,30|101,31', 'key 必须按 lng,lat 顺序落字面量(两家 provider 的坐标顺序约定相反,这里不能含糊)');

  // 反向 leg 是独立 key:去程与回程的里程在山区路网里并不相等
  assert.notEqual(a, C.routeCacheKey(P(101, 31), P(100, 30)), '反向 leg 必须独立缓存');

  const n1 = C.routeCacheKey(undefined, P(101, 31));
  const n2 = C.routeCacheKey(undefined, P(101, 31));
  assert.ok(n1.startsWith('bad:'), `坏坐标不得进正常键位,实际拿到 ${n1}`);
  assert.notEqual(n1, n2, '坏坐标必须每次拿到不同 key——复用会把「失败」本身缓存住,该 leg 整会话都废掉');
});

test('坏坐标:缓存层不得比业务层更早抛错,要把准确报错原样交给调用方', () => {
  // 这条是踩坑的直接回归:早先在 key 函数里直接读 from.lng,传 undefined 时同步抛
  // "Cannot read properties of undefined",把更友好的「坐标非法」报错盖掉了。
  assert.doesNotThrow(() => C.routeCacheKey(undefined, undefined), 'key 函数对坏输入必须自己兜住,不许抛');
  assert.doesNotThrow(() => C.routeCacheKey({ lng: 'x', lat: null }, P(1, 1)), '非数值坐标同样不得抛');
});

test('命中缓存:同一对节点第二次调用不再发请求', async () => {
  const owner = {};
  const key = C.routeCacheKey(P(1, 1), P(2, 2));
  let calls = 0;
  const fetchIt = () => { calls += 1; return Promise.resolve({ distanceKm: 10 }); };

  const r1 = await C.cachedRoute(owner, key, fetchIt);
  const r2 = await C.cachedRoute(owner, key, fetchIt);
  assert.equal(calls, 1, '第二次必须吃缓存,不再发请求(个人 Key 的 QPS 只有 3,重查会被打爆)');
  assert.deepEqual(r1, r2, '两次拿到同一份结果');
});

test('in-flight 去重:同一对节点并发调用只发一次请求', async () => {
  const owner = {};
  const key = C.routeCacheKey(P(3, 3), P(4, 4));
  let calls = 0;
  let release;
  const gate = new Promise((res) => { release = res; });
  const fetchIt = () => { calls += 1; return gate.then(() => ({ distanceKm: 7 })); };

  const p1 = C.cachedRoute(owner, key, fetchIt);
  const p2 = C.cachedRoute(owner, key, fetchIt);
  assert.equal(calls, 1, '并发第二次必须复用 in-flight 的 promise,而不是再发一次');
  release();
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.deepEqual(r1, r2);
  assert.equal(calls, 1, 'await 完之后仍然只发过一次');
});

test('失败不缓存:一次限频不能让该 leg 整个会话永久失败', async () => {
  const owner = {};
  const key = C.routeCacheKey(P(5, 5), P(6, 6));
  let calls = 0;
  const boom = () => { calls += 1; return Promise.reject(new Error('限频')); };

  await assert.rejects(C.cachedRoute(owner, key, boom), /限频/);
  // 断言写**增量**而不是累计值:累计写在 calls 已经涨到 2 时会自己造成假失败(踩过)
  const afterFirst = calls;
  await assert.rejects(C.cachedRoute(owner, key, boom), /限频/);
  assert.equal(calls, afterFirst + 1, '失败必须不缓存,第二次要真的再发一次');
});

test('并发失败:被等待的那一份失败后,缓存项必须清掉而不是留下一个永远 reject 的 promise', async () => {
  const owner = {};
  const key = C.routeCacheKey(P(13, 13), P(14, 14));
  let calls = 0;
  const boom = () => { calls += 1; return Promise.reject(new Error('网络失败')); };

  const p1 = C.cachedRoute(owner, key, boom);
  const p2 = C.cachedRoute(owner, key, boom);
  await assert.rejects(p1, /网络失败/);
  await assert.rejects(p2, /网络失败/);
  assert.equal(calls, 1, '并发两路共享同一次请求');

  // 关键:失败之后重试要能重新发。若 store 里残留那个已 reject 的 promise,
  // 这里会直接拿到旧失败、calls 不涨——该 leg 在本会话内就永久废了。
  const ok = await C.cachedRoute(owner, key, () => { calls += 1; return Promise.resolve({ distanceKm: 42 }); });
  assert.equal(calls, 2, '失败后重试必须重新发请求');
  assert.equal(ok.distanceKm, 42);
});

test('owner 隔离:两个 provider 的缓存互不污染', async () => {
  const amapOwner = {};
  const tencentOwner = {};
  const key = C.routeCacheKey(P(9, 9), P(10, 10));
  let ca = 0;
  let cb = 0;

  const viaAmap = await C.cachedRoute(amapOwner, key, () => { ca += 1; return Promise.resolve({ provider: 'amap' }); });
  const viaTencent = await C.cachedRoute(tencentOwner, key, () => { cb += 1; return Promise.resolve({ provider: 'tencent' }); });
  assert.equal(ca, 1);
  assert.equal(cb, 1, '另一个 provider 必须自己发一次,不能吃到别人的缓存');
  assert.equal(viaAmap.provider, 'amap');
  assert.equal(viaTencent.provider, 'tencent', '同名 key 在各自 owner 下必须存各自的值');
});

test('clear:清空后重新发请求(换 Key 后旧结果不得滞留)', async () => {
  const owner = {};
  const key = C.routeCacheKey(P(11, 11), P(12, 12));
  let calls = 0;
  const fetchIt = () => { calls += 1; return Promise.resolve({ n: calls }); };

  await C.cachedRoute(owner, key, fetchIt);
  await C.cachedRoute(owner, key, fetchIt);
  assert.equal(calls, 1);

  C.clear(owner);
  const after = await C.cachedRoute(owner, key, fetchIt);
  assert.equal(calls, 2, 'clear 之后必须重新发请求');
  assert.equal(after.n, 2, '拿到的是新结果,不是清之前的旧值');

  // clear 一个从未用过的 owner 不得抛错(provider 模块首次调用就 clear 的场景)
  assert.doesNotThrow(() => C.clear({}));
});

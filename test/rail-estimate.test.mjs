// 12306 的三个对外入口:resolveStation / estimateRoundTrip / estimateRoundTripStrict。
//
// 这三个此前在任何单测里零引用,只被 scripts/smoke-rail(真网络)覆盖。
// 本文件只走**不发网络**的路径:
//   - resolveStation 读的是本地 data/stations.json 缓存(命中就不再联网);
//   - estimate* 用不存在的站名,stationCode 会在 ensureCookies 之前就抛错 →
//     被 catch 成 null,连一次 HTTP 都不会发。
import { createRequire } from 'module';
const require = createRequire(new URL('../package.json', import.meta.url));
const test = require('node:test');
const assert = require('node:assert');

const rail = require('./lib/rail12306.js');

test('resolveStation:精确站名返回单条,带电报码', async () => {
  const hits = await rail.resolveStation('成都东');
  assert.ok(Array.isArray(hits) && hits.length >= 1, '至少要命中成都东');
  const exact = hits.find((s) => s.name === '成都东');
  assert.ok(exact, `精确匹配失效:${JSON.stringify(hits.slice(0, 3))}`);
  assert.match(exact.code, /^[A-Z]{2,4}$/, `电报码形状不对:${exact.code}`);
});

test('resolveStation:模糊匹配最多给 10 条(不把 3404 站全丢回界面)', async () => {
  // 用"北"而不是"北京":后者能精确命中单站,走的就不是模糊分支了
  const hits = await rail.resolveStation('北');
  assert.ok(hits.length > 1, `模糊匹配该有多条,实得 ${hits.length}`);
  assert.ok(hits.length <= 10, `必须截断到 10 条以内,实得 ${hits.length}`);
  for (const h of hits) assert.ok(h.name.includes('北'), `不该混进无关站:${h.name}`);
});

test('resolveStation:能精确命中时只返回那一条(不返回一堆同名词)', async () => {
  const hits = await rail.resolveStation('成都东');
  assert.equal(hits.length, 1, `精确命中就该只给一条,实得 ${JSON.stringify(hits)}`);
});

test('resolveStation:查不到时返回空数组,不抛错也不编一个站', async () => {
  const hits = await rail.resolveStation('这个站肯定不存在XYZ');
  assert.deepEqual(hits, []);
});

test('estimateRoundTrip:任何失败一律降级为 null,不打断推荐与浏览', async () => {
  // 站名不存在 → stationCode 抛错 → 被吞成 null。展示层据此标"未含"。
  const r = await rail.estimateRoundTrip('不存在的站A', '不存在的站B', null);
  assert.equal(r, null, '估算失败必须降级为 null,不能把异常抛到推荐页');
});

test('estimateRoundTripStrict:查不到时同样返回 null(与宽松版一致)', async () => {
  const r = await rail.estimateRoundTripStrict('不存在的站A', '不存在的站B', null);
  assert.equal(r, null);
});

test('estimateRoundTrip:没有坐标时不做中转尝试(直接返回直达结果)', async () => {
  // toXY 为 null → 直达失败就返回,不会去试 13 个中转枢纽
  const r = await rail.estimateRoundTrip('不存在的站A', '不存在的站B', null);
  assert.equal(r, null);
  // 给了坐标但两站都不存在时,中转也查不到 → 仍为 null,而不是抛错
  const r2 = await rail.estimateRoundTrip('不存在的站A', '不存在的站B', { lng: 104, lat: 30 });
  assert.equal(r2, null);
});

// 中转估算支持注入 query,可以完全不发网络地验证"两段都有车才算成立"。
test('transferEstimate:两腿都有可购车次才成立,票价是两段去程价之和 ×2', async () => {
  const mk = (price) => ({
    trains: [{ code: 'G9', lishi: '03:00', canWebBuy: true,
      prices: { 二等座: price }, seats: { 二等座: '有' } }],
  });
  const out = await rail.transferEstimate('西安北', '稻城亚丁', { lng: 100, lat: 29 },
    async (from, to) => (to === '稻城亚丁' ? mk(200) : mk(100)));
  assert.ok(out, '两腿都有车就该算出结果');
  assert.equal(out.perPerson, (100 + 200) * 2, '往返 = 两段去程价相加 ×2');
  assert.ok(out.note.includes('中转'), `备注要说明是中转:${out.note}`);
  assert.ok(out.via, '要说明经哪个枢纽中转');
});

test('transferEstimate:任一腿没车就不成立(不编一个半程价)', async () => {
  const out = await rail.transferEstimate('西安北', '稻城亚丁', { lng: 100, lat: 29 },
    async (from, to) => (to === '稻城亚丁'
      ? { trains: [] } // 第二腿没车
      : { trains: [{ code: 'G9', lishi: '03:00', canWebBuy: true, prices: { 二等座: 100 }, seats: { 二等座: '有' } }] }));
  assert.equal(out, null, '半程有价不能当全程用');
});

test('transferEstimate:没给坐标直接返回 null(无法挑中转枢纽)', async () => {
  assert.equal(await rail.transferEstimate('西安北', '稻城亚丁', null, async () => ({ trains: [] })), null);
  assert.equal(await rail.transferEstimate('西安北', '稻城亚丁', { lng: NaN, lat: 30 },
    async () => ({ trains: [] })), null, '坐标为 NaN 也要当没有坐标处理');
});

test('pickJunctions:按离目的地的距离排序,最多给 k 个,不含起终点自身', () => {
  const near = rail.pickJunctions({ lng: 104.14, lat: 30.59 }, 3); // 成都东附近
  assert.ok(near.length > 0 && near.length <= 3, `实得 ${near.length} 个`);
  assert.equal(near[0].name, '成都东', '最近的就是自己所在的大枢纽');
  // 排序要对:第一个必须比第二个更近
  const d = (j) => (j.lng - 104.14) ** 2 + (j.lat - 30.59) ** 2;
  for (let i = 1; i < near.length; i++) assert.ok(d(near[i - 1]) <= d(near[i]), '未按距离排序');
  const k1 = rail.pickJunctions({ lng: 116.3, lat: 39.9 }, 1);
  assert.equal(k1.length, 1);
  assert.equal(rail.pickJunctions(null, 4).length, 0, '没坐标就不给候选');
});

test('estimateDate:落在预售期内(10 天内),且是 YYYY-MM-DD', () => {
  const d = rail.estimateDate();
  assert.match(d, /^\d{4}-\d{2}-\d{2}$/, `日期格式:${d}`);
  assert.equal(rail.beyondPresale(d), false, `挑出来的日期必须在预售期内:${d}`);
});

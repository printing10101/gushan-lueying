// 海拔分档筛选与排序。
//
// 为什么要它:data/trails.json 里 maxAltM 一直是"死数据"——只被 src/app.js 拿去算山顶体感
// 与喂 grading 的海拔分项,路线库的筛选下拉里压根没有海拔这一维(src/app.js:806 实测只有
// province/grade/type/status/mark/sort)。对"我能上到多高"这个入门者最先问的问题,
// 界面答不了。本模块把分档口径收进 lib,与主进程/渲染层同源(经 window.GushanLib)。
//
// 口径:档位是半开区间 [min, max),所以边界值只落一档,不重不漏。
// 缺 maxAltM 的线路不命中任何具体档位——宁可被筛掉,也不给一个假命中
// (同 lib/quickfacts.js「未标注」与 lib/grading.js usable:false 的纪律)。
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(new URL('../package.json', import.meta.url));
const test = require('node:test');
const assert = require('node:assert');

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TRAILS = require(path.join(ROOT, 'data', 'trails.json'));
const { ALT_BANDS, hitAltBand, byAlt } = require('./lib/filters.js');

test('档位定义自洽:key 唯一、label 非空、区间不重叠', () => {
  assert.ok(ALT_BANDS.length >= 3, '至少要有三档,否则这个筛选没有意义');
  const keys = ALT_BANDS.map((b) => b.key);
  assert.equal(new Set(keys).size, keys.length, `档位 key 重复: ${keys.join(',')}`);
  for (const b of ALT_BANDS) {
    assert.ok(typeof b.label === 'string' && b.label.trim(), `档位 ${b.key} 没有 label`);
    assert.ok(Number.isFinite(b.min), `档位 ${b.key} 的 min 非有限值`);
  }
  // 半开区间 [min, max):上一档的 max 必须等于下一档的 min,否则中间漏缝
  const ordered = [...ALT_BANDS].sort((a, b) => a.min - b.min);
  for (let i = 0; i + 1 < ordered.length; i++) {
    assert.equal(ordered[i].max, ordered[i + 1].min,
      `档位 ${ordered[i].key} 与 ${ordered[i + 1].key} 之间有海拔空隙`);
  }
});

test('全库每条线路恰好命中一个海拔档(不漏不重)', () => {
  const all = Object.entries(TRAILS);
  assert.ok(all.length > 0, 'trails.json 读不到数据');
  const bad = [];
  for (const [id, t] of all) {
    const hits = ALT_BANDS.filter((b) => hitAltBand(t, b.key)).map((b) => b.key);
    if (hits.length !== 1) bad.push(`${id}(maxAltM=${t.maxAltM}) 命中 ${hits.length} 档:[${hits}]`);
  }
  assert.equal(bad.length, 0, `以下线路命中档数不是 1:\n   ${bad.join('\n   ')}`);
});

test('边界值只落一档:2000/3500/4500 各归上一档的下界', () => {
  const bandOf = (m) => ALT_BANDS.filter((b) => hitAltBand({ maxAltM: m }, b.key)).map((b) => b.key);
  assert.deepEqual(bandOf(2000), ['2000-3500'], '2000 应落进 2000-3500(含下界)');
  assert.deepEqual(bandOf(3500), ['3500-4500'], '3500 应落进 3500-4500(含下界)');
  assert.deepEqual(bandOf(4500), ['ge4500'], '4500 应落进最高档(含下界)');
  assert.deepEqual(bandOf(1999.9), ['lt2000'], '1999.9 应落进最低档');
});

test('缺 maxAltM 或非有限值不命中任何档(不给假命中)', () => {
  for (const t of [{}, { maxAltM: null }, { maxAltM: undefined }, { maxAltM: NaN },
    { maxAltM: '3830' }, { maxAltM: Infinity }]) {
    const hits = ALT_BANDS.filter((b) => hitAltBand(t, b.key));
    assert.equal(hits.length, 0, `maxAltM=${JSON.stringify(t.maxAltM)} 不该命中任何档`);
  }
  // 整条线路对象缺失也不能炸(筛选会遍历全库,null 条目要能跳过)
  assert.equal(hitAltBand(null, 'ge4500'), false);
});

test('最高档命中集合与直算口径一致(不靠硬编码条数)', () => {
  const top = ALT_BANDS.find((b) => b.max === null || b.max === undefined);
  assert.ok(top, '要有一档上不封顶(max 留空)');
  const viaBand = Object.entries(TRAILS)
    .filter(([, t]) => hitAltBand(t, top.key)).map(([id]) => id).sort();
  const viaCalc = Object.entries(TRAILS)
    .filter(([, t]) => Number.isFinite(t.maxAltM) && t.maxAltM >= top.min).map(([id]) => id).sort();
  assert.deepEqual(viaBand, viaCalc, `档位 ${top.key} 与直算 >=${top.min}m 结果不一致`);
  assert.ok(viaCalc.length > 0, '最高档一条都没有,这个筛选是摆设');
});

test('byAlt 海拔降序,缺值一律排最后且不参与比较', () => {
  const rows = [{ id: 'mid', maxAltM: 3830 }, { id: 'none' },
    { id: 'hi', maxAltM: 5630 }, { id: 'lo', maxAltM: 2100 }];
  assert.deepEqual([...rows].sort(byAlt).map((r) => r.id), ['hi', 'mid', 'lo', 'none']);
  // 缺值在任意参数位置都要排后面:比较器不能依赖调用顺序
  assert.ok(byAlt({ id: 'a' }, { id: 'b', maxAltM: 100 }) > 0, '缺值在前时应被判为更大(排后)');
  assert.ok(byAlt({ id: 'b', maxAltM: 100 }, { id: 'a' }) < 0, '缺值在后时应被判为更小(排前)');
  // 同海拔不产生虚假次序
  assert.equal(byAlt({ maxAltM: 4000 }, { maxAltM: 4000 }), 0);
});

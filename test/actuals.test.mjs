// 实走记录:走过之后把"实际走了多少"记下来,与线路库的规划值并排比差。
//
// 为什么要它:trails.json 的 days/distanceKm/climbM 是抄来的数(没有 source 字段),
// 而 data/marks.json 已经存了 doneAt(哪天走过)——只差实测量这一步。
// 记下来之后有两个用处:① 卡片直接告诉用户"这条线实际比标称多走 18%",
// ② 差得多的条目就是该复核的数据(阈值 REVIEW_PCT),喂给待核清单。
//
// 输入来自手改 data/marks.json(与 trails.json 同一套"改 JSON 即生效"的用法),
// 字段:actualDays / actualDistanceKm / actualClimbM。
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(new URL('../package.json', import.meta.url));
const test = require('node:test');
const assert = require('node:assert');

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { actualVsPlanned, REVIEW_PCT } = require('./lib/actuals.js');

const row = (r, key) => r.rows.find((x) => x.key === key);

test('没记实测量时不出任何一行(当前全库 marks 都是这个状态,老卡片不加噪音)', () => {
  const t = { days: 7, distanceKm: 120, climbM: 5500 };
  assert.deepEqual(actualVsPlanned(t, {}).rows, []);
  assert.deepEqual(actualVsPlanned(t, { doneAt: '2026-08-01' }).rows, []);
  assert.deepEqual(actualVsPlanned(t, null).rows, []);
  assert.deepEqual(actualVsPlanned(null, { actualDays: 7 }).rows, []);
});

test('三项都记时逐行给出差值,百分比按 (实-规)/规 四舍五入', () => {
  const r = actualVsPlanned(
    { days: 7, distanceKm: 120, climbM: 5500 },
    { actualDays: 8, actualDistanceKm: 132, actualClimbM: 4950 });
  assert.equal(r.rows.length, 3);
  assert.equal(row(r, 'distanceKm').diffPct, 10, '120→132 应是 +10%');
  assert.equal(row(r, 'climbM').diffPct, -10, '5500→4950 应是 -10%');
  assert.equal(row(r, 'days').diffPct, 14); // 7→8 = +14.28% → 14
  assert.equal(row(r, 'distanceKm').planned, 120);
  assert.equal(row(r, 'distanceKm').actual, 132);
});

test('复核阈值边界:差 16% 判待复核,差 15% 不判(判据要钉在边界上)', () => {
  assert.equal(REVIEW_PCT, 15);
  const at15 = actualVsPlanned({ distanceKm: 100 }, { actualDistanceKm: 115 });
  const at16 = actualVsPlanned({ distanceKm: 100 }, { actualDistanceKm: 116 });
  assert.equal(row(at15, 'distanceKm').review, false, '正好 15% 不该判');
  assert.equal(row(at16, 'distanceKm').review, true, '超过 15% 该判');
  // 负方向同样算:少标 16% 也是数据可疑
  const neg = actualVsPlanned({ distanceKm: 100 }, { actualDistanceKm: 84 });
  assert.equal(row(neg, 'distanceKm').review, true, '低估与高估同等可疑');
});

test('规划值缺失或为 0 时不出该行(不做除零,也不给 Infinity%)', () => {
  for (const planned of [{}, { distanceKm: 0 }, { distanceKm: -5 }, { distanceKm: '120' }]) {
    const r = actualVsPlanned(planned, { actualDistanceKm: 130 });
    assert.deepEqual(r.rows, [], `规划值 ${JSON.stringify(planned)} 不该产出行`);
  }
});

test('实走值非法时进 bad 并可见,不静默丢弃也不整条炸', () => {
  for (const bad of ['十三', -3, 0, NaN, {}]) {
    const r = actualVsPlanned({ distanceKm: 120 }, { actualDistanceKm: bad });
    assert.deepEqual(r.rows, [], `非法实走值 ${JSON.stringify(bad)} 不该产出行`);
    assert.deepEqual(r.bad, ['actualDistanceKm'], `非法值要留在 bad 里: ${JSON.stringify(bad)}`);
  }
});

test('没填(null/undefined)与填错要分开:没填不打扰,填了错要吭一声', () => {
  // 手改 JSON 时常把字段留成 null 表示"清空",这不该被当成脏数据反复提醒
  for (const absent of [undefined, null]) {
    const r = actualVsPlanned({ distanceKm: 120 }, { actualDistanceKm: absent });
    assert.deepEqual(r.rows, []);
    assert.deepEqual(r.bad, [], `未填(${String(absent)})不该进 bad`);
  }
});

test('只记了部分维度时只出行记了的那部分', () => {
  const r = actualVsPlanned({ days: 7, distanceKm: 120, climbM: 5500 }, { actualClimbM: 6000 });
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].key, 'climbM');
  assert.equal(r.rows[0].diffPct, 9); // 5500→6000 = +9.09%
});

test('每行自带单位与标签,渲染层不必再猜', () => {
  const r = actualVsPlanned({ days: 7 }, { actualDays: 8 });
  const d = row(r, 'days');
  assert.ok(d.label && typeof d.label === 'string');
  assert.ok(d.unit && typeof d.unit === 'string');
});

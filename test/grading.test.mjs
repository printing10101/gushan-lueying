import { createRequire } from 'module';
const require = createRequire(new URL('../package.json', import.meta.url));
const { GRADE_LABELS, computeBreakdown, describe } = require('./lib/grading.js');
const test = require('node:test');
const assert = require('node:assert');

test('参考线路的建议级别:与数据维护的星级相差不超一级', () => {
  // 长坪沟:木栈道+14km+600m爬升,景区轻松线 → 建议入门(数据评 ★1 休闲,差一级可接受)
  assert.equal(computeBreakdown({ days: 1, distanceKm: 14, climbM: 600, maxAltM: 3760 }).suggested, 2);
  // 五台山朝台:2天50km+2500m → 进阶
  assert.equal(computeBreakdown({ days: 2, distanceKm: 50, climbM: 2500, maxAltM: 3061 }).suggested, 3);
  // 冈仁波齐:体力中等但卓玛拉垭口5630m → 高难(数据评 ★3,差一级,海拔主导合理)
  assert.equal(computeBreakdown({ days: 3, distanceKm: 57, climbM: 2000, maxAltM: 5630 }).suggested, 4);
  // 乌孙古道:7天120km+技术地形+多日重装 → 极限
  const wusun = computeBreakdown({ days: 7, distanceKm: 120, climbM: 5500, maxAltM: 3830, techLevel: 2 });
  assert.equal(wusun.suggested, 5);
  // 香八拉:城市拉练 → 休闲
  assert.equal(computeBreakdown({ days: 1, distanceKm: 12, climbM: 600, maxAltM: 575 }).suggested, 1);
});

test('评级维度分项可解释', () => {
  const b = computeBreakdown({ days: 2, distanceKm: 20, climbM: 1000, maxAltM: 1300 });
  assert.equal(b.exertion, 1.5); // 10km/12 + 500m/800
  assert.equal(b.altitude, 0);   // 1300m < 3000m
  assert.equal(b.technical, 0);  // 默认成熟步道
  assert.equal(b.load, 0);       // 2 天不加重装加成
  assert.ok(b.total > 0);
});

test('技术地形与多日重装会抬高建议级别', () => {
  const base = { days: 5, distanceKm: 60, climbM: 2500, maxAltM: 4200 }; // 建议进阶
  assert.equal(computeBreakdown(base).suggested, 3);
  assert.equal(computeBreakdown({ ...base, techLevel: 1 }).suggested, 4); // 达坂/涉水 +1
  // 同样的日均强度,天数更长时补给/扎营负担仍会抬分
  const long = { ...base, days: 9, distanceKm: 108, climbM: 4500 };
  assert.ok(computeBreakdown(long).total > computeBreakdown(base).total);
});

test('标签表与 describe', () => {
  assert.deepEqual(GRADE_LABELS, { 1: '休闲', 2: '入门', 3: '进阶', 4: '高难', 5: '极限' });
  const d = describe({ name: '测试线', grade: 3, days: 2 });
  assert.equal(d.name, '测试线');
  assert.equal(d.gradeLabel, '进阶');
});

// —— 脏数据不许被悄悄编成一个星级 ——
// 下面每个断言都对应一个真实踩过的坑:NaN 跟任何阈值比较都是 false,会穿过全部
// if 落到最后的 else,于是一条数据不明的线路被贴上「★5 极限」。对入门者这是
// 方向性误导——本该被难度闸门挡掉的线,反而顶着最高难度出现在推荐里。
test('days 非法(字符串/null/0)不产生 NaN,也不误判为最高难度', () => {
  const base = { distanceKm: 50, climbM: 1000, maxAltM: 3000 };
  for (const days of ['abc', null, 0, undefined, -3, NaN]) {
    const r = computeBreakdown({ ...base, days });
    assert.ok(Number.isFinite(r.total), `days=${JSON.stringify(days)} 产出了非有限 total: ${r.total}`);
    assert.ok(r.total > 0, `days=${JSON.stringify(days)} 让 total 归零了:${r.total}`);
    assert.ok(r.suggested !== 5 || r.total >= 5.2,
      `days=${JSON.stringify(days)} 在 total=${r.total} 时被判为 ★5,说明比较逻辑被 NaN 穿透了`);
    assert.equal(r.usable, true, `days 非法不该让整条评级作废(它只是除数,回落 1 天即可)`);
  }
});

test('核心指标缺失或非法 → 明说「数据不足」,不编一个 ★1 或 ★5', () => {
  // 这里的危险不是 NaN,而是反向误导:里程/爬升缺失时若收成 0 继续算,
  // 会算出 total=0 → 「★1 休闲」。用户点进去发现啥也没写,却被告知这是轻松线。
  const bads = [
    ['全脏', { days: 'a', distanceKm: 'b', climbM: 'c', maxAltM: 'd' }],
    ['distanceKm 字符串', { days: 3, distanceKm: 'x', climbM: 1000, maxAltM: 3000 }],
    ['climbM 缺失', { days: 3, distanceKm: 50 }],
    ['负数里程', { days: 3, distanceKm: -5, climbM: -1, maxAltM: -999 }],
    ['空对象', {}],
  ];
  for (const [name, t] of bads) {
    const r = computeBreakdown(t);
    assert.equal(r.usable, false, `${name} 应判定为数据不足`);
    assert.equal(r.suggested, null, `${name} 不该给出建议星级,实际给了 ★${r.suggested}`);
    assert.equal(r.label, '数据不足', `${name} 标签应为「数据不足」`);
  }
});

test('正常数据的 usable 恒为 true(修复不能误伤真实线路)', () => {
  for (const t of [
    { days: 1, distanceKm: 14, climbM: 600, maxAltM: 3760 },
    { days: 7, distanceKm: 120, climbM: 5500, maxAltM: 3830, techLevel: 2 },
    // 0 里程 0 爬升是合法的(纯城市公园步道),不该被判成「数据不足」
    { days: 1, distanceKm: 0, climbM: 0, maxAltM: 100 },
  ]) {
    assert.equal(computeBreakdown(t).usable, true,
      `${JSON.stringify(t)} 是合法数据,不该被判为数据不足`);
  }
});

test('techLevel 非法档位(99/null)不产生 NaN', () => {
  // 说明:这里只测「非法档位不能造出 NaN」这一条真实风险。
  // 不测「|| vs ??」——实测两者在 0/1/2/undefined/null 下逐一同值
  // (TECH_SCORE[0] 本来就是 0,|| 把它兜到 0 上还是 0),改成 || 不会让测试变红。
  // 写一条抓不住变异的断言,只会给人「这里有防线」的错觉。
  assert.equal(computeBreakdown({ days: 3, distanceKm: 50, climbM: 1000, maxAltM: 3000, techLevel: 99 }).technical, 0);
  assert.equal(computeBreakdown({ days: 3, distanceKm: 50, climbM: 1000, maxAltM: 3000, techLevel: null }).technical, 0);
  for (const techLevel of [99, null, undefined, 'x', -1, {}]) {
    const r = computeBreakdown({ days: 3, distanceKm: 50, climbM: 1000, maxAltM: 3000, techLevel });
    assert.ok(Number.isFinite(r.total), `techLevel=${String(techLevel)} 产出了非有限 total`);
  }
});

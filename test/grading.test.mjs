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

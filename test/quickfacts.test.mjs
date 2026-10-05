import { createRequire } from 'module';
const require = createRequire(new URL('../package.json', import.meta.url));
const { quickFacts, resupplyGap, DAY_KM_WARN, DAY_CLIMB_WARN } = require('./lib/quickfacts.js');
const test = require('node:test');
const assert = require('node:assert');

const byLabel = (facts, label) => facts.find((f) => f.label === label);
const trail = (over = {}) => ({ name: '测试线', days: 3, type: '进阶', scenery: [], ...over });

test('日均折算:总量除以天数,给出可复算的数字来源', () => {
  const facts = quickFacts(trail({ days: 3, distanceKm: 30, climbM: 1200, maxAltM: 2500 }));
  assert.equal(byLabel(facts, '日均里程').value, '约 10 km/天');
  assert.equal(byLabel(facts, '日均里程').why, '全程 30km ÷ 3 天');
  assert.equal(byLabel(facts, '日均爬升').value, '约 400 m/天');
  assert.equal(byLabel(facts, '最高海拔').value, '2500 m');
});

test('超量级日均里程/爬升要 warn(该留意的程度,不是报错)', () => {
  const heavy = quickFacts(trail({ days: 2, distanceKm: 60, climbM: 3000 }));
  assert.equal(byLabel(heavy, '日均里程').warn, true);
  assert.equal(byLabel(heavy, '日均里程').value, `约 ${60 / 2} km/天`);
  assert.equal(byLabel(heavy, '日均爬升').warn, true);
  assert.ok(30 > DAY_KM_WARN && 1500 > DAY_CLIMB_WARN);
  const light = quickFacts(trail({ days: 5, distanceKm: 20, climbM: 500 }));
  assert.equal(byLabel(light, '日均里程').warn, false);
  assert.equal(byLabel(light, '日均爬升').warn, false);
});

test('高海拔独立 warn:里程短但 4000m+ 照样提醒(高反不看你体力)', () => {
  const facts = quickFacts(trail({ days: 1, distanceKm: 5, climbM: 300, maxAltM: 4500 }));
  assert.equal(byLabel(facts, '日均里程').warn, false);
  assert.equal(byLabel(facts, '最高海拔').warn, true);
  assert.ok(byLabel(facts, '最高海拔').why.includes('高反'));
});

test('无补给判定:优先看原文点名,其次多日重装,判不了就 null', () => {
  assert.equal(resupplyGap(trail({ days: 5, supplies: '无补给,需马帮支持' })), 5);
  assert.equal(resupplyGap(trail({ days: 9, summary: '全程马帮驮包' })), 9);
  assert.equal(resupplyGap(trail({ days: 8, type: '长线重装' })), 8);
  assert.equal(resupplyGap(trail({ days: 2, supplies: '沿途村庄补给' })), null);
  assert.equal(resupplyGap(trail({ days: 1, type: '休闲' })), null);
});

test('补给判不了时明说未标注,不给编出来的数字', () => {
  const facts = quickFacts(trail({ days: 1, supplies: '' }));
  const gap = byLabel(facts, '最长无补给');
  assert.equal(gap.value, '未标注');
  assert.equal(gap.warn, false);
  assert.ok(gap.why.includes('未标注'));
});

test('全程无补给要写明措辞而不是天数,且 warn', () => {
  const facts = quickFacts(trail({ days: 5, supplies: '无补给,需马帮支持' }));
  const gap = byLabel(facts, '最长无补给');
  assert.equal(gap.value, '全程无补给');
  assert.equal(gap.warn, true);
});

test('字段缺失就不给该项,不产出 NaN', () => {
  const facts = quickFacts(trail({ days: 2, distanceKm: undefined, climbM: null }));
  assert.equal(byLabel(facts, '日均里程'), undefined);
  assert.equal(byLabel(facts, '日均爬升'), undefined);
  assert.ok(facts.every((f) => !String(f.value).includes('NaN')));
  assert.equal(quickFacts(null).length, 0);
});

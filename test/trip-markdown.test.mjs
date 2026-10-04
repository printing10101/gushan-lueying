import { createRequire } from 'module';
const require = createRequire(new URL('../package.json', import.meta.url));
const { tripToMarkdown } = require('./lib/trip-markdown.js');
const test = require('node:test');
const assert = require('node:assert');

const trip = {
  id: '20261010-chuanxi',
  regionName: '川西小环线',
  generatedAt: '2026-10-04T12:00:00.000Z',
  input: { days: 5, headcount: 2, startDate: '2026-10-10', originStation: '西安北', trailId: 'dangling' },
  trail: { name: '党岭', grade: 3 },
  schedule: [
    { date: '2026-10-11', type: 'drive', legs: [{ from: '成都', to: '四姑娘山镇', km: 230, hours: 4.5, costs: { driveTotal: 300 } }] },
    { date: '2026-10-12', type: 'hike', info: { name: '党岭', climbM: 900, grade: 3, gradeLabel: '进阶', summary: '葫芦海经典线' }, seasonWarn: '10 月不在最佳月份' },
    { date: '2026-10-13', type: 'rest' },
    { date: '2026-10-14', type: 'note', text: '行程对齐提示' },
  ],
  railOut: { chosen: { code: 'D1918', startTime: '07:00', arriveTime: '11:00' }, seat: { label: '二等座', price: 216 }, prices: { 二等座: 216 } },
  railBack: {},
  budget: {
    items: [{ name: '火车去程', amount: 432, note: 'D1918 二等座 ×2人' }],
    total: 1000, unknownCount: 0, perPerson: 500, headcount: 2,
  },
  weather: { node: '丹巴', forecast: [{ date: '2026-10-12', label: '多云', tempMin: 5, tempMax: 15, precipProb: 30, verdict: '观察' }] },
};

test('tripToMarkdown:段落齐全,车次/预算/天气如实渲染', () => {
  const md = tripToMarkdown(trip, { gradeLabels: { 3: '进阶' }, seatOf: () => null });
  assert.match(md, /# 川西小环线 · 5 天/);
  assert.match(md, /- 徒步:党岭\(★3 进阶\)/);
  assert.match(md, /### 2026-10-11 · 驾车/);
  assert.match(md, /- 成都 → 四姑娘山镇:230km \/ 4\.5h,油\+过路 ¥300/);
  assert.match(md, /## 去程火车:D1918 07:00→11:00\(二等座 ¥216\/人\)/);
  assert.match(md, /## 回程火车:没有可购车次/);
  assert.match(md, /\| \*\*合计\*\* \| \*\*¥1000\*\* \| 2 人 · 人均 ¥500 \|/);
  assert.match(md, /- 2026-10-12:多云 5~15℃,降水 30% → 观察/);
  assert.match(md, /> ⚠ 10 月不在最佳月份/);
  assert.match(md, /实价以出发前复核为准/);
});

test('tripToMarkdown:无 seat 时走注入的兜底选座', () => {
  const copy = { ...trip, railOut: { chosen: trip.railOut.chosen, prices: { 硬卧: 280 } }, railBack: {} };
  const md = tripToMarkdown(copy, {
    gradeLabels: {},
    seatOf: (prices) => (prices?.硬卧 ? { label: '硬卧', price: prices.硬卧 } : null),
  });
  assert.match(md, /硬卧 ¥280\/人/);
});

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

// ---- 日照窗口:纯徒步日的收队时间(缺日出日落就不写,不猜时间) ----
test('tripToMarkdown:徒步日带日照窗口与建议收队时间(由调用方注入计算)', () => {
  const trip = {
    regionName: '测试环线', id: 't1', input: { days: 3, headcount: 1, startDate: '2026-10-15', originStation: 'X' },
    generatedAt: '2026-10-08T00:00:00.000Z',
    schedule: [{ date: '2026-10-16', type: 'hike', trail: '甲线', info: { name: '甲线', climbM: 500, grade: 2 } }],
    railOut: { chosen: null }, railBack: { chosen: null },
    budget: { items: [], total: 0, perPerson: 0 },
    weather: { node: 'N', forecast: [{ date: '2026-10-16', label: '晴', tempMin: 5, tempMax: 18, precipProb: 10, verdict: '宜', sunrise: '07:12', sunset: '18:40' }] },
  };
  // 用真实的 daylightPlan 当注入实现(它自己另有单测)
  const { daylightPlan } = require('./lib/gear.js');
  const md = tripToMarkdown(trip, { daylightOf: daylightPlan });
  assert.match(md, /日照窗口 07:12 → 18:40/, '日出日落要写进导出件: ' + md.slice(0, 200));
  assert.match(md, /建议 17:40 前收队/, '要给出可执行的收队时间(日落前 1 小时)');
});

test('tripToMarkdown:没有日出日落数据时不写日照行(不编时间)', () => {
  const trip = {
    regionName: 'x', id: 't2', input: { days: 1, headcount: 1, startDate: '2026-10-15', originStation: 'X' },
    generatedAt: '', schedule: [{ date: '2026-10-15', type: 'hike', trail: '甲线', info: { name: '甲线' } }],
    railOut: { chosen: null }, railBack: { chosen: null },
    budget: { items: [], total: 0, perPerson: 0 },
    weather: { node: 'N', forecast: [{ date: '2026-10-15', label: '晴', tempMin: 5, tempMax: 18, precipProb: 10, verdict: '宜' }] },
  };
  const { daylightPlan } = require('./lib/gear.js');
  assert.ok(!tripToMarkdown(trip, { daylightOf: daylightPlan }).includes('日照窗口'));
});

// 住宿档次长在预算数字里,而打印稿的读者点不开控件反查 —— 所以导出必须**总是**写明档次,
// 与页面表头刻意不同(表头只在非基准档才写,避免噪音)。这条同时钉住旧档名迁移。
test('tripToMarkdown:导出口径必须写明住宿档次(含旧档名迁移与无字段兜底)', () => {
  const withTier = (tier) => {
    const c = { ...trip, input: { ...trip.input } };
    if (tier === undefined) delete c.input.tier; else c.input.tier = tier;
    return tripToMarkdown(c, { tierAlias: { 经济: '青旅', 舒适: '客栈' } });
  };
  assert.match(withTier('青旅'), /住宿按「青旅档」估算/);
  assert.match(withTier('酒店'), /住宿按「酒店档」估算/);
  // 基准档也要写:它是最容易被"省掉"的一档,而省掉就等于不写口径
  assert.match(withTier('客栈'), /住宿按「客栈档」估算/);
  assert.match(withTier(undefined), /住宿按「客栈档」估算/, '旧档没有 tier 字段 → 它当时就是按客栈算的');
  assert.match(withTier('经济'), /住宿按「青旅档」估算/, '旧档名要迁移,不能原样吐出去');
  // 别把"餐饮"那半句弄丢(改这段时最容易顺手删掉)
  assert.match(withTier('青旅'), /餐饮按 config 口径估算/);
});

test('tripToMarkdown:口径行紧跟在预算表后,不落到文档末尾', () => {
  const md = tripToMarkdown({ ...trip, input: { ...trip.input, tier: '青旅' } });
  const at = md.indexOf('住宿按「青旅档」估算');
  const table = md.lastIndexOf('| **合计**');
  assert.ok(at > table, '口径行要在预算表之后');
  // 预算表与口径行之间不能隔着别的章节(否则读者在表旁找不到口径)
  assert.ok(md.slice(table, at).indexOf('## ') === -1,
    '口径行必须紧跟预算表,中间不能插进新章节');
});

// 离线包:一次产出的四个文件都要能独立用,且数据缺时不产出空壳标题。
import { createRequire } from 'module';
const require = createRequire(new URL('../package.json', import.meta.url));
const test = require('node:test');
const assert = require('node:assert');

const { packFiles, packDirName } = require('./lib/pack.js');
const { parseGpx } = require('./lib/gpx.js');

const region = { name: '京北', loop: [
  { name: 'A', lng: 116.4, lat: 39.9 }, { name: 'B', lng: 115.7, lat: 40.0 }, { name: 'A', lng: 116.4, lat: 39.9 },
] };
const trail = { name: '合成线', grade: 2, days: 1, supplies: '景区有补给', risks: ['风大'],
  maxAltM: 3800, techLevel: 0, bestMonths: [12], start: { lng: 116.0, lat: 39.95 } };
const trip = {
  id: '20261020-jingbei2', regionName: '京北·密云长城环线',
  input: { days: 3, headcount: 2, startDate: '2026-10-20', originStation: '西安北', regionId: 'jingbei2' },
  generatedAt: '2026-10-08T00:00:00.000Z', trail,
  schedule: [
    { date: '2026-10-21', type: 'drive', nodes: ['A', 'B'],
      legs: [{ from: 'A', to: 'B', km: 120, hours: 2, costs: { driveTotal: 100 }, path: '116.4,39.9;115.7,40.0' }] },
    { date: '2026-10-22', type: 'hike', trail: '合成线', node: 'B',
      info: { name: '合成线', climbM: 700, grade: 2, gradeLabel: '入门' } },
  ],
  gear: [{ item: '头灯与备用电池', reason: '徒步日日照仅 8.5 小时' }],
  railOut: { date: '2026-10-20', chosen: null, presale: true }, railBack: { date: '2026-10-22', chosen: null },
  budget: { items: [{ name: '火车去程', amount: 300, note: '占位估算' }], total: 300, perPerson: 150, headcount: 2, unknownCount: 1 },
  weather: { node: 'B', forecast: [{ date: '2026-10-22', label: '晴', tempMin: 5, tempMax: 18, precipProb: 10, verdict: '宜', sunrise: '06:28', sunset: '17:20' }], byDate: {} },
};

test('packDirName:日期+区域名,且不含文件系统非法字符', () => {
  assert.equal(packDirName(trip), '20261020-京北·密云长城环线-离线包');
  assert.equal(packDirName({ input: { startDate: '2026-01-02' }, regionName: 'a/b:c*d?e"f<g>h|i j' }),
    '20260102-abcdefghij-离线包');
});

test('packFiles:四个文件齐全,名字固定(用户按名字找东西)', () => {
  const files = packFiles(trip, region, { daylightOf: require('./lib/gear.js').daylightPlan });
  assert.deepEqual(files.map((f) => f.name).sort(),
    ['驾车轨迹.gpx', '存档.json', '行程.md', '行前清单.md'].sort());
});

test('packFiles:行程.md 带着预算与无票原因(离线也要能看懂为什么没票)', () => {
  const md = packFiles(trip, region).find((f) => f.name === '行程.md').content;
  assert.match(md, /# 京北·密云长城环线 · 3 天/);
  assert.match(md, /预售期|占位估算/);
  assert.match(md, /\| 火车去程 \|/);
});

test('packFiles:行前清单含装备与一次性开销,但两者都不给金额', () => {
  const c = packFiles(trip, region).find((f) => f.name === '行前清单.md').content;
  assert.match(c, /## 装备\(1 项/);
  assert.match(c, /- \[ \] 头灯与备用电池 —— 徒步日日照仅 8\.5 小时/, '装备要带触发原因,便于复核');
  assert.match(c, /## 一次性开销/, 'maxAltM 3800 会命中高原保险那条');
  assert.match(c, /按保额与人数另计/);
  assert.ok(!/¥\s*\d/.test(c), '清单里不该出现任何金额: ' + c.slice(0, 200));
});

test('packFiles:行前清单带日照窗口(徒步日取得到天气时)', () => {
  const c = packFiles(trip, region, { daylightOf: require('./lib/gear.js').daylightPlan })
    .find((f) => f.name === '行前清单.md').content;
  assert.match(c, /## 日照/);
  assert.match(c, /日出 06:28 → 日落 17:20/);
  assert.match(c, /建议 16:20 前收队/);
});

test('packFiles:gpx 能被自家解析器读回来(离线包里的轨迹必须是真轨迹)', () => {
  const gpxText = packFiles(trip, region).find((f) => f.name === '驾车轨迹.gpx').content;
  const back = parseGpx(gpxText);
  assert.equal(back.ok, true, back.error);
  assert.equal(back.points, 2);
  assert.ok(back.distanceKm > 50 && back.distanceKm < 90, '京北到密云约 70km 量级,实得 ' + back.distanceKm);
});

test('packFiles:存档.json 能原样解析回来', () => {
  const raw = packFiles(trip, region).find((f) => f.name === '存档.json').content;
  const back = JSON.parse(raw);
  assert.equal(back.id, trip.id);
  assert.equal(back.schedule.length, 2);
  assert.equal(back.budget.total, 300);
});

test('packFiles:没有线路/装备/天气时仍产出四个文件,不抛错也不留空壳标题', () => {
  const bare = { id: 'x', regionName: 'R', input: { days: 1, headcount: 1, startDate: '2026-10-20' },
    schedule: [], budget: { items: [], total: 0, perPerson: 0 } };
  const files = packFiles(bare, null);
  assert.equal(files.length, 4);
  const c = files.find((f) => f.name === '行前清单.md').content;
  assert.ok(!c.includes('## 装备'), '没有装备就不该出现空的装备小节');
  assert.ok(!c.includes('## 一次性开销'));
  assert.ok(!c.includes('## 日照'), '取不到天气就不写日照');
  assert.match(c, /# 行前清单/);
});

// checklistMarkdown 此前零引用(只通过 packFiles 间接跑到),
// 而它有几个"数据缺就少写那一段"的分支,不直接钉住就会被 packFiles 的整体断言放过。
test('checklistMarkdown:缺数据的段落整段不写(不留空壳标题)', () => {
  const { checklistMarkdown } = require('./lib/pack.js');
  const bare = { regionName: '测试区', input: { days: 5, startDate: '2026-10-20' } };
  const md = checklistMarkdown(bare, {});
  assert.ok(md.includes('# 行前清单'), '标题总要有');
  assert.ok(!md.includes('## 装备'), '没有装备数据就不出装备段');
  assert.ok(!md.includes('## 补给'), '没有线路就不出补给段');
  assert.ok(!md.includes('## 报备'), '没有线路就不出报备段');
  assert.ok(!md.includes('## 日照'), '算不出日照就不出日照段');
});

test('checklistMarkdown:有装备时每条带触发原因,可打勾', () => {
  const { checklistMarkdown } = require('./lib/pack.js');
  const md = checklistMarkdown({
    regionName: '测试区', input: { days: 5, startDate: '2026-10-20' },
    gear: [{ item: '头灯与备用电池', reason: '徒步日日照仅 8.5 小时' }],
  }, {});
  assert.ok(md.includes('- [ ] 头灯与备用电池 —— 徒步日日照仅 8.5 小时'), `打勾项要带原因:${md}`);
  assert.ok(md.includes('## 装备(1 项'), '要报条数');
});

test('checklistMarkdown:一次性开销只列要不要准备,绝不出金额', () => {
  const { checklistMarkdown } = require('./lib/pack.js');
  const md = checklistMarkdown({
    regionName: '测试区', input: { days: 5, startDate: '2026-01-20' },
    trail: { name: '雪山线', grade: 4, days: 5, maxAltM: 4500, type: '重装', supplies: '全程无补给' },
  }, {});
  assert.ok(md.includes('## 一次性开销'), '该触发的规则要触发');
  assert.ok(!/¥\s*\d/.test(md), `清单里不允许出现金额:${md}`);
  assert.ok(/另计|另询/.test(md), '每条都要注明"另计/另询"');
});

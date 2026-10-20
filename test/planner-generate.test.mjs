// planner.generate 的端到端单测。
//
// 为什么非要这一份:generate 是行程生成的**唯一入口**,此前在任何单测里零引用,
// 只被 scripts/smoke-region.mjs(要真网络 + 真 Key)端到端跑到——也就是说
// `npm test` 对它一行覆盖都没有。改坏了要等哪天手跑冒烟才可能发现。
//
// 怎么做到不碰网络:generate 依赖的五个外部模块都从 require 缓存里拿同一个对象,
// 在**本文件内**替换它们的导出即可(node --test 每个文件独立进程,不会污染别的测试)。
// routeProvider 走 'estimate'(config 不给 Key)→ 里程由 amap.estimatedRoute 本地算。
import { createRequire } from 'module';
const require = createRequire(new URL('../package.json', import.meta.url));
const test = require('node:test');
const assert = require('node:assert');

const planner = require('./lib/planner.js');
const store = require('./lib/store.js');
const rail = require('./lib/rail12306.js');
const weather = require('./lib/weather.js');
const oilprice = require('./lib/oilprice.js');
const runos = require('./lib/runos.js');

// ---------- 假数据 ----------
const REGION = {
  name: '测试环线',
  province: '四川',
  hub: { railStation: '成都东', city: '成都' },
  // 闭环:首尾都是成都,与真实 regions.json 同形状
  loop: [
    { name: '成都', lng: 104.07, lat: 30.66 },
    { name: '映秀', lng: 103.48, lat: 31.06 },
    { name: '成都', lng: 104.07, lat: 30.66 },
  ],
  stay: { perRoomPerNight: 200, perPersonPerDay: 80 },
};
const TRAIL = {
  id: 't1', name: '测试线', regionId: 'testregion', node: '映秀',
  days: 2, grade: 2, distanceKm: 20, climbM: 1000, maxAltM: 3200, status: '开放',
  tickets: 50, ticketSource: { source: '测试公示', checkedAt: '2026-10-08' },
  bestMonths: [10], start: { lng: 103.48, lat: 31.06 }, scenery: ['雪山'],
  supplies: '沿途有补给', risks: ['落石'],
};
const CONFIG = {
  fuel: { consumptionLPer100km: 8, pricePerL: 8.2, gasType: '92#' },
  lodging: { perRoomPerNight: 200, peoplePerRoom: 2 },
  food: { perPersonPerDay: 80 },
  maxDriveKmPerDay: 400,
};
const TRAIN = {
  code: 'G1', lishi: '04:00', startTime: '08:00', arriveTime: '12:00',
  canWebBuy: true, prices: { 二等座: 263 }, seats: { 二等座: '有' },
};
const dayForecast = (i) => ({
  date: `2026-10-${String(20 + i).padStart(2, '0')}`, label: '晴',
  tempMin: 5, tempMax: 18, precipProb: 10, windMax: 12, verdict: '宜',
  sunrise: '06:28', sunset: '17:20', elevation: 500,
});

// ---------- 打桩 ----------
let written = [];
let archive = new Map(); // trips/<id> → 内容,让 tripIdFor 的 lookup 能真的读回上一版
function installStubs({ trains = [TRAIN], trail = TRAIL, days = 5, config = CONFIG, region = REGION, trailMap = null } = {}) {
  written = [];
  archive = new Map();
  const trails = trailMap || { t1: { ...trail } };
  store.read = (name) => {
    if (name.startsWith('trips/')) return archive.get(name) || null;
    if (name === 'config') return { ...config };
    if (name === 'regions') return { testregion: region };
    if (name === 'trails') return trails;
    if (name === 'seasonality') return {};
    return null;
  };
  store.write = (name, content) => {
    archive.set(name, content);
    written.push({ name, content });
    return { ok: true };
  };
  rail.queryTrains = async () => ({ trains, stationNames: {}, queriedAt: new Date().toISOString() });
  rail.beyondPresale = () => false;
  rail.estimateRoundTrip = async () => null;
  weather.forecast = async () => Array.from({ length: 16 }, (_, i) => dayForecast(i));
  weather.forecastMany = async (pts) => pts.map((p) => ({
    ...p, forecast: Array.from({ length: 16 }, (_, i) => dayForecast(i)),
  }));
  oilprice.forFuel = async () => null; // 取不到实价 → 回落 config 并在备注言明
  runos.fetchBodyState = async () => ({ available: false, dataReady: false, matches: {} });
  return { trails };
}

const baseInput = (over = {}) => ({
  regionId: 'testregion', originStation: '西安北', startDate: '2026-10-20',
  days: 5, headcount: 2, trailIds: ['t1'], tier: '客栈', ...over,
});

test('generate:不碰网络也能排出一份完整行程(驾车日 + 徒步日 + 预算 + 存档)', async () => {
  installStubs();
  const trip = await planner.generate(baseInput());

  // 排期:成都→映秀(驾车) / 映秀徒步 2 天 / 映秀→成都(驾车)
  const types = trip.schedule.map((d) => d.type);
  assert.equal(types.filter((t) => t === 'drive').length, 2, `驾车日应为 2,实得 ${types.join(',')}`);
  assert.equal(types.filter((t) => t === 'hike').length, 2, `徒步日应为 2,实得 ${types.join(',')}`);
  assert.equal(trip.schedule[1].trail, '测试线', '徒步日要挂线路名');

  // 预算:火车按人头、门票按人头、住宿按房间数、自驾按整车
  const names = trip.budget.items.map((i) => i.name);
  assert.ok(names.some((n) => n.includes('火车去程')), `缺火车去程:${names.join('/')}`);
  assert.ok(names.some((n) => n.includes('火车回程')), `缺火车回程:${names.join('/')}`);
  assert.ok(names.some((n) => n.includes('徒步费用')), `缺门票项:${names.join('/')}`);
  assert.ok(names.some((n) => n.startsWith('住宿')), `缺住宿:${names.join('/')}`);
  assert.ok(names.some((n) => n.startsWith('餐饮')), `缺餐饮:${names.join('/')}`);
  assert.ok(trip.budget.total > 0, `合计应 >0,实得 ${trip.budget.total}`);
  assert.equal(trip.budget.perPerson, Math.round(trip.budget.total / 2), '人均 = 合计 ÷ 人数');
  // 门票 50 × 2 人 = 100(此前只按 1 人计,多人出行合计失真)
  const ticket = trip.budget.items.find((i) => i.name.includes('徒步费用'));
  assert.equal(ticket.amount, 100, '门票必须按人头乘');

  // 存档:只写一次,路径在 trips/ 下
  assert.equal(written.length, 1, `应写一份存档,实得 ${written.length}`);
  assert.match(written[0].name, /^trips\//, `存档路径:${written[0].name}`);
  assert.ok(trip.savedTo.includes('data/trips/'), `savedTo:${trip.savedTo}`);
});

test('generate:多线装备按各自节点天气推导,不拿第一条线的预报代替全部', async () => {
  const region = {
    name: '双节点测试环线', province: '四川', hub: { railStation: '成都东', city: '成都' },
    loop: [
      { name: '成都', lng: 104.07, lat: 30.66 },
      { name: '甲节点', lng: 103.9, lat: 31.0 },
      { name: '乙节点', lng: 103.7, lat: 31.2 },
      { name: '成都', lng: 104.07, lat: 30.66 },
    ],
    stay: { perRoomPerNight: 200, perPersonPerDay: 80 },
  };
  const a = { ...TRAIL, id: 'a', name: '甲线', node: '甲节点', days: 1, maxAltM: 4500 };
  const b = { ...TRAIL, id: 'b', name: '乙线', node: '乙节点', days: 1, maxAltM: 3000 };
  installStubs({ region, trailMap: { a, b } });
  // 第一条线所在节点降水 10%,第二条线所在节点降水 80%。
  // 旧实现用 weatherNode(第一条线)的单点预报推导所有线,雨具这一条会消失。
  weather.forecast = async () => Array.from({ length: 16 }, (_, i) => ({ ...dayForecast(i), precipProb: 10 }));
  weather.forecastMany = async (pts) => pts.map((p) => ({
    ...p,
    forecast: Array.from({ length: 16 }, (_, i) => ({ ...dayForecast(i), precipProb: p.name === '乙节点' ? 80 : 10 })),
  }));
  const trip = await planner.generate({ ...baseInput(), regionId: 'testregion', trailIds: ['a', 'b'], days: 6, headcount: 1 });
  const rain = trip.gear.find((i) => i.item.includes('雨具'));
  assert.ok(rain, `第二条线 80% 降水应推出雨具:${JSON.stringify(trip.gear)}`);
  assert.match(rain.reason, /80%/, `雨具原因必须引用第二条线自己的降水:${rain.reason}`);
});

test('generate:里程口径是估算时,页面与导出都要能说清(routeProvider=estimate)', async () => {
  installStubs();
  const trip = await planner.generate(baseInput());
  assert.equal(trip.routeProvider, 'estimate', '没配 Key 就该走估算');
  assert.equal(trip.distanceEstimated, true);
  assert.match(trip.kmNote, /直线/, ` kmNote 要写明是估算:${trip.kmNote}`);
  assert.ok(trip.schedule.some((d) => d.type === 'drive' && d.legs.some((l) => l.estimated)),
    '逐日卡片要带 estimated 标记,画线与预算都跟着口径走');
});

test('generate:同站出发直接报错(不给一张毫无意义的行程)', async () => {
  installStubs();
  await assert.rejects(() => planner.generate(baseInput({ originStation: '成都东' })),
    /枢纽站相同/, '出发站 == 区域枢纽要响亮报错');
});

test('generate:天数放不下时报错,并说清最少要几天', async () => {
  installStubs();
  await assert.rejects(() => planner.generate(baseInput({ days: 3 })),
    /至少要\s*\d+\s*天/, '3 天放不下 2 天徒步线,要给可执行提示');
});

test('generate:区域不存在时报错并列出可选区域', async () => {
  installStubs();
  await assert.rejects(() => planner.generate(baseInput({ regionId: 'nope' })),
    /testregion/, '报错里要带上现有区域,别让人猜');
});

test('generate:出发日期/天数非法时挡在入口(不写盘 NaN 存档)', async () => {
  installStubs();
  for (const bad of [{ startDate: '' }, { startDate: '2026-13-01' }, { days: 2 }, { days: 21 }, { days: 7.5 }, { originStation: '' }]) {
    await assert.rejects(() => planner.generate(baseInput(bad)),
      /行程输入不合法/, `${JSON.stringify(bad)} 应被入口校验挡下`);
  }
  assert.equal(written.length, 0, '校验失败绝不能写盘');
});

test('generate:门票未标注时计为未知,不按 0 混进合计', async () => {
  installStubs({ trail: { ...TRAIL, tickets: null, ticketSource: undefined } });
  const trip = await planner.generate(baseInput());
  const ticket = trip.budget.items.find((i) => i.name.includes('徒步费用'));
  assert.equal(ticket.amount, null, '未标注就该是 null');
  assert.match(ticket.note, /未标注/, `备注要说清:${ticket.note}`);
  assert.ok(trip.budget.unknownCount >= 1, 'unknownCount 要把它数进去');
  assert.ok(Number.isFinite(trip.budget.total), '合计仍要是有限数,不能变 NaN');
});

test('generate:同条件重生成会复用存档 id,但必须保留旧档的 actualCost', async () => {
  installStubs();
  const first = await planner.generate(baseInput());
  const key = `trips/${first.id}`;
  archive.set(key, { ...archive.get(key), actualCost: 321 });
  const second = await planner.generate(baseInput());
  assert.equal(second.id, first.id, '同条件重生成应复用同一个存档 id');
  assert.equal(archive.get(key).actualCost, 321, '重生成不能把已经记下的实际花费抹掉');
});

test('generate:headcount=Infinity 必须在入口被挡下,不写 NaN/Infinity 存档', async () => {
  installStubs();
  await assert.rejects(() => planner.generate(baseInput({ headcount: Infinity })), /出行人数非法/);
  assert.equal(written.length, 0, '非法人数不能写盘');
});

test('generate:油费配置缺失时在出门查询前报错,不写 ¥NaN 预算', async () => {
  installStubs({ config: { ...CONFIG, fuel: { consumptionLPer100km: 8 } } });
  await assert.rejects(() => planner.generate(baseInput()), /油费配置不完整/);
  assert.equal(written.length, 0, '油费配置坏时不能写盘');
});

test('generate:火车查不到车次时预算不留空洞(给占位估算并说明)', async () => {
  installStubs({ trains: [] });
  const trip = await planner.generate(baseInput());
  const out = trip.budget.items.find((i) => i.name.includes('火车去程'));
  assert.ok(out.note.length > 0, '必须说明为什么没有实价');
  assert.match(out.note, /占位估算|预售期|未查到|取价失败|没有可购车次/,
    `要分清"没车"与"没查上":${out.note}`);
  assert.ok(Number.isFinite(trip.budget.total), '合计仍要算得出来');
});

test('generate:存档 id 换线路/换人数就另开一档(不冲掉上一版)', async () => {
  installStubs();
  const a = await planner.generate(baseInput());
  // 第二份:人数不同 → 必须另开 id
  const b = await planner.generate(baseInput({ headcount: 3 }));
  assert.notEqual(b.id, a.id, `同日期同区域但人数不同,不能互相覆盖:${a.id} vs ${b.id}`);
  assert.equal(written.length, 2, '两份都要落盘');
});

test('generate:装备清单由线路字段与徒步日天气推导,带触发原因', async () => {
  installStubs();
  const trip = await planner.generate(baseInput());
  assert.ok(Array.isArray(trip.gear) && trip.gear.length > 0, '要有行前装备清单');
  for (const it of trip.gear) {
    assert.ok(it.item && it.reason, `每条都要带触发原因:${JSON.stringify(it)}`);
  }
});

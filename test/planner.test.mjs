import { createRequire } from 'module';
const require = createRequire(new URL('../package.json', import.meta.url));
const { planDays, pickTrail, addDays, stayBudget, pickCandidates, fuelPlan } = require('./lib/planner.js');
const test = require('node:test');
const assert = require('node:assert');

const loop = [
  { name: '成都' }, { name: '映秀' }, { name: '四姑娘山镇' }, { name: '丹巴' }, { name: '成都' },
];
const legs = [
  { from: '成都', to: '映秀', km: 100 },
  { from: '映秀', to: '四姑娘山镇', km: 150 },
  { from: '四姑娘山镇', to: '丹巴', km: 110 },
  { from: '丹巴', to: '成都', km: 340 },
];

test('planDays:环线 + 2 日徒步插在徒步节点', () => {
  const trail = { name: '党岭', node: '丹巴', days: 2 };
  const days = planDays(loop, legs, trail, 4, 400);
  assert.deepEqual(days.filter((d) => d.type === 'hike').length, 2);
  // 徒步日之前的驾车日应恰好结束在丹巴
  const firstDrive = days[0];
  assert.equal(firstDrive.type, 'drive');
  assert.deepEqual(firstDrive.nodes, ['成都', '映秀', '四姑娘山镇', '丹巴']);
  assert.equal(firstDrive.km, 360);
  // 徒步后继续走完闭环
  const after = days.slice(3);
  assert.equal(after[0].type, 'drive');
  assert.deepEqual(after[0].nodes, ['丹巴', '成都']);
  assert.equal(after[0].km, 340);
});

test('planDays:超过单日上限时切分并打 overKm 标记', () => {
  const days = planDays(loop, legs, null, 5, 300);
  // 100+150=250 继续累积;+110=360>300 → 该日 overKm 并在下一段后切分
  const flagged = days.filter((d) => d.overKm);
  assert.ok(flagged.length >= 1);
  const totalKm = days.filter((d) => d.type === 'drive').reduce((s, d) => s + d.km, 0);
  assert.equal(totalKm, 700); // 全程守恒
});

test('planDays:天数不足时给出提示日', () => {
  const days = planDays(loop, legs, null, 1, 200);
  const notes = days.filter((d) => d.type === 'note');
  assert.equal(notes.length, 1);
  assert.ok(notes[0].text.includes('超出'));
});

test('pickTrail:自动选放得下的最短线路', () => {
  const trails = {
    a: { regionId: 'cx', days: 2, name: '两天线' },
    b: { regionId: 'cx', days: 1, name: '一天线' },
    c: { regionId: 'other', days: 1, name: '别区域' },
  };
  assert.equal(pickTrail(trails, 'cx', null, 7).id, 'b');
  assert.equal(pickTrail(trails, 'cx', null, 4).id, 'b');
  assert.equal(pickTrail(trails, 'cx', 'a', 7).id, 'a');
  assert.throws(() => pickTrail(trails, 'cx', 'c', 7));
});

test('addDays:跨月', () => {
  assert.equal(addDays('2026-10-30', 3), '2026-11-02');
});

test('stayBudget:缺省配置用兜底值并在备注言明', () => {
  const [lodging, food] = stayBudget(7, 2, {});
  // 6 晚 × ¥200 × 1 间(2人一间)
  assert.equal(lodging.amount, 1200);
  assert.ok(lodging.note.includes('默认估算'));
  // 7 天 × ¥80 × 2 人
  assert.equal(food.amount, 1120);
});

test('stayBudget:配置值生效,房间数向上取整', () => {
  const cfg = { lodging: { perRoomPerNight: 300, peoplePerRoom: 2 }, food: { perPersonPerDay: 100 } };
  const [lodging, food] = stayBudget(5, 3, cfg);
  // 4 晚 × ¥300 × 2 间(3人 → ceil(3/2)=2 间)
  assert.equal(lodging.amount, 2400);
  assert.ok(lodging.note.includes('配置值'));
  assert.equal(food.amount, 1500);
});

test('pickCandidates:主选打头,补足到 5 趟,不含重复', () => {
  const ts = Array.from({ length: 8 }, (_, i) => ({ code: `T${i}` }));
  // 主选在第一位
  assert.deepEqual(pickCandidates(ts[2], ts).map((t) => t.code), ['T2', 'T0', 'T1', 'T3', 'T4']);
  // 无主选(没有可购车次)时取前 5
  assert.equal(pickCandidates(null, ts).length, 5);
  // 候选不足时有多少给多少
  assert.deepEqual(pickCandidates(ts[0], [ts[0], ts[1]]).map((t) => t.code), ['T0', 'T1']);
});

// ---------- 多人预算口径 ----------

const { railBudgetItems, hikeBudgetItem, downsamplePolyline, bestRestDays, hikeWeatherScore } =
  require('./lib/planner.js');

test('railBudgetItems:火车票按人头计,备注带坐席', () => {
  const leg = {
    chosen: { code: 'K1363', startTime: '22:02', arriveTime: '11:19+1', lishi: '13:17', seats: {} },
    seat: { label: '硬卧', price: 279.5 },
  };
  const [out, back] = railBudgetItems(leg, { ...leg, chosen: { ...leg.chosen, code: 'K118' } }, 3);
  assert.equal(out.amount, 279.5 * 3);
  assert.equal(out.note, 'K1363 硬卧 ×3人');
  assert.equal(back.note, 'K118 硬卧 ×3人');
});

test('railBudgetItems:无车次与超预售期分开说,金额未知', () => {
  const [none, presale] = railBudgetItems(
    { chosen: null, presale: false },
    { chosen: null, presale: true }, 2);
  assert.equal(none.amount, null);
  assert.equal(none.note, '没有可购车次');
  assert.ok(presale.note.includes('预售期'));
});

test('hikeBudgetItem:门票按人头,未标注按 0', () => {
  assert.equal(hikeBudgetItem({ name: '测试线', tickets: 60 }, 3).amount, 180);
  assert.ok(hikeBudgetItem({ name: '测试线', tickets: 60 }, 3).note.includes('3 人'));
  assert.equal(hikeBudgetItem({ name: '测试线' }, 2).amount, 0);
});

// ---------- 驾车路线抽稀 ----------

test('downsamplePolyline:点少原样保留,点多抽稀且首尾必在', () => {
  const pts = Array.from({ length: 10 }, (_, i) => `${100 + i * 0.1},${30 + i * 0.1}`);
  const short = pts.join(';');
  assert.equal(downsamplePolyline(short, 120), short);
  const long = Array.from({ length: 1000 }, (_, i) => `${100 + i * 0.001},${30}`).join(';');
  const out = downsamplePolyline(long, 120);
  const arr = out.split(';');
  assert.equal(arr.length, 120);
  assert.equal(arr[0], '100,30');
  assert.equal(arr[arr.length - 1], '100.999,30');
  // 乱码/坏点直接丢
  assert.equal(downsamplePolyline('100,30;bad;101,30'), '100,30;101,30');
  assert.equal(downsamplePolyline(''), '');
});

// ---------- 徒步日天气择优(机动休整日) ----------

const mkForecast = (byDate) => Object.entries(byDate).map(([date, verdict]) => ({ date, verdict }));
const baseDate = '2026-07-10';

test('hikeWeatherScore:最差的一天说了算,窗口外日期不参与变好', () => {
  const plan = [{ type: 'drive' }, { type: 'hike' }, { type: 'hike' }, { type: 'drive' }];
  // 徒步下标 1、2 → 日期 = 起始日 +2、+3,即 07-12 / 07-13(第 0 天是火车日)
  const forecast = mkForecast({
    '2026-07-12': '不宜', '2026-07-13': '宜', '2026-07-15': '宜',
  });
  // 最差 12 日 = 不宜(0);13 日的宜和 15 日的宜都抬不动最差值
  assert.equal(hikeWeatherScore(plan, forecast, baseDate), 0);
});

test('bestRestDays:有余量且插日变好才插,取最小插数;全宜不动;没余量不动', () => {
  const plan = [{ type: 'drive' }, { type: 'hike' }, { type: 'drive' }];
  // 徒步日 07-12;插 1 天后落到 07-13
  const forecast = mkForecast({
    '2026-07-12': '不宜', '2026-07-13': '宜', '2026-07-14': '宜',
  });
  assert.equal(bestRestDays(plan, forecast, baseDate, 2), 1);
  // 没有余量:0
  assert.equal(bestRestDays(plan, forecast, baseDate, 0), 0);
  // 全宜:不动
  const nice = mkForecast({ '2026-07-12': '宜', '2026-07-13': '宜' });
  assert.equal(bestRestDays(plan, nice, baseDate, 2), 0);
  // 插了也不见好:0
  const bad = mkForecast({ '2026-07-12': '不宜', '2026-07-13': '不宜', '2026-07-14': '不宜' });
  assert.equal(bestRestDays(plan, bad, baseDate, 2), 0);
});

test('planDays:restDays 在徒步块前插入休整日', () => {
  const trail = { name: '党岭', node: '丹巴', days: 2 };
  const days = planDays(loop, legs, trail, 4, 400, { restDays: 2 });
  const types = days.map((d) => d.type);
  assert.deepEqual(types, ['drive', 'rest', 'rest', 'hike', 'hike', 'drive']);
});

// ---------- 自动选线:禁入排除 + 当季/体能优先 ----------

test('pickTrail:禁入/关闭不进自动候选', () => {
  const trails = {
    a: { regionId: 'cx', days: 1, name: '一天线' },
    bad: { regionId: 'cx', days: 1, name: '鳌太', status: '禁入' },
  };
  assert.equal(pickTrail(trails, 'cx', null, 7).id, 'a');
  // 手动指定禁入线仍允许(自用,用户自己负责),不抛错
  assert.equal(pickTrail(trails, 'cx', 'bad', 7).id, 'bad');
});

test('pickTrail:当季优先于最短,超体能上限靠后', () => {
  const trails = {
    short: { regionId: 'cx', days: 2, name: '短线' },
    season: { regionId: 'cx', days: 3, name: '当季线', bestMonths: [7] },
    hard: { regionId: 'cx', days: 2, name: '超纲线', grade: 4 },
  };
  // 7 月:当季线优先于更短的短线
  assert.equal(pickTrail(trails, 'cx', null, 9, { month: 7 }).id, 'season');
  // 体能上限 ★2:超纲线在没有任何当季加成时靠后
  const noSeason = {
    short: { regionId: 'cx', days: 2, name: '短线', grade: 2 },
    hard: { regionId: 'cx', days: 2, name: '超纲线', grade: 4 },
  };
  assert.equal(pickTrail(noSeason, 'cx', null, 9, { month: 7, ableCap: 2 }).id, 'short');
});

test('fuelPlan:取到实价就替换 config 价并言明来源,取不到保持 config', () => {
  const oil = { price: 8.7, type: '92#', updatedOn: '2026-09-25' };
  const hit = fuelPlan({ consumptionLPer100km: 8, pricePerL: 8.2 }, oil);
  assert.equal(hit.fuel.pricePerL, 8.7);
  assert.equal(hit.fuel.consumptionLPer100km, 8); // 其余口径不动
  assert.match(hit.note, /92# 实价 ¥8\.7\/L/);
  const miss = fuelPlan({ consumptionLPer100km: 8, pricePerL: 8.2 }, null);
  assert.equal(miss.fuel.pricePerL, 8.2);
  assert.match(miss.note, /config ¥8\.2/);
  assert.match(fuelPlan(null, null).note, /config ¥\?/);
});

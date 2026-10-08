import { createRequire } from 'module';
const require = createRequire(new URL('../package.json', import.meta.url));
const { planDays, pickTrail, addDays, stayBudget, pickCandidates, fuelPlan, buildLegs, noTrailHint, tripIdFor, dayAnchors, forecastsByDate, railBudgetItem, railLeg, pickTrails, fillSpareDays, routeNote, detourInfo, DETOUR_RATIO, DETOUR_MIN_STRAIGHT_KM } = require('./lib/planner.js');
const rec = require('./lib/recommend.js');
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

test('planDays:能拆的绝不超单日上限,只有拆不动的单条 leg 才标 overKm', () => {
  const days = planDays(loop, legs, null, 5, 300);
  // 100+150=250 继续;再加 110 会到 360>300 → 先收 250 这天(旧写法会先塞进去再判,长出 360 的一天)
  const drive = days.filter((d) => d.type === 'drive');
  assert.deepEqual(drive.map((d) => d.km), [250, 110, 340]);
  assert.equal(drive.filter((d) => d.km > 300).length, 1, '只有 340 那条单 leg 超限');
  assert.deepEqual(drive.filter((d) => d.overKm).map((d) => d.km), [340],
    'overKm 只标"一条路拆不成两天"的日子,能靠切分避免的不许标');
  assert.equal(drive.reduce((s, d) => s + d.km, 0), 700); // 全程守恒
});

test('planDays:单条 leg 超上限时不与前序短 leg 叠加(曾把 381+711 堆成 962km)', () => {
  const loop2 = ['A', 'B', 'C', 'D', 'E', 'A'].map((name) => ({ name }));
  const l2 = [{ from: 'A', to: 'B', km: 412 }, { from: 'B', to: 'C', km: 96 },
    { from: 'C', to: 'D', km: 65 }, { from: 'D', to: 'E', km: 90 },
    { from: 'E', to: 'A', km: 711 }];
  const drive = planDays(loop2, l2, null, 5, 400).filter((d) => d.type === 'drive');
  assert.equal(drive.length, 3, '超长 leg 应独占一天');
  // 711km 那条不能被前面的 96+65+90=251km 拖着走
  const last = drive[drive.length - 1];
  assert.equal(last.km, 711);
  assert.equal(last.overKm, true, '711km 单日仍超上限,必须保留提示');
  // 全程守恒
  assert.equal(drive.reduce((s, d) => s + d.km, 0), 412 + 96 + 65 + 90 + 711);
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

test('stayBudget:缺省配置用兜底值并在备注言明(公式在 lib/budget.js,这里验行程语义)', () => {
  const [lodging, food] = stayBudget({ days: 7, headcount: 2, startDate: null, cfg: {} });
  // 6 晚 × ¥200 × 1 间(2 人一间)
  assert.equal(lodging.amount, 1200);
  assert.ok(lodging.note.includes('默认估算'), lodging.note);
  assert.ok(lodging.note.includes('住宿 6 晚') || lodging.name === '住宿 6 晚', '晚数 = 天数-1(行程语义)');
  // 7 天 × ¥80 × 2 人
  assert.equal(food.amount, 1120);
  assert.ok(lodging.note.includes('未填出发日期,按中性基准'), '没日期就要说出来,不能悄悄用 1.0');
});

test('stayBudget:配置值生效,房间数向上取整', () => {
  const cfg = { lodging: { perRoomPerNight: 300, peoplePerRoom: 2 }, food: { perPersonPerDay: 100 } };
  const [lodging, food] = stayBudget({ days: 5, headcount: 3, startDate: '2026-10-02', cfg });
  // 4 晚 × ¥300 × 2 间(3人 → ceil(3/2)=2 间)
  assert.equal(lodging.amount, 2400);
  assert.ok(lodging.note.includes('配置值'));
  assert.equal(food.amount, 1500);
});

test('stayBudget:住宿与餐饮各自标来源——只标了餐标时,住宿不得说成区域基准', () => {
  // 走真实链路:stayCfgFor 逐项算好 basis,stayBudget 逐项取用。
  // 此前共用一个 priced,只要区域标了任意一项,两项都会被说成「含区域基准(x)」。
  // dianxibei 正是这种形态(只标了餐标 90、没标房费),用户会以为自己标过房费。
  const region = { id: 'dianxibei', name: '滇西北环线', stay: { perPersonPerDay: 90 } };
  const stayCfg = rec.stayCfgFor({}, region);
  const [lodging, food] = stayBudget({
    days: 3, headcount: 1, startDate: null, regionId: 'dianxibei', cfg: stayCfg,
  });
  assert.doesNotMatch(lodging.note, /区域基准/, `住宿未标区域基准,不许说成区域基准: ${lodging.note}`);
  assert.match(lodging.note, /默认估算/, '住宿来源是代码默认值,要如实说');
  assert.match(food.note, /区域基准\(滇西北环线\)/, '餐标确实来自区域基准,要保留');
});

test('stayBudget:季节系数按出发日期吃进去(国庆比平日贵,且备注写来源)', () => {
  const cfg = { lodging: { perRoomPerNight: 200, peoplePerRoom: 2 }, food: { perPersonPerDay: 80 } };
  const seasonality = { holidays: [{ label: '国庆', from: '2026-10-01', to: '2026-10-07', lodging: 1.8, food: 1.2 }] };
  const 平日 = stayBudget({ days: 4, headcount: 2, startDate: '2026-11-15', cfg });
  const 国庆 = stayBudget({ days: 4, headcount: 2, startDate: '2026-10-03', cfg, } );
  const 国庆季 = stayBudget({ days: 4, headcount: 2, startDate: '2026-10-03', cfg: { ...cfg, seasonality } });
  assert.equal(平日[0].amount, 3 * 200, '3 晚 × 200 × 1 间');
  assert.equal(国庆[0].amount, 3 * 200, '表没给就等于中性基准,不能猜');
  assert.equal(国庆季[0].amount, Math.round(3 * 200 * 1.8));
  assert.match(国庆季[0].note, /季节 ×1\.8\(国庆\)/);
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

test('railBudgetItems:无车次与超预售期分开说,金额未知(且没有占位估算可用时说破)', () => {
  const [none, presale] = railBudgetItems(
    { chosen: null, presale: false },
    { chosen: null, presale: true }, 2);
  assert.equal(none.amount, null);
  assert.match(none.note, /没有可购车次/, '真没车就说没车,不能含糊');
  assert.match(none.note, /没取到可用的占位估算/, '连占位价都没有时必须说清,而不是留个空');
  assert.ok(presale.note.includes('预售期'));
});

test('railBudgetItems:复核过仍为空时不得断言「没有可购车次」——它与「被限频挡了」无法区分', () => {
  // 实测事实:同一趟「西安北→北京西 2026-10-20」当时被判成"没有可购车次"、预算退化成
  // 占位估算,而同一查询另一时刻返回 40 趟车 / 35 趟可购。空响应是二义的,
  // 所以复核(retried)过仍空只能如实说"未查到 + 请手动复核",不能下"没有车"的判断。
  const [withRetry] = railBudgetItems({ chosen: null, presale: false, retried: true }, { chosen: null }, 2);
  assert.match(withRetry.note, /未查到可购车次/, '复核过仍空要说"未查到"');
  assert.doesNotMatch(withRetry.note, /没有可购车次/, '不得断言"没有可购车次"');
  assert.match(withRetry.note, /手动复核/, '必须给出可执行的下一步');
  // 未复核这一支保留原措辞(理论上不该走到,但分支要保持可测)
  const [noRetry] = railBudgetItems({ chosen: null, presale: false }, { chosen: null }, 2);
  assert.match(noRetry.note, /没有可购车次/);
});

// ---------- 12306 空结果的二义性与复核重试 ----------
// 这两个用例会真等 RAIL_EMPTY_RETRY_MS(1.5 秒),那是实现刻意的等待,不做假。
const rail = require('./lib/rail12306.js');

const aTrain = (from, to) => ({
  trainNo: 'D102', code: 'D102', canWebBuy: true, lishi: '12:31',
  startTime: '02:00', arriveTime: '14:31', seats: { 二等座: '有' },
  prices: { 二等座: 187 }, from, to,
});

async function withRailStub(stub, fn) {
  const realQuery = rail.queryTrains;
  const realPresale = rail.beyondPresale;
  rail.queryTrains = stub.query;
  rail.beyondPresale = stub.beyondPresale;
  try { return await fn(); } finally {
    rail.queryTrains = realQuery;
    rail.beyondPresale = realPresale;
  }
}

test('railLeg:首次为空且未超预售期时,必须绕缓存复核一次并采纳复核结果', async () => {
  const calls = [];
  const leg = await withRailStub({
    beyondPresale: () => false,
    query: async (f, t, _d, opts = {}) => {
      calls.push(opts.force ? 'force' : 'normal');
      return opts.force
        ? { trains: [aTrain(f, t)], stationNames: {} }
        : { trains: [], stationNames: {}, emptyResult: true };
    },
  }, () => railLeg('西安北', '北京西', '2026-10-20'));

  assert.deepEqual(calls, ['normal', 'force'], '拿到空之后必须绕缓存重发一次(不绕缓存会命中刚才的空结果)');
  assert.ok(leg.chosen, '复核拿到的车次必须被采纳——这正是"误判成没车"要修的那一步');
  assert.equal(leg.chosen.code, 'D102');
  assert.equal(leg.evidence.retried, true, 'evidence 要留下"复核过"的痕迹,便于将来诊断');
  assert.equal(leg.presale, false);
});

test('railLeg:首次就有车次时不复核(正常路径零额外请求,不打爆个人 Key 的 QPS)', async () => {
  const calls = [];
  const leg = await withRailStub({
    beyondPresale: () => false,
    query: async (f, t, _d, opts = {}) => {
      calls.push(opts.force ? 'force' : 'normal');
      return { trains: [aTrain(f, t)], stationNames: {} };
    },
  }, () => railLeg('西安北', '北京西', '2026-10-20'));

  assert.deepEqual(calls, ['normal'], '有车就不该再问一次');
  assert.equal(leg.evidence.retried, false);
  assert.ok(leg.chosen);
});

test('railLeg:超预售期不复核(预售期外必然是空,复核纯属浪费配额)', async () => {
  const calls = [];
  const leg = await withRailStub({
    beyondPresale: () => true,
    query: async (_f, _t, _d, opts = {}) => {
      calls.push(opts.force ? 'force' : 'normal');
      return { trains: [], stationNames: {}, emptyResult: true };
    },
  }, () => railLeg('西安北', '北京西', '2026-12-31'));

  assert.deepEqual(calls, ['normal'], '超预售期不该复核');
  assert.equal(leg.presale, true, '而且必须如实标成"超预售期"');
  assert.equal(leg.evidence.retried, false);
});

test('railLeg:复核后仍为空时,标记 retried 供文案改口', async () => {
  const leg = await withRailStub({
    beyondPresale: () => false,
    query: async () => ({ trains: [], stationNames: {}, emptyResult: true }),
  }, () => railLeg('西安北', '北京西', '2026-10-20'));

  assert.equal(leg.chosen, null);
  assert.equal(leg.evidence.retried, true);
  assert.equal(leg.evidence.trainCount, 0);
  assert.equal(leg.presale, false, '在预售期内,不该标成预售期外');
});

// ---- 逐日天气锚点 ----
test('dayAnchors:驾车日锚在当天最后一个节点,徒步日锚在徒步节点,休整/提示日无锚点', () => {
  const schedule = [
    { date: '2026-10-15', type: 'drive', legs: [{ from: '成都', to: '映秀' }, { from: '映秀', to: '丹巴' }] },
    { date: '2026-10-16', type: 'hike', trail: '党岭' },
    { date: '2026-10-17', type: 'rest' },
    { date: '2026-10-18', type: 'note', text: 'x' },
    { date: '2026-10-19', type: 'drive', legs: [{ from: '丹巴', to: '成都' }] },
  ];
  assert.deepEqual(dayAnchors(schedule, '丹巴'), [
    { date: '2026-10-15', node: '丹巴' },
    { date: '2026-10-16', node: '丹巴' },
    { date: '2026-10-19', node: '成都' },
  ], '驾车日取当天终点(不是起点)');
  assert.deepEqual(dayAnchors([], 'x'), []);
});

test('forecastsByDate:按锚点名取当天预报,取不到的点/日就不出条目', () => {
  const many = [
    { name: '丹巴', forecast: [{ date: '2026-10-15', label: '晴', tempMax: 18 }] },
    { name: '成都', forecast: [{ date: '2026-10-19', label: '小雨', tempMax: 20 }] },
  ];
  const out = forecastsByDate([
    { date: '2026-10-15', node: '丹巴' },
    { date: '2026-10-16', node: '丹巴' },
    { date: '2026-10-19', node: '成都' },
    { date: '2026-10-20', node: '不存在' },
  ], many);
  assert.deepEqual(Object.keys(out).sort(), ['2026-10-15', '2026-10-19'],
    '取不到就空着,不拿别的点的天气凑');
  assert.equal(out['2026-10-15'].at, '丹巴', '要带上是哪个点的预报');
  assert.equal(out['2026-10-19'].label, '小雨');
});

// ---- 票价占位:接口失败 / 预售期 / 真没车 三件事分开说 ----
test('railBudgetItem:没查到车次但有往返估算 → 填占位价并说明口径', () => {
  const it = railBudgetItem({ date: '2026-10-20', presale: true, error: null }, '火车去程', 2,
    { perPerson: 600, note: '经西安中转;' });
  assert.equal(it.amount, 300 * 2, '按往返÷2 再乘人数');
  assert.match(it.note, /超出预售期/);
  assert.match(it.note, /出发前请复核/);
});

test('railBudgetItem:接口失败与"没有可购车次"必须是两句不同的话', () => {
  const failed = railBudgetItem({ error: 'queryG: 返回非 JSON' }, '火车去程', 1, { perPerson: 400 });
  assert.match(failed.note, /取价失败/);
  const noTrain = railBudgetItem({ error: null, presale: false }, '火车去程', 1, { perPerson: 400 });
  assert.match(noTrain.note, /没有可购车次/);
  assert.ok(!/取价失败/.test(noTrain.note), '别把"真没车"说成接口坏了');
});

test('railBudgetItem:连占位估算都拿不到 → 保持 null 并说清,不编一个价', () => {
  const it = railBudgetItem({ presale: true }, '火车回程', 1, null);
  assert.equal(it.amount, null);
  assert.match(it.note, /没取到可用的占位估算/);
});

test('railBudgetItem:有票时照旧走实价,不受占位逻辑影响', () => {
  const it = railBudgetItem({ chosen: { code: 'D117' }, seat: { label: '二等座', price: 263 } },
    '火车去程', 3, { perPerson: 600 });
  assert.equal(it.amount, 263 * 3);
  assert.match(it.note, /D117 二等座 ×3人/);
});

test('hikeBudgetItem:门票按人头;未标注是"未知"而不是 0 元', () => {
  const paid = hikeBudgetItem({ name: '测试线', tickets: 60 }, 3);
  assert.equal(paid.amount, 180);
  assert.ok(paid.note.includes('3 人'));
  // 曾经这里 `tickets ?? 0` 把"没查过"算成 ¥0 还声称"来自线路库门票字段",
  // 而 budget.ticketItem(推荐页)是如实报"未标注"的——同一件事两条口径。
  // 2026-10-08 清掉 59 条无出处的 0 之后这个不一致才暴露出来。
  const unknown = hikeBudgetItem({ name: '测试线' }, 2);
  assert.equal(unknown.amount, null, '未标注必须是不计入合计,不是 0 元');
  assert.match(unknown.note, /未标注门票/, '要如实说是未标注');
  assert.match(unknown.note, /不是 0 元/, '要挡住"看着像免费"的误读');
  // 有出处的免票(0 元)仍然可以是 0——那种"0"是查过的结论,不是猜的
  const free = hikeBudgetItem({ name: '测试线', tickets: 0, ticketSource: { source: '官网', checkedAt: '2026-10-08' } }, 2);
  assert.equal(free.amount, 0, '有出处的免票就该是 0');
});

// ---------- 回程无票的时刻衔接(回归:曾崩在 planner.js) ----------

const { hourOf } = require('./lib/planner.js');

test('hourOf:正常时刻取小时,空/脏值一律 null 而不是 0', () => {
  assert.equal(hourOf('09:35'), 9);
  assert.equal(hourOf('00:01'), 0);
  assert.equal(hourOf('15:00'), 15);
  // 这几条是崩溃根因:Number('') === 0,而 0 < 10 会被当成"清晨发车"
  assert.equal(hourOf(undefined), null);
  assert.equal(hourOf(null), null);
  assert.equal(hourOf(''), null);
  assert.equal(hourOf('待定'), null);
  assert.equal(hourOf('99:00'), null);
});

test('回程无票时不该触发"清晨发车"分支(旧实现会崩在 null.chosen)', () => {
  const railBack = { chosen: null, presale: false };
  const schedule = [{ type: 'drive', text: '驾车' }];
  const departHour = hourOf(railBack.chosen?.startTime);
  const wouldAnnotate = departHour !== null && departHour < 10;
  assert.equal(wouldAnnotate, false, '无票不得进入早班分支');
  // 旧写法在这里等价于 true,随后 lastDrive.earlyDepart = railBack.chosen.startTime 崩掉
  assert.equal(Number(String(railBack.chosen?.startTime || '').slice(0, 2)), 0);
  assert.equal(schedule[0].earlyDepart, undefined, '未标注早班出发');
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

// ---- 徒步起点=环线第 0 站(枢纽)的排法 ----
// 环线的最后一腿闭环回到 loop[0],旧实现在那一刻才插徒步块:实测 jingxi + 香八拉
// 排出「先绕完 515km 全程、再开始走一天」,而且整圈堆成一天还超单日上限。
test('planDays:徒步节点=loop[0] 时徒步排在所有驾车日之前', () => {
  const l = [{ name: '北京' }, { name: '斋堂' }, { name: '涿鹿' }, { name: '北京' }];
  const lg = [{ from: '北京', to: '斋堂', km: 90 }, { from: '斋堂', to: '涿鹿', km: 120 },
    { from: '涿鹿', to: '北京', km: 130 }];
  const trail = { name: '香八拉', node: '北京', days: 1 };
  const days = planDays(l, lg, trail, 4, 400);
  assert.equal(days[0].type, 'hike', '落地当天就该走,不是绕完一圈再走');
  assert.equal(days.filter((d) => d.type === 'hike').length, 1,
    '闭环最后一腿的 to 同样等于 trail.node,不得插第二块徒步');
  assert.equal(days.filter((d) => d.type === 'drive').reduce((s, d) => s + d.km, 0), 340,
    '全程里程守恒');
});

test('planDays:节点=loop[0] 且需插机动休整日时,顺序为 休整 → 徒步 → 驾车', () => {
  const l = [{ name: '拉萨' }, { name: '米林' }, { name: '拉萨' }];
  const lg = [{ from: '拉萨', to: '米林', km: 300 }, { from: '米林', to: '拉萨', km: 300 }];
  const days = planDays(l, lg, { name: '甘丹寺—桑耶寺', node: '拉萨', days: 2 }, 6, 400, { restDays: 1 });
  assert.deepEqual(days.slice(0, 3).map((d) => d.type), ['rest', 'hike', 'hike']);
});

test('planDays:jingxi 实测形态——香八拉在前,且五段不再堆成 515km 的一天', () => {
  // 真实数据形状:北京→斋堂→涿鹿→蔚县→怀来→北京,直线估算 81/77/103/132/122 km
  const l = ['北京', '斋堂', '涿鹿', '蔚县', '怀来', '北京'].map((name) => ({ name }));
  const lg = [81, 77, 103, 132, 122].map((km, i) => ({ from: l[i].name, to: l[i + 1].name, km }));
  const days = planDays(l, lg, { name: '香八拉', node: '北京', days: 1 }, 4, 400);
  assert.equal(days[0].type, 'hike');
  const drive = days.filter((d) => d.type === 'drive');
  assert.deepEqual(drive.map((d) => d.km), [393, 122], '393+122=515 必须拆成两天');
  assert.equal(drive.some((d) => d.overKm), false, '能拆开的日子不该挂"行程偏紧"');
});

// ---- 里程来源:没 Key 走估算,有 Key 的错误不许被估算吞掉 ----
test('buildLegs:未配 Key 时逐段估算并全程标注 estimated', async () => {
  const loop = [{ name: 'A', lng: 100, lat: 30 }, { name: 'B', lng: 101, lat: 31 },
    { name: 'A', lng: 100, lat: 30 }];
  const { legs, estimated, provider } = await buildLegs(loop, { provider: 'estimate' });
  assert.equal(legs.length, 2);
  assert.equal(estimated, true);
  assert.ok(legs[0].km > 0);
  assert.equal(legs[0].estimated, true);
  assert.equal(legs[0].route.path, '', '估算没有真实路线可画');
  assert.equal(provider, 'estimate', '要把用了哪一路报出来,页面与导出据此说清来源');
});

test('buildLegs:配了 Key 时 routeFn 抛错必须原样抛出,不静默降级成估算', async () => {
  const loop = [{ name: 'A', lng: 100, lat: 30 }, { name: 'B', lng: 101, lat: 31 }];
  await assert.rejects(
    buildLegs(loop, { provider: 'amap', routeFn: async () => { throw new Error('高德路径规划坐标非法'); } }),
    /坐标非法/,
  );
});

test('tripIdFor:同条件重生成算刷新,换线路/换天数就另开一档,不冲掉上一版', () => {
  const mk = (over) => ({ id: 'x', input: { trailId: 'a', days: 7, headcount: 2, regionId: 'jingxi', startDate: '2026-10-14' }, ...over });
  const A = mk({});
  const B = mk({ input: { ...A.input, trailId: 'b' } });
  // 没有存档 → 用 base
  assert.equal(tripIdFor({ base: 'd-r', input: A.input, lookup: () => null }), 'd-r');
  // 已有同条件存档 → 还是 base(覆盖自己)
  assert.equal(tripIdFor({ base: 'd-r', input: A.input, lookup: (id) => (id === 'd-r' ? A : null) }), 'd-r');
  // base 是 A 方案,现在生成 B 方案 → 另开 d-r-2
  assert.equal(tripIdFor({ base: 'd-r', input: B.input, lookup: (id) => (id === 'd-r' ? A : null) }), 'd-r-2');
  // 两个方案各自稳定:A 永远落 d-r,B 永远落 d-r-2(不会互相挤掉)
  const two = { 'd-r': A, 'd-r-2': B };
  assert.equal(tripIdFor({ base: 'd-r', input: A.input, lookup: (id) => two[id] || null }), 'd-r');
  assert.equal(tripIdFor({ base: 'd-r', input: B.input, lookup: (id) => two[id] || null }), 'd-r-2');
  // 天数不同也算另一份;人数不同同样
  assert.equal(tripIdFor({ base: 'd-r', input: { ...A.input, days: 9 }, lookup: (id) => (id === 'd-r' ? A : null) }), 'd-r-2');
  assert.equal(tripIdFor({ base: 'd-r', input: { ...A.input, headcount: 4 }, lookup: (id) => (id === 'd-r' ? A : null) }), 'd-r-2');
  // 前 3 档都被别的方案占着 → 找到第一个空位
  const three = { 'd-r': A, 'd-r-2': B, 'd-r-3': mk({ input: { ...A.input, trailId: 'c' } }) };
  assert.equal(tripIdFor({ base: 'd-r', input: mk({ input: { ...A.input, trailId: 'e' } }).input, lookup: (id) => three[id] || null }), 'd-r-4');
});

test('noTrailHint:天数放不下时说清最短线路与建议天数,而不是让行程长出 0 个徒步日', () => {
  const trails = {
    a: { regionId: 'zd', days: 4, name: '四天线', status: '开放' },
    b: { regionId: 'zd', days: 6, name: '六天线', status: '开放' },
    c: { regionId: 'zd', days: 1, name: '禁入线', status: '禁入' },
    d: { regionId: 'other', days: 1, name: '别区线', status: '开放' },
  };
  const msg = noTrailHint(trails, 'zd', 3);
  assert.match(msg, /最短的一条要走 4 天/);
  assert.match(msg, /至少需要 6 天/);
  assert.match(msg, /当前 3 天/);
  assert.match(msg, /另有 1 条禁入\/关闭/);
  assert.match(noTrailHint({}, 'zz', 5), /还没有接入/);
});

// ---- 多线串联 ----
test('pickTrails:显式选多条按给定顺序返回,同一节点也允许(两条线连着走)', () => {
  const trails = {
    a: { regionId: 'cx', days: 1, name: '甲线', node: '丹巴' },
    b: { regionId: 'cx', days: 2, name: '乙线', node: '丹巴' },
    c: { regionId: 'cx', days: 1, name: '丙线', node: '八美' },
    x: { regionId: 'other', days: 1, name: '别区' },
  };
  assert.deepEqual(pickTrails(trails, 'cx', ['b', 'a'], 9, {}).map((t) => t.name), ['乙线', '甲线']);
  assert.deepEqual(pickTrails(trails, 'cx', ['a', 'a'], 9, {}).map((t) => t.name), ['甲线'], '重复的 id 只算一次');
  assert.throws(() => pickTrails(trails, 'cx', ['x'], 9, {}), /不属于该区域/);
  assert.throws(() => pickTrails(trails, 'cx', ['a', 'b', 'c'], 3, {}), /至少要 6 天/, '几条线的天数超了就响亮报错');
  // 没给 id 时退回自动选一条(不替用户凑满)
  assert.equal(pickTrails(trails, 'cx', [], 9, { month: 7 }).length, 1);
  assert.deepEqual(pickTrails(trails, 'cx', null, 9, { month: 7 }).length, 1);
});

test('planDays:两条线同节点时连着排,各自算自己的天数', () => {
  const l = [{ name: 'A' }, { name: 'B' }, { name: 'A' }];
  const lg = [{ from: 'A', to: 'B', km: 100 }, { from: 'B', to: 'A', km: 100 }];
  const days = planDays(l, lg, [
    { name: '甲', node: 'B', days: 1 },
    { name: '乙', node: 'B', days: 2 },
  ], 5, 400);
  assert.deepEqual(days.map((d) => d.type), ['drive', 'hike', 'hike', 'hike', 'drive']);
  assert.deepEqual(days.filter((d) => d.type === 'hike').map((d) => d.trail), ['甲', '乙', '乙']);
});

test('planDays:节点不在环线上时响亮报错,而不是静默排一条开不到的行程', () => {
  const l = [{ name: 'A' }, { name: 'B' }, { name: 'A' }];
  const lg = [{ from: 'A', to: 'B', km: 100 }, { from: 'B', to: 'A', km: 100 }];
  assert.throws(() => planDays(l, lg, [{ name: '野线', node: '不存在', days: 1 }], 5, 400), /不在该区域环线上/);
});

// ---- 余量天数:补成机动日而不是留一句"天数不对齐" ----
test('fillSpareDays:排不满就补机动日,天数守恒重新成立', () => {
  const plan = [{ type: 'hike' }, { type: 'drive' }];
  const out = fillSpareDays(plan, 6);
  assert.equal(out.length, 5, '输入 6 天 → 除出发日外应排 5 天');
  assert.equal(out.filter((d) => d.spare).length, 3);
  assert.ok(out.filter((d) => d.spare).every((d) => d.type === 'rest'), '补的是机动日,不是假驾车日');
});

test('fillSpareDays:排满/排不下时原样返回,偏紧提示必须留着', () => {
  const full = [{ type: 'drive' }, { type: 'hike' }];
  assert.deepEqual(fillSpareDays(full, 3), full, '正好排满 → 原样返回');
  // 排太多(带 note 表示偏紧):原样返回,提示不能被吃掉
  const withNote = [{ type: 'drive' }, { type: 'note', text: '偏紧' }];
  assert.deepEqual(fillSpareDays(withNote, 2), withNote, '偏紧提示要留着,不能因为补机动日就丢了它');
});

// ---- 里程来源的口径文案(页面/导出都吃它,错了会让人把估算当实价) ----
test('routeNote:三家各说各的,腾讯那档必须点明"过路费仍是估的"', () => {
  assert.match(routeNote('amap'), /高德真实驾车路线/);
  assert.match(routeNote('amap'), /过路费.*高德/);
  const tx = routeNote('tencent');
  assert.match(tx, /腾讯真实驾车路线/);
  assert.ok(tx.includes('过路费'), '腾讯的过路费来自真实 toll 字段,文案要把它算进去');
  assert.match(routeNote('estimate'), /直线×1.3 估算/);
  assert.ok(routeNote('estimate').includes('未配高德/腾讯 Key'), '两家的 Key 名都要点到,用户才知道该配哪个');
  // 防回归:这句曾被实测证伪。99 条 leg 跑下来既低估(-15%)也高估(+290%),
  // 说成"只保证不低估"会让用户以为落差方向只可能是预算偏高——那是方向性误导。
  // README 早已改成"量级参考",但代码里这句多活了一天,且当时没有任何断言盯着它。
  assert.doesNotMatch(routeNote('estimate'), /只保证不低估|只保不低估/,
    '估算既可能高估也可能低估,不许再写成"只保证不低估"');
  assert.match(routeNote('estimate'), /量级参考/, '必须说清它只是量级参考');
  assert.ok(routeNote('whatever').includes('直线×1.3 估算'), '不认识的来源按最保守的口径说(估的)');
});

test('buildLegs:provider 可由 cfg 决定(没配任何 Key → estimate,不会去发请求)', async () => {
  const loop = [{ name: 'A', lng: 100, lat: 30 }, { name: 'B', lng: 101, lat: 31 }];
  const { legs, provider } = await buildLegs(loop, { cfg: { routeProvider: 'estimate' } });
  assert.equal(provider, 'estimate');
  assert.equal(legs.length, 1);
  assert.ok(legs[0].km > 0);
});

test('buildLegs:cfg 里指定了没配 Key 的 provider 会响亮报错,不静默退回估算', async () => {
  // 必须隔离真实 config:用户机器上可能真的配了腾讯 Key,那样这条断言的前提就不成立了,
  // 而且会真的打出去一次接口(测试不该有网络副作用)。
  const storeMod = require('./lib/store.js');
  const realRead = storeMod.read;
  storeMod.read = () => ({});
  try {
    const loop = [{ name: 'A', lng: 100, lat: 30 }, { name: 'B', lng: 101, lat: 31 }];
    await assert.rejects(buildLegs(loop, { cfg: { routeProvider: 'tencent' } }), /tencentKeyWeb/);
  } finally {
    storeMod.read = realRead;
  }
});

// ---- 疑似路网绕行:真实里程远超直线距离要单独提示 ----
test('detourInfo:真实/直线 > 8 倍且直线 >10km 才判绕行;短腿与估算段不判', () => {
  const A = { name: 'A', lng: 100, lat: 30 };
  const B = { name: 'B', lng: 100.5, lat: 30 };
  // 实测 派镇→墨脱 就是这种绕法:直线 50km、路网 1890km、186 段路
  const far = detourInfo({ distanceKm: 1890, estimated: false }, A, B);
  assert.ok(far.detour, '38 倍必须判出来');
  assert.equal(far.detour.ratio, 39);
  assert.ok(far.detour.straightKm > 40 && far.detour.straightKm < 50);
  assert.equal(detourInfo({ distanceKm: 120, estimated: false }, A, B).detour, undefined,
    '2.5 倍属正常山路,不报');
  const near = { name: 'C', lng: 100, lat: 30 };
  const near2 = { name: 'D', lng: 100.03, lat: 30 };
  assert.equal(detourInfo({ distanceKm: 60, estimated: false }, near, near2).detour, undefined,
    '直线 <10km 不判,免得把县城里的绕行报成路不通');
  assert.equal(detourInfo({ distanceKm: 999, estimated: true }, A, B).detour, undefined,
    '估算段没资格判(它本来就是直线×1.3)');
  assert.equal(detourInfo({ distanceKm: 999, estimated: false }, undefined, B).detour, undefined);
});

test('detourInfo:阈值常量被钉住(改口径要连测试一起改)', () => {
  assert.equal(DETOUR_RATIO, 8);
  assert.equal(DETOUR_MIN_STRAIGHT_KM, 10);
});

// ---- 门票来源要跟着预算走:行程页的"徒步费用"那条备注必须带出处 ----
test('hikeBudgetItem:有 ticketSource 时备注带来源与核对日期', () => {
  const withSrc = hikeBudgetItem({ name: '泰山红门夜爬', tickets: 115,
    ticketSource: { source: '泰山景区管委会', url: 'https://x', checkedAt: '2026-10-08' } }, 2);
  assert.equal(withSrc.amount, 230);
  assert.match(withSrc.note, /泰山景区管委会 2026-10-08 核对/, withSrc.note);
  // 没来源时不硬编一句"来源未知",保持原文案(老数据不受影响)
  const plain = hikeBudgetItem({ name: 'x', tickets: 60 }, 1);
  assert.equal(plain.note, '来自线路库门票字段,观光车/马帮另计');
});

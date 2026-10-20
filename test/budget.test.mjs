// 落地成本模型:分项化 + 季节系数 + 住宿档次。设计稿见
// docs/superpowers/specs/2026-10-07-落地成本模型-design.md
//
// 断言重点不是"算出多少",而是三条不变量:
//  1) 未知 → amount null,绝不写 0 冒充;合计只加已知项。
//  2) 数字必须吃用户的输入(日期/人数/档次),旧公式三样都不吃才导致"一直一个样子"。
//  3) 季节四路候选取**最大值**而不是命中即返回——国庆 ∩ 川西秋色必须取 1.8。
import { createRequire } from 'module';
const require = createRequire(new URL('../package.json', import.meta.url));
const test = require('node:test');
const assert = require('node:assert');

const B = require('./lib/budget.js');

const CFG = { lodging: { perRoomPerNight: 200, peoplePerRoom: 2 }, food: { perPersonPerDay: 80 } };
const SEASON = {
  months: { _说明: '注释', 1: 0.9, 7: 1.3, 8: 1.3 },
  holidays: [
    { label: '国庆', from: '2026-10-01', to: '2026-10-07', lodging: 1.8, food: 1.2 },
    { label: '清明', from: '2026-04-04', to: '2026-04-06', lodging: 1.3 },
  ],
  regions: { chuanxi: { label: '川西秋色旺季', months: { 10: 1.4, 11: 1.2 } } },
};

// ---------- 晚数语义分离 ----------
test('hikeNights 与 tripNights 是两件事,不许再混用', () => {
  assert.equal(B.hikeNights(1), 1, '1 天徒步也要在景区附近过夜(旧口径算 0 晚曾把阿布吉措估成 ¥90)');
  assert.equal(B.hikeNights(7), 6);
  assert.equal(B.tripNights(1), 0, '1 天行程不住夜,这是行程语义');
  assert.equal(B.tripNights(7), 6);
  assert.equal(B.hikeNights('abc'), 0, '脏天数不给晚数,不给 NaN');
  assert.equal(B.tripNights(-3), 0);
});

// ---------- 季节系数:取最大值 ----------
test('季节系数取命中项最大值:国庆 ∩ 川西秋色 = 1.8,不是 1.4', () => {
  const s = B.seasonFactors('2026-10-02', 'chuanxi', SEASON);
  assert.equal(s.lodging, 1.8, '按"命中即返回"会取到区域 1.4,把最贵的时候算便宜了');
  assert.equal(s.lodgingFrom, '国庆');
  assert.equal(s.food, 1.2, '餐饮只吃点名了 food 的节假日,不跟随住宿');
});

test('季节系数四路来源都能报出来,并注明用了哪一路', () => {
  assert.equal(B.seasonFactors('2026-11-15', 'chuanxi', SEASON).lodgingFrom, '川西秋色旺季');
  assert.equal(B.seasonFactors('2026-11-15', 'chuanxi', SEASON).lodging, 1.2);
  assert.equal(B.seasonFactors('2026-07-10', null, SEASON).lodgingFrom, '全国 7 月基准');
  assert.equal(B.seasonFactors('2026-03-10', null, SEASON).lodging, 1, '没命中任何一档就是中性基准');
  assert.equal(B.seasonFactors('2026-03-10', null, SEASON).lodgingFrom, '中性基准');
});

test('下划线键是注释不是月份(这条读错会凭空多一个旺季)', () => {
  assert.equal(B.seasonFactors('2026-01-05', null, { months: { _说明: 'x', 1: 0.9 } }).lodging, 0.9);
  assert.equal(B.monthFactor({ _说明: 'x', 1: 0.9 }, '_说明'), null);
  assert.equal(B.monthFactor({ 13: 5 }, 13), null, '月份越界不认');
});

test('日期留空 / 非法 → 中性基准并明说,不静默用 1.0', () => {
  // 空/脏/越界的日子一律当"没填",并且要说破
  for (const bad of [null, '', '2026-13-01', '2026-00-10', '2026-04-32', '明天', '2026-10-1', 20261001]) {
    const s = B.seasonFactors(bad, 'chuanxi', SEASON);
    assert.equal(s.lodging, 1, `${JSON.stringify(bad)} 不该有系数`);
    assert.match(s.notes.join(';'), /未填出发日期/);
  }
  // 顺手钉住合法格式:ISO 且补零,少了这一层上面对象都会被误判
  assert.equal(B.seasonFactors('2026-10-01', null, SEASON).lodging, 1.8);
});

test('validDate:日历上不存在的日子不能靠"1-31"蒙混过关', () => {
  for (const d of ['2026-02-29', '2026-02-31', '2026-04-31', '2026-06-31', '2026-09-31', '2026-11-31']) {
    assert.equal(B.validDate(d), null, `${d} 不存在,必须是 null`);
  }
  for (const d of ['2026-01-31', '2026-02-28', '2026-12-31', '2028-02-29']) {
    assert.equal(B.validDate(d), d, `${d} 合法,应原样返回`);
  }
});

test('节假日日历没覆盖的年份降级到月份,并说明', () => {
  const s = B.seasonFactors('2028-04-05', null, SEASON);
  assert.equal(s.lodging, 1);
  assert.match(s.notes.join(';'), /节假日日历未覆盖 2028 年/);
});

// ---------- 档次与人数 ----------
test('档次系数生效且可被 config 覆盖', () => {
  assert.equal(B.tierFactorOf('经济'), 0.6);
  assert.equal(B.tierFactorOf('舒适'), 1.0);
  assert.equal(B.tierFactorOf('乱填'), 1.0, '不认识的档次回落基准,不猜一个倍数');
  assert.equal(B.tierFactorOf('经济', { 经济: 0.5, 舒适: 1 }), 0.5);
});

// 上一轮变异验证发现:只测 tierFactorOf 这个纯函数不够——把 tierFactor 从金额公式里删掉,
// 全库单测照样绿(档次这条线就没人守了)。所以这里必须断言**金额与备注**两处。
test('stayCost:档次真的乘进金额,并在备注里点名档位', () => {
  const base = B.stayCost({ nights: 2, headcount: 1, perRoomPerNight: 200, peoplePerRoom: 2 });
  const eco = B.stayCost({ nights: 2, headcount: 1, perRoomPerNight: 200, peoplePerRoom: 2,
    tierFactor: 0.6, tierLabel: '经济' });
  assert.equal(base.amount, 400);
  assert.equal(eco.amount, 240, '经济档 = ×0.6');
  assert.match(eco.note, /经济档 ×0\.6/, '备注要写出乘过档');
  assert.ok(!/舒适档 ×1/.test(base.note), '基准档不该在备注里刷噪音');
});

test('季节系数也真的乘进金额(不是只回传一个字段)', () => {
  const it = B.stayCost({ nights: 2, headcount: 1, perRoomPerNight: 200, peoplePerRoom: 2,
    seasonFactor: 1.8, seasonFrom: '国庆' });
  assert.equal(it.amount, Math.round(2 * 200 * 1.8));
  assert.match(it.note, /季节 ×1\.8\(国庆\)/);
});

test('一个人也要包整间房:1 人住宿不因 ÷2 被算便宜', () => {
  const one = B.stayCost({ nights: 1, headcount: 1, perRoomPerNight: 200, peoplePerRoom: 2 });
  const two = B.stayCost({ nights: 1, headcount: 2, perRoomPerNight: 200, peoplePerRoom: 2 });
  assert.equal(one.amount, 200);
  assert.equal(two.amount, 200);
  assert.equal(one.perPerson, 200, '人均 = 整间房');
  assert.equal(two.perPerson, 100, '两人分摊');
  assert.equal(B.stayCost({ nights: 1, headcount: 3, perRoomPerNight: 200, peoplePerRoom: 2 }).amount, 400,
    '3 人 → 2 间');
});

test('landBudget:默认口径下一条 1 天无门票线 = ¥280(设计稿验收第 7 条)', () => {
  const bd = B.landBudget({ days: 1 }, {}, CFG);
  assert.equal(bd.total, 280, '住宿 200(1 人整间)+ 餐饮 80,门票未标不进合计');
  assert.equal(bd.unknownCount, 1);
});

// ---------- 未知项 ----------
test('amount null 的项不参与合计,只进 unknownCount', () => {
  const bd = B.landBudget({ days: 2 }, { headcount: 2 }, CFG);
  assert.equal(bd.items.find((i) => i.key === 'tickets').perPerson, null);
  assert.equal(bd.total, 100 + 160);
  assert.equal(bd.unknownCount, 1);
  const known = bd.items.filter((i) => i.perPerson !== null);
  assert.equal(known.reduce((s, i) => s + i.perPerson, 0), bd.total, '分项之和必须等于合计');
});

test('门票标了 0 元是"已知免费",与未标注是两回事', () => {
  assert.equal(B.ticketItem({ tickets: 0 }, { headcount: 2 }).amount, 0);
  assert.equal(B.ticketItem({}, { headcount: 2 }).amount, null);
  assert.equal(B.landBudget({ days: 2, tickets: 0 }, { headcount: 2 }, CFG).ticketsUnknown, false);
  assert.equal(B.landBudget({ days: 2 }, { headcount: 2 }, CFG).ticketsUnknown, true);
  assert.equal(B.ticketItem({ tickets: '三百' }, { headcount: 2 }).amount, null, '脏票价按未知处理,不 Number() 蒙混');
});

test('extraFees:没这个字段就不产出条目;有非法条目要留脏标记,不静默丢', () => {
  assert.deepEqual(B.extraFeeItems({}, { headcount: 2 }), [], '没数据 = 没有这一项,而不是 0 元');
  const ok = B.extraFeeItems({ extraFees: [{ name: '观光车', amount: 40 }] }, { headcount: 2 });
  assert.equal(ok.length, 1);
  assert.equal(ok[0].amount, 80);
  assert.equal(ok[0].source, 'data');
  const dirty = B.extraFeeItems({ extraFees: [{ name: '', amount: 40 }, { name: '无金额' }] }, { headcount: 1 });
  assert.equal(dirty.length, 1);
  assert.equal(dirty[0].perPerson, null);
  assert.match(dirty[0].note, /2 条 extraFees 格式不对/);
  assert.equal(B.extraFeeItems({ extraFees: '不是数组' }, { headcount: 1 })[0].perPerson, null);
});

test('缺省配置(空 cfg)走兜底值,并在 note 里说的是兜底', () => {
  const bd = B.landBudget({ days: 3 }, { headcount: 1 }, {});
  assert.equal(bd.items.find((i) => i.key === 'lodging').amount, 2 * 200);
  assert.equal(bd.items.find((i) => i.key === 'food').amount, 3 * 80);
});

test('住宿价没配 → 该项未知,不给 0 元住宿的假合计', () => {
  const it = B.stayCost({ nights: 3, headcount: 2, perRoomPerNight: undefined });
  assert.equal(it.amount, null);
  assert.equal(it.source, 'unknown');
  assert.match(it.note, /未配置/);
});

test('区域基准覆盖全局口径,并在 note 里点名是哪个区域', () => {
  const bd = B.landBudget({ days: 2, regionId: 'sc' }, { headcount: 1 }, {
    ...CFG, regionStay: { sc: { perRoomPerNight: 400 } },
  });
  assert.equal(bd.items.find((i) => i.key === 'lodging').amount, 400);
  assert.match(bd.items.find((i) => i.key === 'lodging').note, /区域基准\(sc\)/);
});

test('口径来源按字段判断:只标了餐标时,住宿不得被说成「区域基准」', () => {
  // 这是 dianxibei 的真实形态(stay 只有 perPersonPerDay)。
  // 曾共用一个 basisNote —— 只要区域标了任意一项,住宿也会被标成「区域基准(x)」,
  // 而它的值其实来自 config 或代码默认值。来源标错比不标更糟:用户会以为自己标过。
  const bd = B.landBudget({ days: 3, regionId: 'dxb' }, { headcount: 1, nights: 2 }, {
    regionStay: { dxb: { perPersonPerDay: 90 } },
  });
  const lodging = bd.items.find((i) => i.key === 'lodging');
  const food = bd.items.find((i) => i.key === 'food');
  assert.equal(lodging.amount, 400, '住宿仍按默认 ¥200 × 2 晚算(金额不受本次修正影响)');
  assert.doesNotMatch(lodging.note, /区域基准/, `住宿没标区域基准,不许说成区域基准: ${lodging.note}`);
  assert.match(lodging.note, /默认估算/, '应明说这是默认估算,而不是让用户去 config 里找');
  assert.equal(food.amount, 270);
  assert.match(food.note, /区域基准\(dxb\)/, '餐标确实来自区域基准,要保留');
});

test('口径三档要能分清:区域基准 / config 全局口径 / 默认估算', () => {
  const stayOnlyRegion = (cfg) => B.landBudget({ days: 1, regionId: 'r1' }, { headcount: 1 }, cfg);
  // 区域标了 → 区域基准
  assert.match(stayOnlyRegion({ regionStay: { r1: { perRoomPerNight: 300 } } })
    .items.find((i) => i.key === 'lodging').note, /区域基准\(r1\)/);
  // 区域没标、config 有 → config 全局口径
  assert.match(stayOnlyRegion({ regionStay: {}, lodging: { perRoomPerNight: 260 } })
    .items.find((i) => i.key === 'lodging').note, /config 全局口径/);
  // 都没有 → 默认估算,且要写明 config 里没设(别让用户白找)
  const none = stayOnlyRegion({}).items.find((i) => i.key === 'lodging').note;
  assert.match(none, /默认估算/);
  assert.match(none, /config\.json 未设/);
});

test('分档价:区域标了 stay.tiers 就取该档绝对价,且不再乘档次系数(否则打两次折)', () => {
  const cfg = {
    regionStay: { r1: { tiers: { 青旅: { perRoomPerNight: 120 }, 客栈: { perRoomPerNight: 260 } } } },
    lodging: { perRoomPerNight: 999 }, // 有分档价时不该碰 config 这个值
  };
  const at = (tier) => B.landBudget({ days: 1, regionId: 'r1' }, { headcount: 1, nights: 2, tier }, cfg)
    .items.find((i) => i.key === 'lodging');
  assert.equal(at('青旅').amount, 240, '青旅 ¥120 × 2 晚');
  assert.equal(at('客栈').amount, 520, '客栈 ¥260 × 2 晚');
  // 关键:绝对价不能再被系数乘一遍 —— 青旅若被 ×0.6 会变成 144,那是打两次折
  assert.match(at('青旅').note, /青旅档价/, '备注要说清是哪一档的价,而不是笼统的"区域基准"');
  // 旧档名要能取到对应档(存档与 localStorage 里可能还写着 舒适/经济)
  assert.equal(at('舒适').amount, 520, '「舒适」等价于客栈');
  assert.equal(at('经济').amount, 240, '「经济」等价于青旅');
  // 没标分档价的档位回落到"基准价 × 系数"
  assert.equal(at('酒店').amount, Math.round(2 * 999 * 1.8), '无分档价时用基准价 × 酒店系数 1.8');
});

test('tierFactorOf:三档系数、旧档名别名、用户自定义表按原名优先', () => {
  assert.equal(B.tierFactorOf('青旅'), 0.6);
  assert.equal(B.tierFactorOf('客栈'), 1.0);
  assert.equal(B.tierFactorOf('酒店'), 1.8);
  assert.equal(B.tierFactorOf('经济'), 0.6, '旧名 → 青旅');
  assert.equal(B.tierFactorOf('舒适'), 1.0, '旧名 → 客栈');
  // 用户的表里若还用旧名,必须按原名命中(不能被别名逻辑绕开)
  assert.equal(B.tierFactorOf('经济', { 经济: 0.5, 舒适: 1 }), 0.5);
  // 完全不认识的档名兜底到基准档,绝不返回 NaN
  assert.equal(B.tierFactorOf('套房'), 1.0);
});

test('budgetRange:只浮动有 band 的已知项;未含项(null)不参与;实价项不浮动', () => {
  const r = B.budgetRange([
    { name: '住宿 4 晚', amount: 1000, band: 0.3 },
    { name: '火车去程', amount: 1000, band: 0 },
    { name: '门票', amount: null, band: 0.2 },
  ]);
  assert.equal(r.low, 700 + 1000, '住宿下浮 30%,实价火车不动');
  assert.equal(r.high, 1300 + 1000, '住宿上浮 30%,实价火车不动');
  assert.deepEqual(r.contributors, ['住宿 4 晚'], '要说清是谁贡献了不确定,别让人以为整条预算都不准');
  assert.equal(r.band, 15, '半幅 = (2300-1700)/2 / 2000 = 15%');
});

test('budgetRange:全实价时区间退化成一个点,不编出一个假的浮动范围', () => {
  const r = B.budgetRange([
    { name: '火车去程', amount: 748, band: 0 },
    { name: '火车回程', amount: 748, band: 0 },
  ]);
  assert.equal(r.low, 1496);
  assert.equal(r.high, 1496);
  assert.equal(r.band, 0, '没有估算项就不该凭空给一个区间');
  assert.deepEqual(r.contributors, []);
});

test('budgetRange:band 缺失按实价处理(不因为少个字段就乱浮动),空列表返回 0', () => {
  const r = B.budgetRange([{ name: 'x', amount: 500 }]);
  assert.equal(r.low, 500);
  assert.equal(r.high, 500);
  const empty = B.budgetRange([]);
  assert.equal(empty.low, 0);
  assert.equal(empty.high, 0);
  assert.equal(empty.band, 0);
});

test('landBudget 返回的 range 是人均口径且与 items 的 band 一致', () => {
  const bd = B.landBudget({ days: 3, regionId: 'r9' }, { headcount: 1, nights: 2 }, {
    regionStay: { r9: { perRoomPerNight: 200, perPersonPerDay: 100 } },
  });
  const lodging = bd.items.find((i) => i.key === 'lodging');
  const food = bd.items.find((i) => i.key === 'food');
  assert.equal(lodging.band, B.BUDGET_BANDS.lodging, '住宿项要带上自己的幅度');
  assert.equal(food.band, B.BUDGET_BANDS.food);
  // 住宿 400、餐饮 300(3 天 ×100):下界 400×0.7 + 300×0.75 = 505,上界 400×1.3 + 300×1.25 = 895
  assert.equal(bd.range.low, Math.round(400 * 0.7) + Math.round(300 * 0.75));
  assert.equal(bd.range.high, Math.round(400 * 1.3) + Math.round(300 * 1.25));
  assert.deepEqual(bd.range.contributors, ['住宿 2 晚', '餐饮 3 天']);
});

test('青旅按床位计价:人均恒等于床位价,不随人数阶梯跳动', () => {
  // 青旅是按**床位**卖的,一人一床,不存在"包整间"。旧实现把它当"整间房价 × 0.6",
  // 房间数仍按 ceil(人数/2) 算,于是人均随人数跳(1 人 156 / 2 人 78 / 3 人 104)——
  // 而真实的青旅人均本来就该是个常数。
  const cfg = { regionStay: { r: { perRoomPerNight: 260, tiers: { 青旅: { perBedPerNight: 60 } } } } };
  const at = (hc, tier = '青旅') => B.landBudget({ days: 2, regionId: 'r' }, { headcount: hc, nights: 1, tier }, cfg)
    .items.find((i) => i.key === 'lodging');
  for (const hc of [1, 2, 3, 4]) {
    assert.equal(at(hc).amount, 60 * hc, `${hc} 人 = ${hc} 张床`);
    assert.equal(at(hc).perPerson, 60, '人均恒等于床位价,与人数无关');
  }
  assert.match(at(3).note, /按床位计价/, '备注要说清是床位口径');
  assert.match(at(3).note, /3 人 × ¥60\/床\/晚/, '要写出床位数,让人能反查');
  // 对照:客栈是房间模式,人均就该随人数阶梯变化(这不是 bug,是"包整间"的现实)
  assert.equal(at(1, '客栈').amount, 260);
  assert.equal(at(2, '客栈').amount, 260, '2 人一间,仍是 1 间');
  assert.equal(at(3, '客栈').amount, 520, '3 人要 2 间');
  assert.notEqual(at(1, '客栈').perPerson, at(2, '客栈').perPerson, '房间模式人均随人数变才是对的');
});

test('青旅没标床位价时回落到房间价 × 系数(向后兼容,不因此变成未知)', () => {
  const cfg = { regionStay: { r: { perRoomPerNight: 260 } } };
  const l = B.landBudget({ days: 2, regionId: 'r' }, { headcount: 2, nights: 1, tier: '青旅' }, cfg)
    .items.find((i) => i.key === 'lodging');
  assert.equal(l.amount, Math.round(260 * 1 * 0.6), '回落:1 间 × 260 × 系数 0.6');
  assert.doesNotMatch(l.note, /按床位计价/, '没走床位口径就不能这么说');
});

test('床位价只对青旅生效:客栈/酒店档不会被它影响', () => {
  const cfg = {
    regionStay: { r: { perRoomPerNight: 300, perBedPerNight: 50, tiers: { 青旅: { perBedPerNight: 60 } } } },
  };
  const at = (tier) => B.landBudget({ days: 2, regionId: 'r' }, { headcount: 1, nights: 1, tier }, cfg)
    .items.find((i) => i.key === 'lodging');
  assert.equal(at('客栈').amount, 300, '客栈仍按房间计价(区域级床位价不得泄漏过来)');
  assert.equal(at('酒店').amount, Math.round(300 * 1.8), '酒店按房间 × 系数');
  assert.equal(at('青旅').amount, 60, '青旅取 tiers.青旅.perBedPerNight(优先于区域级 50)');
});

// ---- 一次性开销清单(设计稿 4.5):只列要不要准备,不给金额 ----
test('oneTimeCosts:三条触发规则各自命中,命中几条列几条', () => {
  const items = B.oneTimeCosts({ days: 5, type: '长线重装', supplies: '全程无补给', maxAltM: 3800 }, {})
    .map((i) => i.item);
  assert.ok(items.includes('向导 / 马帮 / 背夫'), '3 天以上 + 重装/无补给');
  assert.ok(items.includes('高原保险 / 应急药品'), '海拔 ≥3500');
  assert.ok(!items.includes('装备租赁(冰爪 / 雪套)'), 'bestMonths 无冬季、日期也没填 → 不猜季节');
});

test('oneTimeCosts:只说"另计",绝不给出金额', () => {
  for (const i of B.oneTimeCosts({ days: 7, type: '长线重装', maxAltM: 5000, bestMonths: [12] }, { date: '2027-01-05' })) {
    assert.ok(typeof i.amountNote === 'string' && /另计|另询/.test(i.amountNote), '只能说另计/另询');
    assert.equal(i.amount, undefined, '这些价没有可查证的公开口径,给金额就是编');
  }
});

test('oneTimeCosts:冬季按日期或 bestMonths 任一路判,两条都不满足就不列', () => {
  assert.ok(B.oneTimeCosts({ days: 1, maxAltM: 1200, bestMonths: [12, 1, 2] }, {})
    .some((i) => /冰爪/.test(i.item)), 'bestMonths 含冬季');
  assert.ok(B.oneTimeCosts({ days: 1, maxAltM: 1200 }, { date: '2027-01-05' })
    .some((i) => /冰爪/.test(i.item)), '出行日期在 1 月');
  assert.deepEqual(B.oneTimeCosts({ days: 1, maxAltM: 1200 }, { date: '2026-07-05' }), [],
    '夏天短线什么都不用租');
});

test('oneTimeCosts:空输入 / 脏输入不产条目,也不抛错', () => {
  assert.deepEqual(B.oneTimeCosts(null, {}), []);
  assert.deepEqual(B.oneTimeCosts({}, {}), []);
  assert.deepEqual(B.oneTimeCosts({ days: 'abc', maxAltM: 'x', supplies: null, type: null }, {}), []);
  assert.equal(B.oneTimeCosts({ days: 1, bestMonths: [12] }, { date: '不是日期' }).length, 1,
    '日期脏了只走 bestMonths 那一路,不因为日期坏掉就报错');
});

test('oneTimeCosts:技术地形等级 ≥3 也触发保险项(海拔不高也可能是技术线)', () => {
  assert.ok(B.oneTimeCosts({ days: 1, maxAltM: 800, techLevel: 3 }, {})
    .map((i) => i.item).includes('高原保险 / 应急药品'));
});

// ---- 预算汇总的唯一实现(budgetRollup) ----
// 它存在的理由就是"生成时"与"改动时(换车次)"不能再各算一份:
// 2026-10-08 实测 switchTrain 只重算了 total/perPerson/unknownCount,漏掉 range,
// 于是换车次后票价变了、区间还是旧的。所以这几条断言一半在测数值,
// 一半在锁"区间会随 band 变"这个行为。
test('budgetRollup:合计/人均/未含项/区间一次算清,与逐项手算一致', () => {
  const items = [
    { name: '住宿 2 晚', key: 'lodging', amount: 520, band: 0.3 },
    { name: '餐饮 3 天', key: 'food', amount: 300, band: 0.25 },
    { name: '火车去程', amount: 374, band: 0 },
    { name: '门票', amount: null, band: 0.2 },
  ];
  const r = B.budgetRollup(items, 2);
  assert.equal(r.total, 1194);
  assert.equal(r.perPerson, 597);
  assert.equal(r.knownCount, 3);
  assert.equal(r.unknownCount, 1, 'amount=null 是「未含」,不是 0 元,也不该被算进合计');
  assert.deepEqual(r.range.contributors, ['住宿 2 晚', '餐饮 3 天'], 'band=0 的实价项不进贡献者');
  assert.equal(r.range.low, Math.round(520 * 0.7) + Math.round(300 * 0.75) + 374);
  assert.equal(r.range.high, Math.round(520 * 1.3) + Math.round(300 * 1.25) + 374);
});

test('budgetRollup:金额不动、只把 band 从占位(25%)改成实价(0),区间必须收窄', () => {
  // 隔离变量:金额保持一致,只有这样"区间变窄"才能归因到 band 而不是票价本身变了
  const withBand = (band) => B.budgetRollup([
    { name: '住宿 2 晚', amount: 520, band: B.BUDGET_BANDS.lodging },
    { name: '火车去程', amount: 374, band },
  ], 1);
  const est = withBand(B.BUDGET_BANDS.railEstimate);
  const act = withBand(B.BUDGET_BANDS.railActual);
  assert.ok(est.range.contributors.includes('火车去程'), '占位估算车次要算进不确定来源');
  assert.ok(!act.range.contributors.includes('火车去程'), '实价车次不再是「不确定来源」');
  assert.ok(act.range.high - act.range.low < est.range.high - est.range.low,
    `实价后区间必须更窄:${act.range.high - act.range.low} 应 < ${est.range.high - est.range.low}`);
});

test('budgetRollup:headcount 缺省/非法时退回 1 人,绝不产出 NaN 人均', () => {
  const items = [{ name: 'x', amount: 100, band: 0 }];
  assert.equal(B.budgetRollup(items).perPerson, 100);
  assert.equal(B.budgetRollup(items, 0).perPerson, 100, '0 人退回 1 人');
  assert.equal(B.budgetRollup(items, 'abc').perPerson, 100);
  assert.ok(Number.isFinite(B.budgetRollup(items, NaN).perPerson));
  // 脏金额不该被当成已知项(否则合计变 NaN,而界面上会显示 ¥NaN)
  assert.equal(B.budgetRollup([{ name: 'y', amount: 'oops', band: 0.2 }], 1).total, 0);
  assert.equal(B.budgetRollup([{ name: 'y', amount: 'oops', band: 0.2 }], 1).unknownCount, 1);
});

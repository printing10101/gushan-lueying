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

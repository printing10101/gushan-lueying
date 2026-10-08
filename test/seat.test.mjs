// 选座口径。这个模块此前**没有直接单测**,而它有两件事值得钉:
//   1) 有产品语义的规则——≥10 小时的夜车/长途优先卧铺(硬座 20 小时不是人坐的),
//      短途以二等座为主。这条规则以前是手抄在两个地方的,INSTINCTS 记着"手抄副本必漂移";
//   2) 它被主进程(rail12306/planner)与渲染进程(window.GushanLib.seat)双端共用同一份实现,
//      任何一侧跑偏都只有真起窗口才看得见。
// 断言按"金额逐值"写:只断言标签等于没测优先级对不对(INSTINCTS「成对字段要逐值断言」)。
import { createRequire } from 'module';
const require = createRequire(new URL('../package.json', import.meta.url));
const test = require('node:test');
const assert = require('node:assert');

const S = require('./lib/seat.js');

test('lishiHours:"18:35" → 18.58 小时;10:00 必须精确等于 10(它是卧铺判据的边界)', () => {
  assert.equal(S.lishiHours('18:35'), 18 + 35 / 60);
  assert.equal(S.lishiHours('10:00'), 10, '整点要落在边界上,差一点就会把长途当短途');
  assert.ok(S.lishiHours('09:59') < 10, '差一分钟仍是短途');
  assert.equal(S.lishiHours('00:30'), 0.5);
});

test('lishiHours:解析不出按 0 走短途口径——这是刻意的降级,不是"猜一个数"', () => {
  // 这里 0 同时表示"0 点出发"与"解析失败",两者不可区分。
  // 对选座是安全的:两种情况都该走短途口径(二等座),所以不存在"把失败糊成合法值"的问题。
  // 换成里程/时刻那种"0 是合法值但含义不同"的场景就不安全了(见 INSTINCTS「0 点陷阱」)。
  assert.equal(S.lishiHours(''), 0);
  assert.equal(S.lishiHours(undefined), 0);
  assert.equal(S.lishiHours(null), 0);
  assert.equal(S.lishiHours('abc'), 0);
  // 只有小时没有分钟:按整点算,不因为缺一半就把整条车次判成短途
  assert.equal(S.lishiHours('18'), 18);
});

test('seatPreference:≥10 小时优先卧铺,短途以二等座为主', () => {
  const long = ['硬卧', '动卧', '软卧', '二等座', '硬座'];
  const short = ['二等座', '硬座', '一等座'];
  assert.deepEqual(S.seatPreference('10:00'), long, '10 小时整必须算长途');
  assert.deepEqual(S.seatPreference('09:59'), short);
  assert.deepEqual(S.seatPreference('22:30'), long, '夜车是卧铺最典型的场景');
  // 顺序本身就是口径:硬卧排在软卧前面(先看买不买得起,再看舒不舒服)
  assert.ok(long.indexOf('硬卧') < long.indexOf('软卧'));
});

test('pickSeat:夜车有硬卧就选硬卧,票价要逐值核对', () => {
  const got = S.pickSeat({ 硬座: 128, 硬卧: 222, 软卧: 348 }, '20:00');
  assert.equal(got.label, '硬卧');
  assert.equal(got.price, 222, '金额必须断言——只看标签的话,优先级顺序写反了也测不出来');
});

test('pickSeat:短途优先二等座;优先级全不命中时退到第一个有价的,不返回 null', () => {
  assert.deepEqual(S.pickSeat({ 一等座: 405, 二等座: 252 }, '02:00'), { label: '二等座', price: 252 });
  // 只有一等座时:优先级列表里没有它"有价"的项命中(一等座只排在短途末位),
  // 但绝不能让有票的行程"选不出座"——退回第一个有价的
  assert.deepEqual(S.pickSeat({ 一等座: 405 }, '02:00'), { label: '一等座', price: 405 });
  // 完全不在词表里的代码(12306 新增席别)同理
  assert.deepEqual(S.pickSeat({ 座位代码X: 123 }, '20:00'), { label: '座位代码X', price: 123 });
});

test('pickSeat:空票价表返回 null(既不抛错,也不编一个价)', () => {
  assert.equal(S.pickSeat({}, '20:00'), null);
  assert.equal(S.pickSeat(null, '20:00'), null);
  assert.equal(S.pickSeat(undefined, '20:00'), null);
});

test('pickSeat:0 元会被当成有效票价——"票价表只含有价席别"由上游 parsePrices 保证', () => {
  // 这条断言记录的是**契约**而不是"这里安全":pickSeat 用 Number.isFinite 判有效,0 能过。
  // 所以"0 不进票价表"必须由数据入口保证(rail12306.parsePrices 的 price > 0),
  // 那条过滤另有断言盯着(rail12306-parse.test.mjs)。
  // 若哪天 pickSeat 改成自己过滤 0,这条会红——那时要同步更新这里的契约说明,不是直接删。
  assert.deepEqual(S.pickSeat({ 硬卧: 0 }, '20:00'), { label: '硬卧', price: 0 });
  // 非数值价格一律不算命中(会被优先级循环跳过,最终走兜底分支)
  assert.deepEqual(S.pickSeat({ 硬卧: 'x', 硬座: 128 }, '20:00'), { label: '硬座', price: 128 });
});

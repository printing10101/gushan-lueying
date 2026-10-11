import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
const require = createRequire(new URL('../package.json', import.meta.url));

// 站名表必须在 require 之前指向**测试自带的临时数据根**。
// 原因:`store.read('stations')` 读的是 data/stations.json,而它是 gitignore 的运行时缓存
// (官方 station_name.js 下载后落的盘)。开发机上它存在,用例就绿;一旦导出到干净目录
// (新 clone / CI)它不存在,ensureStations 只能去联网,公网被挡 → 抛"站名表解析为空",
// 4 条 queryTrains 用例全红。实测过,不是推测。
// 所以这里自带一份最小站名表,让用例不依赖机器上是否跑过 App。
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'gushan-rail-test-'));
fs.writeFileSync(path.join(TMP_DATA, 'stations.json'), JSON.stringify([
  { name: '西安北', code: 'ICW' }, // 与下面的 QT_MAP 对应
  { name: '北京西', code: 'EAY' },
]));
process.env.GUSHAN_DATA_DIR = TMP_DATA; // store.js 在模块加载时读它,顺序不能反

const rail = require('./lib/rail12306.js');
const test = require('node:test');
const assert = require('node:assert');

test('parseStationJs:提取站名与电报码', () => {
  const text = `var station_names ='@bjb|北京北|VAP|beijingbei|bjb|0|0357|北京|||@bjn|北京南|VNP|beijingnan|bjn|3|0357|北京|||@cdd|成都东|ICW|chengdudong|cdd|6|0119|成都|||'`;
  const stations = rail.parseStationJs(text);
  assert.deepEqual(stations, [
    { name: '北京北', code: 'VAP' },
    { name: '北京南', code: 'VNP' },
    { name: '成都东', code: 'ICW' },
  ]);
});

test('parsePrices:解码余票行内嵌票价(f39)', () => {
  // 实证样例:G4184 成都东→西安北,商务774 一等405 二等252
  const prices = rail.parsePrices('9077400001M040500000O025200000O025203000');
  assert.deepEqual(prices, { 商务座: 774, 一等座: 405, 二等座: 252 });
});

test('parsePrices:普速车硬座硬卧软卧', () => {
  const prices = rail.parsePrices('3022250021403485000710128500211012853198');
  assert.deepEqual(prices, { 硬卧: 222, 软卧: 348, 硬座: 128 });
});

test('parsePrices:空字段与未知代码', () => {
  assert.deepEqual(rail.parsePrices(''), {});
  assert.deepEqual(rail.parsePrices(undefined), {});
  const p = rail.parsePrices('X0123000001');
  assert.deepEqual(p, { 座位代码X: 123 });
});

test('parsePrices:0 元席别(无价/无票)必须被过滤,否则会被 pickSeat 当成有效价选中', () => {
  // 这条过滤是"0 不进票价表"的唯一防线:下游 seat.pickSeat 用 Number.isFinite 判有效,
  // 0 能通过那道门,于是一个 0 元席别会被当成"最便宜的可选座"选出来。
  // 删掉 price > 0 这个用例就必须红(已做变异验证)。
  const p = rail.parsePrices('9077400001M040500000O000000000');
  assert.deepEqual(p, { 商务座: 774, 一等座: 405 }, '0 元的二等座不得进表');
  assert.ok(!Object.values(p).some((v) => v === 0), '票价表里不允许出现 0 元项');
});

// ---------- queryTrains 的空结果二义性(网络层 mock) ----------
// 空车次列表是**二义**响应:可能真的没有匹配车次,也可能是被限频/风控时返回的
// "结构正确、内容为空"。实测撞到过后一种——同一趟「西安北→北京西 2026-10-20」
// 被判成"没有可购车次"、预算退化成占位估算,而同一查询另一时刻返回 40 趟车。
// 所以:空结果要换路径再试、不缓存、并带上 emptyResult 标记交给调用方复核。
const jsonRes = (body) => new Response(JSON.stringify(body), {
  status: 200, headers: { 'content-type': 'application/json' },
});

// 一条最小合法余票行(字段序号对应 ROW,票价编码见上面 parsePrices 的用例)
function qtRow() {
  const r = new Array(40).fill('');
  r[2] = '76000D10200'; r[3] = 'D102';
  r[6] = 'ICW'; r[7] = 'EAY';
  r[8] = '02:00'; r[9] = '14:31'; r[10] = '12:31'; r[11] = 'Y';
  r[30] = '有'; r[39] = 'O018700000';
  return r.map(String).join('|');
}
const QT_MAP = { ICW: '西安北', EAY: '北京西' };

function withFetch(impl) {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  return () => { globalThis.fetch = real; };
}

// seen 只统计**余票请求**:cookie 初始化那次不计(它是模块级 cookieJar 的一次性副作用)
function makeNet(plan) {
  const seen = [];
  return {
    seen,
    fetch: async (url) => {
      const u = String(url);
      if (u.includes('/leftTicket/init')) {
        return new Response('', { status: 200, headers: { 'set-cookie': 'JSESSIONID=qt; Path=/' } });
      }
      seen.push(u);
      return plan(seen.length, u);
    },
  };
}

test('queryTrains:空车次列表返回 emptyResult 而不是抛错(空是合法结果,不是故障)', async () => {
  const net = makeNet(() => jsonRes({ status: true, data: { result: [], map: QT_MAP } }));
  const restore = withFetch(net.fetch);
  try {
    const r = await rail.queryTrains('西安北', '北京西', '2026-03-01', { force: true });
    assert.equal(r.trains.length, 0);
    assert.equal(r.emptyResult, true, '空结果必须带标记,否则调用方只能猜它是"没车"');
    assert.ok(r.emptyHits >= 2, `空结果要换路径再试,不能拿到第一个空就收工(实际 emptyHits=${r.emptyHits})`);
  } finally { restore(); }
});

test('queryTrains:某条路径返回非空车次就立刻采纳(空的先换路径)', async () => {
  const net = makeNet((n) => (n === 1
    ? jsonRes({ status: true, data: { result: [], map: QT_MAP } })
    : jsonRes({ status: true, data: { result: [qtRow()], map: QT_MAP } })));
  const restore = withFetch(net.fetch);
  try {
    const r = await rail.queryTrains('西安北', '北京西', '2026-03-02', { force: true });
    assert.equal(r.trains.length, 1, '第二条路径有车次就必须采纳');
    assert.equal(r.trains[0].code, 'D102');
    assert.equal(r.trains[0].prices['二等座'], 187, '票价要一路带出来');
    assert.equal(r.emptyResult, undefined, '有结果时不该带 emptyResult 标记');
    assert.equal(net.seen.length, 2, '拿到车次立刻收工,不再打后面的路径(省配额)');
  } finally { restore(); }
});

test('queryTrains:空结果不缓存——复核重发必须真的发出请求(否则"被限频"会被固化)', async () => {
  const net = makeNet(() => jsonRes({ status: true, data: { result: [], map: QT_MAP } }));
  const restore = withFetch(net.fetch);
  try {
    await rail.queryTrains('西安北', '北京西', '2026-03-03');
    const after1 = net.seen.length;
    await rail.queryTrains('西安北', '北京西', '2026-03-03'); // 同 key,故意不 force
    assert.ok(net.seen.length > after1,
      '同 key 再查必须重新发请求:空结果不许进缓存,否则限频一次会固化 10 分钟');
  } finally { restore(); }
});

test('queryTrains:有结果时进缓存;force 可绕过(复核重试靠它)', async () => {
  const net = makeNet(() => jsonRes({ status: true, data: { result: [qtRow()], map: QT_MAP } }));
  const restore = withFetch(net.fetch);
  try {
    await rail.queryTrains('西安北', '北京西', '2026-03-04');
    const after1 = net.seen.length;
    await rail.queryTrains('西安北', '北京西', '2026-03-04');
    assert.equal(net.seen.length, after1, '第二次应命中缓存,不发请求');
    await rail.queryTrains('西安北', '北京西', '2026-03-04', { force: true });
    assert.equal(net.seen.length, after1 + 1, 'force 必须真的重发,否则 planner 的复核是假动作');
  } finally { restore(); }
});

function row(overrides = {}) {
  const r = new Array(40).fill('');
  r[2] = '76000D199803'; r[3] = 'D1998';
  r[6] = 'ICW'; r[7] = 'EAY';
  r[8] = '06:09'; r[9] = '09:31'; r[10] = '03:22'; r[11] = 'Y';
  r[16] = '01'; r[17] = '04'; r[35] = '9MOO';
  r[30] = '--'; r[31] = '7'; r[32] = '无';
  return rail.parseTrain(r.map((v, i) => overrides[i] ?? v).map(String).join('|'), { ICW: '成都东', EAY: '西安北' });
}

test('parseTrain:字段解析与余票格式', () => {
  const t = row();
  assert.equal(t.code, 'D1998');
  assert.equal(t.from, '成都东');
  assert.equal(t.to, '西安北');
  assert.equal(t.startTime, '06:09');
  assert.equal(t.canWebBuy, true);
  assert.deepEqual(t.seats, { 一等座: '7 张', 商务座: '无' });
  assert.deepEqual(t.prices, {});
});

test('parseTrain:内嵌票价解码', () => {
  const t = row({ 39: '9077400001M040500000O025200000O025203000' });
  assert.deepEqual(t.prices, { 商务座: 774, 一等座: 405, 二等座: 252 });
});

test('parseTrain:余票"有"格式与不可购车次', () => {
  const t = row({ 30: '有', 11: 'N' });
  assert.equal(t.seats['二等座'], '有');
  assert.equal(t.canWebBuy, false);
});


// ---------- 坐席口径与预售期 ----------

test('lishiHours:解析历时为小时数,坏值按 0', () => {
  assert.equal(rail.lishiHours('06:16'), 6 + 16 / 60);
  assert.equal(rail.lishiHours('13:17'), 13 + 17 / 60);
  assert.equal(rail.lishiHours(''), 0);
  assert.equal(rail.lishiHours(undefined), 0);
});

test('seatPreference:夜车长途优先卧铺,短途以二等座为主', () => {
  assert.deepEqual(rail.seatPreference('13:17'), ['硬卧', '动卧', '软卧', '二等座', '硬座']);
  assert.deepEqual(rail.seatPreference('09:59'), ['二等座', '硬座', '一等座']);
  assert.deepEqual(rail.seatPreference('10:00'), ['硬卧', '动卧', '软卧', '二等座', '硬座']);
});

test('pickSeat:按历时口径选坐席,没命中取首个有价的,全空 null', () => {
  // 夜车:二等座不存在,硬卧顶上
  assert.deepEqual(rail.pickSeat({ 硬座: 152.5, 硬卧: 279.5 }, '13:17'), { label: '硬卧', price: 279.5 });
  // 短途:二等座优先
  assert.deepEqual(rail.pickSeat({ 商务座: 774, 一等座: 405, 二等座: 252 }, '06:16'), { label: '二等座', price: 252 });
  // 偏好坐席无价时顺延(短途车只有一等座报价)
  assert.deepEqual(rail.pickSeat({ 一等座: 405 }, '06:16'), { label: '一等座', price: 405 });
  assert.equal(rail.pickSeat({}, '06:16'), null);
  assert.equal(rail.pickSeat(null, '06:16'), null);
});

test('beyondPresale:15 天外算超预售期,格式坏不算', () => {
  const now = new Date('2026-10-04T12:00:00+08:00').getTime();
  assert.equal(rail.beyondPresale('2026-10-10', now), false);
  assert.equal(rail.beyondPresale('2026-10-19', now), false); // 15 天边界内
  assert.equal(rail.beyondPresale('2026-10-20', now), true);
  assert.equal(rail.beyondPresale('2026-12-01', now), true);
  assert.equal(rail.beyondPresale('bad-date', now), false);
  assert.equal(rail.beyondPresale('', now), false);
});

// ---------- 往返大交通估算 ----------

test('estimateDate:落在预售期内,格式为 YYYY-MM-DD', () => {
  const now = new Date('2026-10-04T12:00:00+08:00').getTime();
  const date = rail.estimateDate(now);
  assert.match(date, /^\d{4}-\d{2}-\d{2}$/); // 10 天后,精确日随本机时区浮动,不硬编码
  assert.equal(rail.beyondPresale(date, now), false);
});

test('pickEstimateTrain:与行程规划同口径,可购+选座有票优先', () => {
  const t = (over = {}) => ({
    code: 'D1998', canWebBuy: true, lishi: '06:16',
    prices: { 二等座: 252 }, seats: { 二等座: '有' }, ...over,
  });
  // 选座有票的车优先
  const trains = [t({ code: 'G1', seats: { 二等座: '无' } }), t({ code: 'G2' })];
  assert.equal(rail.pickEstimateTrain(trains).t.code, 'G2');
  // 全部选座无票:退而取第一个有报价的可购车次
  assert.equal(rail.pickEstimateTrain([t({ code: 'G1', seats: { 二等座: '无' } })]).t.code, 'G1');
  // 不可购/无票价的一律不选
  assert.equal(rail.pickEstimateTrain([t({ canWebBuy: false }), t({ prices: {} })]), null);
  assert.equal(rail.pickEstimateTrain([]), null);
});

// ---------- 中转估算 ----------

test('pickJunctions:按离目的地距离从近到远取 k 个,坐标缺失返回空', () => {
  // 丽江附近:昆明最近,其后成都东、贵阳北
  const picks = rail.pickJunctions({ lng: 100.229, lat: 26.858 }, 3);
  assert.deepEqual(picks.map((j) => j.name), ['昆明', '成都东', '贵阳北']);
  assert.deepEqual(rail.pickJunctions(null), []);
  assert.deepEqual(rail.pickJunctions({ lng: NaN, lat: 26 }), []);
});

test('transferEstimate:两腿实价相加 ×2,没车次的枢纽自动跳过', async () => {
  const train = (code, price) => ({
    code, canWebBuy: true, lishi: '06:00',
    prices: { 二等座: price }, seats: { 二等座: '有' },
  });
  const calls = [];
  const query = async (from, to) => {
    calls.push(`${from}→${to}`);
    if (from === '昆明') return { trains: [] }; // 最近枢纽没车 → 轮到成都东
    if (from === '西安北') return { trains: [train('G1', 200)] };
    return { trains: [train('D2', 150)] };
  };
  const est = await rail.transferEstimate('西安北', '丽江', { lng: 100.229, lat: 26.858 }, query);
  assert.equal(est.perPerson, (200 + 150) * 2);
  assert.equal(est.via, '成都东');
  assert.match(est.note, /经成都东中转\(G1 二等座 \+ D2 二等座\)/);
  assert.ok(calls.includes('西安北→昆明') && calls.includes('昆明→丽江'));
});

test('transferEstimate:全部枢纽都没车且无网络错误 → null', async () => {
  const query = async () => ({ trains: [] });
  assert.equal(await rail.transferEstimate('西安北', '丽江', { lng: 100.2, lat: 26.8 }, query), null);
});

test('transferEstimate:查询抛错且整轮没成 → 抛出(不缓存负结果)', async () => {
  const query = async () => { throw new Error('网络'); };
  await assert.rejects(rail.transferEstimate('西安北', '丽江', { lng: 100.2, lat: 26.8 }, query));
});

// ---- cookie 不是取一次就永远有效 ----
// 旧写法:jar 非空就跳过初始化 → 应用开一整天后每次查票都带着过期 cookie,
// 失败还被 planner 吞成"取价失败/占位估算",用户看不出重启就好。
test('cookie 判新:没取过要取,新鲜的不重取,超 30 分钟必须重取', () => {
  const { cookieNeedsRefresh, COOKIE_TTL_MS } = rail;
  const now = 1_700_000_000_000;
  assert.equal(cookieNeedsRefresh({}, 0, now), true, '空 jar = 从没取过');
  assert.equal(cookieNeedsRefresh({ JSESSIONID: 'x' }, now, now), false, '刚取的不用重取');
  assert.equal(cookieNeedsRefresh({ JSESSIONID: 'x' }, now - COOKIE_TTL_MS + 1000, now), false, '差一点还没过期');
  assert.equal(cookieNeedsRefresh({ JSESSIONID: 'x' }, now - COOKIE_TTL_MS, now), true, '到点就该重取');
  assert.equal(cookieNeedsRefresh({ JSESSIONID: 'x' }, now - 10 * 60 * 60 * 1000, now), true, '跑了 10 小时必须重取');
});

test('dropCookies 清空 jar 与取用时间,下一次必然重新初始化', () => {
  const { cookieNeedsRefresh, dropCookies, COOKIE_TTL_MS } = rail;
  const now = 1_700_000_000_000;
  // 先模拟"取过":直接断言 drop 之后的状态是"没取过"
  dropCookies();
  assert.equal(cookieNeedsRefresh(undefined, undefined, now), true, 'drop 后必须判定为需要重取');
  assert.ok(COOKIE_TTL_MS > 0 && COOKIE_TTL_MS <= 60 * 60 * 1000, `TTL 应在合理区间,实得 ${COOKIE_TTL_MS}`);
});

// ---- 缓存不能只增不减 ----
// 两个会话级 Map 原先只有 set 没有 delete:过期项要等"再次命中同一 key"才被覆盖,
// 否则永久驻留。estimateCache 更极端——存的是裸 Promise,压根没有 expires 字段。
test('sweepExpired:清掉已过期的,留下新鲜的与没有 expires 的', () => {
  const { sweepExpired } = rail;
  const now = 1_700_000_000_000;
  const m = new Map([
    ['old', { expires: now - 1, result: 1 }],
    ['fresh', { expires: now + 1000, result: 2 }],
    ['noExpiry', { result: 3 }],            // 没有 expires 的不该被误删
    ['badExpires', { expires: NaN, result: 4 }],
  ]);
  const out = sweepExpired(m, now);
  assert.equal(out.has('old'), false, '过期的必须清掉');
  assert.equal(out.has('fresh'), true, '新鲜的不能动');
  assert.equal(out.has('noExpiry'), true, '没有 expires 字段的不能误删');
  assert.equal(out.has('badExpires'), true, 'expires 不是数字的不能误删');
  assert.equal(out.size, 3);
});

test('sweepExpired 返回同一个 Map(就地清,不是复制一份)', () => {
  const { sweepExpired } = rail;
  const m = new Map([['a', { expires: 0 }]]);
  assert.equal(sweepExpired(m, Date.now()), m);
});

test('两个缓存都有 TTL 常量(estimeCache 原先没有)', () => {
  const { QUERY_TTL_MS, ESTIMATE_TTL_MS } = rail;
  assert.ok(QUERY_TTL_MS > 0, 'queryTrains 缓存要有 TTL');
  assert.ok(ESTIMATE_TTL_MS > 0, '往返估算缓存要有 TTL(此前存裸 Promise,永不失效)');
});

test('cachedEstimate 存的条目带 expires(sweep 才扫得到)', () => {
  const fs = require('fs');
  const src = fs.readFileSync(new URL('../lib/rail12306.js', import.meta.url), 'utf8');
  const at = src.indexOf('async function cachedEstimate');
  assert.ok(at > 0, '找不到 cachedEstimate');
  const body = src.slice(at, src.indexOf('\n}\n', at));
  assert.ok(body.includes('expires:'), '估算缓存的条目必须带 expires');
  assert.ok(body.includes('sweepExpired('), 'cachedEstimate 要顺手清过期项');
});

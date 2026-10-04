import { createRequire } from 'module';
const require = createRequire(new URL('../package.json', import.meta.url));
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

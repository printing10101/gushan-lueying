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


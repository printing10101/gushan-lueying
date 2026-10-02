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
  assert.equal(t.fromNo, '01');
  assert.equal(t.seatTypes, '9MOO');
});

test('parseTrain:余票"有"格式与不可购车次', () => {
  const t = row({ 30: '有', 11: 'N' });
  assert.equal(t.seats['二等座'], '有');
  assert.equal(t.canWebBuy, false);
});

test('extractPrices:清洗货币符号并跳过无效值', () => {
  const prices = rail.extractPrices({ A1: '¥1,234.5', M: '728.5', XX: '', O: 0 });
  assert.equal(prices['商务座'], 1234.5);
  assert.equal(prices['一等座'], 728.5);
  assert.equal(prices['XX'] ?? prices['二等座'], undefined);
});

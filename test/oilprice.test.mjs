import { createRequire } from 'module';
const require = createRequire(new URL('../package.json', import.meta.url));
const oilprice = require('./lib/oilprice.js');
const test = require('node:test');
const assert = require('node:assert');

// 截自金投网四川页的真实结构(现价表 hq_table1 + 历史表最近调价日期)
const FIXTURE = `<table width="100%" border="0" cellspacing="0" cellpadding="0" class="hq_table1">
  <thead>
    <tr class="bg">
      <th>89#汽油</th>
      <th>92#汽油</th>
      <th>95#汽油</th>
      <th>0#柴油</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>8.08</td>
      <td>8.7</td>
      <td>9.3</td>
      <td>8.34</td>
    </tr>
  </tbody>
</table>
<table id="oilTable"><tbody><tr><td class="data">2026-09-25</td></tr></tbody></table>`;

test('parseOilPage:表头标签与同行数值配对,附最近调价日期', () => {
  const { prices, updatedOn } = oilprice.parseOilPage(FIXTURE);
  assert.deepEqual(prices, { '89#': 8.08, '92#': 8.7, '95#': 9.3, '0#': 8.34 });
  assert.equal(updatedOn, '2026-09-25');
});

test('parseOilPage:页面改版(找不到现价表)响亮返回空,不猜数', () => {
  assert.deepEqual(oilprice.parseOilPage('<html>改版了</html>'), { prices: null, updatedOn: null });
});

test('normalizeLabel:92#汽油→92#,0#柴油→0#', () => {
  assert.equal(oilprice.normalizeLabel('92#汽油'), '92#');
  assert.equal(oilprice.normalizeLabel('0#柴油'), '0#');
  assert.equal(oilprice.normalizeLabel('95号'), '95#');
});

test('省份 slug 表:31 个省市自治区齐全,陕西是该站特有 slug', () => {
  assert.equal(Object.keys(oilprice.PROVINCE_SLUG).length, 31);
  assert.equal(oilprice.PROVINCE_SLUG.四川, 'sichuan');
  assert.equal(oilprice.PROVINCE_SLUG.陕西, 'sanxi');
  assert.equal(oilprice.PROVINCE_SLUG.山西, 'shanxi');
});

test('todayStr:本地日期格式 YYYY-MM-DD', () => {
  assert.match(oilprice.todayStr(), /^\d{4}-\d{2}-\d{2}$/);
});

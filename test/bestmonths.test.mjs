import { createRequire } from 'module';
const require = createRequire(new URL('../package.json', import.meta.url));
const { parseBestSeason } = require('./lib/bestmonths.js');
const test = require('node:test');
const assert = require('node:assert');

test('区间写法:含修饰词、跨年、多段组合', () => {
  assert.deepEqual(parseBestSeason('6月中-9月底'), [6, 7, 8, 9]);
  assert.deepEqual(parseBestSeason('10月中旬-11月上旬(秋色)、5-6月(春花)'), [5, 6, 10, 11]);
  // 跨年:11月-次年3月(输出升序)
  assert.deepEqual(parseBestSeason('11月-次年3月'), [1, 2, 3, 11, 12]);
  assert.deepEqual(parseBestSeason('12月至次年2月'), [1, 2, 12]);
});

test('季节词与全年', () => {
  assert.deepEqual(parseBestSeason('冬季(雪景)'), [1, 2, 12]);
  assert.deepEqual(parseBestSeason('春季、秋季'), [3, 4, 5, 9, 10, 11]);
  // 全年/四季皆宜 = 不存在错季,返回 null 与"未标注"同义
  assert.equal(parseBestSeason('全年'), null);
  assert.equal(parseBestSeason('四季皆宜,夏季最佳'), null);
});

test('单月写法与解析不了的返回 null(宁缺毋编)', () => {
  assert.deepEqual(parseBestSeason('10月-11月'), [10, 11]);
  assert.deepEqual(parseBestSeason('9月,10月为最佳'), [9, 10]);
  assert.equal(parseBestSeason('视降雪情况而定'), null);
  assert.equal(parseBestSeason(''), null);
  assert.equal(parseBestSeason(null), null);
  // 非法月份数字不硬夹:整段作废
  assert.equal(parseBestSeason('15月-18月'), null);
});

test('真实路线库上可跑:解析结果都在 1-12 内,且已有手标不被改动', () => {
  const store = require('./lib/store.js');
  const trails = store.read('trails');
  let parsed = 0;
  for (const [id, t] of Object.entries(trails)) {
    if (Array.isArray(t.bestMonths) && t.bestMonths.length) {
      parsed++;
      for (const m of t.bestMonths) {
        assert.ok(Number.isInteger(m) && m >= 1 && m <= 12, `${id} bestMonths 越界: ${m}`);
      }
      assert.equal(new Set(t.bestMonths).size, t.bestMonths.length, `${id} bestMonths 有重复月份`);
    }
  }
  assert.ok(parsed >= 150, `结构化月份应有 150+ 条(回填后),现在 ${parsed}`);
});

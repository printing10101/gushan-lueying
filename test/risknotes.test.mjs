// riskNotes:风险的出处字段。
//
// 为什么要它:trails.json 的 risks 覆盖 167/191 条,但全是无出处的描述句——这是全库唯一
// 不带来源口径的字段,和 README/INSTINCTS 里「每项带数字来源、宁缺毋编」的纪律自相矛盾。
// 借鉴 Summitra 首屏那份「中国攀登事故报告 2022–2026」的做法:风险不该是一句感觉,
// 而该能指回某份记录。
//
// 本模块只管口径,不产数据。数据由人核对后手填,填不出来源的一律显示「未核实」。
// 与老 risks 并存(平行字段),因为 lib/gear.js:16 与 lib/quickfacts.js:18 都在对 risks
// 做字符串拼接,改 risks 的结构会连带把那两个模块的推导打碎。
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(new URL('../package.json', import.meta.url));
const test = require('node:test');
const assert = require('node:assert');

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TRAILS = require(path.join(ROOT, 'data', 'trails.json'));
const { normalizeRiskNotes, riskNotesSummary } = require('./lib/risknotes.js');

test('向后兼容:没有 riskNotes 的老线路返回空列表且不报错(当前全库 191 条都该走这条)', () => {
  const r = normalizeRiskNotes({ name: '乌孙古道' });
  assert.deepEqual(r.items, []);
  assert.equal(r.dirty, 0);
  // 连线路对象本身缺失也不能炸(渲染层会遍历全库)
  assert.deepEqual(normalizeRiskNotes(null).items, []);
  assert.equal(normalizeRiskNotes(null).dirty, 0);
  // 有人手改 JSON 把 riskNotes 写成了字符串:形状错要留下脏痕,不能当成"没有风险记录"
  const wrongShape = normalizeRiskNotes({ riskNotes: '一段字符串' });
  assert.deepEqual(wrongShape.items, []);
  assert.equal(wrongShape.dirty, 1, '非数组的 riskNotes 应计 1 条脏,而不是静默当作没有');
});

test('有出处的条目如实带出 source 与 year', () => {
  const r = normalizeRiskNotes({
    riskNotes: [{ text: '2023 年有队员在阿克布拉克达坂滑坠', source: '中国攀登事故报告 2023 卷', year: 2023 }],
  });
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].verified, true, '有 source 就该判为已核实');
  assert.equal(r.items[0].source, '中国攀登事故报告 2023 卷');
  assert.equal(r.items[0].year, 2023);
  assert.equal(r.dirty, 0);
});

test('缺 source / 空白 source 一律不冒充有出处(verified=false,UI 走「未核实」)', () => {
  for (const bad of [{}, { source: '' }, { source: '   ' }, { source: null }]) {
    const r = normalizeRiskNotes({ riskNotes: [{ text: '塌方落石', ...bad }] });
    assert.equal(r.items.length, 1, `条目不该被丢掉: ${JSON.stringify(bad)}`);
    assert.equal(r.items[0].verified, false, `不该冒充有出处: ${JSON.stringify(bad)}`);
  }
});

test('脏条目计入 dirty 并可见,不静默消失也不整条炸', () => {
  // INSTINCTS 的教训:脏值被悄悄收成 0 / 被 filter 掉,等于给用户一个"这里没问题"的假象
  const r = normalizeRiskNotes({
    riskNotes: [null, '字符串条目', { text: '  ' }, { text: '合法一条', source: '某队报' }],
  });
  assert.equal(r.dirty, 3, '非对象 / 空 text 的条目要计入脏数');
  assert.equal(r.items.length, 1, '只有合法条目进 items');
  assert.equal(r.items[0].text, '合法一条');
});

test('year 非法时置 null,但不影响出处判定', () => {
  for (const y of ['2023', 12, 1899, 99999, NaN, undefined]) {
    const r = normalizeRiskNotes({ riskNotes: [{ text: 'x', source: '某报告', year: y }] });
    assert.equal(r.items[0].year, null, `year=${JSON.stringify(y)} 应被拒`);
    assert.equal(r.items[0].verified, true, 'year 坏不该连带把出处也判成未核实');
  }
  const ok = normalizeRiskNotes({ riskNotes: [{ text: 'x', source: '某报告', year: 2024 }] });
  assert.equal(ok.items[0].year, 2024);
});

test('汇总口径:withSource + withoutSource === 条目总数,脏数单独一路', () => {
  const s = riskNotesSummary([
    { riskNotes: [{ text: 'a', source: '报告' }, { text: 'b' }] },
    { riskNotes: [{ text: 'c', source: '报告' }] },
    {},
  ]);
  assert.equal(s.total, 3);
  assert.equal(s.withSource, 2);
  assert.equal(s.withoutSource, 1);
  assert.equal(s.withSource + s.withoutSource, s.total);
  assert.equal(riskNotesSummary([]).total, 0);
});

test('全库不变量:现有 trails.json 每条线路过 normalize 都不抛错、且没有脏条目', () => {
  const problems = [];
  for (const [id, t] of Object.entries(TRAILS)) {
    try {
      const r = normalizeRiskNotes(t);
      if (r.dirty) problems.push(`${id}: ${r.dirty} 条脏 riskNotes`);
    } catch (e) {
      problems.push(`${id}: 抛错 ${e.message}`);
    }
  }
  assert.equal(problems.length, 0, problems.join('\n   '));
});

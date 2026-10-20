// 数据标注欠账清单:列出缺 tickets / risks / supplies / bestMonths / regionId / riskNotes / permit
// 的线路,给人工按社区共识补标用(这些字段需要查证,不做自动猜测)。
// 用法:node scripts/label-backlog.mjs [字段名…]  缺省查全部字段
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);

const trails = JSON.parse(fs.readFileSync(new URL('../data/trails.json', import.meta.url), 'utf8'));
const FIELDS = ['tickets', 'risks', 'supplies', 'bestMonths', 'regionId', 'riskNotes', 'permit'];
// permit 只对受限线路有意义:150 条「开放」线路全列进欠账清单只会淹掉真正要查的 41 条
const RESTRICTED = require('../lib/permit.js').RESTRICTED;
const wanted = process.argv.slice(2).length ? process.argv.slice(2) : FIELDS;

for (const field of wanted) {
  if (!FIELDS.includes(field)) { console.log(`未知字段: ${field}(可选:${FIELDS.join(' / ')})`); continue; }
  const scope = field === 'permit'
    ? Object.entries(trails).filter(([, t]) => RESTRICTED.includes(t.status))
    : Object.entries(trails);
  // bestSeason 写「全年/四季」的线路本来就没有错季概念(如香八拉、莫干山),
  // 不标 bestMonths 是设计结果,不是欠账;否则这 14 条会永久占着欠账清单。
  const allYear = (t) => /全年|四季/.test(String(t.bestSeason || ''));
  const skippedAllYear = field === 'bestMonths' ? scope.filter(([, t]) => allYear(t)) : [];
  const missing = scope
    .filter(([, t]) => !(field === 'bestMonths' && allYear(t)))
    .filter(([, t]) => t[field] == null
      || (Array.isArray(t[field]) && !t[field].length))
    .map(([id, t]) => `${t.province}|${t.name}(${id})`);
  const scopeNote = field === 'permit' ? `(只看 ${scope.length} 条受限线路,开放线路不计)` : '';
  console.log(`\n== 缺 ${field}: ${missing.length}/${scope.length - skippedAllYear.length} ${scopeNote}==`);
  if (skippedAllYear.length) {
    console.log(`(另有 ${skippedAllYear.length} 条 bestSeason 为全年/四季,按设计不标 bestMonths)`);
  }
  console.log(missing.join('\n') || '(无欠账)');
}

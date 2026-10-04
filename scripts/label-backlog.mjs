// 数据标注欠账清单:列出缺 tickets / risks / supplies / bestMonths / regionId 的线路,
// 给人工按社区共识补标用(这些字段需要查证,不做自动猜测)。
// 用法:node scripts/label-backlog.mjs [字段名…]  缺省查全部五个字段
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);

const trails = JSON.parse(fs.readFileSync(new URL('../data/trails.json', import.meta.url), 'utf8'));
const FIELDS = ['tickets', 'risks', 'supplies', 'bestMonths', 'regionId'];
const wanted = process.argv.slice(2).length ? process.argv.slice(2) : FIELDS;

for (const field of wanted) {
  if (!FIELDS.includes(field)) { console.log(`未知字段: ${field}(可选:${FIELDS.join(' / ')})`); continue; }
  const missing = Object.entries(trails)
    .filter(([, t]) => t[field] == null
      || (Array.isArray(t[field]) && !t[field].length))
    .map(([id, t]) => `${t.province}|${t.name}(${id})`);
  console.log(`\n== 缺 ${field}: ${missing.length}/${Object.keys(trails).length} ==`);
  console.log(missing.join('\n') || '(无欠账)');
}

// 一次性回填:把 bestSeason 文本里机械可解析的月份写进 bestMonths。
// 已有手标 bestMonths 的条目不动(人工为准),只比对并报告分歧;
// 解析不了的保持无标注——宁缺毋编,剩下的留给人工。
// 用法:node scripts/enrich-best-months.mjs(幂等,可重复跑,已回填的不会再动)
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const { parseBestSeason } = require('../lib/bestmonths.js');

const TRAILS_FILE = new URL('../data/trails.json', import.meta.url); // 锚定仓库位置,不依赖 CWD
const trails = JSON.parse(fs.readFileSync(TRAILS_FILE, 'utf8'));
let added = 0, kept = 0, mismatch = 0, unparseable = 0;
const mismatches = [];

for (const [id, t] of Object.entries(trails)) {
  const parsed = parseBestSeason(t.bestSeason);
  if (Array.isArray(t.bestMonths) && t.bestMonths.length) {
    kept++;
    const same = parsed
      && parsed.length === t.bestMonths.length
      && parsed.every((m, i) => m === t.bestMonths[i]);
    if (!same) {
      mismatch++;
      mismatches.push(`  ${id}: 手标 [${t.bestMonths}] vs 解析 [${parsed || 'null'}] 原文「${t.bestSeason}」`);
    }
    continue;
  }
  if (parsed) { t.bestMonths = parsed; added++; } else unparseable++;
}

// 幂等:零回填不重写文件
if (added > 0) {
  fs.writeFileSync(TRAILS_FILE, JSON.stringify(trails, null, 2) + '\n', 'utf8');
}
console.log(`已有手标(未动): ${kept},其中与解析分歧: ${mismatch}`);
if (mismatches.length) console.log(mismatches.join('\n'));
console.log(`本次回填: ${added},原文无法解析(留给人工): ${unparseable}`);

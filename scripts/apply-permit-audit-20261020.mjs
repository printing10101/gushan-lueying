#!/usr/bin/env node
// 2026-10-20 permit 审计：只写有官方通告的禁止/关闭状态。
// 用法：node scripts/apply-permit-audit-20261020.mjs          试运行
//      node scripts/apply-permit-audit-20261020.mjs --apply  写回 data/trails.json
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'data', 'trails.json');
const APPLY = process.argv.includes('--apply');
const CHECKED_AT = '2026-10-20';
const SOURCE = "太白县人民政府/陕西太白山国家级自然保护区管理局《关于禁止“非法穿越秦岭核心保护区和太白山”的通告》(2025-02-11)";
const URL = 'http://www.taibai.gov.cn/col6606/col6614/202502/t20250211_1117862.html';
const HOW = '依据官方通告,禁止非法穿越秦岭核心保护区和太白山';
const WHERE = '太白县人民政府、陕西太白山国家级自然保护区管理局';

const updates = {
  aotai: {
    permit: { prohibited: true, how: HOW, where: WHERE, source: SOURCE, url: URL, checkedAt: CHECKED_AT },
  },
  'taibai-nanbei': {
    status: '禁入',
    statusNote: '2025-02-11 太白县政府/保护区管理局通告:禁止非法穿越秦岭核心保护区和太白山;通行政策以官方最新通告为准',
    permit: { prohibited: true, how: HOW, where: WHERE, source: SOURCE, url: URL, checkedAt: CHECKED_AT },
  },
};

const trails = JSON.parse(fs.readFileSync(FILE, 'utf8'));
let changed = 0;
for (const [id, patch] of Object.entries(updates)) {
  const trail = trails[id];
  if (!trail) throw new Error(`找不到线路 ${id}`);
  const before = JSON.stringify({ status: trail.status, statusNote: trail.statusNote, permit: trail.permit });
  Object.assign(trail, patch);
  const after = JSON.stringify({ status: trail.status, statusNote: trail.statusNote, permit: trail.permit });
  if (before !== after) {
    changed += 1;
    console.log(`${id}: ${before} -> ${after}`);
  }
}
console.log(`\n共 ${changed} 条变更${APPLY ? ',写回' : '(试运行,未写文件;加 --apply 写回)'}`);
if (APPLY) fs.writeFileSync(FILE, `${JSON.stringify(trails, null, 2)}\n`, 'utf8');

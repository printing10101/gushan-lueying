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
  xiate: {
    status: '禁入',
    statusNote: '2026-04-08 昭苏县文旅局公告:2026 年昭苏县辖区内所有山区禁止徒步及户外露营,含夏特古道;以官方最新通告为准',
    permit: {
      prohibited: true,
      how: '2026 年昭苏县辖区内所有山区禁止徒步/露营/穿越(含夏特古道)',
      where: '昭苏县文化体育广播电视和旅游局',
      source: '新疆昭苏县文旅局 2026-04-08 公告',
      url: 'https://cbgc.scol.com.cn/news/7477322',
      checkedAt: CHECKED_AT,
    },
  },
  nianbaoyuze: {
    permit: {
      prohibited: true,
      how: '年保玉则景区 2018 年起关闭;2026-10-04 久治县通告严禁擅自进入未开发未开放区域(含年保玉则核心区)',
      where: '久治县人民政府/年保玉则景区管理方',
      source: '新华网:青海久治县关于严禁擅自进入未开发未开放区域探险徒步旅游的通告(2026-10-04)',
      url: 'http://qh.news.cn/20261004/9decf2dc48c54163bf3a252c7a9e02c3/c.html',
      checkedAt: CHECKED_AT,
    },
  },
  wusun: {
    status: '禁入',
    statusNote: '2026-02 特克斯县/拜城县文旅局表示乌孙古道 2026 年暂不开放;2026-04 报道仍为封闭状态,开放时间以官方公告为准',
    permit: {
      prohibited: true,
      how: '乌孙古道 2026 年暂不开放;开放后组织穿越仍需报备审批',
      where: '特克斯县文化体育广播电视和旅游局/拜城县文旅局',
      source: '新浪财经:南天山北线、乌孙古道、珠峰东坡嘎玛沟等徒步管理收紧(2026-04-09)',
      url: 'https://finance.sina.com.cn/wm/2026-04-09/doc-inhtwnwz8892161.shtml',
      checkedAt: CHECKED_AT,
    },
  },
  bogeda: {
    status: '禁入',
    statusNote: '天池博格达峰自然保护区核心区禁止非法穿越;2026-08 有擅入者被行政处罚,通行以保护区审批为准',
    permit: {
      prohibited: true,
      how: '天池博格达峰自然保护区核心区禁止一切非法穿越;2026-08 已有行政处罚案例',
      where: '新疆天池博格达峰自然保护区管理局/阜康市林业和草原局',
      source: '新疆维吾尔自治区政府:关于严禁进入天池博格达峰自然保护区有关区域的通告(2019-06-27)',
      url: 'https://www.xinjiang.gov.cn/xinjiang/hbddc/201906/1309f7d133874b2792c84ef70c483747.shtml',
      checkedAt: CHECKED_AT,
    },
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

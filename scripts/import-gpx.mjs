#!/usr/bin/env node
// 把一条 GPX 轨迹的实测量导进线路库,让 distanceKm/climbM/maxAltM 从「抄来的」变成「量过的」。
//
// 为什么需要:trails.json 这三个字段没有 source 口径,是攻略与文档里的数;
// 而两步路/六只脚/Strava 上大量线路有现成 GPX。lib/gpx.js 已经把解析与判定口径
// 定死(差超过 10% 不覆盖、缺高程不报爬升),这个脚本只是它的落盘入口。
//
// 用法:
//   node scripts/import-gpx.mjs track.gpx --trail wusun                 试运行,只出对比表
//   node scripts/import-gpx.mjs track.gpx --trail wusun --apply         写 data/trails.json
//   node scripts/import-gpx.mjs track.gpx --trail wusun --apply --out /tmp/t.json
//                                                  写到别处(验证写盘路径,不动正本)
//
// ⚠️ --apply 会改 data/trails.json:先跑试运行看对比表,确认无误再写。
//    review 档(差 >10%)永不写盘——那正是要人看一眼的地方,谁覆盖谁不该由脚本决定。

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const TRAILS = path.join(ROOT, 'data', 'trails.json');

const gpx = require('../lib/gpx.js');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : null;
};

const file = argv.find((a) => !a.startsWith('--'));
const trailId = opt('trail');
const APPLY = flag('apply');
const OUT = opt('out') || TRAILS;

const die = (msg) => { console.error(`✗ ${msg}`); process.exit(1); };

if (!file) die('缺 GPX 文件路径。用法:node scripts/import-gpx.mjs track.gpx --trail <线路id>');
if (!trailId) die('缺 --trail <线路 id>。不给线路 id 就不知道要校哪条线。');
if (!fs.existsSync(file)) die(`GPX 文件不存在:${file}`);

const trails = JSON.parse(fs.readFileSync(TRAILS, 'utf8'));
const trail = trails[trailId];
if (!trail) {
  const keys = Object.keys(trails).slice(0, 8).join(', ');
  die(`线路 id 不在库里:${trailId}(库里前几个:${keys} …)`);
}

const parsed = gpx.parseGpx(fs.readFileSync(file, 'utf8'));
if (!parsed.ok) die(`GPX 解析失败:${parsed.error}`);

console.log(`GPX:${path.basename(file)}  有效点 ${parsed.points}`
  + `  缺高程段 ${parsed.eleGaps}${parsed.skipped ? `  丢弃非法点 ${parsed.skipped}` : ''}`);
console.log(`实测:里程 ${parsed.distanceKm ?? '算不出'}km`
  + ` · 爬升 ${parsed.climbM ?? '算不出(逐点高程不齐)'}m`
  + ` · 最高 ${parsed.maxAltM ?? '算不出'}m`);
console.log(`线路「${trail.name}」标称:里程 ${trail.distanceKm ?? '—'}km`
  + ` · 爬升 ${trail.climbM ?? '—'}m · 最高 ${trail.maxAltM ?? '—'}m\n`);

const d = gpx.mergeMeasured(trail, parsed);
for (const [field, v] of Object.entries(d.apply)) {
  console.log(`  可写入  ${field.padEnd(10)} ${trail[field] ?? '—'} → ${v}(${d.appliedReason[field]})`);
}
for (const r of d.review) {
  console.log(`  待复核  ${r.field.padEnd(10)} 标称 ${r.planned} vs 实测 ${r.measured}`
    + `  差 ${r.diffPct > 0 ? '+' : ''}${r.diffPct}% —— 超过 ${gpx.GPX_REVIEW_PCT}%,不写盘`);
}
for (const r of d.rejected) console.log(`  已拒收  ${r.field.padEnd(10)} 实测值非法(${r.reason})`);

if (!Object.keys(d.apply).length) {
  console.log('\n没有任何字段可写入(要么全在待复核档,要么这条 GPX 没测出可用值)。');
  process.exit(0);
}
if (!APPLY) {
  console.log(`\n试运行:未写盘。确认无误后加 --apply(目标 ${path.relative(ROOT, OUT)})。`);
  process.exit(0);
}

trail.distanceKm = d.apply.distanceKm ?? trail.distanceKm;
trail.climbM = d.apply.climbM ?? trail.climbM;
trail.maxAltM = d.apply.maxAltM ?? trail.maxAltM;
trail.metricsSource = 'gpx';
trail.metricsFile = path.basename(file);
trail.metricsAt = new Date().toISOString().slice(0, 10);
trail.metricsPoints = parsed.points;
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(trails, null, 2), 'utf8');
console.log(`\n✓ 已写入 ${path.relative(ROOT, OUT)}:字段 ${Object.keys(d.apply).join(', ')}`
  + ` · 来源 gpx/${path.basename(file)} · ${trail.metricsAt}`);
if (d.review.length) console.log(`  仍有 ${d.review.length} 项待人工复核(未写)`);

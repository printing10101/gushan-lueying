#!/usr/bin/env node
// 回填线路的 regionId(规划器接入用)。
//
// 背景:planner.pickTrail 按 `regionId` 挑线路,而 9 个 region 是**具体自驾环线**
// (节点是成都-映秀-四姑娘山镇-丹巴…这类市镇),不是省份。数据里只有 35 条标了
// regionId,其余 151 条在线路库里显示「未接入行程规划」。
//
// 为什么用地理邻近判定,不用省份:省份是行政概念,区域是环线概念,两者不等价。
// 按省份映射会把贵州的线路塞进「滇西北环线」,生成一条从丽江出发根本到不了的
// 行程——那是造假,比现状更糟。所以判据是「线路起点到某环线节点的实际球面距离」。
//
// 阈值 80km 的来由:80km 是自驾一天舒适半径,环线节点到线路起点在这个距离内,
// 规划器生成的「第 N 天驾车到线起点,再徒步」是成立的。实测:
//   ≤30km 13 条、30-50km 4 条、50-80km 9 条 —— 逐条核对全部地理正确;
//   80-120km 起出现错配(峨眉山后山穿越→泸定 113km、三奥雪山→四姑娘山镇 112km),
//   >120km 完全错(冈仁波齐转山→伊犁昭苏 1352km)。
// 宁可少覆盖 115 条,也不硬凑。宁可显示「未接入」,也不给一条到不了的行程。
//
// 本脚本对已标注的 35 条只做**校验不改写**——实测该方法与人工标注 35/35 完全
// 一致,任何不一致都会在这里报出来,不静默覆盖人工判断。
//
// 用法:node scripts/backfill-region.mjs            只报告,不改文件
//      node scripts/backfill-region.mjs --apply    写回 data/trails.json
//      node scripts/backfill-region.mjs --apply --max-km 120   放宽阈值(需人工复核)

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const TRAILS = path.join(ROOT, 'data', 'trails.json');
const REGIONS = path.join(ROOT, 'data', 'regions.json');

// 判定半径:超出这个距离就不归入任何区域。见文件头「阈值 80km 的来由」。
const DEFAULT_MAX_KM = 80;

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const maxKmArg = argv.indexOf('--max-km');
const MAX_KM = maxKmArg >= 0 ? Number(argv[maxKmArg + 1]) : DEFAULT_MAX_KM;
if (!Number.isFinite(MAX_KM) || MAX_KM <= 0) {
  console.error(`--max-km 需要一个正数,收到: ${argv[maxKmArg + 1]}`);
  process.exit(1);
}

const trails = JSON.parse(fs.readFileSync(TRAILS, 'utf8'));
const regions = JSON.parse(fs.readFileSync(REGIONS, 'utf8'));

// 球面距离(haversine),单位 km。用球面而非直线:川西到滇西北的实际公路里程
// 远超直线距离,直线会低估可达性、把人骗进「看着近其实很远」的误判。
const EARTH_R = 6371;
const rad = (d) => (d * Math.PI) / 180;
function distanceKm(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2
    + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(s)));
}

// 最近的环线节点。返回该节点所属区域与距离——不只给区域,距离要能给人复核。
//
// 两类线路必须在这里就排除,否则会生成「看着合理、根本开不过去」的行程:
//   · 跨境(港澳台):内地车不能自驾跨境进香港/澳门。内地车进港需「粤港跨境私家车
//     常规配额」(抽签,中签率极低);反向的「港车北上」只限持香港居民身份证+回乡证的
//     香港居民,且每人每年在内地累计停留不超180 天。澳门同理需澳车北上/跨境配额。
//     麦理浩径/凤凰径/卫奕信径/港岛径/路环岛地理上贴着深圳(直线仅 30km),
//     haversine 判不出「过不去」,但真实车程要过关+通关,不是 30km。所以按省名硬排除。
//   · 跨省:t.province ≠ region.province 时,即使直线距离近也不收。
//     跨省不是绝对不可能(例如贵州线路可从广西节点进),但那需要人工逐条裁决,
//     不该由脚本自动写进数据。
const CROSS_BORDER = new Set(['香港', '澳门', '台湾']);

function nearestNode(trail) {
  if (!trail.start || !Number.isFinite(trail.start.lng) || !Number.isFinite(trail.start.lat)) {
    return null;
  }
  let best = null;
  for (const [regionId, region] of Object.entries(regions)) {
    for (const node of region.loop || []) {
      const km = distanceKm(trail.start, node);
      if (!best || km < best.km) best = { regionId, km, nodeName: node.name, regionName: region.name };
    }
  }
  return best;
}

// 判定是否可挂到候选区域下:跨境直接不可;跨省需人工裁决。
//
// 选区域的原则就是**就近**,曾试过「同省优先」被两条真实数据否掉:
//   · 浙西三尖距浙江临安 55km、距安徽绩溪 43km;
//   · 清凉峰南山脊(area 写明「杭州·临安—安徽绩溪」,本来就走绩溪一侧山脊)
//     距绩溪 10km、距临安 85km。
// 强制同省会把这两条推去更远的地方,判据反而制造「开过去更远」的行程。
// 环线跨市界、跨省界是合法的(南太行/河南收山西的王莽岭,距该环线 14km)。
// 判据与 test/trails-data.test.mjs 的「起点地理上确实靠近该环线」保持一致。
function assignable(trail, near) {
  if (CROSS_BORDER.has(trail.province)) {
    return { ok: false, reason: '跨境线路,内地车无法自驾往返(需配额或通关)' };
  }
  const region = regions[near.regionId];
  if (region && trail.province !== region.province) {
    return { ok: false, reason: `跨省(${trail.province}→${region.province}),需人工裁决` };
  }
  return { ok: true };
}

// ── 第1 步:校验已有人工标注,不一致就报出来(不改写) ──
const conflicts = [];
for (const trail of Object.values(trails)) {
  if (!trail.regionId) continue;
  const near = nearestNode(trail);
  if (!near) {
    conflicts.push({ name: trail.name, reason: '无 start 坐标,无法校验' });
    continue;
  }
  if (near.regionId !== trail.regionId) {
    conflicts.push({
      name: trail.name, reason: `人工标注 ${trail.regionId} ≠ 最近节点所属 ${near.regionId}`,
      km: Math.round(near.km),
    });
  }
}

// ── 第 2 步:算出可回填项 ──
// 两种情况都要处理:①没标 regionId 但够近的,补 regionId;②标了 regionId 却没 node 的,
// 补 node。②必须单独走一遍——若只按「没 regionId」筛选,补完 regionId 的下一次运行
// 就再也进不来,这些线路的 node 会永远空着,planner 退化成 loop[1] 兜底、行程顺序出错。
const pending = [];
const nodePending = [];
const rejected = [];
for (const [id, trail] of Object.entries(trails)) {
  const near = nearestNode(trail);
  if (!near) continue;
  const pick = near;
  const ok = assignable(trail, pick);
  if (!trail.regionId) {
    if (!ok.ok) {
      // 距离够近但不可挂的,单独列出来——这些线路在 UI 上显示「未接入」,
      // 用户会想知道为什么,清单比一句「未接入」有用。
      if (pick.km <= MAX_KM) rejected.push({ id, name: trail.name, province: trail.province, ...pick, reason: ok.reason });
      continue;
    }
    if (pick.km <= MAX_KM) pending.push({ id, name: trail.name, province: trail.province, ...pick });
  } else if (!trail.node) {
    if (!ok.ok) {
      rejected.push({ id, name: trail.name, province: trail.province, ...pick, reason: ok.reason });
      continue;
    }
    nodePending.push({ id, name: trail.name, province: trail.province, ...pick });
  }
}

// ── 报告 ──
const total = Object.keys(trails).length;
const already = Object.values(trails).filter((t) => t.regionId).length;
console.log(`线路总数 ${total} · 已标注 ${already} · 可回填 regionId ${pending.length} · 可补 node ${nodePending.length} · 阈值 ${MAX_KM}km\n`);

if (conflicts.length) {
  console.log(`⚠ 已标注与地理判定冲突 ${conflicts.length} 条(不自动改写,需人工裁决):`);
  for (const c of conflicts) console.log(`   ${c.name} — ${c.reason}${c.km ? ` (${c.km}km)` : ''}`);
  console.log('');
} else {
  console.log('✓ 已标注的线路全部通过地理校验(最近节点所属区域 == regionId)\n');
}

const byRegion = {};
for (const p of pending) byRegion[p.regionId] = (byRegion[p.regionId] || 0) + 1;
console.log('回填后各区域可选线路数:');
for (const rid of Object.keys(regions)) {
  const before = Object.values(trails).filter((t) => t.regionId === rid).length;
  const after = before + (byRegion[rid] || 0);
  console.log(`   ${rid.padEnd(12)} ${String(before).padStart(3)} → ${String(after).padStart(3)}`);
}
console.log('\n待回填 regionId 明细:');
if (!pending.length) console.log('   (无)');
for (const p of pending.sort((a, b) => a.km - b.km)) {
  console.log(`   ${String(Math.round(p.km)).padStart(4)}km  ${p.name.padEnd(20)}${p.province.padEnd(5)}→ ${p.regionId}(${p.nodeName})`);
}

console.log('\n待补 node 明细:');
if (!nodePending.length) console.log('   (无)');
for (const p of nodePending.sort((a, b) => a.km - b.km)) {
  console.log(`   ${String(Math.round(p.km)).padStart(4)}km  ${p.name.padEnd(20)}${p.province.padEnd(5)}→ ${p.regionId}(${p.nodeName})`);
}

if (rejected.length) {
  console.log(`\n⚠ 距离够近但**不可接入** ${rejected.length} 条(保持悬空,不做假行程):`);
  for (const r of rejected.sort((a, b) => a.km - b.km)) {
    console.log(`   ${String(Math.round(r.km)).padStart(4)}km  ${r.name.padEnd(20)}${r.province.padEnd(5)}→ 最近节点 ${r.nodeName} — ${r.reason}`);
  }
}

// ── 写回 ──
if (!APPLY) {
  console.log(`\n(试运行,未改文件。加 --apply 写回)`);
  process.exit(0);
}
if (conflicts.length) {
  console.error('\n✗ 存在人工标注冲突,拒绝写回——先裁决冲突再回填,避免两种错误叠加。');
  process.exit(1);
}
if (!pending.length && !nodePending.length) {
  console.log('\n✓ 无需改动(全部已标注且带 node)');
  process.exit(0);
}
let changed = 0;
for (const p of pending) {
  trails[p.id].regionId = p.regionId;
  trails[p.id].node = p.nodeName; // node 是 planner 拼行程必需项,见 planner.js:279
  changed++;
}
for (const p of nodePending) {
  trails[p.id].node = p.nodeName;
  changed++;
}
fs.writeFileSync(TRAILS, JSON.stringify(trails, null, 2) + '\n', 'utf8');
console.log(`\n✓ 已写回 data/trails.json:${changed} 条补齐(regionId ${pending.length} 条 + node ${nodePending.length} 条)`);
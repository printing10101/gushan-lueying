#!/usr/bin/env node
// 用真实路线服务(高德 / 腾讯)验证全部区域的**真实驾车里程**,并与项目当前的
// 「直线×1.3」估算值逐条对比,输出一张差距表。
//
// 为什么需要这个:`data/config.json` 的 `amapKeyWeb` 为空时,planner 用
// haversine × 1.3 估算环线相邻节点间的距离,那只保证「不低估」。
// 配好 Key 后才能知道 18 个区域的里程到底被低估了多少、有没有哪条 leg
// 被严重高估(=估算在骗人,预算会跟着错)。
//
// 前置:data/config.json 的 amapKeyWeb 填好高德「Web服务」类型的 Key。
// 用法:node scripts/verify-routes.mjs            试运行,不写文件
//      node scripts/verify-routes.mjs --apply    写回 data/regions.json
//      node scripts/verify-routes.mjs --only jingbei2   只查一个区域
//
// ⚠️ 写回是破坏性操作:会把真实里程写进 regions.json 的节点字段。
// 先跑试运行看差距表,确认没问题再加 --apply。

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const REGIONS = path.join(ROOT, 'data', 'regions.json');
const CONFIG = path.join(ROOT, 'data', 'config.json');

// provider 分发与真实路线都走 lib/routing.js,与 planner 用同一条路径
const amap = require('../lib/amap');
const routing = require('../lib/routing');
const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const onlyIdx = argv.indexOf('--only');
const ONLY = onlyIdx >= 0 ? argv[onlyIdx + 1] : null;

const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
const providerArg = argv.includes('--provider') ? argv[argv.indexOf('--provider') + 1] : '';
if (providerArg) cfg.routeProvider = providerArg;
let provider = '';
try {
  provider = routing.activeProvider(cfg);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
if (provider === 'estimate') {
  console.error('routeProvider 解析成 estimate:config 里 amapKeyWeb / tencentKeyWeb 都为空,'
    + '没有真实里程可比——先申请一个 Key 再用这个脚本。');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 估算口径单一来源:lib/amap.js。这里以前手抄了一份 haversine×1.3,
// 抄本一旦和 planner 实际用的系数漂移,「估算 vs 真实」差距表就在骗人。
const estimateKm = (a, b) => amap.haversineKm(a, b) * amap.LOOP_FACTOR;

const regions = JSON.parse(fs.readFileSync(REGIONS, 'utf8'));
const targets = ONLY ? { [ONLY]: regions[ONLY] } : regions;
if (!Object.values(targets).every(Boolean)) {
  console.error(`区域 ${ONLY} 不存在`);
  process.exit(1);
}

console.log(`== 路线来源: ${routing.labelOf(provider)} ==`);
console.log(`待验证区域 ${Object.keys(targets).length} 个\n`);

const report = [];
let failures = 0;

for (const [rid, region] of Object.entries(targets)) {
  const loop = region.loop;
  const legs = [];
  for (let i = 0; i < loop.length - 1; i++) {
    const from = loop[i];
    const to = loop[i + 1];
    const est = Math.round(estimateKm(from, to));
    let real = null;
    let err = null;
    try {
      const route = await routing.drivingRoute(from, to, provider);
      real = Math.round(route.distanceKm);
    } catch (e) {
      err = e.message;
      failures += 1;
    }
    if (real !== null) {
      const diff = real - est;
      const pct = est > 0 ? (diff / est) * 100 : 0;
      legs.push({ from: from.name, to: to.name, est, real, diff, pct, ok: true });
    } else {
      legs.push({ from: from.name, to: to.name, est, real: null, err, ok: false });
    }
    // 尊重 QPS 限制
    await sleep(400);
  }

  const estTotal = legs.reduce((s, l) => s + l.est, 0);
  const realTotal = legs.filter((l) => l.ok).reduce((s, l) => s + l.real, 0);
  const allOk = legs.every((l) => l.ok);
  report.push({ rid, name: region.name, legs, estTotal, realTotal, allOk });

  console.log(`── ${rid}  ${region.name}`);
  for (const l of legs) {
    if (!l.ok) {
      console.log(`   ✗ ${l.from}→${l.to}  估算 ${l.est}km  真实查询失败: ${l.err}`);
      continue;
    }
    // 标出两个方向的异常:严重低估(<10%)会让预算失真;严重高估(>60%)说明
    // 直线×1.3 在这段明显失准,估算里程比真实值多出近一倍。
    const flag = l.pct < -10 ? ' ⚠低估' : l.pct > 60 ? ' ⚠高估' : '';
    console.log(`   ${String(l.est).padStart(5)}km → ${String(l.real).padStart(5)}km  `
      + `${l.pct >= 0 ? '+' : ''}${l.pct.toFixed(0)}%${flag}`);
  }
  if (allOk) {
    const diffPct = ((realTotal - estTotal) / estTotal) * 100;
    console.log(`   合计 ${estTotal}km → ${realTotal}km (${diffPct >= 0 ? '+' : ''}${diffPct.toFixed(0)}%)\n`);
  } else {
    console.log('');
  }
}

const ok = report.filter((r) => r.allOk);
const estSum = ok.reduce((s, r) => s + r.estTotal, 0);
const realSum = ok.reduce((s, r) => s + r.realTotal, 0);
console.log('='.repeat(60));
console.log(`验证完成:${ok.length}/${report.length} 个区域全部 leg 查询成功${failures ? `,${failures} 条失败` : ''}`);
if (estSum > 0) {
  console.log(`全库环线里程:估算 ${estSum}km → 真实 ${realSum}km `
    + `(${((realSum - estSum) / estSum * 100).toFixed(1)}%)`);
}
const under = report.flatMap((r) => r.legs).filter((l) => l.ok && l.pct < -10);
const over = report.flatMap((r) => r.legs).filter((l) => l.ok && l.pct > 60);
if (under.length) {
  console.log(`\n⚠ 严重低估(真实比估算少 10% 以上,预算会偏高) ${under.length} 条:`);
  for (const l of under) console.log(`   ${l.from}→${l.to} 估算 ${l.est}km 真实 ${l.real}km (${l.pct.toFixed(0)}%)`);
}
if (over.length) {
  console.log(`\n⚠ 严重高估(真实比估算少 60% 以上,估算明显失准) ${over.length} 条:`);
  for (const l of over) console.log(`   ${l.from}→${l.to} 估算 ${l.est}km 真实 ${l.real}km (+${l.pct.toFixed(0)}%)`);
}

if (!APPLY) {
  console.log('\n(试运行,未改文件。确认差距合理后加 --apply 把真实里程写回 regions.json)');
  process.exit(failures ? 1 : 0);
}
console.log('\n注意:regions.json 目前没有「真实里程」字段,写回需要先给节点加 km 字段——'
  + '\n这一步留给实现时决定,现在只输出对比表。');

// 逐区域量化「单日驾车上限」的实际效果:同一个环线的相邻节点里程,分别用
// 当前打包策略(planDays)跑一遍,输出最差单日、最长单条 leg、是否仍超限。
//
// 为什么需要它:`maxDriveKmPerDay` 的切分策略是共享算法,改一次会影响 18 个区域的
// 行程形状。INSTINCTS 的规矩是"动手前先量化影响面"——这张表就是影响面本身,
// 也是 README 里那些"最差单日 XXXkm"数字的唯一来源(数字必须能一条命令复现)。
//
// 用法:node scripts/measure-drive-packing.mjs            全部区域,默认上限 400km
//      node scripts/measure-drive-packing.mjs --max 350   换个上限重算
//      node scripts/measure-drive-packing.mjs --only jingxi
//
// 里程来源固定为 lib/amap.estimatedRoute(直线×1.3),与 planner 未配 Key 时同一条路径;
// 本脚本只测打包策略,真实里程请用 scripts/verify-amap-routes.mjs。
import { createRequire } from 'node:module';
import process from 'node:process';

const require = createRequire(import.meta.url);
const planner = require('../lib/planner');
const amap = require('../lib/amap');
const regions = require('../data/regions.json');

const argv = process.argv.slice(2);
const maxIdx = argv.indexOf('--max');
const MAX_KM = maxIdx >= 0 ? Number(argv[maxIdx + 1]) : 400;
const onlyIdx = argv.indexOf('--only');
const ONLY = onlyIdx >= 0 ? argv[onlyIdx + 1] : null;

if (!Number.isFinite(MAX_KM) || MAX_KM <= 0) {
  console.error(`--max 需要正数,收到: ${argv[maxIdx + 1]}`);
  process.exit(1);
}

// 里程一律走 lib 的估算口径,保证 18 个区域的对比是同一把尺子
function legsOf(loop) {
  return loop.slice(1).map((n, i) => {
    const r = amap.estimatedRoute(loop[i], n);
    return { from: loop[i].name, to: n.name, km: Math.round(r.distanceKm) };
  });
}

const targets = ONLY ? { [ONLY]: regions[ONLY] } : regions;
if (!Object.values(targets).every(Boolean)) {
  console.error(`区域 ${ONLY} 不存在`);
  process.exit(1);
}

const rows = [];
for (const [rid, region] of Object.entries(targets)) {
  const loop = region.loop;
  const legs = legsOf(loop);
  // trail=null 的整环打包:只看切分策略本身的上限表现
  const plan = planner.planDays(loop, legs, null, 99, MAX_KM);
  const drive = plan.filter((d) => d.type === 'drive');
  const worst = drive.reduce((m, d) => Math.max(m, d.km), 0);
  const longestLeg = legs.reduce((m, l) => Math.max(m, l.km), 0);
  rows.push({
    区域: rid,
    环线: `${legs.reduce((s, l) => s + l.km, 0)}km/${legs.length} 段`,
    驾车日: drive.length,
    最差单日: worst,
    最长单条: longestLeg,
    超限日: drive.filter((d) => d.overKm).length,
    判定: worst > MAX_KM
      ? `仍超(有一条 ${longestLeg}km 的路拆不成两天)`
      : '达标',
  });
}
console.table(rows);

const still = rows.filter((r) => r.最差单日 > MAX_KM);
console.log(`\n上限 ${MAX_KM}km:最差单日仍超上限的区域 ${still.length}/${rows.length}`
  + (still.length ? ` —— ${still.map((r) => `${r.区域}(${r.最差单日}km)`).join(' ')}` : ''));
console.log('说明:超限只可能来自"单条路段自身就超上限"(算法拆不动),能靠切分避免的都已切开。');

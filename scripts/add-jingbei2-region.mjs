#!/usr/bin/env node
// 新增「京北·密云长城环线」(jingbei2) 区域,接入京东三条入门级长城。
//
// 用法:node scripts/add-jingbei2-region.mjs          只报告,不改文件
//      node scripts/add-jingbei2-region.mjs --apply  写回 data/regions.json
//
// ── 为什么环线起点是「密云」而不是「北京」 ──
//
// 最初的方案是「北京→鹿皮关→金山岭→黄崖关→北京」(343km)。实测推翻了它:
// 判据「已标注线路的最近环线节点必须属于所挂区域」全面告红,因为 16 条已接入
// jingxi 的北京西郊线路(香八拉 21km、鹫峰环线 31km、云蒙山 72-77km……)起点
// 都在「北京」节点 80km 内。新区域只要带一个北京市区节点,就和 jingxi 抢归属。
//
// 换枢纽(北京西站/清河/通州/顺义/承德/蓟州/兴隆/怀柔)全部试过,结论一致:
// **抢走线路的数量由「三条长城节点」决定,和第 0 节点选谁无关。** 换成清河甚至
// 更糟(抢 6 条)。所以「换枢纽」这条思路本身是错的,不能再往下试。
//
// 真正的解法是**放弃「第 0 节点=大城市」这个约束**,把起点放到京东本地县城「密云」:
//   · 环线 208km(比北京起点少 135km,-39%),1 个驾车日,不需要 2 天车程
//   · 密云距三条长城 19/46/55km,全在「当天往返舒适半径」内
//   · loop[0] 语义是「环线第一站」不是「城市中心」,planner 只用它算 leg 与
//     天气锚点;现有 17 个区域的 loop[0] 已经是成都/映秀/四姑娘山镇这类市镇
//   · ⚠️ 但 loop[0]=密云 不等于可以从密云坐高铁来。hub.railStation 仍必须是
//     12306 站表里真实存在的站名,密云站在表里但**只办普速**,不能当高铁枢纽。
//     所以 hub.railStation 保持「北京西」,与 jingxi 一致;代价是玩家要自己
//     从北京西站再开 90km 到密云——这段没有写进环线里程,必须在 notes 里说清。
//
// ── 3 条会被「抢」的线路:本脚本**刻意不动它们** ──
//
//   线路                     原标注        距新区域节点
//   箭扣长城(西栅子—慕田峪)  jingxi/北京 73km   鹿皮关 25km
//   云蒙山—天仙瀑            jingxi/北京 72km   鹿皮关 10km
//   云蒙山青空岭环线         jingxi/北京 77km   鹿皮关  4km
//
// 三条都是 jingxi 已有人工标注,且云蒙山两条的最近节点是「北京」(72-77km)。
// 改它们会让 jingxi 平白少 3 条可选线路(16→13),而它们挂 jingxi/北京 本身
// 成立(北京 72-77km 仍在 80km 阈值内,不是错配)。「地理上更近」不等于
// 「产品上该换区」——三条都是怀柔/密云的山地纵走,与本区域三条长城不是一类。
// 因此它们维持原标注,地理校验的例外登记在 test/trails-data.test.mjs 的
// KEEP_MANUAL,与 backfill-region.mjs 的 MANUAL_EXCLUDE 同源,两处必须同步改。
//
// ── 为什么不接雾灵山 ──
//
// 雾灵山距金山岭仅 27km,地理上能接,但:★3 / 2118m / status=管控 /
// bestMonths 只有 5-9 月。它是一条独立山体(京东第一峰)不是长城体系,
// 接进长城环线会让区域定位变脏,且 10-12 月来这里无路可走——而这正是
// 本轮补冬季覆盖的目的。登记在 MANUAL_EXCLUDE,带完整理由。

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const REGIONS = path.join(ROOT, 'data', 'regions.json');

const APPLY = process.argv.includes('--apply');

const REGION = {
  name: '京北·密云长城环线',
  province: '北京',
  hub: {
    city: '北京',
    // ⚠️ 必须是 12306 站表里真实存在的单一站名。密云站虽在表里(共 3404 站,
    // 「密云」「密云北」都有),但只办普速,当不了高铁枢纽,所以这里仍填北京西。
    // 代价:玩家从北京西站落地后还要自己开 90km 到密云,这段不计入环线里程。
    railStation: '北京西',
    airport: '首都/大兴',
    flightCity: 'beijing',
  },
  loop: [
    { name: '密云', lng: 116.843, lat: 40.376 },
    { name: '鹿皮关', lng: 116.85, lat: 40.55 },
    { name: '金山岭', lng: 117.25, lat: 40.65 },
    { name: '黄崖关', lng: 117.46, lat: 40.23 },
    { name: '密云', lng: 116.843, lat: 40.376 },
  ],
  stay: {
    perRoomPerNight: 260,
    perPersonPerDay: 120,
  },
  notes: [
    '接入:鹿皮关长城环线(挂鹿皮关 0km)、金山岭—司马台长城(挂金山岭 0km)、'
      + '黄崖关长城穿越(挂黄崖关 0km)。三条都是 1 天单日线,是长城里门槛最低的一档',
    '环线 208km / 1 个驾车日(密云→鹿皮关 25km→金山岭 46km→黄崖关 65km→密云 71km)。'
      + '里程为直线×1.3 估算,与项目其余区域同口径,未接高德 Key',
    '⚠️ hub.railStation 是「北京西」不是「密云」:密云站虽在 12306 站表里但只办普速,'
      + '当不了高铁枢纽。玩家从北京西站落地后需自己再开约 90km 到密云,这段不计入环线里程',
    '⚠️ 环线起点是密云县城而非北京市中心,与其他区域「loop[0]=省会」的惯例不同。'
      + '这是刻意选择:环线往东北走(密云→承德方向),不经过北京市区,'
      + '若把起点设成北京市中心会与 jingxi 抢 16 条北京西郊线路的归属',
    '黄崖关在天津蓟州、金山岭在河北延庆,都跨省。跨省合法(近距跨省是环线常态),'
      + '但三地合在一个环里,车程比纯市内环线长,规划时注意 400km/日上限',
    '箭扣长城(★3/2 天/部分管控)距鹿皮关仅 25km,云蒙山两条(天仙瀑、青空岭)距鹿皮关'
      + '10km 与 4km,地理上更近,但它们维持 jingxi/北京 的原标注——三条是怀柔/密云'
      + '的山地纵走,与本区域三条长城不是一类,不该混在一个环线里',
    '雾灵山(★3/2118m/管控/bestMonths 仅 5-9 月)距金山岭 27km 但刻意不接:'
      + '独立山体非长城体系,接进来区域定位变脏,且 10-12 月无路可走',
  ],
};

const regions = JSON.parse(fs.readFileSync(REGIONS, 'utf8'));

if (regions.jingbei2) {
  console.log('跳过 jingbei2: 已存在,不覆盖');
  process.exit(0);
}

// 幂等前置校验:环线必须是闭合的(末节点 = 首节点),否则 planner 少算一条 leg
const first = REGION.loop[0];
const last = REGION.loop[REGION.loop.length - 1];
if (first.name !== last.name || first.lng !== last.lng || first.lat !== last.lat) {
  console.error('✗ 环线未闭合:末节点必须与首节点同名同坐标');
  process.exit(1);
}

console.log(`区域「${REGION.name}」(${REGION.id || 'jingbei2'}) 定义就绪`);
console.log(`  环线 ${REGION.loop.length} 节点(${REGION.loop.length - 1} 条 leg),闭合 ✓`);
console.log(`  province=${REGION.province}  hub=${REGION.hub.city} / ${REGION.hub.railStation}`);

if (!APPLY) {
  console.log('\n(试运行,未改文件。加 --apply 写回)');
  process.exit(0);
}

regions.jingbei2 = REGION;
fs.writeFileSync(REGIONS, JSON.stringify(regions, null, 2) + '\n', 'utf8');
console.log(`\n✓ 已写回 data/regions.json:新增 jingbei2,区域数 ${Object.keys(regions).length}`);

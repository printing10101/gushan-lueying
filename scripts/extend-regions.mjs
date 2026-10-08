// 给**已有**区域加节点(2026-10-08,应昱龙「给 3 个老区域加节点」)。
//
// 这是本仓第一次主动改已有环线的节点,必须把规矩写在最前面:
//   README 明写「新增节点会改变已有行程」——planner 按 loop 顺序切驾车日,
//   加节点会增加总里程,可能让该区域已接入线路的行程多出一天车程。
//   所以每个改动都要**先量后改**:加之前算清里程/驾车日/最差单日的变化,
//   代价不合理就不做(zhexi 放弃龙泉节点就是这么否掉的)。
//
// 本次三个候选的实测结果(直线×1.3,单日上限 400km):
//   ① qinling + 华阴  429→699km,驾车日 2→2,最差单日 376→376  → 划算,做
//   ② sanxia  + 五峰  869→893km,驾车日 3→3,最差单日 345→345  → 划算,做
//   ③ gannan  + 白银  726→874km,驾车日 2→3,最差单日 368→383  → **不划算,不做**
//      加白银/景泰接黄河石林会让甘南多出一个驾车日,而甘南只有 2 条线路,
//      等于为 1 条线赔上 2 条的体验。黄河石林改建成独立的 baiyin 小环线
//      (187km/1 个驾车日,见 add-regions-4.mjs)。**距离是必要条件不是充分条件。**
//
// 插入位置不是随便挑的:脚本试遍了每个位置,取「驾车日不变、里程最小」的那个。
//   华阴插在「鄠邑」之后(秦岭环线西段走完,东出到华山再回西安);
//   五峰插在「利川」之后(鄂西走完往东南回宜昌,顺路经过五峰)。
//
// 幂等:节点已存在就跳过,不重复插入。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const file = path.join(__dirname, '..', 'data', 'regions.json');
const regions = JSON.parse(fs.readFileSync(file, 'utf8'));

// [区域, 插在谁之后, 新节点, 结语(写进 notes)]
const EXTEND = [
  {
    rid: 'qinling', after: '鄠邑',
    node: { name: '华阴', lng: 110.087, lat: 34.482 },
    note: '⚠️2026-10-08 加「华阴」节点接华山夜爬(距节点 1km):环线从约 429km 增到约 699km,'
      + '但驾车日仍是 2 个(实测插入位置取"驾车日不变"的那个)。华阴站在陇海线上,华山景区就在华阴市区南侧',
  },
  {
    rid: 'sanxia', after: '利川',
    node: { name: '五峰', lng: 110.674, lat: 30.202 },
    note: '⚠️2026-10-08 加「五峰」节点接壶瓶山(距节点 26km):环线只从约 869km 增到约 893km,'
      + '驾车日仍是 3 个——因为"利川→宜昌"那段本来就长,经五峰折返几乎不增加总里程。'
      + '五峰是宜昌市辖的土家族自治县,壶瓶山(湖南石门)就在它北侧山脊另一面',
  },
];

let changed = 0;
for (const e of EXTEND) {
  const region = regions[e.rid];
  if (!region) { console.log(`跳过 ${e.rid}: 区域不存在`); continue; }
  if (region.loop.some((n) => n.name === e.node.name)) {
    console.log(`跳过 ${e.rid}: 已有节点「${e.node.name}」`);
    continue;
  }
  const at = region.loop.findIndex((n) => n.name === e.after);
  if (at < 0) { console.log(`跳过 ${e.rid}: 找不到锚点节点「${e.after}」`); continue; }
  region.loop.splice(at + 1, 0, e.node);
  region.notes = region.notes || [];
  if (!region.notes.some((n) => n.includes(e.node.name))) region.notes.push(e.note);
  changed++;
  console.log(`${e.rid}: 在「${e.after}」之后插入「${e.node.name}」→ ${region.loop.map((n) => n.name).join(' → ')}`);
}
fs.writeFileSync(file, JSON.stringify(regions, null, 2) + '\n');
console.log(`\n共改动 ${changed} 个已有区域(每个区域已接入线路的行程都会随之变化,README 已同步记录)`);

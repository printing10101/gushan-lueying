// 冬季区域维护脚本:为长三角·太湖、滇中·禄劝东川各建一组环线区域。
// 幂等:已存在的 id 不覆盖,只补新的。
//
// 为什么建这两个(数据依据,不是"感觉该有"):
// - 长三角:佘山九峰(★1)与军嶂古道(★2)都是库内明确标注 10-12 月的冬季线路,
//   但距最近的 zhexi/德清 分别 133km / 110km,超 80km 回填阈值,长期悬空。
//   佘山距松江 0km、军嶂山距无锡 9km —— 环线应该这么设,而不是硬塞进浙西。
// - 滇中:轿子雪山(★2,4223m)与雪岭火峰(★3,4344m)互相只隔 16km,
//   但距 dianxibei/丽江 有 119km / 105km,同样超阈值。这两条是冬季登顶线
//   ("冬看雪"是轿子山官方宣传语,雪岭火峰因冬季山顶积雪得名),
//   属真正的高海拔冬季价值,不该继续悬空。
//
// 刻意不建的两个:
// - 东北(黑龙江雪乡、吉林老里克湖):距最近环线节点(北京)1070km+,
//   靠加节点救不了,库里冬季线路只有 2 条,不成簇。
// - 新疆:全库 0 条冬季线路。没有线路数据,建区域等于建空壳。
// - 华南三条(船底顶/丹霞山巴寨/天露山):距 huanan 节点 103-156km,
//   扩 huanan 环线会把它从 661km 撑到 900km+,影响已接入的 7 条线路;
//   为 3 条线另建区域又不划算。待评估,本轮不动。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const file = path.join(__dirname, '..', 'data', 'regions.json');
const regions = JSON.parse(fs.readFileSync(file, 'utf8'));

const defs = {
  // 长三角·太湖:上海—苏州—无锡。315km 单日环线(直线×1.3 估算),
  // 1 驾车日搞定,适合城里人周末出发。
  // 枢纽取「上海」站:市中心站,不像上海虹桥那样只停高铁。
  // 注意佘山最近的铁路站是「上海松江」不是「松江」——12306 站表里没有后者。
  'yangtzedelta': {
    name: '长三角·太湖环线',
    province: '江苏',
    hub: { city: '上海', railStation: '上海', airport: '虹桥', flightCity: 'shanghai' },
    loop: [
      { name: '上海', lng: 121.473, lat: 31.23 },
      { name: '松江', lng: 121.227, lat: 31.032 },
      { name: '苏州', lng: 120.585, lat: 31.299 },
      { name: '无锡', lng: 120.302, lat: 31.574 },
      { name: '上海', lng: 121.473, lat: 31.23 },
    ],
    stay: { perRoomPerNight: 300, perPersonPerDay: 130 },
    notes: [
      '接入:佘山九峰连穿挂松江(0km)、军嶂古道挂无锡(9km)。两条都是 10-12 月冬季线路',
      '佘山是「沪上陆地第一高峰」仅 97.2m、爬升不足百米,石板路,是入门线不是登山线',
      '军嶂古道全程分六段,可只走 2-3 段(第一段宝界山→大山头 3.07km 约 3 小时)',
      '⚠️ hub.railStation 是「上海」不是「上海虹桥」:虹桥只停高铁,市中心站覆盖更全',
      '⚠️ 佘山地区高铁站实名是「上海松江」,12306 站表里没有「松江」这一站',
    ],
  },

  // 滇中·禄劝东川:昆明东部高山环线。轿子雪山在禄劝转龙镇(昆明北 150km),
  // 雪岭火峰在东川新炭房(昆明 213km),两地相距约 16km。
  // 这是真高山线——轿子山 4223m、雪岭火 4344m,冬季是雪季,不是普通徒步。
  'dianzhong': {
    name: '滇中·禄劝东川环线',
    province: '云南',
    hub: { city: '昆明', railStation: '昆明', airport: '长水', flightCity: 'kunming' },
    loop: [
      { name: '昆明', lng: 102.833, lat: 24.88 },
      { name: '倘甸', lng: 102.95, lat: 25.6 },
      { name: '转龙镇', lng: 102.72, lat: 26.05 },
      { name: '东川红土地', lng: 102.98, lat: 26.14 },
      { name: '昆明', lng: 102.833, lat: 24.88 },
    ],
    stay: { perRoomPerNight: 220, perPersonPerDay: 90 },
    notes: [
      '接入:轿子雪山(4223m,★2)与雪岭火峰(4344m,★3)都挂转龙镇,两地相距仅 16km',
      '这两条是本库少数「高海拔 + 冬季」兼具的线:轿子山官方说法是"冬看雪,春观冰"',
      '雪岭火峰是拱王山主峰、滇中最高峰,官方强度更高:大本营 3800m 冲顶需 14 小时',
      '⚠️ 两条线海拔都超 4200m,高反风险真实存在;入门者请先评估,别当普通公园山走',
      '⚠️ 本区域只覆盖昆明东部。滇西北的 dianxibei 已有自己的环线,别把两者混着排',
    ],
  },
};

let added = 0;
for (const [id, v] of Object.entries(defs)) {
  if (regions[id]) { console.log(`跳过 ${id}: 已存在,不覆盖`); continue; }
  regions[id] = v;
  added++;
  console.log(`新增区域 ${id} (${v.name}) — loop ${v.loop.length} 节点`);
}
fs.writeFileSync(file, JSON.stringify(regions, null, 2) + '\n', 'utf8');
console.log(`\n共新增 ${added} 个区域,现共 ${Object.keys(regions).length} 个`);

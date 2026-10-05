// 追加「淡季/冬季入门线路」。定位:用户是入门级徒步者,而现有 186 条里冬季线路虽有 33 条,
// 但大多悬空或难度偏高。本批挑的是「开箱能带家人走、当季不挤、离城近」的。
//
// 硬约束(不是偏好,是数据/测试逼出来的):
//   1. 起点必须落在已接入区域的 80km 内,否则生成了也规划不了(见 backfill-region.mjs)。
//   2. type 必须在 lib/recommend.js 的 TYPES 词表内,scenery 必须在 SCENERY 词表内,
//      否则线路库/推荐页的筛选下拉会漏出未知值(test/trails-data.test.mjs 会红)。
//   3. 人工 grade 与 computeBreakdown 的建议相差不得超过 1 级(同一条测试校验),
//      所以下面每条都按真实里程/爬升反推过量级,不随手拍 grade。
//   4. 里程不得超 60km/天(同一条测试校验)。
//
// 里程/爬升/门票/海拔的来源写在各自的 sourceNote 里,方便后人复核或纠错——
// 这些数字来自公开攻略,不是精确测量,若与实地不符请以 sourceNote 为线索重新核实。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TRAILS = path.join(__dirname, '..', 'data', 'trails.json');
const trails = JSON.parse(fs.readFileSync(TRAILS, 'utf8'));

const NEW = {
  jiufeng: {
    name: '鹫峰环线',
    province: '北京',
    area: '北京·海淀苏家坨镇',
    type: '景区步道',
    scenery: ['森林', '古道人文'],
    days: 1,
    distanceKm: 8.5,
    climbM: 500,
    maxAltM: 465,
    techLevel: 0,
    grade: 1,
    bestSeason: '全年(冬春雪后另有一番景象)',
    status: '开放',
    start: { lng: 116.13, lat: 40.08 },
    summary: '京郊最稳的入门环线之一,千年古道穿林,8.5km 走 4-5 小时,老少皆宜',
    risks: ['冬季台阶结冰', '山区信号弱'],
    supplies: '山下有便利店,建议自带水;景区门票旺季 15 元、淡季 10 元',
    bestMonths: [1, 2, 3, 4, 5, 6, 9, 10, 11, 12],
    tickets: 15,
    sourceNote: '里程/爬升/耗时/主峰海拔/票价来自公开攻略(常规环线约 8.5km、累计爬升约 500m、4-5 小时、主峰及望京塔海拔 465m、门票旺季 15 元淡季 10 元)。坐标取海淀苏家坨镇秀峰寺路一带。'
  },

  lupiguan: {
    name: '鹿皮关长城环线',
    province: '北京',
    area: '北京·密云龙池/石城镇',
    type: '长城',
    scenery: ['古道人文', '峡谷'],
    days: 1,
    distanceKm: 6.5,
    climbM: 480,
    maxAltM: 620,
    techLevel: 1,
    grade: 2,
    bestSeason: '4-11月;冬季雪后别有一景,但需手套与防滑鞋',
    status: '开放',
    start: { lng: 116.85, lat: 40.55 },
    summary: '行走古长城俯瞰密云水库与白河峡谷,6.5km 环线,公认适合冬天走的京郊短线',
    risks: ['碎石与土路,雨雪后湿滑', '部分陡坡建议结伴'],
    supplies: '农家院可补给;务必带手套(攻略明确提示),穿冲锋衣',
    bestMonths: [1, 2, 3, 4, 5, 6, 10, 11],
    sourceNote: '里程/爬升/耗时来自公开攻略(全程 6-7km 环线、爬升 450-500m、约 4.5 小时,途经两处敌楼,沿途俯瞰密云水库与白河峡谷)。海拔按攻略描述的降蓬山一带估算。'
  },

  'yunmengshan-qingkong': {
    name: '云蒙山青空岭环线',
    province: '北京',
    area: '北京·密云石城镇北石城村',
    type: '山地纵走',
    scenery: ['森林', '云海', '峰林田园'],
    days: 1,
    distanceKm: 7,
    climbM: 600,
    maxAltM: 1414,
    techLevel: 1,
    grade: 2,
    bestSeason: '4-10月;冬季雪后可上到凌云观景台,人少景净',
    status: '开放',
    start: { lng: 116.82, lat: 40.52 },
    summary: '「北京小黄山」,山脊看云海与密云水库,主峰 1414m,单日往返即可',
    risks: ['高海拔风大', '雨后石阶湿滑'],
    supplies: '门票约 78 元(门票+摆渡车套票);摆渡车单程约 20 元,可省体力',
    bestMonths: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    tickets: 78,
    sourceNote: '主峰海拔 1414m、门票 78 元、摆渡车约 20 元来自公开攻略。步道长度按「缆车站—凌云观景台—逍遥谷—1314 平台」段约 4.2km 加上山脊往返估算为单日 7km,属近似值。'
  },

  shenglianshan: {
    name: '圣莲山二十八盘',
    province: '北京',
    area: '北京·房山史家营乡柳林水村',
    type: '古道',
    scenery: ['森林', '古道人文', '峰林田园'],
    days: 1,
    distanceKm: 12,
    climbM: 800,
    maxAltM: 1100,
    techLevel: 1,
    grade: 2,
    bestSeason: '4-11月;冬季雪景好但台阶结冰,谨慎',
    status: '开放',
    start: { lng: 115.94, lat: 39.79 },
    summary: '「京西小五岳」,二十八盘 Z 字古道盘上主峰,京西第一道观所在',
    risks: ['台阶多且陡,膝关节负担大', '冬季青苔与结冰'],
    supplies: '门票 60 元(线上购约 29.9-39.9);大门到登山口 3.5km 上坡路建议坐摆渡车(往返约 20 元)',
    bestMonths: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    tickets: 60,
    sourceNote: '门票 60 元、摆渡车往返 20 元、索道单程约 40 元、景区海拔 600-1100m、二十八盘垂直高度约 300m 来自公开攻略。里程 12km 为「大门—登山口—山顶—逍遥谷下撤」按攻略描述估算。'
  },

  beiding: {
    name: '北台—西台朝圣线',
    province: '山西',
    area: '山西·忻州五台山(北台顶—西台顶)',
    type: '古道',
    scenery: ['草原', '古道人文'],
    days: 1,
    distanceKm: 15,
    climbM: 700,
    maxAltM: 3061,
    techLevel: 1,
    grade: 2,
    bestSeason: '6-9月;冬季极寒不建议,气温可至 -25℃',
    status: '开放',
    start: { lng: 113.2, lat: 39.1 },
    summary: '朝圣者的经典台顶穿越,经北台挂月峰登西台挂心峰,高海拔但台阶成熟',
    risks: ['海拔 3000m 以上,高反风险', '冬季严寒与大风', '山顶风极大'],
    supplies: '各台顶有寺与补给(牛奶、炒面、纸马烧);下山后交通方便',
    bestMonths: [6, 7, 8, 9],
    sourceNote: '北台顶(挂月峰,海拔约 3061m)与西台顶(挂心峰,海拔约 2953m)之间的朝圣古道,里程按公开路线估算为 15km、爬升约 700m。冬季风险提示依据五台山冬季常规气温。'
  }
};

let added = 0;
for (const [id, t] of Object.entries(NEW)) {
  if (trails[id]) { console.log(`跳过 ${id}: 已存在,不覆盖`); continue; }
  trails[id] = t;
  added++;
  console.log(`新增线路 ${id} — ${t.name}(${t.province}) ${t.days}天 ${t.distanceKm}km ★${t.grade}`);
}
fs.writeFileSync(TRAILS, JSON.stringify(trails, null, 2) + '\n');
console.log(`\n共新增 ${added} 条,线路总数 ${Object.keys(trails).length}`);
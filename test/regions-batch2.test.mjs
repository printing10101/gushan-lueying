// 第 2 批环线区域(18 → 23)的决定,固化成断言。
//
// 为什么单独一个文件:这批区域的价值全在「接了哪 18 条线、各自挂哪个节点、
// 为什么允许 3 条跨省」这几件事上。它们散在 191 条线路的 JSON 里,下次有人手改
// trails.json 时看不出这是一次有意的判断——比如「把元宝山退回悬空显得更干净」,
// 一退就少 1 条可规划线路,而其它测试一条都不会红(悬空是合法状态)。
// 同理,「为接入一条线给环线加节点」会让环线从 2 个驾车日涨到 3 个,
// 这个代价在数据里看不出来,所以也要钉住。
//
// 已经由其它文件覆盖、这里不重复的:环线闭合 / 节点不重复 / hub 四字段齐备 /
// railStation 在 12306 站表 / 坐标落在国境范围 / 跨省 ≤80km 的通用判据。
import { createRequire } from 'module';
const require = createRequire(new URL('../package.json', import.meta.url));
const store = require('./lib/store.js');
const { LOOP_FACTOR } = require('./lib/amap.js');
const test = require('node:test');
const assert = require('node:assert');

const trails = store.read('trails');
const regions = store.read('regions');

const BATCH2 = ['guibei', 'qiandongnan', 'ganxi', 'xuexiang', 'changbaidong'];

// 新增区域接入的线路:id → [区域, 节点]。节点名必须与环线节点完全一致
// (planner 用 legs[i].to === trail.node 定位徒步日,差一个字就落到兜底分支)。
const CONNECTED = {
  // 桂北:4 条广西 + 1 条湖南韭菜岭(跨省 69km)
  'longji-titian': ['guibei', '龙胜'],
  'yangdi-xingping': ['guibei', '阳朔'],
  'maoershan': ['guibei', '兴安'],
  'shengtangshan': ['guibei', '金秀'],
  'jiucailing': ['guibei', '兴安'],
  // 黔东南·黔南:4 条贵州 + 1 条广西元宝山(跨省 48km)
  'leigongshan': ['qiandongnan', '雷山'],
  'jiabang-titian': ['qiandongnan', '从江'],
  'maolan': ['qiandongnan', '荔波'],
  'doupengshan': ['qiandongnan', '都匀'],
  'yuanbaoshan': ['qiandongnan', '从江'],
  // 赣西·罗霄:3 条江西 + 1 条湖南八面山(跨省 61km)
  'wugongshan': ['ganxi', '芦溪'],
  'nanfengmian-lingfeng': ['ganxi', '遂川'],
  'qiyunshan-gan': ['ganxi', '崇义'],
  'bamianshan-hunan': ['ganxi', '崇义'],
  // 黑龙江:雪乡(海林)挂亚布力、镜泊湖(宁安)挂宁安——各自属地,不是就近乱挂
  'xuexiang-chuanyue': ['xuexiang', '亚布力'],
  'jingbohu': ['xuexiang', '宁安'],
  // 吉林:老里克湖(和龙)、长白山西坡(松江河)
  'laolikelake': ['changbaidong', '和龙'],
  'changbaishan-xipo': ['changbaidong', '松江河'],
};

const EXPECTED_LOOP = {
  guibei: ['桂林', '龙胜', '兴安', '阳朔', '金秀', '桂林'],
  qiandongnan: ['凯里', '雷山', '从江', '荔波', '都匀', '凯里'],
  ganxi: ['宜春', '芦溪', '遂川', '崇义', '宜春'],
  xuexiang: ['哈尔滨', '亚布力', '宁安', '哈尔滨'],
  changbaidong: ['延吉', '和龙', '松江河', '延吉'],
};

const EARTH_R = 6371;
const rad = (d) => (d * Math.PI) / 180;
function distanceKm(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2
    + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(s)));
}

test('第 2 批 5 个新区域:节点序列与枢纽站未被改动', () => {
  for (const id of BATCH2) {
    assert.ok(regions[id], `区域 ${id} 不存在——第 2 批建的 5 个区域不该被删`);
    assert.deepEqual(regions[id].loop.map((n) => n.name), EXPECTED_LOOP[id],
      `${id} 环线节点序列变了。改节点会改变区域内每条线路的行程长度,`
      + '并可能把隔壁区域的线路抢过来(见 jingbei2 的教训),不是随手能改的数据');
    // 节点名去掉闭环的重复点后必须唯一:planner 按节点名定位徒步日
    const mid = regions[id].loop.slice(1, -1).map((n) => n.name);
    assert.equal(new Set(mid).size, mid.length, `${id} 中间节点重名`);
  }
  // 枢纽必须是该环线的 loop[0],否则 planner 的首日 leg 从别处起算
  for (const id of BATCH2) {
    assert.equal(regions[id].hub.city.length > 0, true);
    assert.equal(regions[id].loop[0].name, EXPECTED_LOOP[id][0], `${id} 的 loop[0] 应等于首站`);
  }
});

test('第 2 批接入的 18 条线:regionId 与 node 精确锁定', () => {
  const wrong = [];
  for (const [tid, [regionId, node]] of Object.entries(CONNECTED)) {
    const t = trails[tid];
    if (!t) { wrong.push(`${tid} 不存在于线路库`); continue; }
    if (t.regionId !== regionId) {
      wrong.push(`${t.name} 的 regionId 是 ${t.regionId || '(悬空)'},应为 ${regionId}`);
    }
    if (t.node !== node) {
      wrong.push(`${t.name} 的 node 是 ${t.node || '(空)'},应为 ${node}`);
    }
  }
  assert.deepEqual(wrong, [], `第 2 批的接入关系被改动了:\n   ${wrong.join('\n   ')}`);
  // 这 18 条必须都有 node——只标 regionId 不标 node 会让 planner 退化成 loop[1] 兜底
  const missingNode = Object.keys(CONNECTED).filter((id) => !trails[id].node);
  assert.deepEqual(missingNode, [], `缺 node:${missingNode.join('、')}`);
});

test('3 条跨省接入必须仍是「近距跨省」(≤80km),否则就该退回悬空', () => {
  // 跨省不是硬排除:环线跨省界是常态(南太行/河南收山西王莽岭 14km、
  // 皖南收浙江清凉峰 10km)。不允许的只有「超距还跨省」。
  // 这三条正是踩在阈值内的判断,一旦有人的坐标改动把它们推出 80km,
  // 行程就会变成「开过去很远」,必须立刻红。
  const CROSS = [['yuanbaoshan', 'qiandongnan', '从江'], ['jiucailing', 'guibei', '兴安'], ['bamianshan-hunan', 'ganxi', '崇义']];
  for (const [tid, regionId, node] of CROSS) {
    const t = trails[tid];
    const n = regions[regionId].loop.find((x) => x.name === node);
    assert.ok(n, `${regionId} 少了节点 ${node}`);
    assert.notEqual(t.province, regions[regionId].province, `${t.name} 现在是同省了,跨省前提变了,请复核这条断言`);
    const km = distanceKm(t.start, n);
    assert.ok(km <= 80, `${t.name}(${t.province}→${regions[regionId].province})距 ${node} ${km.toFixed(1)}km,`
      + '已超 80km 阈值——超距跨省是真错配,应退回悬空而不是放宽阈值');
  }
});

test('新环线保持紧凑:估算里程 ≤800km 且不超过 2 个驾车日', () => {
  // 与 planner/measure-drive-packing 同一口径:直线 × LOOP_FACTOR(1.30),单日上限 400km。
  // 这条来自一次真实的取舍:桂北原本想并入融水元宝山,加节点后环线从约 565km/2 个驾车日
  // 涨到约 898km/3 个驾车日,5 天行程会直接报「偏紧」——与 zhexi 放弃龙泉节点同理。
  // 所以元宝山改按「就近」归黔东南。若哪天有人为了多接一条线给这里加节点,这条会红。
  const MAX_DAY = 400, MAX_KM = 800;
  for (const id of BATCH2) {
    const loop = regions[id].loop;
    const legs = [];
    for (let i = 1; i < loop.length; i++) legs.push(distanceKm(loop[i - 1], loop[i]) * LOOP_FACTOR);
    const km = legs.reduce((a, b) => a + b, 0);
    let days = 1, cur = 0;
    for (const L of legs) { if (cur > 0 && cur + L > MAX_DAY) { days++; cur = 0; } cur += L; }
    assert.ok(km <= MAX_KM, `${id} 估算环线 ${km.toFixed(0)}km 超过 ${MAX_KM}km——加节点会把整条环线的行程拉长`);
    assert.ok(days <= 2, `${id} 需要 ${days} 个驾车日(估算 ${km.toFixed(0)}km)——超过 2 天就不是「紧凑环线」了`);
  }
});

test('第 2 批没有从已有 18 个区域抢走线路(净增 18 条)', () => {
  // 建 jingbei2 时的坑:新区域的节点离隔壁区域的线路更近,地理校验全线告红。
  // 本批在建区前逐条算过,零冲突;这条把它钉住——若哪天有人挪了新区域的节点,
  // 已有区域的线路数会掉,这里立刻红。
  // qinling 6 / sanxia 5 是建区时的值;2026-10-08 第 4 批给这两个区域加了节点
  // (华阴/五峰,应昱龙授权,见 test/regions-batch4.test.mjs),因此各 +1 —— 这里同步为加节点后的值。
  const ORIGINAL = {
    chuanxi: 16, dianxibei: 10, yili: 5, gannan: 2, qinghaihu: 2, qinling: 7, jinbei: 5,
    nantaihang: 3, jingxi: 16, huanan: 7, zhennan: 4, zhexi: 3, wannan: 5, sanxia: 5,
    zangdongnan: 4, yangtzedelta: 2, dianzhong: 2, jingbei2: 3, sanxia: 6,
  };
  const NEW_ADDED = { guibei: 5, qiandongnan: 5, ganxi: 4, xuexiang: 2, changbaidong: 2 };
  const count = {};
  for (const t of Object.values(trails)) if (t.regionId) count[t.regionId] = (count[t.regionId] || 0) + 1;
  const problems = [];
  for (const [rid, n] of Object.entries(ORIGINAL)) {
    if ((count[rid] || 0) !== n) problems.push(`${rid} 有 ${count[rid] || 0} 条,建区前是 ${n} 条`);
  }
  for (const [rid, n] of Object.entries(NEW_ADDED)) {
    if ((count[rid] || 0) !== n) problems.push(`${rid} 有 ${count[rid] || 0} 条,应为 ${n} 条`);
  }
  const netNew = Object.values(NEW_ADDED).reduce((a, b) => a + b, 0);
  assert.equal(netNew, Object.keys(CONNECTED).length,
    `新增区域接入表(${Object.keys(CONNECTED).length} 条)与预期数(${netNew} 条)不一致`);
  assert.deepEqual(problems, [], `线路归属发生了变化:\n   ${problems.join('\n   ')}`);
});

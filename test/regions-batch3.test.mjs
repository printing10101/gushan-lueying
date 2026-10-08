// 第 3 批环线区域(23 → 29)的决定,固化成断言。结构与 regions-batch2.test.mjs 一致。
//
// 这批有三个「不写下来就会被后人误改」的判断:
//   ① **枢纽选址是成本项**:黔西用六盘水而不是贵阳。贵阳↔赫章单程 255km,
//      拿贵阳做枢纽时即使不绕兴义也要约 758km/3 个驾车日;六盘水居中,含兴义只要 606km/2 个。
//      有人「按惯例统一成省会」改回贵阳,行程会实打实多一天。
//   ② **单线区域是刻意的**:qiandongbei 只接 1 条(梵净山)。它看着像"空壳",
//      但梵净山是孤峰、最近邻线在 300km 外,不单独建区就永远悬空。
//      删掉这个区域 = 少 1 条可规划线路,而任何既有测试都不会红。
//   ③ **闽北环线评估过、选择不建**:赣东北 173km/1 个驾车日就能接 黄岗山+天游峰,
//      闽北(南平)要 657km/3 个驾车日、只多接戴云山 1 条——为 1 条线把环线推到 3 天,
//      与放弃「元宝山并入桂北」「龙泉并入 zhexi」同型。所以黄岗山挂铅山、天游峰挂铅山。
import { createRequire } from 'module';
const require = createRequire(new URL('../package.json', import.meta.url));
const store = require('./lib/store.js');
const { LOOP_FACTOR } = require('./lib/amap.js');
const test = require('node:test');
const assert = require('node:assert');

const trails = store.read('trails');
const regions = store.read('regions');

const BATCH3 = ['qianxi', 'gandongbei', 'dianxi', 'hainan', 'yuxi', 'qiandongbei'];

const EXPECTED_LOOP = {
  qianxi: ['六盘水', '赫章', '盘州', '兴义', '六盘水'],
  gandongbei: ['上饶', '玉山', '铅山', '上饶'],
  dianxi: ['大理', '漾濞', '宾川', '大理'],
  hainan: ['海口', '五指山', '乐东', '海口'],
  yuxi: ['洛阳', '登封', '栾川', '洛阳'],
  qiandongbei: ['铜仁', '江口', '印江', '铜仁'],
};

// 第 3 批接入的 14 条:id → [区域, 节点]
const CONNECTED = {
  'jiucaiping': ['qianxi', '赫章'],
  'wumeng-caoyuan': ['qianxi', '盘州'],
  'wanfenglin': ['qianxi', '兴义'],
  'luoping': ['qianxi', '兴义'], // 云南曲靖,跨省 54km
  'sanqingshan': ['gandongbei', '玉山'],
  'huanggangshan': ['gandongbei', '铅山'],
  'wuyishan': ['gandongbei', '铅山'], // 福建南平武夷山天游峰环线,跨省 74km
  'cangshan-shijiu': ['dianxi', '大理'],
  'jizushan': ['dianxi', '宾川'],
  'wuzhishan': ['hainan', '五指山'],
  'jianfengling': ['hainan', '乐东'],
  'songshan-shaoshi': ['yuxi', '登封'],
  'laojunshan-luoyang': ['yuxi', '栾川'],
  'fanjingshan': ['qiandongbei', '江口'],
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

test('第 3 批 6 个新区域:节点序列与 loop[0] 未被改动', () => {
  for (const id of BATCH3) {
    assert.ok(regions[id], `区域 ${id} 不存在——第 3 批建的 6 个区域不该被删`);
    assert.deepEqual(regions[id].loop.map((n) => n.name), EXPECTED_LOOP[id],
      `${id} 环线节点序列变了。改节点会改变区域内每条线路的行程长度,并可能抢走邻区的线路`);
    assert.equal(regions[id].loop[0].name, EXPECTED_LOOP[id][0], `${id} 的 loop[0] 应是枢纽站所在市镇`);
    const mid = regions[id].loop.slice(1, -1).map((n) => n.name);
    assert.equal(new Set(mid).size, mid.length, `${id} 中间节点重名`);
  }
  // 枢纽站不允许写成复合值(会被原样丢进 12306 查站名),这条通用断言在 trails-data 里也有,
  // 这里再点名一次是因为本批已知一个真实陷阱:铜仁南站(沪昆高铁)在玉屏县、距市区 80km,
  // 正确做法是 railStation 只写「铜仁」,南站的事写进 notes。
  assert.equal(regions.qiandongbei.hub.railStation, '铜仁',
    '黔东北的 hub.railStation 应是铜仁站;铜仁南站距市区约 80km,只能写进 notes');
});

test('第 3 批接入的 14 条线:regionId 与 node 精确锁定', () => {
  const wrong = [];
  for (const [tid, [regionId, node]] of Object.entries(CONNECTED)) {
    const t = trails[tid];
    if (!t) { wrong.push(`${tid} 不存在于线路库`); continue; }
    if (t.regionId !== regionId) wrong.push(`${t.name} 的 regionId 是 ${t.regionId || '(悬空)'},应为 ${regionId}`);
    if (t.node !== node) wrong.push(`${t.name} 的 node 是 ${t.node || '(空)'},应为 ${node}`);
  }
  assert.deepEqual(wrong, [], `第 3 批的接入关系被改动了:\n   ${wrong.join('\n   ')}`);
});

test('2 条跨省接入必须仍是「近距跨省」(≤80km)', () => {
  // 跨省不是硬排除,近距跨省合法;不允许的只有「超距 + 跨省」。
  // 这两条是踩在阈值内的判断,坐标一改就可能变成「开过去很远」的行程。
  const CROSS = [['luoping', 'qianxi', '兴义'], ['wuyishan', 'gandongbei', '铅山']];
  for (const [tid, regionId, node] of CROSS) {
    const t = trails[tid];
    const n = regions[regionId].loop.find((x) => x.name === node);
    assert.ok(n, `${regionId} 少了节点 ${node}`);
    assert.notEqual(t.province, regions[regionId].province, `${t.name} 已变成同省,跨省前提变了,请复核`);
    const km = distanceKm(t.start, n);
    assert.ok(km <= 80, `${t.name}(${t.province}→${regions[regionId].province})距 ${node} ${km.toFixed(1)}km,`
      + '已超 80km 阈值——超距跨省是真错配,应退回悬空而不是放宽阈值');
  }
  // 反向:这两个区域必须各至少有一条跨省线,否则说明标注被改成同省了(该复核是否合理)
  assert.ok(trails.luoping.regionId === 'qianxi');
  assert.ok(trails['wuyishan'].regionId === 'gandongbei');
});

test('新环线保持紧凑:估算里程 ≤800km 且不超过 2 个驾车日', () => {
  // 与 planner / measure-drive-packing 同一口径:直线 × LOOP_FACTOR(1.30),单日上限 400km。
  // 本批正是靠「换枢纽」而不是「加里程」满足这条:黔西若把枢纽换成贵阳,
  // 估算会从 606km/2 个驾车日变成约 758km/3 个驾车日,这条立刻红。
  const MAX_DAY = 400, MAX_KM = 800;
  for (const id of BATCH3) {
    const loop = regions[id].loop;
    const legs = [];
    for (let i = 1; i < loop.length; i++) legs.push(distanceKm(loop[i - 1], loop[i]) * LOOP_FACTOR);
    const km = legs.reduce((a, b) => a + b, 0);
    let days = 1, cur = 0;
    for (const L of legs) { if (cur > 0 && cur + L > MAX_DAY) { days++; cur = 0; } cur += L; }
    assert.ok(km <= MAX_KM, `${id} 估算环线 ${km.toFixed(0)}km 超过 ${MAX_KM}km`);
    assert.ok(days <= 2, `${id} 需要 ${days} 个驾车日(估算 ${km.toFixed(0)}km)——超过 2 天就不是「紧凑环线」了`);
  }
});

test('单线区域 qiandongbei 必须保留(梵净山没有别的落脚点)', () => {
  // 库里唯一一个只接 1 条线路的区域。它长得像「空壳」,但:
  // 梵净山(铜仁)最近的邻线在 300km 外,没有区域它就只能一直悬空。
  // 这条断言防的是「看着多余就删掉/合并」——删了不会让任何其它测试红。
  const n = Object.values(trails).filter((t) => t.regionId === 'qiandongbei').length;
  assert.equal(n, 1, `qiandongbei 应恰有 1 条线路,现为 ${n} 条`);
  assert.equal(trails.fanjingshan.regionId, 'qiandongbei', '梵净山应挂在 qiandongbei');
  assert.equal(trails.fanjingshan.node, '江口');
});

test('第 3 批没有从已有 23 个区域抢走线路(净增 14 条)', () => {
  const BEFORE = {
    // qinling 7 / sanxia 6:第 4 批给这两个区域加了节点(华阴/五峰),各 +1,详见 test/regions-batch4.test.mjs
    chuanxi: 16, dianxibei: 10, yili: 5, gannan: 2, qinghaihu: 2, qinling: 7, jinbei: 5,
    nantaihang: 3, jingxi: 16, huanan: 7, zhennan: 4, zhexi: 3, wannan: 5, sanxia: 6,
    zangdongnan: 4, yangtzedelta: 2, dianzhong: 2, jingbei2: 3,
    guibei: 5, qiandongnan: 5, ganxi: 4, xuexiang: 2, changbaidong: 2,
  };
  const ADDED = { qianxi: 4, gandongbei: 3, dianxi: 2, hainan: 2, yuxi: 2, qiandongbei: 1 };
  const count = {};
  for (const t of Object.values(trails)) if (t.regionId) count[t.regionId] = (count[t.regionId] || 0) + 1;
  const problems = [];
  for (const [rid, n] of Object.entries(BEFORE)) {
    if ((count[rid] || 0) !== n) problems.push(`${rid} 有 ${count[rid] || 0} 条,建区前是 ${n} 条`);
  }
  for (const [rid, n] of Object.entries(ADDED)) {
    if ((count[rid] || 0) !== n) problems.push(`${rid} 有 ${count[rid] || 0} 条,应为 ${n} 条`);
  }
  assert.equal(Object.values(ADDED).reduce((a, b) => a + b, 0), Object.keys(CONNECTED).length,
    '新增区域接入表条数与预期不一致');
  assert.deepEqual(problems, [], `线路归属发生了变化:\n   ${problems.join('\n   ')}`);
});

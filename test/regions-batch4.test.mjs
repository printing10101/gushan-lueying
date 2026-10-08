// 第 4 批(29 → 34)的决定,固化成断言。这一批与前 3 批性质不同,断言的重点也不同:
//
//   前 3 批是「悬空线路的簇 → 建区」,断言防的是"接入关系被改回去"。
//   第 4 批做了两件前 3 批明令禁止的事,所以必须把**授权与代价**一起钉住:
//     ① **给已有区域加了节点**(qinling + 华阴、sanxia + 五峰)。
//        README 一直写着「新增节点会改变已有行程」——这是本仓第一次真的这么做。
//        规矩不是"不许做",而是"先量后改":加节点后**驾车日不得增加**。
//        (第三个候选 gannan + 白银 实测会让甘南 2→3 个驾车日,因此没做,
//         黄河石林改成独立小环线 baiyin。这条也用断言钉住了,防止有人"顺手"把它并回甘南。)
//     ② **建了 4 个单线区域**。它们是孤点,删掉不会有任何既有测试红(悬空是合法状态),
//        所以这里把「单线区域名单」整体锁住:数量少了要有人来解释。
import { createRequire } from 'module';
const require = createRequire(new URL('../package.json', import.meta.url));
const store = require('./lib/store.js');
const { LOOP_FACTOR } = require('./lib/amap.js');
const test = require('node:test');
const assert = require('node:assert');

const trails = store.read('trails');
const regions = store.read('regions');

const BATCH4 = ['ningxia', 'taishan', 'daiyunshan', 'dabieshan', 'baiyin'];

const EXPECTED_LOOP = {
  ningxia: ['银川', '中卫', '固原', '银川'],
  taishan: ['济南', '泰安', '济南'],
  daiyunshan: ['泉州', '德化', '泉州'],
  dabieshan: ['六安', '霍山', '六安'],
  baiyin: ['白银', '景泰', '白银'],
};

// 本批接入的 9 条(含 2 条挂到已有区域节点上的)
const CONNECTED = {
  // 新建区域
  'helanshan': ['ningxia', '银川'],
  'liupanshan': ['ningxia', '固原'],
  'tengger-wuhu': ['ningxia', '银川'], // 内蒙古阿拉善左旗,腾格里沙漠五湖连穿,跨省 77km
  'taishan-hongmen': ['taishan', '泰安'],
  'daiyunshan': ['daiyunshan', '德化'],
  'baimajian': ['dabieshan', '霍山'],
  'huangheshilin': ['baiyin', '景泰'],
  // 挂到已有区域新加的节点上
  'huashan-yepa': ['qinling', '华阴'],
  'hupingshan': ['sanxia', '五峰'],
};

// 加节点前的环线节点序列(照抄自 2026-10-08 改前状态)
const LOOP_BEFORE = {
  qinling: ['西安', '眉县', '太白县', '黄柏塬', '厚畛子', '鄠邑', '西安'],
  sanxia: ['宜昌', '秭归', '奉节', '巫山', '巴东', '恩施', '利川', '宜昌'],
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
function pack(loop) {
  const legs = [];
  for (let i = 1; i < loop.length; i++) legs.push(distanceKm(loop[i - 1], loop[i]) * LOOP_FACTOR);
  let days = 1, cur = 0;
  const det = [];
  for (const L of legs) { if (cur > 0 && cur + L > 400) { det.push(cur); days++; cur = 0; } cur += L; }
  det.push(cur);
  return { km: legs.reduce((a, b) => a + b, 0), days, worst: Math.max(...det) };
}

test('第 4 批 5 个新区域的节点序列与 loop[0] 未被改动', () => {
  for (const id of BATCH4) {
    assert.ok(regions[id], `区域 ${id} 不存在——第 4 批建的 5 个区域不该被删`);
    assert.deepEqual(regions[id].loop.map((n) => n.name), EXPECTED_LOOP[id], `${id} 环线节点序列变了`);
    assert.equal(regions[id].loop[0].name, EXPECTED_LOOP[id][0], `${id} 的 loop[0] 应是枢纽所在市镇`);
  }
});

test('第 4 批接入的 9 条线:regionId 与 node 精确锁定', () => {
  const wrong = [];
  for (const [tid, [regionId, node]] of Object.entries(CONNECTED)) {
    const t = trails[tid];
    if (!t) { wrong.push(`${tid} 不存在于线路库`); continue; }
    if (t.regionId !== regionId) wrong.push(`${t.name} 的 regionId 是 ${t.regionId || '(悬空)'},应为 ${regionId}`);
    if (t.node !== node) wrong.push(`${t.name} 的 node 是 ${t.node || '(空)'},应为 ${node}`);
  }
  assert.deepEqual(wrong, [], `第 4 批的接入关系被改动了:\n   ${wrong.join('\n   ')}`);
});

test('给已有区域加节点的唯一硬约束:驾车日不得增加', () => {
  // 这是本仓第一次改已有环线。README 写着「新增节点会改变已有行程」,但没说
  // "不许改"——规矩是**先量后改**,量化判据就是这条:加了节点后驾车日不能变多。
  // 实测:qinling +华阴 2→2 个驾车日、sanxia +五峰 3→3 个,所以做了;
  //       gannan +白银 2→3 个,所以没做(改成了独立的 baiyin 小环线)。
  const cases = [
    ['qinling', '华阴', '鄠邑', 2, '华山夜爬'],
    ['sanxia', '五峰', '利川', 3, '壶瓶山'],
  ];
  for (const [rid, node, after, beforeDays, why] of cases) {
    const region = regions[rid];
    const names = region.loop.map((n) => n.name);
    assert.ok(names.includes(node), `${rid} 缺少为「${why}」加的节点「${node}」`);
    assert.equal(names.indexOf(node), names.indexOf(after) + 1,
      `${node} 应紧跟在「${after}」之后插入(实测取的是"驾车日不变、里程最小"的那个位置)`);
    // 加节点后的序列 = 改前序列把新节点插进对应位置
    const expected = [...LOOP_BEFORE[rid]];
    expected.splice(expected.indexOf(after) + 1, 0, node);
    assert.deepEqual(names, expected, `${rid} 环线节点序列与"加节点前 + 插入一个节点"对不上,说明还动过别的地方`);
    const p = pack(region.loop);
    assert.ok(p.days <= beforeDays, `${rid} 加「${node}」后需要 ${p.days} 个驾车日,改前是 ${beforeDays} 个——`
      + '加节点让整条环线的行程变长了,按判据这次改动应当撤销(或改成独立小环线)');
    assert.ok(p.worst <= 400, `${rid} 出现 ${Math.round(p.worst)}km 的单日(上限 400km)`);
  }
});

test('黄河石林刻意不并入 gannan:甘南必须仍是 2 个驾车日且不含白银/景泰', () => {
  // 这是"量出来不划算就不做"的那条。若有人后来把它并回甘南(看起来更"整齐"),
  // 甘南已接入的 2 条线路行程会平白多出一个驾车日,而其它测试都不会红。
  const names = regions.gannan.loop.map((n) => n.name);
  assert.ok(!names.includes('白银') && !names.includes('景泰'),
    '甘南环线出现了白银/景泰——这条改动实测会让甘南从 2 个驾车日涨到 3 个,已明确否决');
  const p = pack(regions.gannan.loop);
  assert.ok(p.days <= 2, `甘南现在需要 ${p.days} 个驾车日(应为 ≤2)`);
  assert.equal(trails.huangheshilin.regionId, 'baiyin', '黄河石林应挂在独立的 baiyin 小环线下');
});

test('单线区域名单:5 个孤点区域必须都在', () => {
  // 单线区域删掉不会有任何既有测试红(线路退回悬空是合法状态),所以整份名单锁住。
  // 每一条都是"别处接不了的孤点":
  //   qiandongbei 梵净山(最近邻线 300km 外)、taishan 泰山(山东唯一入库线路)、
  //   daiyunshan 戴云山(距外省节点 250km+)、dabieshan 白马尖(距 wannan 250km)、
  //   baiyin 黄河石林(原打算并入甘南,实测代价过大)
  const count = {};
  for (const t of Object.values(trails)) if (t.regionId) count[t.regionId] = (count[t.regionId] || 0) + 1;
  const singles = Object.entries(count).filter(([, n]) => n === 1).map(([rid]) => rid).sort();
  assert.deepEqual(singles, ['baiyin', 'dabieshan', 'daiyunshan', 'qiandongbei', 'taishan'],
    `单线区域名单变了(现为 ${singles.join(', ')})——新增或减少都要先在 README 里写清为什么`);
});

test('第 4 批没有从已有区域抢走线路,且新区域单日不超 400km', () => {
  // 老区域只有 qinling/sanxia 因"授权加节点"各 +1 条,其余逐区不变。
  const BEFORE = {
    chuanxi: 16, dianxibei: 10, yili: 5, gannan: 2, qinghaihu: 2, qinling: 6, jinbei: 5,
    nantaihang: 3, jingxi: 16, huanan: 7, zhennan: 4, zhexi: 3, wannan: 5, sanxia: 5,
    zangdongnan: 4, yangtzedelta: 2, dianzhong: 2, jingbei2: 3,
    guibei: 5, qiandongnan: 5, ganxi: 4, xuexiang: 2, changbaidong: 2,
    qianxi: 4, gandongbei: 3, dianxi: 2, hainan: 2, yuxi: 2, qiandongbei: 1,
  };
  const BEFORE_EXCEPTIONS = { qinling: 7, sanxia: 6 }; // 加节点后各 +1
  const ADDED = { ningxia: 3, taishan: 1, daiyunshan: 1, dabieshan: 1, baiyin: 1 };
  const count = {};
  for (const t of Object.values(trails)) if (t.regionId) count[t.regionId] = (count[t.regionId] || 0) + 1;
  const problems = [];
  for (const [rid, n] of Object.entries(BEFORE)) {
    const want = BEFORE_EXCEPTIONS[rid] !== undefined ? BEFORE_EXCEPTIONS[rid] : n;
    if ((count[rid] || 0) !== want) problems.push(`${rid} 有 ${count[rid] || 0} 条,应为 ${want} 条`);
  }
  for (const [rid, n] of Object.entries(ADDED)) {
    if ((count[rid] || 0) !== n) problems.push(`${rid} 有 ${count[rid] || 0} 条,应为 ${n} 条`);
  }
  assert.deepEqual(problems, [], `线路归属发生了变化:\n   ${problems.join('\n   ')}`);
  // 新区域的单日上限:宁夏是"一条环线串两个相距 340km 的目标",3 个驾车日,但任何一天都不许超 400km
  for (const id of BATCH4) {
    const p = pack(regions[id].loop);
    assert.ok(p.worst <= 400, `${id} 出现 ${Math.round(p.worst)}km 的单日(上限 400km)`);
    assert.ok(p.days <= 3, `${id} 需要 ${p.days} 个驾车日,超过 3 天不适合做成"一个周末能去的区域"`);
  }
});

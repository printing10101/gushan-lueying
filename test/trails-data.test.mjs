import { createRequire } from 'module';
const require = createRequire(new URL('../package.json', import.meta.url));
const store = require('./lib/store.js');
const { computeBreakdown } = require('./lib/grading.js');
const { SCENERY } = require('./lib/recommend.js');
const test = require('node:test');
const assert = require('node:assert');

const trails = store.read('trails');
const regions = store.read('regions');
// 自动回填判定半径,与 scripts/backfill-region.mjs 的 DEFAULT_MAX_KM 保持一致。
// 提到文件级:多条测试都要用(跨省合法性、地理校验、超距检查)。
const AUTO_MAX_KM = 80;
const TYPES = ['长线重装', '雪山攀登', '高原转山', '古道', '沙漠', '长城', '城市周边', '山地纵走', '景区步道', '峡谷穿越'];
const STATUSES = ['开放', '部分管控', '管控', '禁入', '关闭'];

test('路线库规模:全国覆盖不应缩水', () => {
  assert.ok(Object.keys(trails).length >= 100, `现有 ${Object.keys(trails).length} 条,应不少于 100 条`);
  const provinces = new Set(Object.values(trails).map((t) => t.province));
  assert.ok(provinces.size >= 25, `现有 ${provinces.size} 个省级区域,应不少于 25 个`);
});

// 同名条目会让路线库/推荐页渲染出两张无法区分的卡片,且两份数据常互相矛盾
// (实测「珠峰东坡·嘎玛沟」曾有 11 天/100km 与 9 天/90km 两版并存),必须挡住。
test('线路名唯一:不得有同名条目', () => {
  const byName = new Map();
  for (const [id, t] of Object.entries(trails)) {
    const list = byName.get(t.name) || [];
    list.push(id);
    byName.set(t.name, list);
  }
  const dups = [...byName.entries()].filter(([, ids]) => ids.length > 1);
  assert.equal(dups.length, 0,
    `以下线路名重复: ${dups.map(([n, ids]) => `${n} → ${ids.join(', ')}`).join('; ')}`);
});

test('全量校验:必填字段 / 词汇表 / 坐标 / 评级与指标建议相差不超一级', () => {
  for (const [id, t] of Object.entries(trails)) {
    for (const key of ['name', 'province', 'area', 'type', 'days', 'distanceKm', 'climbM', 'maxAltM', 'grade', 'status', 'start', 'summary']) {
      assert.ok(t[key] !== undefined && t[key] !== '', `${id} 缺必填字段 ${key}`);
    }
    assert.match(id, /^[a-z0-9-]+$/, `${id} 只允许小写字母数字连字符`);
    assert.ok(Number.isInteger(t.grade) && t.grade >= 1 && t.grade <= 5, `${id} grade 越界: ${t.grade}`);
    assert.ok(t.days >= 1 && t.days <= 30, `${id} days 异常: ${t.days}`);
    assert.ok(TYPES.includes(t.type), `${id} 非法类型 ${t.type}(词表外的类型会漏出筛选下拉)`);
    assert.ok(STATUSES.includes(t.status), `${id} 非法状态 ${t.status}`);
    assert.ok(t.start.lng >= 73 && t.start.lng <= 136 && t.start.lat >= 3 && t.start.lat <= 54, `${id} 坐标异常`);
    assert.ok(t.distanceKm <= 60 * t.days, `${id} 日均里程超 60km,数据可疑`);
    // 景色标签可以留空(确实无标志景观的技术线),但不能有词表外的值,否则推荐页会漏出未知筛选
    assert.ok(Array.isArray(t.scenery), `${id} 缺 scenery 数组(可为空)`);
    assert.ok(t.scenery.every((s) => SCENERY.includes(s)), `${id} scenery 含词表外标签: ${t.scenery.filter((s) => !SCENERY.includes(s)).join('、')}`);
    assert.equal(new Set(t.scenery).size, t.scenery.length, `${id} scenery 有重复标签`);
    // 结构化月份(手标或 bestSeason 解析回填):必须是 1-12 的去重整数月
    if (t.bestMonths != null) {
      assert.ok(Array.isArray(t.bestMonths) && t.bestMonths.length > 0, `${id} bestMonths 应为非空数组`);
      assert.ok(t.bestMonths.every((m) => Number.isInteger(m) && m >= 1 && m <= 12),
        `${id} bestMonths 越界: ${t.bestMonths}`);
      assert.equal(new Set(t.bestMonths).size, t.bestMonths.length, `${id} bestMonths 有重复月份`);
    }

    const suggested = computeBreakdown(t).suggested;
    const gap = Math.abs(t.grade - suggested);
    assert.ok(gap <= 1, `${id} 人工评级 ★${t.grade} 与指标建议 ★${suggested} 相差 ${gap} 级,请复核数据或评级`);
  }
});

test('行程规划关联线路:区域存在且节点落在环线上', () => {
  for (const [id, t] of Object.entries(trails)) {
    if (!t.regionId) continue;
    const region = regions[t.regionId];
    assert.ok(region, `${id} 引用不存在的区域 ${t.regionId}`);
    assert.ok(region.loop.some((n) => n.name === t.node), `${id} 的节点 ${t.node} 不在区域 ${t.regionId} 环线上`);
  }
});

// regionId 不能靠「看着像同省」手工填:9 个 region 是具体自驾环线,不是省份概念。
// 填错的后果不是报错而是生成一条到不了的行程(贵州线路被塞进「滇西北环线」,
// 规划器从丽江出发环线,全程根本开不到贵州),而且静默——用户看不出来。
// 这里用地理校验兜住:已标注的线路,其起点最近的环线节点必须就在所标的那个环线上。
// scripts/backfill-region.mjs 是同一判据的可执行版本(且默认阈值 80km,实测 35/35
// 与人工标注一致),用 --max-km 可放宽,但放宽后必须人工复核。
const EARTH_R = 6371;
const rad = (d) => (d * Math.PI) / 180;
function distanceKm(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2
    + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(s)));
}

// 判据只有一条:**就近**。曾经试过「同省优先」,被两条真实数据否掉了:
//   · 浙西三尖(起点 119.15,30.25)距浙江临安 55km、距安徽绩溪 43km;
//   · 清凉峰南山脊(area 写明「杭州·临安—安徽绩溪」,本来就走绩溪一侧山脊)
//     距绩溪 10km、距临安 85km。
// 强制同省会把这两条推去更远的地方,判据反而制造「开过去更远」的行程。
// 环线跨市界、跨省界是合法的(南太行/河南收山西的王莽岭 14km、
// 长三角/江苏收上海佘山 8km、三峡/湖北收重庆三峡之巅 8km、皖南收浙江清凉峰 10km),
// 真正的错只在于「离哪个环线都远」。
//
// 唯一单独处理的是跨境(港澳台):内地车不能自驾跨境,它们不该挂进任何区域。
const CROSS_BORDER_PROVINCES = new Set(['香港', '澳门', '台湾']);

// 近距跨省必须允许(这条被真实数据钉死过一次:旧的 backfill 脚本对跨省
// 无条件硬排除,结果佘山九峰/清凉峰/三峡之巅/阴条岭全被误卡成悬空)。
// 判据与下面「超距可以接受,但不得跨省」那条一致:只有「超距+跨省」才是错配。
test('近距跨省合法:跨省线路挂在邻省环线上不是错配', () => {
  const crossProvince = [];
  for (const [id, t] of Object.entries(trails)) {
    if (!t.regionId) continue;
    const region = regions[t.regionId];
    if (!region || t.province === region.province) continue;
    const node = (region.loop || []).find((n) => n.name === t.node);
    if (!node) continue;
    crossProvince.push({ name: t.name, province: t.province, region: region.province,
      km: Math.round(distanceKm(t.start, node)) });
  }
  // 一旦建了跨省区域,近距跨省条目就应该存在;存在时必须都在阈值内
  for (const c of crossProvince) {
    assert.ok(c.km <= AUTO_MAX_KM,
      `${c.name}(${c.province}→${c.region})相距 ${c.km}km 超过 ${AUTO_MAX_KM}km,` +
      '超距又跨省才是真错配,应当人工裁决而非自动挂靠');
  }
  // 防退化:若哪天规则被改回「跨省一律拒绝」,这个断言会红
  assert.ok(crossProvince.length > 0,
    '库里应当存在近距跨省的接入线路(长三角收上海佘山/皖南收浙江清凉峰),' +
    '若为 0 说明跨省硬排除规则被改回去了');
});


test('已标注 regionId 的线路,起点地理上确实靠近该环线(防手工填错)', () => {
  const offenders = [];
  for (const [id, t] of Object.entries(trails)) {
    if (!t.regionId) continue;
    if (CROSS_BORDER_PROVINCES.has(t.province)) {
      offenders.push(`${t.name}属${t.province},内地车无法自驾跨境,不应挂进 ${t.regionId}`);
      continue;
    }
    let best = null;
    for (const [regionId, region] of Object.entries(regions)) {
      for (const node of region.loop || []) {
        const km = distanceKm(t.start, node);
        if (!best || km < best.km) best = { regionId, km, nodeName: node.name };
      }
    }
    if (best && best.regionId !== t.regionId) {
      offenders.push(`${t.name}(标注 ${t.regionId},但最近的 ${best.nodeName} 属 ${best.regionId},相距 ${Math.round(best.km)}km)`);
    }
  }
  assert.equal(offenders.length, 0,
    `以下线路的 regionId 与地理位置不符,会产生到不了的行程:\n   ${offenders.join('\n   ')}`);
});

// 阈值 80km 是「自动归类」的门槛,不是「人工标注正确性」的判据——两者要分开:
//   · 自动归类:backfill-region.mjs 只把 ≤80km 的线路收进区域,所以回填的必然满足,
//     这条测试是防将来有人绕过脚本手工填一个远距离的。
//   · 人工标注:本来就允许超距。新疆伊犁环线在伊宁河谷,而夏特/孟克德在昭苏西南、
//     尼勒克东部山区,直线距离 82–158km(实际公路里程更远),但都在伊犁州境内、
//     与环线节点同县,标注是对的。用 80km 去卡人工标注是否定正确的判断,
//     逼着人删掉正确数据或放宽阈值让真错配钻进来。
// 所以这里只检查「超距且跨州」——省份与区域所在地不一致才是真错配。
test('已标注 regionId 的线路:超距可以接受,但不得跨省', () => {
  const problems = [];
  for (const [id, t] of Object.entries(trails)) {
    if (!t.regionId) continue;
    const region = regions[t.regionId];
    const node = region.loop.find((n) => n.name === t.node);
    if (!node) continue;
    const km = distanceKm(t.start, node);
    if (km <= AUTO_MAX_KM) continue;
    // 超距只在这里提示,不单独判失败;跨省才是硬错误。
    if (t.province !== region.province) {
      problems.push(`${t.name}(${t.province},但区域 ${t.regionId} 在 ${region.province},相距 ${Math.round(km)}km)`);
    }
  }
  assert.equal(problems.length, 0,
    `以下线路跨省却挂到外省环线上,会产生到不了的行程:\n   ${problems.join('\n   ')}`);
});

// 区域结构本身也要校验。新增区域时最容易犯的错:
//   · loop 不闭合 —— planner 按 loop[i]→loop[i+1] 生成 leg,首尾不重合就没有返程;
//   · hub.railStation 写成复合值 —— 它会被原样丢进 12306 查站名,「广州南/广州站」
//     这种斜杠写法必然查不到(实测冒烟直接抛「找不到 12306 车站」)。
//     要表达「有两个站」应该写在 notes 里,railStation 只放 planner 真正用来查的那个。
//   · loop 节点重名重复 —— planDays 用 legs[i].to === trail.node 定位徒步日,
//     出现重复节点会让匹配歧义。
test('区域结构:环线闭合 / 铁路站是单一站名 / 节点不重复', () => {
  const problems = [];
  for (const [id, region] of Object.entries(regions)) {
    const loop = region.loop || [];
    const first = loop[0];
    const last = loop[loop.length - 1];
    if (!first || first.name !== last.name || first.lng !== last.lng || first.lat !== last.lat) {
      problems.push(`${id} 环线未闭合:首节点 ${first && first.name} ≠ 末节点 ${last && last.name}(planner 无返程 leg)`);
    }
    const station = region.hub && region.hub.railStation;
    if (!station) problems.push(`${id} 缺 hub.railStation`);
    else if (/[/、,，;；|]/.test(station)) {
      problems.push(`${id} 的 hub.railStation 是复合值「${station}」,会被原样丢进 12306 查站名,必然查不到;只放单个站名,其余写进 notes`);
    }
    // 中间节点重名(首尾同名的闭合点除外)
    const mid = loop.slice(1, -1).map((n) => n.name);
    const dup = mid.filter((n, i) => mid.indexOf(n) !== i);
    if (dup.length) problems.push(`${id} 环线中间节点重名:${[...new Set(dup)].join('、')}(planDays 按节点名定位徒步日会歧义)`);
    for (const n of loop) {
      if (!Number.isFinite(n.lng) || !Number.isFinite(n.lat)) {
        problems.push(`${id} 节点「${n.name}」坐标非法`);
      }
    }
  }
  assert.equal(problems.length, 0, `区域结构有问题:\n   ${problems.join('\n   ')}`);
});

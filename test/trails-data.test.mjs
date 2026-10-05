import { createRequire } from 'module';
const require = createRequire(new URL('../package.json', import.meta.url));
const store = require('./lib/store.js');
const { computeBreakdown } = require('./lib/grading.js');
const { SCENERY } = require('./lib/recommend.js');
const test = require('node:test');
const assert = require('node:assert');

const trails = store.read('trails');
const regions = store.read('regions');
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

test('已标注 regionId 的线路,起点地理上确实靠近该环线(防手工填错)', () => {
  const offenders = [];
  for (const [id, t] of Object.entries(trails)) {
    if (!t.regionId) continue;
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
  const AUTO_MAX_KM = 80;
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

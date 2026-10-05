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

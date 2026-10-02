import { createRequire } from 'module';
const require = createRequire(new URL('../package.json', import.meta.url));
const store = require('./lib/store.js');
const { computeBreakdown } = require('./lib/grading.js');
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

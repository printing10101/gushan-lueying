// 区域库(regions.json)的数据断言。
//
// 与 trails-data.test.mjs 的分工:那边从**线路**视角看区域(线路引用的区域是否存在、
// 节点是否落在环线上、地理归属是否合理);这里从**区域自身**视角看。
// 已有的「环线闭合 / 节点不重复 / hub.railStation 不是复合值」在那边的
// 「区域结构」用例里,这里不重复,只补它没管到的几条:
//   · hub 四个子字段是否齐备(openFlightPage 缺 flightCity 就点不动)
//   · hub.railStation 是否**真的存在于 12306 站表**(站名拼错的最终防线)
//   · loop 节点坐标是否落在国境经纬度范围内(那边只校验"是有限数")
//   · stay 覆盖字段的数值合法性(字段级覆盖是设计允许的,所以只校验"写了的必须合法")
import { createRequire } from 'module';
const require = createRequire(new URL('../package.json', import.meta.url));
const store = require('./lib/store.js');
const test = require('node:test');
const assert = require('node:assert');

const regions = store.read('regions');
// stations.json 是运行时缓存(gitignore),干净克隆里不存在——所以下面那条要能优雅跳过
const stations = store.read('stations');

const entries = Object.entries(regions);

test('区域规模与 id 格式:至少 15 个区域,id 只允许小写字母数字连字符', () => {
  assert.ok(entries.length >= 15, `现有 ${entries.length} 个区域,不应缩水`);
  for (const [id, r] of entries) {
    assert.match(id, /^[a-z0-9-]+$/, `区域 id ${id} 只允许小写字母数字连字符`);
    for (const key of ['name', 'province', 'hub', 'loop']) {
      assert.ok(r[key] !== undefined && r[key] !== '', `${id} 缺必填字段 ${key}`);
    }
    assert.ok(Array.isArray(r.loop) && r.loop.length >= 2,
      `${id} 环线至少要有 2 个节点(闭环的首尾各一个),现有 ${(r.loop || []).length} 个`);
    assert.equal(new Set(entries.map(([, x]) => x.name)).size, entries.length,
      '区域名必须唯一——UI 上按名称并列展示,重名会渲染出两张无法区分的卡片');
  }
});

test('hub 四个子字段齐备:缺 flightCity 会让「查机票」点了必报错', () => {
  // openFlightPage 的判据是 `!from || !to` 就 alert 并 return;
  // from 来自 config.flightCityPinyin(另一处有 configGaps 盯着),to 就是 hub.flightCity。
  const problems = [];
  for (const [id, r] of entries) {
    const hub = r.hub || {};
    for (const key of ['city', 'railStation', 'airport', 'flightCity']) {
      if (!hub[key]) problems.push(`${id} 缺 hub.${key}`);
    }
    if (hub.flightCity && !/^[a-z]+$/.test(hub.flightCity)) {
      problems.push(`${id} 的 hub.flightCity「${hub.flightCity}」应为小写拼音(拼进携程 URL 用)`);
    }
  }
  assert.equal(problems.length, 0, `hub 字段有问题:\n   ${problems.join('\n   ')}`);
});

test('hub.railStation 必须真的在 12306 站表里(站名拼错的最终防线)', (t) => {
  // 站名写错(多一个"站"字、用简称)不会在任何别处炸:它只在查票那一刻静默查不到,
  // 而查票要网络——离线开发时根本发现不了。这条把它提前到数据层。
  if (!stations) {
    t.skip('data/stations.json 未生成(它是运行时缓存、不入库);跑一次应用或冒烟脚本后会生成');
    return;
  }
  const all = Array.isArray(stations) ? stations : Object.values(stations);
  const names = new Set(all.map((s) => s && s.name).filter(Boolean));
  assert.ok(names.size > 1000, `站表只有 ${names.size} 个站,数据可疑`);
  const missing = entries
    .filter(([, r]) => r.hub && r.hub.railStation && !names.has(r.hub.railStation))
    .map(([id, r]) => `${id}=「${r.hub.railStation}」`);
  assert.equal(missing.length, 0,
    `以下枢纽站名不在 12306 站表(共 ${names.size} 站),查票必然失败: ${missing.join('、')}`);
});

test('loop 节点坐标落在国境经纬度范围内(trails-data 那边只校验"是有限数")', () => {
  const problems = [];
  for (const [id, r] of entries) {
    for (const n of r.loop || []) {
      // 中国国境大致范围:经度 73-136,纬度 3-54。越界说明经纬写反了或漏了小数点。
      if (!(n.lng >= 73 && n.lng <= 136 && n.lat >= 3 && n.lat <= 54)) {
        problems.push(`${id} 节点「${n.name}」坐标 (${n.lng}, ${n.lat}) 越界——大概率把 lng/lat 写反了`);
      }
    }
  }
  assert.equal(problems.length, 0, `环线坐标有问题:\n   ${problems.join('\n   ')}`);
});

test('stay 覆盖字段:写了的必须是正数(字段级覆盖是设计允许的,不要求两个都写)', () => {
  // README 口径:stay 是「字段级覆盖 config 全局口径」,所以只写一半是合法的
  // (缺失的那半走 config 默认值)。但写了的那个必须是有意义的正数——
  // 写成 0 会让住宿/餐饮估算变成 0,而界面上看不出异常。
  const problems = [];
  for (const [id, r] of entries) {
    if (!r.stay) continue;
    for (const [key, v] of Object.entries(r.stay)) {
      // tiers 是嵌套对象(分档价),由「床位价必须与出处配套」那条单独管;
      // 这里只看平铺的数值字段——否则加个嵌套结构就会把这条通用断言打红
      if (v !== null && typeof v === 'object') continue;
      if (!Number.isFinite(v) || v <= 0) {
        problems.push(`${id}.stay.${key} = ${JSON.stringify(v)},应为正数(0 会让该项估算静默变成免费)`);
      }
    }
  }
  assert.equal(problems.length, 0, `stay 数值有问题:\n   ${problems.join('\n   ')}`);
});

test('青旅床位价必须与出处配套:数字不许没来源(同门票的纪律)', () => {
  // 床位价是 2026-10-08 从 Hostelworld 城市页抓的**在售参考价**,会随季节与日期波动。
  // 所以数字必须带 source(来源 + URL + 核对日期 + 样本数),否则用户没法判断它有多可信。
  const problems = [];
  for (const [id, r] of entries) {
    const bed = r.stay && r.stay.tiers && r.stay.tiers.青旅;
    if (!bed) continue;
    if (!Number.isFinite(bed.perBedPerNight) || bed.perBedPerNight <= 0) {
      problems.push(`${id}: perBedPerNight 必须是正数,实为 ${JSON.stringify(bed.perBedPerNight)}`);
    }
    const src = bed.source;
    if (!src || typeof src !== 'object') { problems.push(`${id}: 有床位价却没有 source(数字必须与出处配套)`); continue; }
    if (typeof src.source !== 'string' || !src.source.trim()) problems.push(`${id}: source.source 不能空`);
    if (typeof src.checkedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(src.checkedAt)) {
      problems.push(`${id}: source.checkedAt 必须是 YYYY-MM-DD`);
    }
    if (src.url !== undefined && !/^https:\/\//.test(String(src.url))) problems.push(`${id}: source.url 必须是 https`);
    if (src.sample !== undefined && (!Number.isInteger(src.sample) || src.sample < 1)) {
      problems.push(`${id}: source.sample 必须是 ≥1 的整数(样本太小的价不可信)`);
    }
  }
  assert.equal(problems.length, 0, `床位价有问题:\n   ${problems.join('\n   ')}`);
});

test('床位价写了就得"看起来像青旅":挡住把房价误填进床位价的静默翻倍', () => {
  // 区域房价量级 190-350,床位价量级 30-140。把房价填进 perBedPerNight 不会报错,
  // 只会让青旅估算静默翻两三倍——这类"填错位置"的错误必须靠数值区间才拦得住。
  const known = entries.filter(([, r]) => r.stay && r.stay.tiers && r.stay.tiers.青旅
    && r.stay.tiers.青旅.perBedPerNight != null);
  assert.ok(known.length >= 5, `库里只有 ${known.length} 个区域标了床位价,不该越写越少`);
  for (const [id, r] of known) {
    const bed = r.stay.tiers.青旅.perBedPerNight;
    assert.ok(bed <= 160, `${id} 床位价 ¥${bed} 偏高,不像青旅床位——是不是把房价填进来了?`);
  }
});

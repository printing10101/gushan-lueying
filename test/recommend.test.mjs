import { createRequire } from 'module';
const require = createRequire(new URL('../package.json', import.meta.url));
const store = require('./lib/store.js');
const { SCENERY, costPerPerson, costBreakdown, scoreTrail, rank, enrichWithTransport, hubTarget, stayCfgFor, regionStayMap } = require('./lib/recommend.js');
const test = require('node:test');
const assert = require('node:assert');

const CFG = { lodging: { perRoomPerNight: 200, peoplePerRoom: 2 }, food: { perPersonPerDay: 80 } };

const trail = (over = {}) => ({ name: '测试线', days: 7, status: '开放', scenery: [], ...over });

test('景色词表:非空、无重复', () => {
  assert.ok(SCENERY.length >= 10);
  assert.equal(new Set(SCENERY).size, SCENERY.length);
});

test('人均花费估算:口径透明可复算(房费均摊 + 餐标 + 门票)', () => {
  // 7 天:6 晚 × ¥200 ÷ 2 人 + 7 天 × ¥80 + 门票 ¥60 = 600 + 560 + 60
  assert.equal(costPerPerson({ days: 7, tickets: 60 }, CFG), 1220);
  // 门票未标注按 0 计,不允许 NaN
  assert.equal(costPerPerson({ days: 3 }, CFG), 2 * 200 / 2 + 3 * 80);
  // config 缺字段时用与 planner.stayBudget 相同的兜底值
  assert.equal(costPerPerson({ days: 2 }, {}), 1 * 200 / 2 + 2 * 80);
});

test('一日线住宿按 1 晚计(不再算 0 晚)', () => {
  // 1 天线人在景区附近过夜是实打实开支,算 0 晚会让入门者最常选的当日线系统性低估
  const bd = costBreakdown({ days: 1 }, CFG);
  assert.equal(bd.lodging, 200 / 2);
  assert.equal(bd.total, 200 / 2 + 80);
  // 多日线仍是 days-1 晚,口径不因这次修正而改动
  assert.equal(costBreakdown({ days: 7 }, CFG).lodging, 6 * 200 / 2);
  assert.equal(costBreakdown({ days: 3 }, CFG).lodging, 2 * 200 / 2);
  assert.equal(costBreakdown({ days: 2 }, CFG).lodging, 1 * 200 / 2);
});

test('门票未标注时 ticketsUnknown 为 true,不静默按 0', () => {
  assert.equal(costBreakdown({ days: 2 }, CFG).ticketsUnknown, true);
  assert.equal(costBreakdown({ days: 2, tickets: 0 }, CFG).ticketsUnknown, false);
  assert.equal(costBreakdown({ days: 2, tickets: 60 }, CFG).ticketsUnknown, false);
  // 未标注仍按 0 参与求和(不编造金额),但必须带标记让 UI 能言明
  assert.equal(costBreakdown({ days: 2 }, CFG).total, 100 + 160);
});

test('难度是硬闸门:gradeMax/gradeMin 之外一律不推', () => {
  const t = (g) => trail({ grade: g, scenery: ['雪山'] });
  assert.equal(scoreTrail(t(5), { gradeMax: 2 }, {}), null);
  assert.equal(scoreTrail(t(3), { gradeMax: 2 }, {}), null);
  assert.ok(scoreTrail(t(2), { gradeMax: 2 }, {}));
  assert.ok(scoreTrail(t(1), { gradeMax: 2 }, {}));
  assert.equal(scoreTrail(t(1), { gradeMin: 3 }, {}), null);
  assert.ok(scoreTrail(t(3), { gradeMin: 3 }, {}));
  // 缺省不传 = 不设限,接入前的老调用行为不变
  assert.ok(scoreTrail(t(5), {}, {}));
  assert.ok(scoreTrail(t(5), { gradeMin: null, gradeMax: null }, {}));
});

test('难度闸门优先于景色:★5 长线不能只因命中景色就混进入门候选', () => {
  const trails = {
    easy: { name: '轻松线', days: 1, grade: 1, status: '开放', scenery: ['雪山'] },
    hard: { name: '极限线', days: 7, grade: 5, status: '开放', scenery: ['雪山'] },
  };
  const gated = rank({ scenery: ['雪山'], gradeMax: 2, limit: 10 }, trails, CFG);
  assert.deepEqual(gated.map((r) => r.id), ['easy']);
  // 不设限时两条都在(与接入前一致)
  assert.equal(rank({ scenery: ['雪山'], limit: 10 }, trails, CFG).length, 2);
});

// difficultyGate 抽成纯函数就是为了锁住这个回归点:此前 main.js 里
// `{excludeIds, gradeMin, gradeMax, ...picked}` 的展开顺序让 picked.gradeMax=null
// 覆盖了体能上限,「未选难度时按体能自动收窄」静默失效——单测通过但功能是坏的。
test('difficultyGate:手选优先于自动,关掉联动则不设限', () => {
  const g = require('./lib/recommend.js').difficultyGate;
  // 前端「难度不限」传的是 null(不是 undefined),必须能回落到体能上限
  assert.deepEqual(g({ userPicked: null, ableCap: 2 }), { gradeMax: 2, auto: true });
  assert.deepEqual(g({ userPicked: undefined, ableCap: 3 }), { gradeMax: 3, auto: true });
  // 显式选档 → 用手选的,且不算自动收窄(否则 UI 会谎报"已按体能收窄")
  assert.deepEqual(g({ userPicked: 4, ableCap: 2 }), { gradeMax: 4, auto: false });
  // 关掉联动 → 不设限,且 auto 必须 false
  assert.deepEqual(g({ userPicked: null, useFitness: false, ableCap: 2 }), { gradeMax: null, auto: false });
  // 体能取不到 → 不设限,auto 为 false(不能声称收窄过)
  assert.deepEqual(g({ userPicked: null, ableCap: null }), { gradeMax: null, auto: false });
  // 0 是有限数字,必须被当成"手选★0"而不是"没填"
  assert.deepEqual(g({ userPicked: 0, ableCap: 3 }), { gradeMax: 0, auto: false });
  assert.deepEqual(g({}), { gradeMax: null, auto: false });
});

test('硬条件:禁入/关闭一律不推,超天数上限不推,管控不排除', () => {
  assert.equal(scoreTrail(trail({ status: '禁入' }), {}, {}), null);
  assert.equal(scoreTrail(trail({ status: '关闭' }), {}, {}), null);
  assert.equal(scoreTrail(trail({ days: 8 }), { maxDays: 7 }, {}), null);
  assert.ok(scoreTrail(trail({ days: 7 }), { maxDays: 7 }, {}));
  assert.ok(scoreTrail(trail({ status: '管控' }), {}, {}));
});

test('景色为主:命中标签越多得分越高,hits 只列命中的', () => {
  const want = ['雪山', '湖泊', '星空'];
  const both = scoreTrail(trail({ scenery: ['雪山', '湖泊'] }), { scenery: want }, {});
  const one = scoreTrail(trail({ scenery: ['雪山'] }), { scenery: want }, {});
  assert.deepEqual(both.hits, ['雪山', '湖泊']);
  assert.ok(both.score > one.score);
});

test('预算为辅:同景色命中时预算内排在超预算前,超预算金额如实标出', () => {
  const cheap = scoreTrail(trail({ days: 2, scenery: ['雪山'] }), { scenery: ['雪山'], budget: 1000 }, {});
  const dear = scoreTrail(trail({ days: 7, scenery: ['雪山'] }), { scenery: ['雪山'], budget: 1000 }, {});
  assert.ok(cheap.est < 1000 && dear.est > 1000);
  assert.ok(cheap.score > dear.score);
  assert.equal(dear.overBudget, dear.est - 1000);
});

test('没填预算给中立分;没选景色时按花费兜底排序且剔除禁入', () => {
  assert.equal(scoreTrail(trail(), {}, {}).score, 15); // 30(预算权重) × 0.5(中立)
  const ranked = rank({}, {
    b: trail({ days: 9 }), a: trail({ days: 3 }), c: trail({ days: 5, status: '禁入' }),
  });
  assert.deepEqual(ranked.map((r) => r.id), ['a', 'b']);
});

test('rank 输出结构完整且 limit 生效', () => {
  const trails = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`t${i}`, trail({ days: 3 + i })]));
  const out = rank({ budget: 5000, limit: 5 }, trails, CFG);
  assert.equal(out.length, 5);
  for (const r of out) {
    assert.ok(r.id && r.trail);
    assert.equal(typeof r.est, 'number');
    assert.equal(typeof r.score, 'number');
    assert.deepEqual(r.hits, []);
  }
});

test('真实路线库上可跑:不含禁入/关闭,景色命中优先于纯预算', () => {
  const trails = store.read('trails');
  const out = rank({ scenery: ['雪山', '湖泊'], budget: 1500 }, trails, {});
  assert.ok(out.length > 0 && out.length <= 12);
  for (const r of out) {
    assert.ok(!['禁入', '关闭'].includes(r.trail.status), `${r.id} 不应出现在推荐里`);
    assert.ok(r.trail.scenery.length, '有景色偏好时命中的线路必有标签');
  }
});

// ---------- 省份限定与排除走过 ----------

test('rank:province 硬过滤,excludeIds 剔除走过的', () => {
  const trails = {
    xj: trail({ name: '天山线', province: '新疆' }),
    sc: trail({ name: '贡嘎线', province: '四川' }),
  };
  assert.deepEqual(rank({ province: '新疆' }, trails, CFG).map((r) => r.id), ['xj']);
  assert.deepEqual(rank({ excludeIds: ['xj'] }, trails, CFG).map((r) => r.id), ['sc']);
  assert.deepEqual(rank({ province: '新疆', excludeIds: ['xj'] }, trails, CFG), []);
});

// ---------- 花费明细与往返大交通富化 ----------

test('costBreakdown:分项与总额一致,门票未标按 0', () => {
  // 7 天:6 晚 × ¥200 ÷ 2 人 + 7 天 × ¥80 + 门票 ¥60
  assert.deepEqual(costBreakdown({ days: 7, tickets: 60 }, CFG),
    { lodging: 600, food: 560, tickets: 60, ticketsUnknown: false, total: 1220 });
  assert.deepEqual(costBreakdown({ days: 3 }, CFG),
    { lodging: 200, food: 240, tickets: 0, ticketsUnknown: true, total: 440 });
  // 分项之和恒等于总额(新字段 ticketsUnknown 不参与求和,只是给 UI 的标记)
  const bd = costBreakdown({ days: 1, tickets: 55 }, CFG);
  assert.equal(bd.lodging + bd.food + bd.tickets, bd.total);
});

test('enrichWithTransport:estAll 含往返火车,超预算改按含交通口径重算', async () => {
  const scored = [
    { id: 'far', est: 1000, score: 60, hits: [], trail: trail({ regionId: 'xj' }) },
    { id: 'near', est: 500, score: 60, hits: [], trail: trail({ regionId: 'sc' }) },
  ];
  const regions = { xj: { hub: { railStation: '乌鲁木齐' } }, sc: { hub: { railStation: '成都东' } } };
  const out = await enrichWithTransport(scored, {
    originStation: '西安北', regions, budget: 1200,
    estimate: async (_from, to) => (to === '乌鲁木齐' ? { perPerson: 800, note: 'Z1 硬卧 去程价×2' } : null),
  });
  const byId = Object.fromEntries(out.map((r) => [r.id, r]));
  assert.equal(byId.far.estAll, 1800);
  assert.equal(byId.far.overBudget, 600); // 只看落地会误判为预算内
  assert.deepEqual(byId.far.transport, { hub: '乌鲁木齐', perPerson: 800, note: 'Z1 硬卧 去程价×2' });
  assert.equal(byId.near.estAll, 500); // 查不到价的保持未含口径
  assert.equal(byId.near.transport, null);
  assert.equal(byId.near.overBudget, 0);
});

test('enrichWithTransport:没接规划区域的线路不动,同分按含交通价排序', async () => {
  const scored = [
    { id: 'far', est: 1000, score: 60, hits: [], trail: trail({ regionId: 'xj' }) },
    { id: 'plain', est: 700, score: 60, hits: [], trail: trail({}) }, // 无 regionId
  ];
  const out = await enrichWithTransport(scored, {
    originStation: '西安北',
    regions: { xj: { hub: { railStation: '乌鲁木齐' } } },
    estimate: async () => ({ perPerson: 800, note: 'Z1 硬卧 去程价×2' }),
  });
  assert.deepEqual(out.map((r) => r.id), ['plain', 'far']); // plain estAll=700 < far estAll=1800
  assert.equal(out[0].transport, null);
});

test('hubTarget:枢纽站与坐标(取环线上与 hub.city 同名的节点),没接规划的返回 null', () => {
  const t = hubTarget({
    hub: { city: '成都', railStation: '成都东' },
    loop: [{ name: '映秀', lng: 103, lat: 31 }, { name: '成都', lng: 104, lat: 30.6 }],
  });
  assert.deepEqual(t, { hub: '成都东', xy: { lng: 104, lat: 30.6 } });
  assert.equal(hubTarget({ hub: { city: '成都', railStation: '成都东' }, loop: [] }).xy, null);
  assert.equal(hubTarget(undefined), null);
});

test('enrichWithTransport:预算分按含交通价重打,同落地价时交通便宜的分数更高', async () => {
  const scored = [
    { id: 'far', est: 1000, score: 99, hits: [], trail: trail({ regionId: 'xj' }) },
    { id: 'near', est: 1000, score: 99, hits: [], trail: trail({ regionId: 'sc' }) },
  ];
  const out = await enrichWithTransport(scored, {
    originStation: '西安北', budget: 1500, scenery: [],
    regions: { xj: { hub: { railStation: '乌鲁木齐' } }, sc: { hub: { railStation: '成都东' } } },
    estimate: async (_f, to) => (to === '乌鲁木齐' ? { perPerson: 800, note: 'x' } : { perPerson: 400, note: 'y' }),
  });
  const byId = Object.fromEntries(out.map((r) => [r.id, r]));
  assert.ok(byId.near.score > byId.far.score, '落地相同、交通更近的线应排前');
  assert.deepEqual(out.map((r) => r.id), ['near', 'far']);
});

test('enrichWithTransport:多个枢纽按 3 路并发查询,结果齐全', async () => {
  let inflight = 0, peak = 0;
  const scored = ['a', 'b', 'c', 'd'].map((id, i) => ({
    id, est: 100, score: 50, hits: [], trail: trail({ regionId: `r${i}` }),
  }));
  const regions = Object.fromEntries(['a', 'b', 'c', 'd'].map((id, i) =>
    [id === 'a' ? 'r0' : `r${i}`, { hub: { railStation: `站${i}` } }]));
  const out = await enrichWithTransport(scored, {
    originStation: '西安北', regions,
    estimate: async () => {
      inflight++; peak = Math.max(peak, inflight);
      await new Promise((r) => setTimeout(r, 5));
      inflight--;
      return { perPerson: 100, note: 'x' };
    },
  });
  assert.equal(out.length, 4);
  assert.ok(out.every((r) => r.transport && r.estAll === 200));
  assert.ok(peak <= 3, `并发峰值 ${peak} 应不超过 3`);
});

test('stayCfgFor/regionStayMap:区域基准字段级覆盖 config', () => {
  const region = { name: '川西小环线', stay: { perPersonPerDay: 90 } };
  const cfg = { lodging: { perRoomPerNight: 200, peoplePerRoom: 2 }, food: { perPersonPerDay: 80 } };
  const merged = stayCfgFor(cfg, region);
  assert.equal(merged.food.perPersonPerDay, 90); // 区域覆盖
  assert.equal(merged.lodging.perRoomPerNight, 200); // 未标注的字段回落 config
  assert.match(merged.note, /区域基准/);
  const fallback = stayCfgFor(cfg, { name: '伊犁环线' });
  assert.equal(fallback.lodging.perRoomPerNight, 200);
  assert.equal(fallback.note, undefined);
  assert.deepEqual(regionStayMap({ a: { stay: { perPersonPerDay: 90 } }, b: {} }),
    { a: { perPersonPerDay: 90 } });
  // costBreakdown 吃 regionStay 映射
  const bd = costBreakdown({ days: 2, regionId: 'a' }, { ...cfg, regionStay: { a: { perPersonPerDay: 90 } } });
  assert.equal(bd.food, 180);
});

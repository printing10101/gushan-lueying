import { createRequire } from 'module';
const require = createRequire(new URL('../package.json', import.meta.url));
const { ableGrade, matchTrail } = require('./lib/fitness.js');
const test = require('node:test');
const assert = require('node:assert');

// 通用身体状态夹具:覆盖大部分用例的"健康常模"底座,个别字段按用例覆盖
const baseState = {
  dataReady: true,
  endurance: { score: 62, label: '' },
  hill: { score: 55, label: '坡感良好' },
  status: { key: 'maintaining', label: '维持状态', detail: '' },
  readiness: { score: 72, verdict: '状态良好,正常训练' },
  form: 5,
  acwr: 1.05,
  todayAdvice: null,
};
const trail = (over = {}) => ({ name: '测试线', grade: 2, days: 1, maxAltM: 1500, ...over });

test('ableGrade:耐力锚定 + 爬坡微调,封顶 4 兜底 1', () => {
  assert.equal(ableGrade({ endurance: { score: 80 }, hill: { score: 50 } }), 4);
  assert.equal(ableGrade({ endurance: { score: 60 }, hill: { score: 50 } }), 3);
  assert.equal(ableGrade({ endurance: { score: 35 }, hill: { score: 50 } }), 2);
  assert.equal(ableGrade({ endurance: { score: 10 }, hill: { score: 50 } }), 1);
  // 山地型上浮 / 平路型下调
  assert.equal(ableGrade({ endurance: { score: 60 }, hill: { score: 80 } }), 4);
  assert.equal(ableGrade({ endurance: { score: 60 }, hill: { score: 20 } }), 2);
  // 封顶 ★4:极限长线不给自动放行;降档不跌破 ★1
  assert.equal(ableGrade({ endurance: { score: 95 }, hill: { score: 90 } }), 4);
  assert.equal(ableGrade({ endurance: { score: 35 }, hill: { score: 10 } }), 1);
  // 数据不足不给结论
  assert.equal(ableGrade({}), null);
  assert.equal(ableGrade({ endurance: {} }), null);
});

test('matchTrail:档位由 grade 与上限的差值决定', () => {
  // end 62 + hill 55 → 上限 3
  assert.equal(matchTrail(trail({ grade: 2 }), baseState).level, 'fit');
  assert.equal(matchTrail(trail({ grade: 3 }), baseState).level, 'stretch');
  assert.equal(matchTrail(trail({ grade: 5 }), baseState).level, 'over');
  assert.equal(matchTrail(trail({ grade: 3 }), baseState).cap, 3);
  // 主结论引用真实数字,不编
  const reasons = matchTrail(trail({ grade: 2 }), baseState).reasons.join(';');
  assert.ok(reasons.includes('耐力得分 62'));
  assert.ok(reasons.includes('爬坡「坡感良好」'));
});

test('matchTrail:负荷过高/训练中断/准备度低迷都把上限压一档', () => {
  const strained = { ...baseState, status: { key: 'strained', label: '负荷过高' }, acwr: 1.7 };
  const m = matchTrail(trail({ grade: 3 }), strained);
  assert.equal(m.level, 'over'); // 原本 stretch,压档后超纲
  assert.ok(m.reasons.join(';').includes('ACWR 1.7'));
  const detached = { ...baseState, status: { key: 'detached', label: '训练中断' } };
  assert.equal(matchTrail(trail({ grade: 3 }), detached).level, 'over');
  const low = { ...baseState, readiness: { score: 30, verdict: '疲劳积累' } };
  assert.equal(matchTrail(trail({ grade: 3 }), low).level, 'over');
});

test('matchTrail:降档有下限,状态再差 ★1 也只是有挑战', () => {
  const awful = {
    dataReady: true, endurance: { score: 5 }, hill: { score: 5 },
    status: { key: 'strained' }, acwr: 2, readiness: { score: 10, verdict: '' },
  };
  // 1 → strained 压到 0 → readiness 压到 -1 → 兜底回 1
  const m = matchTrail(trail({ grade: 1 }), awful);
  assert.equal(m.level, 'stretch');
  assert.equal(m.cap, 1);
});

test('matchTrail:恢复期硬线、今日档位、多日与海拔只提示不降档', () => {
  const state = {
    ...baseState,
    status: { key: 'recovering', label: '恢复中' },
    todayAdvice: { level: 'rest', verdict: '今天休息' },
  };
  const m = matchTrail(trail({ grade: 3, days: 4, maxAltM: 4300 }), state);
  assert.equal(m.level, 'stretch'); // 档位没动
  const text = m.notes.join(';');
  assert.ok(text.includes('恢复期'));
  assert.ok(text.includes('休息'));
  assert.ok(text.includes('连续 4 天'));
  assert.ok(text.includes('高反'));
  // 中海拔轻提示、低海拔无海拔提示
  assert.ok(matchTrail(trail({ maxAltM: 3200 }), baseState).notes.join(';').includes('留意高反'));
  assert.ok(!matchTrail(trail({ maxAltM: 1500 }), baseState).notes.some((n) => n.includes('高反')));
});

test('matchTrail:今日建议 easy 只提示多日线,单日线不打扰', () => {
  const state = { ...baseState, todayAdvice: { level: 'easy', verdict: '不宜上强度' } };
  assert.ok(matchTrail(trail({ days: 2 }), state).notes.join(';').includes('轻松活动'));
  assert.equal(matchTrail(trail({ days: 1 }), state).notes.length, 0);
});

test('matchTrail:form 低迷提示疲劳积累', () => {
  const m = matchTrail(trail(), { ...baseState, form: -20 });
  assert.ok(m.notes.some((n) => n.includes('疲劳')));
});

test('matchTrail:数据缺失一律 unknown,不编结论', () => {
  assert.equal(matchTrail(trail(), null).level, 'unknown');
  assert.equal(matchTrail(trail(), { dataReady: false }).level, 'unknown');
  // 有状态但没有耐力分 → 依旧不出结论
  assert.equal(matchTrail(trail(), { dataReady: true, status: baseState.status }).level, 'unknown');
});

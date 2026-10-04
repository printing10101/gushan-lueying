import { createRequire } from 'module';
const require = createRequire(new URL('../package.json', import.meta.url));
const { composeBodyState } = require('./lib/runos.js');
const test = require('node:test');
const assert = require('node:assert');

// fixture 字段名对照 RunOS 真实端点(routers/training_status.py、health.py、checkin.py、connections.py)
const trainingStatus = {
  daily: [], baselines: {},
  acute_7d: 800, chronic_weekly: 750, acwr: 1.1,
  fitness: 42, fatigue: 55, form: -13,
  monotony: {}, load_focus: {},
  recovery_time_h: 18,
  status: { key: 'maintaining', label: '维持状态', detail: '负荷与能力大体稳定' },
  readiness: { score: 72, components: [], verdict: '状态良好,正常训练' },
  endurance_score: { score: 62, label: '' },
  hill_score: { score: 55, label: '坡感良好', detail: '周均爬升 260m' },
  athlete: { name: '测试跑者', max_hr: 195, resting_hr: 54, hrv_baseline: 48 },
};
const metrics = {
  empty: false,
  metrics: [{
    date: '2026-10-02', weight_kg: null, resting_hr: 52, hrv_rmssd: null,
    sleep_hours: 6.5, body_fat_pct: null, sleep_score: 80, spo2: null,
    resp_rate: null, stress: 30, body_battery: 60, recovery_pct: 88,
    recovery_level: '', recovery_hours: 0,
  }],
  baseline: {},
};

const pad = (n) => String(n).padStart(2, '0');
// RunOS 的 last_sync_at 是不带时区的本地时间字符串,这里造同格式的时间
const daysAgoLocal = (days) => {
  const d = new Date(Date.now() - days * 864e5);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T`
    + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
const connections = {
  connections: [
    { platform: 'coros', last_sync_at: daysAgoLocal(5) },
    { platform: 'garmin', last_sync_at: daysAgoLocal(3) },
  ],
};

const trails = {
  easy1: { name: '休闲线', grade: 1, days: 1, maxAltM: 800 },
  hard1: { name: '硬线', grade: 4, days: 6, maxAltM: 4300 },
};

test('composeBodyState:字段映射 + 逐线匹配 + 新鲜度', () => {
  const s = composeBodyState({
    trainingStatus, metrics,
    checkin: { advice: { level: 'reduce', verdict: '客观信号联动降档' } },
    connections,
  }, trails);

  assert.equal(s.available, true);
  assert.equal(s.dataReady, true);
  assert.equal(s.status.key, 'maintaining');
  assert.equal(s.readiness.score, 72);
  assert.equal(s.acwr, 1.1);
  assert.equal(s.recoveryTimeH, 18);
  assert.equal(s.endurance.score, 62);
  assert.equal(s.todayAdvice.level, 'reduce');
  assert.equal(s.latest.resting_hr, 52);
  assert.equal(s.latest.recovery_pct, 88);
  // 同步时间取各平台最新的一个
  assert.equal(s.lastSyncAt, daysAgoLocal(3));
  assert.equal(s.staleDays, 3);
  // 每条线都有匹配结论:休闲线 fit,硬线带高反提示
  assert.equal(s.matches.easy1.level, 'fit');
  assert.equal(s.matches.hard1.level, 'over');
  assert.ok(s.matches.hard1.notes.join(';').includes('高反'));
});

test('composeBodyState:RunOS 无档案 → dataReady=false,不产出匹配', () => {
  const s = composeBodyState({
    trainingStatus: { empty: true }, metrics, checkin: null, connections: null,
  }, trails);
  assert.equal(s.available, true);
  assert.equal(s.dataReady, false);
  assert.ok(s.reason.includes('档案'));
  assert.deepEqual(Object.keys(s.matches), []);
});

test('composeBodyState:没有连接记录时新鲜度为空,不猜数字', () => {
  const s = composeBodyState({
    trainingStatus, metrics, checkin: null, connections: { connections: [] },
  }, trails);
  assert.equal(s.lastSyncAt, null);
  assert.equal(s.staleDays, null);
});

test('fetchBodyState:TTL 内复用缓存,force 绕过;网络失败也缓存但 force 可重试', async () => {
  const realFetch = globalThis.fetch;
  const runos = require('./lib/runos.js');
  let calls = 0;
  const payload = { trainingStatus: { empty: true }, metrics: {}, checkin: {}, connections: [] };
  try {
    globalThis.fetch = async () => { calls++; return { ok: true, json: async () => payload }; };
    await runos.fetchBodyState({}, {}, {});
    await runos.fetchBodyState({}, {});
    assert.equal(calls, 4, '第二轮应命中 TTL 缓存(每轮 4 个端点)');
    await runos.fetchBodyState({}, {}, { force: true });
    assert.equal(calls, 8, 'force 应绕过缓存');
    // 失败结果同样缓存:失败轮 4 次,再查不走网络,force 才重试
    globalThis.fetch = async () => { calls++; throw new Error('连接拒绝'); };
    const failed = await runos.fetchBodyState({}, {}, { force: true });
    assert.equal(failed.available, false);
    const before = calls;
    const again = await runos.fetchBodyState({}, {}, {});
    assert.equal(calls, before, '失败结果在 TTL 内不重打网络');
    assert.equal(again.available, false);
  } finally {
    globalThis.fetch = realFetch;
  }
});

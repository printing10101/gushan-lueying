// RunOS 联动:从本机 RunOS 服务(默认 http://127.0.0.1:8000)只读拉取近期身体状态,
// 交给 lib/fitness.js 算每条路线的匹配结论。不登录、不写库、不触发同步、不拉起对方进程。
// RunOS 未启动是设计内状态:返回 available=false 交 UI 展示,不抛错。

const fitness = require('./fitness');
const { httpFetch } = require('./http');

const BASE_DEFAULT = 'http://127.0.0.1:8000';
const TIMEOUT_MS = 4000;
const CACHE_TTL_MS = 10 * 60 * 1000; // 与 12306 查询同款低频纪律

async function getJson(base, path) {
  const res = await httpFetch(`${base}${path}`, { timeoutMs: TIMEOUT_MS });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// 各端点返回 → 给 UI 与匹配用的紧凑状态;纯函数,fixture 可单测。
// 字段名对照 RunOS 的 routers(training_status / health / checkin / connections)。
function composeBodyState({ trainingStatus, metrics, checkin, connections }, trails = {}) {
  if (!trainingStatus || trainingStatus.empty) {
    return {
      available: true, dataReady: false,
      reason: 'RunOS 已连接,但还没有运动档案或数据,先在 RunOS 里完善档案并同步',
      fetchedAt: new Date().toISOString(),
      matches: {},
    };
  }
  const rows = metrics?.metrics || [];
  const latest = rows.length ? rows[rows.length - 1] : null; // health/metrics 按日期升序返回
  const syncTimes = (connections?.connections || [])
    .map((c) => c.last_sync_at).filter(Boolean).sort();
  const lastSyncAt = syncTimes.length ? syncTimes[syncTimes.length - 1] : null;
  // last_sync_at 是不带时区的本地时间字符串(RunOS models.py 有言明),按本地时区解析后算滞后天数
  const staleDays = lastSyncAt
    ? Math.max(0, Math.floor((Date.now() - new Date(lastSyncAt).getTime()) / 864e5))
    : null;

  const state = {
    available: true,
    dataReady: true,
    fetchedAt: new Date().toISOString(),
    athlete: trainingStatus.athlete || null,
    status: trainingStatus.status || null,
    readiness: trainingStatus.readiness || null,
    fitness: trainingStatus.fitness ?? null,
    fatigue: trainingStatus.fatigue ?? null,
    form: trainingStatus.form ?? null,
    acwr: trainingStatus.acwr ?? null,
    recoveryTimeH: trainingStatus.recovery_time_h ?? null,
    endurance: trainingStatus.endurance_score || null,
    hill: trainingStatus.hill_score || null,
    todayAdvice: checkin?.advice?.level
      ? { level: checkin.advice.level, verdict: checkin.advice.verdict || '' }
      : null,
    latest: latest ? {
      date: latest.date,
      resting_hr: latest.resting_hr,
      hrv_rmssd: latest.hrv_rmssd,
      sleep_hours: latest.sleep_hours,
      stress: latest.stress,
      body_battery: latest.body_battery,
      recovery_pct: latest.recovery_pct,
    } : null,
    lastSyncAt,
    staleDays,
  };

  const matches = {};
  for (const [id, trail] of Object.entries(trails)) matches[id] = fitness.matchTrail(trail, state);
  return { ...state, matches };
}

let cache = null; // { expires, state }

async function fetchBodyState(cfg = {}, trails = {}, { force = false } = {}) {
  if (!force && cache && cache.expires > Date.now()) return cache.state;
  const base = String(cfg.runos?.baseUrl || BASE_DEFAULT).replace(/\/+$/, '');
  let state;
  try {
    const [trainingStatus, metrics, checkin, connections] = await Promise.all([
      getJson(base, '/api/training-status'),
      getJson(base, '/api/health/metrics?days=14'),
      getJson(base, '/api/checkin/today'),
      getJson(base, '/api/connections'),
    ]);
    state = composeBodyState({ trainingStatus, metrics, checkin, connections }, trails);
  } catch (e) {
    state = {
      available: false, dataReady: false,
      reason: `RunOS 未连接(${base} 无响应:${e.message})。启动 RunOS 后点「刷新」即可联动。`,
      fetchedAt: new Date().toISOString(),
      matches: {},
    };
  }
  cache = { expires: Date.now() + CACHE_TTL_MS, state };
  return state;
}

module.exports = { fetchBodyState, composeBodyState };

import { createRequire } from 'module';
const require = createRequire(new URL('../package.json', import.meta.url));
const { hikeVerdict } = require('./lib/weather.js');
const test = require('node:test');
const assert = require('node:assert');

test('hikeVerdict:晴天舒适', () => {
  assert.equal(hikeVerdict(10, 22, 8, 15), '宜');
});

test('hikeVerdict:降雨概率高判不宜', () => {
  assert.equal(hikeVerdict(80, 22, 8, 15), '不宜');
});

test('hikeVerdict:边界条件判观察', () => {
  assert.equal(hikeVerdict(50, 22, 8, 15), '观察');
  assert.equal(hikeVerdict(10, 32, 8, 15), '观察');
});

test('hikeVerdict:高温/严寒/大风判不宜', () => {
  assert.equal(hikeVerdict(10, 36, 8, 15), '不宜');
  assert.equal(hikeVerdict(10, 22, -12, 15), '不宜');
  assert.equal(hikeVerdict(10, 22, 8, 65), '不宜');
});

test('hikeVerdict:关键值缺失/NaN 判观察,不许静默滑向最宽松的宜', () => {
  assert.equal(hikeVerdict(10, null, 8, 15), '观察');
  assert.equal(hikeVerdict(10, NaN, 8, 15), '观察');
  assert.equal(hikeVerdict(10, 22, null, 15), '观察');
  assert.equal(hikeVerdict(null, 22, 8, 15), '观察');
  assert.equal(hikeVerdict(10, 22, 8, null), '观察');
});

// ---------- 预报点海拔透传(山顶气温折算用) ----------

test('forecast:附带你预报点海拔,坏值按 null', async () => {
  const daily = {
    time: ['2026-10-10', '2026-10-11'],
    weather_code: [0, 61],
    temperature_2m_max: [22, 18],
    temperature_2m_min: [8, 6],
    precipitation_probability_max: [10, 70],
    wind_speed_10m_max: [15, 30],
  };
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ elevation: 3200.4, daily }) });
    const { forecast } = require('./lib/weather.js');
    const days = await forecast(102, 31, 2);
    assert.equal(days[0].elevation, 3200);
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ daily }) });
    const noElev = await forecast(102, 31, 2);
    assert.equal(noElev[0].elevation, null);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('forecast:边缘日缺值不再按 0 兜底,判观察且温度为 null', async () => {
  const daily = {
    time: ['2026-10-10', '2026-10-11'],
    weather_code: [0, null],
    temperature_2m_max: [22, null],
    temperature_2m_min: [8, null],
    precipitation_probability_max: [10, null],
    wind_speed_10m_max: [15, null],
  };
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ elevation: 1000, daily }) });
    const { forecast } = require('./lib/weather.js');
    const days = await forecast(102, 31, 2);
    assert.equal(days[0].verdict, '宜');
    assert.equal(days[1].verdict, '观察'); // 缺值宁谨慎,不许最宽松
    assert.equal(days[1].tempMax, null);
    assert.equal(days[1].precipProb, null);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('forecast:坐标非法响亮报错,days 坏值收敛为 1 天', async () => {
  const { forecast } = require('./lib/weather.js');
  await assert.rejects(forecast(undefined, 31, 2), /坐标非法/);
  await assert.rejects(forecast(102, 'abc', 2), /坐标非法/);
  const realFetch = globalThis.fetch;
  try {
    let url = '';
    globalThis.fetch = async (u) => { url = String(u); return { ok: true, json: async () => ({ elevation: 0, daily: { time: ['2026-10-10'], weather_code: [0], temperature_2m_max: [20], temperature_2m_min: [10], precipitation_probability_max: [0], wind_speed_10m_max: [5] } }) }; };
    await forecast(102, 31, undefined);
    assert.match(url, /forecast_days=1/); // NaN 不上 URL
  } finally {
    globalThis.fetch = realFetch;
  }
});

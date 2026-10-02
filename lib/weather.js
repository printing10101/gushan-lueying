// 天气窗口:Open-Meteo 免 key、16 天预报。徒步宜否为粗判:降水概率 + 气温区间 + 风速。
const CODE_LABELS = {
  0: '晴', 1: '多云为主', 2: '多云', 3: '阴', 45: '雾', 48: '雾凇',
  51: '毛毛雨', 53: '毛毛雨', 55: '毛毛雨', 61: '小雨', 63: '中雨', 65: '大雨',
  66: '冻雨', 67: '冻雨', 71: '小雪', 73: '中雪', 75: '大雪', 77: '雪粒',
  80: '阵雨', 81: '阵雨', 82: '强阵雨', 85: '阵雪', 86: '阵雪',
  95: '雷雨', 96: '雷雨伴冰雹', 99: '雷雨伴冰雹',
};

function hikeVerdict(precipProb, tMax, tMin, windMax) {
  if (precipProb >= 70 || tMax >= 35 || tMin <= -10 || windMax >= 60) return '不宜';
  if (precipProb >= 40 || tMax >= 30 || windMax >= 40) return '观察';
  return '宜';
}

async function forecast(lng, lat, days) {
  const n = Math.min(Math.max(days, 1), 16);
  const url = 'https://api.open-meteo.com/v1/forecast' +
    `?latitude=${lat}&longitude=${lng}&timezone=Asia%2FShanghai&forecast_days=${n}` +
    '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max';
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo 天气查询失败: HTTP ${res.status}`);
  const json = await res.json();
  const d = json.daily;
  if (!d?.time?.length) throw new Error('Open-Meteo 返回缺少 daily 数据');
  return d.time.map((date, i) => {
    const precipProb = d.precipitation_probability_max[i] ?? 0;
    const tMax = d.temperature_2m_max[i];
    const tMin = d.temperature_2m_min[i];
    const windMax = d.wind_speed_10m_max[i] ?? 0;
    return {
      date,
      label: CODE_LABELS[d.weather_code[i]] || '未知',
      tempMin: Math.round(tMin), tempMax: Math.round(tMax),
      precipProb, windMax,
      verdict: hikeVerdict(precipProb, tMax, tMin, windMax),
    };
  });
}

module.exports = { forecast, hikeVerdict, CODE_LABELS };

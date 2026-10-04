// 天气窗口:Open-Meteo 免 key、16 天预报。徒步宜否为粗判:降水概率 + 气温区间 + 风速。
const { httpFetch } = require('./http');

const CODE_LABELS = {
  0: '晴', 1: '多云为主', 2: '多云', 3: '阴', 45: '雾', 48: '雾凇',
  51: '毛毛雨', 53: '毛毛雨', 55: '毛毛雨', 61: '小雨', 63: '中雨', 65: '大雨',
  66: '冻雨', 67: '冻雨', 71: '小雪', 73: '中雪', 75: '大雪', 77: '雪粒',
  80: '阵雨', 81: '阵雨', 82: '强阵雨', 85: '阵雪', 86: '阵雪',
  95: '雷雨', 96: '雷雨伴冰雹', 99: '雷雨伴冰雹',
};

function hikeVerdict(precipProb, tMax, tMin, windMax) {
  // 关键值缺失按「观察」:NaN/null 的比较恒为 false,会静默滑向最宽松的「宜」,方向不能反
  if ([precipProb, tMax, tMin, windMax].some((v) => !Number.isFinite(v))) return '观察';
  if (precipProb >= 70 || tMax >= 35 || tMin <= -10 || windMax >= 60) return '不宜';
  if (precipProb >= 40 || tMax >= 30 || windMax >= 40) return '观察';
  return '宜';
}

async function forecast(lng, lat, days) {
  if (!Number.isFinite(Number(lng)) || !Number.isFinite(Number(lat))) {
    throw new Error(`天气查询坐标非法: lng=${lng} lat=${lat}`);
  }
  // days 坏值(空/undefined)收敛为 1 天,而不是把 NaN 拼进 URL
  const n = Math.min(Math.max(Math.round(Number(days)) || 1, 1), 16);
  const url = 'https://api.open-meteo.com/v1/forecast' +
    `?latitude=${lat}&longitude=${lng}&timezone=Asia%2FShanghai&forecast_days=${n}` +
    '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max';
  const res = await httpFetch(url);
  if (!res.ok) throw new Error(`Open-Meteo 天气查询失败: HTTP ${res.status}`);
  let json;
  try { json = await res.json(); } catch { throw new Error(`Open-Meteo 返回非 JSON(HTTP ${res.status})`); }
  const d = json.daily;
  if (!d?.time?.length) throw new Error('Open-Meteo 返回缺少 daily 数据');
  // 预报点海拔:山顶气温按递减率折算时要用(预报点通常是山下镇子)
  const elevation = Number.isFinite(json.elevation) ? Math.round(json.elevation) : null;
  return d.time.map((date, i) => {
    // 边缘日缺值是常态:字段可能整个缺失或单日为 null,一律按缺值处理而不是猜 0
    const precipProb = d.precipitation_probability_max?.[i] ?? null;
    const tMax = d.temperature_2m_max?.[i] ?? null;
    const tMin = d.temperature_2m_min?.[i] ?? null;
    const windMax = d.wind_speed_10m_max?.[i] ?? null;
    return {
      date,
      label: CODE_LABELS[d.weather_code?.[i]] || '未知',
      tempMin: tMin == null ? null : Math.round(tMin),
      tempMax: tMax == null ? null : Math.round(tMax),
      precipProb, windMax,
      verdict: hikeVerdict(precipProb, tMax, tMin, windMax),
      elevation,
    };
  });
}

module.exports = { forecast, hikeVerdict };

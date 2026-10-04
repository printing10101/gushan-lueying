// 区域端到端冒烟:真实 12306 余票 + 真实 Open-Meteo 天气,拼装走真实 planner。
// 仅高德驾车距离用"直线×1.3"近似打桩(require 缓存补丁),因此没有高德 Key 也能验证区域数据
// 与行程拼装全链路;配好 Key 后跑 GUSHAN_MOCK_DRIVE=0 即是全真实链路。
// 用法:node scripts/smoke-region.mjs [regionId=chuanxi] [出发站=成都东] [日期=+7天] [天数=7] [trailId=自动]
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const planner = require('../lib/planner');
const amap = require('../lib/amap');

if (process.env.GUSHAN_MOCK_DRIVE === '0') {
  console.log('== 驾车段走真实高德 API ==');
} else {
  const R = 6371;
  const haversineKm = (a, b) => {
    const rad = (x) => (x * Math.PI) / 180;
    const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2
      + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  };
  amap.drivingRoute = async (from, to) => {
    const km = Math.round(haversineKm(from, to) * 1.3);
    return { distanceKm: km, durationHours: Math.round((km / 45) * 10) / 10, tolls: null, mocked: true };
  };
  console.log('== 驾车段为直线近似(GUSHAN_MOCK_DRIVE=0 用真实高德) ==');
}

const pad = (x) => String(x).padStart(2, '0');
const in7 = new Date(Date.now() + 7 * 864e5);
// 命令行传 "" 视为未提供,落默认值;出发站默认西安北(跨城查询才有意义,同站会被 planner 拒绝)
const [regionId = 'chuanxi', originStation = '西安北',
  startDate = `${in7.getFullYear()}-${pad(in7.getMonth() + 1)}-${pad(in7.getDate())}`,
  days = '7', trailId = null] = process.argv.slice(2).map((s) => (s === '' ? undefined : s));

const trip = await planner.generate({
  regionId, originStation, startDate, days: Number(days), headcount: 2, trailId,
});

console.log(`\n=== ${trip.regionName} · ${trip.input.days} 天 · ${trip.input.headcount} 人 ===`);
for (const d of trip.schedule) {
  const brief = d.type === 'drive'
    ? d.legs.map((l) => `${l.from}→${l.to} ${l.km}km/${l.hours}h`).join(' + ')
    : d.type === 'hike' ? `${d.info?.name || d.trail}${d.seasonWarn ? ` ⚠${d.seasonWarn}` : ''}`
    : d.text;
  console.log(`${d.date} [${d.type}] ${brief}`);
}
console.log(`去程:${trip.railOut.chosen ? `${trip.railOut.chosen.code} ${trip.railOut.chosen.startTime}` : '无可购车次'}`);
console.log(`回程:${trip.railBack.chosen ? `${trip.railBack.chosen.code} ${trip.railBack.chosen.startTime}` : '无可购车次'}`);
console.log(`天气基准点:${trip.weather.node},徒步日宜否:${trip.weather.forecast.map((w) => `${w.date.slice(5)}=${w.verdict}`).join(' ')}`);
console.log(`预算合计 ¥${trip.budget.total}(人均 ¥${trip.budget.perPerson},未知 ${trip.budget.unknownCount} 项)`);
console.log(`存档:${trip.savedTo}`);

// 冒烟必须有牙:输出正常但内容空壳(如预算 0、日程空)也算失败,exit 1
const problems = [];
if (!Array.isArray(trip.schedule) || trip.schedule.length < 3) problems.push(`日程异常(${trip.schedule?.length} 项)`);
if (!Number.isFinite(trip.budget.total) || trip.budget.total <= 0) problems.push(`预算合计异常(${trip.budget.total})`);
if (!trip.railOut || !trip.railBack) problems.push('往返火车数据缺失');
if (problems.length) {
  console.error(`冒烟失败: ${problems.join('; ')}`);
  process.exit(1);
}
console.log('冒烟通过 ✓');

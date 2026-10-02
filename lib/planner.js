// 行程拼装器:确定性逻辑(选线路、切分驾车日、算预算),LLM 不参与。
// 输入 { regionId, originStation, startDate, days, trailId } → 逐日安排 + 预算表 + 存档。
const store = require('./store');
const rail = require('./rail12306');
const amap = require('./amap');
const weather = require('./weather');

function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + n);
  // 用本地时间格式化,toISOString 会因时区偏移掉一天
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// 沿环线把中段天数切成驾车日/徒步日。纯函数,方便单测。
// loop: 环线节点数组(首尾都是枢纽);legs: 相邻节点里程(与 loop 逐一对应,含闭环最后一腿)。
// 返回的驾车日带 legIdx(当日覆盖的 legs 下标),generate 据此取真实路线与花费。
function planDays(loop, legs, trail, middleDays, maxDriveKm) {
  const days = [];
  let legIdx = [];
  let km = 0;
  let overKm = false;

  const closeDay = () => {
    const nodes = [legs[legIdx[0]].from, ...legIdx.map((i) => legs[i].to)];
    days.push({ type: 'drive', nodes, legIdx, km: Math.round(km), overKm });
    legIdx = [];
    km = 0;
    overKm = false;
  };

  for (let i = 0; i < legs.length; i++) {
    legIdx.push(i);
    km += legs[i].km;
    if (km > maxDriveKm) overKm = true;

    if (trail && legs[i].to === trail.node) {
      if (legIdx.length) closeDay();
      for (let h = 0; h < trail.days; h++) days.push({ type: 'hike', trail: trail.name, node: trail.node });
    } else if (i === legs.length - 1) {
      closeDay();
    } else if (km >= maxDriveKm) {
      closeDay();
    }
  }

  const driveDays = days.filter((d) => d.type === 'drive').length;
  if (driveDays > middleDays) {
    days.push({ type: 'note', text: `驾车中段需要 ${driveDays} 天,超出可用 ${middleDays} 天,行程偏紧:建议增加天数或减少环线节点` });
  }
  return days;
}

function pickTrail(trails, regionId, trailId, days) {
  const pool = Object.entries(trails)
    .map(([id, t]) => ({ id, ...t }))
    .filter((t) => t.regionId === regionId);
  if (trailId) {
    const hit = pool.find((t) => t.id === trailId);
    if (!hit) throw new Error(`线路 ${trailId} 不存在或不属于该区域`);
    return hit;
  }
  // 自动:去掉首尾火车日之后还放得下的最短线路
  return pool
    .filter((t) => t.days <= days - 2)
    .sort((a, b) => a.days - b.days)[0] || null;
}

async function railLeg(fromStation, toStation, date) {
  const { trains, stationNames } = await rail.queryTrains(fromStation, toStation, date);
  // 优先选还有二等座或硬座的列车,没有则取第一趟可购的
  const buyable = trains.filter((t) => t.canWebBuy);
  const chosen = buyable.find((t) => t.seats['二等座'] && t.seats['二等座'] !== '无')
    || buyable.find((t) => t.seats['硬座'] && t.seats['硬座'] !== '无')
    || buyable[0] || null;
  return {
    date, fromStation, toStation,
    chosen: chosen && {
      code: chosen.code, startTime: chosen.startTime, arriveTime: chosen.arriveTime,
      lishi: chosen.lishi, seats: chosen.seats,
    },
    prices: chosen?.prices || null, // 余票行内嵌票价;空则预算表明示"未知"
    evidence: { stationNames, queriedAt: new Date().toISOString(), trainCount: trains.length },
  };
}

async function generate(input) {
  const cfg = store.read('config');
  if (!cfg) throw new Error('缺少 data/config.json');
  const regions = store.read('regions');
  const region = regions[input.regionId];
  if (!region) throw new Error(`区域 ${input.regionId} 不存在,现有: ${Object.keys(regions).join('、')}`);
  const allTrails = store.read('trails') || {};
  const { days } = input;

  const trail = pickTrail(allTrails, input.regionId, input.trailId, days);
  if (input.trailId && !trail) throw new Error('找不到指定线路');

  // 环线相邻节点的真实驾车里程与路线(planDays 的输入,也是驾车日花费的来源)
  const loop = region.loop;
  const legs = [];
  for (let i = 0; i < loop.length - 1; i++) {
    const route = await amap.drivingRoute(loop[i], loop[i + 1]);
    legs.push({ from: loop[i].name, to: loop[i + 1].name, km: route.distanceKm, route });
  }

  const middleDays = days - 2 - (trail ? trail.days : 0);
  if (middleDays < 1) throw new Error(`天数太少:${days} 天去掉往返火车和 ${trail ? trail.days : 0} 天徒步后,没有驾车时间`);

  const dayPlan = planDays(loop, legs, trail, middleDays, cfg.maxDriveKmPerDay || 400);

  // 逐日安排 + 预算
  const budgetItems = [];
  const schedule = [];
  let ticketAdded = false;
  for (let d = 0; d < dayPlan.length; d++) {
    const day = dayPlan[d];
    const date = addDays(input.startDate, d + 1); // 第 0 天是出发火车日
    if (day.type === 'drive') {
      const dayLegs = day.legIdx.map((i) => {
        const leg = legs[i];
        const costs = amap.calcCosts(leg.km, leg.route.tolls, cfg.fuel);
        budgetItems.push({
          name: `自驾 ${leg.from}→${leg.to}`, amount: costs.driveTotal,
          note: `油费约${costs.fuel} + 过路费${costs.tolls}${costs.tollsEstimated ? '(估)' : ''}`,
        });
        return {
          from: leg.from, to: leg.to, km: Math.round(leg.km),
          hours: Math.round(leg.route.durationHours * 10) / 10, costs,
        };
      });
      schedule.push({ date, type: 'drive', nodes: day.nodes, legs: dayLegs, overKm: day.overKm });
    } else if (day.type === 'hike') {
      schedule.push({ date, type: 'hike', trail: day.trail, node: day.node, info: trail });
      if (!ticketAdded && trail) {
        ticketAdded = true;
        budgetItems.push({ name: `徒步费用 ${trail.name}`, amount: trail.tickets || 0, note: '来自线路库门票字段,观光车/马帮另计' });
      }
    } else {
      schedule.push({ date, type: 'note', text: day.text });
    }
  }
  if (dayPlan.filter((d) => d.type !== 'note').length !== days - 1) {
    schedule.push({ date: addDays(input.startDate, days - 1), type: 'note',
      text: '行程天数与输入天数不完全对齐,请适当增减天数' });
  }

  // 往返火车(第 0 天去程,最后一天回程)
  const railOut = await railLeg(input.originStation, region.hub.railStation, input.startDate);
  const backDate = addDays(input.startDate, days - 1);
  const railBack = await railLeg(region.hub.railStation, input.originStation, backDate);
  for (const [label, leg] of [['火车去程', railOut], ['火车回程', railBack]]) {
    const seat = leg.prices?.['二等座'] ?? leg.prices?.['硬座'] ?? Object.values(leg.prices || {})[0];
    budgetItems.unshift({
      name: label,
      amount: seat ?? null,
      note: leg.chosen ? `${leg.chosen.code}${seat === null ? ',票价字段缺失,请核对' : ''}` : '没有可购车次',
    });
  }

  // 天气窗口:以徒步节点(无徒步则环线第一个中途节点)为准
  const weatherNode = trail
    ? loop.find((n) => n.name === trail.node) || loop[1]
    : loop[1];
  const forecast = await weather.forecast(weatherNode.lng, weatherNode.lat, 16);

  const known = budgetItems.filter((b) => b.amount !== null);
  const total = known.reduce((s, b) => s + b.amount, 0);

  const tripId = input.startDate.replace(/-/g, '') + '-' + input.regionId;
  const trip = {
    id: tripId, input, regionName: region.name, trail, schedule, railOut, railBack,
    budget: { items: budgetItems, total, unknownCount: budgetItems.length - known.length },
    weather: { node: weatherNode.name, forecast },
    generatedAt: new Date().toISOString(),
  };
  store.write(`trips/${tripId}`, trip);
  return { savedTo: `data/trips/${tripId}.json`, ...trip };
}

module.exports = { generate, planDays, pickTrail, addDays };

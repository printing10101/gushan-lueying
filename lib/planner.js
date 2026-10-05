// 行程拼装器:确定性逻辑(选线路、切分驾车日、算预算),LLM 不参与。
// 输入 { regionId, originStation, startDate, days, headcount, trailId } → 逐日安排 + 预算表 + 存档。
const store = require('./store');
const rail = require('./rail12306');
const amap = require('./amap');
const weather = require('./weather');
const grading = require('./grading');
const fitness = require('./fitness');
const runos = require('./runos');
const gear = require('./gear');
const oilprice = require('./oilprice');
const recommend = require('./recommend');

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
// opts.restDays: 徒步块前插入的机动休整日数量(天气避让/高反适应),占用中段余量。
function planDays(loop, legs, trail, middleDays, maxDriveKm, opts = {}) {
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
    // 单条 leg 自身就超单日上限(如藏东南 然乌→拉萨 711km)时,先把当日已累积的 leg 冲掉,
    // 否则超长 leg 会和它前面的短 leg 堆成一天(实测曾把 381+711 堆成 962km)。
    // 修不了"单 leg 超上限"(一条路没法拆两天),但至少别再往上叠加。
    if (legs[i].km > maxDriveKm && legIdx.length) closeDay();
    legIdx.push(i);
    km += legs[i].km;
    if (km > maxDriveKm) overKm = true;

    if (trail && legs[i].to === trail.node) {
      if (legIdx.length) closeDay();
      for (let r = 0; r < (opts.restDays || 0); r++) days.push({ type: 'rest' });
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

// 徒步块天气评分:最差的一天说了算(1=不宜 2=观察 3=宜,null=没有徒步日)。
// 预报窗口外的日期记 -1,不会比已知天气"更好",避免拿未知当优化。
const VERDICT_RANK = { 不宜: 0, 观察: 1, 宜: 2 };
function hikeWeatherScore(dayPlan, forecast, startDate) {
  const rankOf = (date) => {
    const wx = (forecast || []).find((w) => w.date === date);
    return wx ? VERDICT_RANK[wx.verdict] ?? -1 : -1;
  };
  const hikeIdx = dayPlan.findIndex((d) => d.type === 'hike');
  if (hikeIdx < 0) return null;
  let worst = 2;
  for (let i = hikeIdx; i < dayPlan.length && dayPlan[i].type === 'hike'; i++) {
    worst = Math.min(worst, rankOf(addDays(startDate, i + 1)));
  }
  return worst;
}

// 徒步块前该插几个机动休整日(0 = 不动):在 slack 天余量内试插 1..k,
// 取让最差徒步日变最好的最小插数;没有余量或没有改进就返回 0,建议文案交给 UI。
// 纯函数,评分逻辑复用 hikeWeatherScore(前插 k 天 = 徒步下标整体 +k)。
function bestRestDays(dayPlan, forecast, startDate, slack) {
  const current = hikeWeatherScore(dayPlan, forecast, startDate);
  if (current == null || current >= 2) return 0; // 没有徒步日,或已经全宜,不动
  let bestK = 0;
  let bestScore = current;
  for (let k = 1; k <= slack; k++) {
    const padded = [...Array(k).fill({ type: 'drive' }), ...dayPlan];
    const score = hikeWeatherScore(padded, forecast, startDate);
    if (score > bestScore) { bestScore = score; bestK = k; }
  }
  return bestK;
}

// 高德 polyline("lng,lat;lng,lat;…")抽稀:驾车画线够用即可,存档不膨胀。
// 保留首尾,中间均匀取样;段数不多于 maxPoints 时原样返回。
function downsamplePolyline(str, maxPoints = 120) {
  const pts = String(str || '').split(';').filter((p) => /^[0-9.-]+,[0-9.-]+$/.test(p));
  if (pts.length <= maxPoints) return pts.join(';');
  const picked = [];
  for (let i = 0; i < maxPoints - 1; i++) {
    picked.push(pts[Math.round((i * (pts.length - 1)) / (maxPoints - 1))]);
  }
  picked.push(pts[pts.length - 1]);
  return picked.join(';');
}

function pickTrail(trails, regionId, trailId, days, prefs = {}) {
  const pool = Object.entries(trails)
    .map(([id, t]) => ({ id, ...t }))
    .filter((t) => t.regionId === regionId);
  if (trailId) {
    const hit = pool.find((t) => t.id === trailId);
    if (!hit) throw new Error(`线路 ${trailId} 不存在或不属于该区域`);
    return hit;
  }
  // 自动:禁入/关闭的一律不去;在此基础上先当季、再体能上限内、最后最短
  const { month, ableCap } = prefs;
  const candidates = pool.filter((t) =>
    t.status !== '禁入' && t.status !== '关闭' && t.days <= days - 2);
  const seasonOf = (t) => (Array.isArray(t.bestMonths) && t.bestMonths.length
    ? (t.bestMonths.includes(month) ? 0 : 1) // 未标注月份的不惩罚,按当季对待
    : 0.5);
  const fitOf = (t) => (Number.isFinite(ableCap) && t.grade > ableCap ? 1 : 0);
  return candidates.sort((a, b) =>
    seasonOf(a) - seasonOf(b) || fitOf(a) - fitOf(b)
    || a.days - b.days || a.name.localeCompare(b.name, 'zh'))[0] || null;
}

// 候选车次:主选打头,再补最多 4 趟可购车次。全部来自同一次余票查询,UI 切换零新增请求
function pickCandidates(chosen, buyable, max = 5) {
  return [chosen, ...buyable.filter((t) => t !== chosen)].filter(Boolean).slice(0, max);
}

function trainBrief(t) {
  return {
    code: t.code, startTime: t.startTime, arriveTime: t.arriveTime,
    lishi: t.lishi, seats: t.seats, prices: t.prices || null,
    // 坐席按历时口径选定(夜车优先卧铺),预算与展示共用,渲染端不再各算一遍
    seat: rail.pickSeat(t.prices, t.lishi),
  };
}

async function railLeg(fromStation, toStation, date) {
  const { trains, stationNames } = await rail.queryTrains(fromStation, toStation, date);
  const buyable = trains.filter((t) => t.canWebBuy);
  // 优先选首选坐席(按历时口径)仍有票的车次,没有则取第一趟有报价的
  const withSeat = buyable.map((t) => ({ t, seat: rail.pickSeat(t.prices, t.lishi) }))
    .filter((x) => x.seat);
  const seatOpen = (x) => {
    const v = x.t.seats[x.seat.label];
    return v && v !== '无';
  };
  const picked = withSeat.find(seatOpen) || withSeat[0] || null;
  return {
    date, fromStation, toStation,
    chosen: picked && picked.t,
    candidates: pickCandidates(picked?.t, buyable).map(trainBrief),
    seat: picked?.seat || null,
    // 空结果要先分清"真没车"还是"超出预售期",否则用户会误以为这条线不通
    presale: !picked && rail.beyondPresale(date),
    evidence: { stationNames, queriedAt: new Date().toISOString(), trainCount: trains.length },
  };
}

// 油价口径:取到当日分省实价就替换 config 价,备注言明来源;取不到保持 config 并言明。
// 纯函数,方便单测。
function fuelPlan(cfgFuel, oil) {
  if (oil) {
    return {
      fuel: { ...cfgFuel, pricePerL: oil.price },
      note: `${oil.type} 实价 ¥${oil.price}/L(金投 ${oil.updatedOn || '当日'})`,
    };
  }
  return { fuel: cfgFuel || {}, note: `油价按 config ¥${cfgFuel?.pricePerL ?? '?'}/L(未取到实价)` };
}

// 住宿与餐饮估算:口径透明(晚数×房间价×房间数 + 天数×餐标×人数),数值来自 config,
// 区域基准(region.stay)已由 stayCfgFor 合并进 cfg 并在 note 里言明
function stayBudget(days, headcount, cfg) {
  const perRoomPerNight = cfg.lodging?.perRoomPerNight ?? 200;
  const peoplePerRoom = cfg.lodging?.peoplePerRoom ?? 2;
  const perPersonPerDay = cfg.food?.perPersonPerDay ?? 80;
  const priced = cfg.note || ((cfg.lodging?.perRoomPerNight != null || cfg.food?.perPersonPerDay != null)
    ? '配置值' : '默认估算,config.json 可改');
  const rooms = Math.ceil(headcount / peoplePerRoom);
  const nights = Math.max(days - 1, 0);
  return [
    { name: `住宿 ${nights} 晚`, amount: nights * perRoomPerNight * rooms,
      note: `估算:${rooms} 间 × ¥${perRoomPerNight}/晚 × ${nights} 晚(${priced})` },
    { name: `餐饮 ${days} 天`, amount: days * perPersonPerDay * headcount,
      note: `估算:¥${perPersonPerDay}/人/天 × ${headcount} 人(${priced})` },
  ];
}

// 时刻取值:车次缺失或字段不可解析一律返回 null,绝不返回 0。
// 坑:Number(String(undefined || '').slice(0,2)) === 0,而 0 < 10 成立,
// 会把"回程没票"误判成"清晨发车",随后解引用 null.chosen 直接崩。
// 纯函数,方便单测。
function hourOf(time) {
  const s = String(time == null ? '' : time).trim().slice(0, 2);
  if (!/^\d{1,2}$/.test(s)) return null;
  const h = Number(s);
  return h >= 0 && h <= 23 ? h : null;
}

// 火车票按人头计:每人一票,预算合计随人数增长(此前只按 1 张计,多人出行合计失真)
function railBudgetItem(leg, label, headcount) {
  if (!leg.chosen) {
    return {
      name: label, amount: null,
      note: leg.presale ? '超出预售期(约 15 天),临近出发再查' : '没有可购车次',
    };
  }
  const seat = leg.seat;
  return {
    name: label,
    amount: seat ? seat.price * headcount : null,
    note: `${leg.chosen.code} ${seat ? seat.label : '票价字段缺失,请核对'}${headcount > 1 ? ` ×${headcount}人` : ''}`,
  };
}

function railBudgetItems(railOut, railBack, headcount) {
  return [railBudgetItem(railOut, '火车去程', headcount), railBudgetItem(railBack, '火车回程', headcount)];
}

// 门票同样按人头(此前只按 1 人计)
function hikeBudgetItem(trail, headcount) {
  const tickets = trail?.tickets ?? 0;
  return {
    name: `徒步费用 ${trail.name}`,
    amount: tickets * headcount,
    note: `来自线路库门票字段${headcount > 1 ? ` ×${headcount} 人` : ''},观光车/马帮另计`,
  };
}

async function generate(input) {
  const cfg = store.read('config');
  if (!cfg) throw new Error('缺少 data/config.json');
  const regions = store.read('regions');
  const region = regions[input.regionId];
  if (!region) throw new Error(`区域 ${input.regionId} 不存在,现有: ${Object.keys(regions).join('、')}`);
  // 同站查询(如默认表单没改)查出来的车次毫无意义,提前响亮报错而不是给出假行程
  if (input.originStation === region.hub.railStation) {
    throw new Error(`出发站(${input.originStation})与该区域枢纽站相同,请填你的真实出发站`);
  }
  const allTrails = store.read('trails') || {};
  const { days } = input;

  // 人数先收敛,预算与住宿估算全程用它;脏输入一律 ≥1
  const headcount = Math.max(1, Math.round(Number(input.headcount) || 1));
  input.headcount = headcount;

  // 自驾油费优先当日分省实价;区域没标省份或站点没取到,回退 config 并在备注言明
  const { fuel: fuelCfg, note: fuelNote } = fuelPlan(
    cfg.fuel,
    region.province ? await oilprice.forFuel(region.province, cfg.fuel?.gasType) : null,
  );

  // 自动选线口径:出发月份(当季优先)+ 当前体能上限(超上限的线自动绕开)
  // RunOS 没跑是设计内状态,拿不到上限就退化为"只看季节和天数",不影响生成
  let ableCap = null;
  try {
    const bodyState = await runos.fetchBodyState(cfg, allTrails, {});
    if (bodyState?.dataReady) ableCap = fitness.ableGrade(bodyState);
  } catch { /* 联动失败不挡规划 */ }
  const month = Number(String(input.startDate).slice(5, 7));

  const trail = pickTrail(allTrails, input.regionId, input.trailId, days, { month, ableCap });
  if (input.trailId && !trail) throw new Error('找不到指定线路');

  // 环线相邻节点的真实驾车里程与路线(planDays 的输入,也是驾车日花费/画线的来源)
  const loop = region.loop;
  const legs = [];
  for (let i = 0; i < loop.length - 1; i++) {
    const route = await amap.drivingRoute(loop[i], loop[i + 1]);
    legs.push({ from: loop[i].name, to: loop[i + 1].name, km: route.distanceKm, route });
  }

  const middleDays = days - 2 - (trail ? trail.days : 0);
  if (middleDays < 1) throw new Error(`天数太少:${days} 天去掉往返火车和 ${trail ? trail.days : 0} 天徒步后,没有驾车时间`);

  const maxDriveKm = cfg.maxDriveKmPerDay || 400;
  const prePlan = planDays(loop, legs, trail, middleDays, maxDriveKm);

  // 天气先行:徒步日择优需要先知道宜否,再决定要不要插机动休整日。
  // 以徒步节点(无徒步则环线第一个中途节点)为基准点。
  const weatherNode = trail
    ? loop.find((n) => n.name === trail.node) || loop[1]
    : loop[1];
  const forecast = await weather.forecast(weatherNode.lng, weatherNode.lat, 16);

  // 机动余量 = 对齐天数 - 已用天数;有余量且插日能让最差徒步日变好时才插
  const usedDays = prePlan.filter((d) => d.type !== 'note').length;
  const slack = Math.max(0, days - 1 - usedDays);
  const restDays = trail ? bestRestDays(prePlan, forecast, input.startDate, slack) : 0;
  const dayPlan = restDays > 0
    ? planDays(loop, legs, trail, middleDays, maxDriveKm, { restDays })
    : prePlan;

  // 逐日安排 + 预算
  const budgetItems = [];
  const schedule = [];
  let ticketAdded = false;
  let fuelNoteAdded = false; // 油价口径只在首个驾车日言明,免得每段路都重复一遍
  for (let d = 0; d < dayPlan.length; d++) {
    const day = dayPlan[d];
    const date = addDays(input.startDate, d + 1); // 第 0 天是出发火车日
    if (day.type === 'drive') {
      const dayLegs = day.legIdx.map((i) => {
        const leg = legs[i];
        const costs = amap.calcCosts(leg.km, leg.route.tolls, fuelCfg);
        budgetItems.push({
          name: `自驾 ${leg.from}→${leg.to}`, amount: costs.driveTotal,
          note: `油费约${costs.fuel} + 过路费${costs.tolls}${costs.tollsEstimated ? '(估)' : ''}${fuelNoteAdded ? '' : `,${fuelNote}`}`,
        });
        fuelNoteAdded = true;
        return {
          from: leg.from, to: leg.to, km: Math.round(leg.km),
          hours: Math.round(leg.route.durationHours * 10) / 10, costs,
          // 抽稀后的真实路线画线用;存档体积可控(每段 ≤120 点)
          ...(leg.route.path ? { path: downsamplePolyline(leg.route.path) } : {}),
        };
      });
      schedule.push({ date, type: 'drive', nodes: day.nodes, legs: dayLegs, overKm: day.overKm });
    } else if (day.type === 'hike') {
      schedule.push({ date, type: 'hike', trail: day.trail, node: day.node, info: grading.describe(trail) });
      if (!ticketAdded && trail) {
        ticketAdded = true;
        budgetItems.push(hikeBudgetItem(trail, headcount));
      }
    } else if (day.type === 'rest') {
      schedule.push({ date, type: 'rest' });
    } else {
      schedule.push({ date, type: 'note', text: day.text });
    }
  }
  if (dayPlan.filter((d) => d.type !== 'note').length !== days - 1) {
    schedule.push({ date: addDays(input.startDate, days - 1), type: 'note',
      text: '行程天数与输入天数不完全对齐,请适当增减天数' });
  }

  // 错季提醒:仅在数据标注了结构化 bestMonths 时检查,没标注不猜
  const hikeDay = schedule.find((d) => d.type === 'hike');
  if (hikeDay && Array.isArray(trail.bestMonths) && trail.bestMonths.length) {
    const monthOfHike = Number(hikeDay.date.slice(5, 7));
    if (!trail.bestMonths.includes(monthOfHike)) {
      hikeDay.seasonWarn = `${monthOfHike} 月不在最佳月份(${trail.bestMonths.join('、')} 月)内,风景和路况可能打折`;
    }
  }

  // 往返火车(第 0 天去程,最后一天回程)
  const railOut = await railLeg(input.originStation, region.hub.railStation, input.startDate);
  const backDate = addDays(input.startDate, days - 1);
  const railBack = await railLeg(region.hub.railStation, input.originStation, backDate);
  budgetItems.unshift(...railBudgetItems(railOut, railBack, headcount));

  // 时刻衔接校验:去程太晚到(≥15 点)首日赶不了多少路,回程太早发(<10 点)末日不敢排长驾
  // 用 hourOf 显式判空:回程无票时 chosen 为 null,不能进分支再去解引用
  const arriveHour = hourOf(railOut.chosen?.arriveTime);
  if (arriveHour !== null && arriveHour >= 15) {
    const first = schedule.find((d) => d.type === 'drive' || d.type === 'hike');
    if (first) first.lateArrival = { time: railOut.chosen.arriveTime, station: region.hub.railStation };
  }
  const departHour = hourOf(railBack.chosen?.startTime);
  if (departHour !== null && departHour < 10) {
    const lastDrive = [...schedule].reverse().find((d) => d.type === 'drive');
    if (lastDrive) lastDrive.earlyDepart = { time: railBack.chosen.startTime };
  }

  // 住宿与餐饮估算(在火车/自驾/门票之后追加);region.stay 的区域基准覆盖 config 全局口径
  budgetItems.push(...stayBudget(days, headcount, recommend.stayCfgFor(cfg, region)));

  const known = budgetItems.filter((b) => b.amount !== null);
  const total = known.reduce((s, b) => s + b.amount, 0);

  // 行前装备清单:线路字段 + 徒步日天气(山顶体感/最大降水)确定性推导,随存档保存
  let tripGear = [];
  if (trail) {
    const wxByDate = new Map(forecast.map((w) => [w.date, w]));
    let summitMin = null;
    let maxHikePrecip = null;
    for (const d of schedule.filter((x) => x.type === 'hike')) {
      const wx = wxByDate.get(d.date);
      if (!wx) continue;
      maxHikePrecip = maxHikePrecip == null ? wx.precipProb : Math.max(maxHikePrecip, wx.precipProb);
      const st = gear.summitTemp(wx.tempMin, wx.elevation, trail.maxAltM);
      if (st != null && (summitMin == null || st < summitMin)) summitMin = st;
    }
    tripGear = gear.gearChecklist(trail, { summitMin, maxHikePrecip });
  }

  const tripId = input.startDate.replace(/-/g, '') + '-' + input.regionId;
  const trip = {
    id: tripId, input, regionName: region.name, trail, schedule, railOut, railBack,
    gear: tripGear,
    budget: {
      items: budgetItems, total, headcount,
      perPerson: Math.round(total / headcount),
      unknownCount: budgetItems.length - known.length,
    },
    weather: { node: weatherNode.name, forecast },
    generatedAt: new Date().toISOString(),
  };
  store.write(`trips/${tripId}`, trip);
  return { savedTo: `data/trips/${tripId}.json`, ...trip };
}

module.exports = {
  generate, planDays, pickTrail, addDays, stayBudget, pickCandidates,
  railBudgetItems, hikeBudgetItem, downsamplePolyline, bestRestDays, hikeWeatherScore, fuelPlan,
  hourOf,
};

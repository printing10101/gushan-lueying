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
const costModel = require('./budget');
const routing = require('./routing');

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
// 徒步线归一:单个对象或数组都收,统一成数组(旧的调用点不用改)
function normalizeTrails(trail) {
  if (!trail) return [];
  return (Array.isArray(trail) ? trail : [trail]).filter(Boolean);
}

function planDays(loop, legs, trail, middleDays, maxDriveKm, opts = {}) {
  const trails = normalizeTrails(trail);
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

  // 徒步块:多条线各自插在自己的节点位置。休整日只在**第一块**徒步前插一次
  // (那是给高反适应/天气避让用的机动余量,不是每条线都配一份)。
  let restPending = opts.restDays || 0;
  const hikeBlock = (t) => {
    for (let r = 0; r < restPending; r++) days.push({ type: 'rest' });
    restPending = 0;
    for (let h = 0; h < t.days; h++) days.push({ type: 'hike', trail: t.name, node: t.node });
  };
  const nodeNames = new Set(loop.map((n) => n.name));
  for (const t of trails) {
    if (!nodeNames.has(t.node)) {
      throw new Error(`线路「${t.name}」的徒步节点 ${t.node} 不在该区域环线上,无法排进行程`);
    }
  }

  // 徒步起点就是环线第 0 站(枢纽)时,徒步块必须排在驾车**之前**。
  // 环线的最后一腿闭环回到 loop[0],所以旧写法只在 `legs[i].to === trail.node` 的最后一刻
  // 才插徒步:实测 jingxi + 香八拉 排出「先绕完 515km 全程、再开始走一天」,而且整圈堆成
  // 一天还超单日上限。这类线本来就是从枢纽当天往返的入门线(香八拉/鹫峰/云蒙山×2/箭扣/
  // 大觉寺—阳台山 + 藏东南 甘丹寺—桑耶寺/楚布寺—羊八井,共 8 条),落地当天就该走。
  const hikeFirst = trails.filter((t) => t.node === loop[0]?.name);
  const hikeOnLoop = trails.filter((t) => t.node !== loop[0]?.name);
  for (const t of hikeFirst) hikeBlock(t);

  for (let i = 0; i < legs.length; i++) {
    // 前瞻切分:当天已有路、且加上这一段会把当天顶过上限时,先收当天,下一段另起一天。
    // 旧写法是"加完再看是否超"——实测 jingxi 五段 81+77+103+132+122 会整圈塞成一天 515km:
    // 第 4 段前累积只有 393(未到上限)所以不切,最后一腿又走的是"收尾"分支,515 就这么长出来了。
    // 例外:这一段自己就超上限(如藏东南 然乌→拉萨 711km)时,先冲掉当天、再让它独占一天,
    // 修不了"单 leg 超上限"(一条路拆不成两天),但至少别再往上叠加。
    if (legs[i].km > maxDriveKm) {
      if (legIdx.length) closeDay();
    } else if (legIdx.length && km + legs[i].km > maxDriveKm) {
      closeDay();
    }
    legIdx.push(i);
    km += legs[i].km;
    // 只有"这一段自己就超上限"才会让单日超限——算法拆不动的才标,能拆的不该标
    if (km > maxDriveKm) overKm = true;

    // 走到某条徒步线的节点就把它排进去;闭环最后一腿的 to 也是 loop[0],
    // 而起点在枢纽的线路已经在最前面排过了,这里只处理"环上节点"的那些。
    const here = hikeOnLoop.filter((t) => t.node === legs[i].to);
    if (here.length) {
      if (legIdx.length) closeDay();
      for (const t of here) hikeBlock(t);
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

// 余量天数:天数够用但排不满时,把剩下的补成**机动日**而不是留一句"天数不对齐"。
// 真实的行程本来就要留缓冲(天气、路况、体力),补成机动日比虚报一天驾车诚实,
// 也让天数守恒这条不变量重新成立。pure:由 generate 调用,单测直接喂天数。
function fillSpareDays(dayPlan, days) {
  const used = dayPlan.filter((d) => d.type !== 'note').length;
  const spare = days - 1 - used;
  if (spare <= 0) return dayPlan;
  const out = dayPlan.filter((d) => d.type !== 'note');
  for (let i = 0; i < spare; i++) {
    out.push({ type: 'rest', spare: true });
  }
  return out;
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

// 环线逐段的里程来源。有高德 Key 走真实驾车路线;没 Key 用「直线 × 1.3」估算,
// 并由调用方把口径写进预算备注与页面提示。
//
// 只兜「没配 Key」这一种确定的情况:坏坐标、配额超限、网络失败照原样抛出——
// 估算不能替真故障遮丑,否则 regions.json 填错坐标会静默变成一条像模像样的假里程。
// (README 一直写着"没 Key 时按 haversine×1.3 估算",但那条兜底此前只活在
// scripts/smoke-region.mjs 的 monkey patch 里,app 内实跑是必抛的。)
// 逐段里程来源交给 lib/routing.js:高德 / 腾讯 / 直线估算三选一(规则见那个文件)。
// routeFn 与 provider 都能注入,单测据此不碰网络。
async function buildLegs(loop, opts = {}) {
  const provider = opts.provider || routing.activeProvider(opts.cfg || {});
  const routeFn = opts.routeFn || ((from, to) => routing.drivingRoute(from, to, provider));
  const legs = [];
  for (let i = 0; i < loop.length - 1; i++) {
    const from = loop[i];
    const to = loop[i + 1];
    const route = await routeFn(from, to);
    legs.push({
      from: from.name, to: to.name, km: route.distanceKm, route,
      estimated: Boolean(route.estimated),
      // 疑似路网绕行:真实里程远超两点直线距离。实测 派镇→墨脱 直线 50km、路网绕成
      // 1890km(186 段路/37 小时)——不是"有条一天能开完的路",而是那条近路在路网里不通。
      // 不提示的话,用户会以为真有一条 1890km 的路要开。
      ...detourInfo(route, from, to),
    });
  }
  return { legs, estimated: legs.some((l) => l.estimated), provider };
}

// 绕行判据:真实/直线 > 8 倍且直线 > 10km(短腿的比值噪声大,不判)
const DETOUR_RATIO = 8;
const DETOUR_MIN_STRAIGHT_KM = 10;
function detourInfo(route, from, to) {
  if (!route || route.estimated || !Number.isFinite(route.distanceKm)) return {};
  if (!from || !to || !Number.isFinite(Number(from.lng)) || !Number.isFinite(Number(from.lat))) return {};
  const straight = amap.haversineKm(
    { lng: Number(from.lng), lat: Number(from.lat) },
    { lng: Number(to.lng), lat: Number(to.lat) },
  );
  if (straight < DETOUR_MIN_STRAIGHT_KM) return {};
  const ratio = route.distanceKm / straight;
  if (ratio <= DETOUR_RATIO) return {};
  return { detour: { straightKm: Math.round(straight * 10) / 10, ratio: Math.round(ratio) } };
}

// 里程/过路费的口径文案(纯函数,单测钉住;页面与导出都吃它)。
// 腾讯不返回过路费字段,所以那一档必须自己说清"过路费仍是估的"——不能让人以为是实价。
function routeNote(provider) {
  if (provider === 'tencent') return '里程、时长与过路费来自腾讯真实驾车路线';
  if (provider === 'amap') return '里程与过路费来自高德真实驾车路线';
  return '里程为直线×1.3 估算(未配高德/腾讯 Key),只是量级参考,既可能高估也可能低估';
}
// 自动选线为空时的可执行提示:说清"为什么放不下"并给出最少要给几天。
// 纯函数,单测直接钉文案里的数字。
function noTrailHint(trails, regionId, days) {
  const pool = Object.values(trails || {}).filter((t) => t.regionId === regionId);
  if (!pool.length) {
    return `该区域还没有接入任何徒步线路(线路库需标注 regionId 与环线节点);`
      + '可改选其他区域,或先去路线库看未接入的线路';
  }
  const open = pool.filter((t) => t.status !== '禁入' && t.status !== '关闭');
  if (!open.length) {
    return `该区域 ${pool.length} 条线路当前都是禁入/关闭状态,没有能走的线`;
  }
  const min = Math.min(...open.map((t) => t.days));
  return `${regionId} 区放不下任何线路:该区域 ${open.length} 条可选线路里最短的一条要走 ${min} 天,`
    + `加上往返火车至少需要 ${min + 2} 天(当前 ${days} 天)`
    + (pool.length > open.length ? `;另有 ${pool.length - open.length} 条禁入/关闭不计入` : '');
}

// 多选版:先把显式指定的那些挑出来(按用户给的顺序),自动补齐到"能排下的最短线"仍然只挑一条。
// 为什么不做"自动凑满":凑满等于替用户决定他要走几条线,那是产品判断,不是算法该偷偷做的。
function pickTrails(trails, regionId, trailIds, days, prefs = {}) {
  const ids = (Array.isArray(trailIds) ? trailIds : [trailIds]).filter(Boolean);
  if (!ids.length) {
    const auto = pickTrail(trails, regionId, null, days, prefs);
    return auto ? [auto] : [];
  }
  const pool = Object.entries(trails).map(([id, t]) => ({ id, ...t })).filter((t) => t.regionId === regionId);
  const out = [];
  for (const id of ids) {
    const hit = pool.find((t) => t.id === id);
    if (!hit) throw new Error(`线路 ${id} 不存在或不属于该区域`);
    if (!out.some((x) => x.id === hit.id)) out.push(hit);
  }
  const need = out.reduce((n, t) => n + t.days, 0);
  if (need > days - 2) {
    throw new Error(`选中的 ${out.length} 条线路要 ${need} 天,加上往返火车至少要 ${need + 2} 天(当前 ${days} 天)`);
  }
  return out;
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

// 空车次结果复核前的等待:限频/风控常常是瞬时的,隔一下再问一次能区分
// 「真的没车」和「被挡了」。取 1.5 秒是权衡——再长会明显拖慢生成,再短对瞬时抖动的
// 恢复概率没有帮助。复核只在**空结果**时发生,正常路径零额外请求。
const RAIL_EMPTY_RETRY_MS = 1500;

async function railLeg(fromStation, toStation, date) {
  let trains = [];
  let stationNames = {};
  let error = null;
  let retried = false;
  let emptyResult = false;
  try {
    let r = await rail.queryTrains(fromStation, toStation, date);
    // 预售期外必然是空,不必复核;预售期内却是空,就大概率是瞬时被挡——
    // 这是实测踩过的坑:同一趟「西安北→北京西 2026-10-20」当时判成"没有可购车次",
    // 预算退化成占位估算,而同一查询另一时刻返回 40 趟车 / 35 趟可购。
    if (!r.trains.length && !rail.beyondPresale(date)) {
      retried = true;
      await new Promise((res) => setTimeout(res, RAIL_EMPTY_RETRY_MS));
      r = await rail.queryTrains(fromStation, toStation, date, { force: true });
    }
    trains = r.trains;
    stationNames = r.stationNames;
    emptyResult = Boolean(r.emptyResult) && !r.trains.length;
  } catch (e) {
    // 查询失败 ≠ 没有车次。旧写法让异常一路抛到界面,整条行程都出不来;
    // 现在记下来:预算项填占位价、页面明说是"取价失败",用户仍拿得到完整行程。
    error = e.message;
  }
  const buyable = trains.filter((t) => t.canWebBuy);
  // 挑哪趟车与哪个坐席:口径只有一份(lib/seat.js 的 pickBuyableTrain,经 rail 转发),
  // 与推荐页的往返估算同源。此前这里手抄了一份,注释还写着"与 planner.railLeg 一致"——
  // 那正是分家的开始:一侧改了夜车优先卧铺,另一侧还在推硬座。
  const picked = rail.pickEstimateTrain(trains);
  return {
    date, fromStation, toStation,
    chosen: picked && picked.t,
    candidates: pickCandidates(picked?.t, buyable).map(trainBrief),
    seat: picked?.seat || null,
    // 空结果要先分清"真没车"还是"超出预售期";有 error 时不谈预售期,那是另一回事
    presale: !picked && !error && rail.beyondPresale(date),
    // 复核过仍为空:不再断言"没有可购车次"——它与"被挡了"无法完全区分,
    // 页面据此改说"未查到,请手动复核"(下同 railBudgetItem 的文案)
    retried,
    error,
    evidence: { stationNames, queriedAt: new Date().toISOString(), trainCount: trains.length, retried, emptyResult },
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

// 住宿与餐饮估算(**合计**口径),公式一律走 lib/budget.js——这里只负责两件行程语义:
// 晚数 = 天数 - 1(行程表住几晚),季节系数 = 按出发日期与该区域命中的那一档。
// 档次默认「客栈」(基准 ×1.0);可由 input.tier 指定——行程页有档次控件后用户能选青旅。
// 档名与 lib/budget.js 的 TIER_FACTORS 对应(旧名「舒适」等价于客栈,别名兼容在那边)。
// **青旅按床位计价**:stayCfgFor 会传 perBedPerNight,见 budget.stayCost 的两种计价单位。
// 返回结构与旧版 stayBudget 一致({name, amount, note}),预算表其余代码不用改。
function stayBudget({ days, headcount, startDate, regionId, cfg, tier = '客栈' }) {
  const season = costModel.seasonFactors(startDate, regionId, cfg?.seasonality || {});
  const tail = season.notes.length ? `,${season.notes.join(';')}` : '';
  // 口径来源**逐项**取:由 recommend.stayCfgFor 按字段算好(lodging.basis / food.basis)。
  // 曾共用一个 priced —— 区域基准是字段级覆盖,只标了餐标时住宿的来源其实是 config
  // 或代码默认值,说成"含区域基准"会让用户以为那个数是他自己标过的。
  // || 后面那段是给"直接传原始 config"的调用方(单测)兜底,不依赖调用方一定传 basis。
  const fallbackBasis = (hasCfgVal) => (hasCfgVal ? '配置值' : '默认估算,config.json 可改');
  const lodgingBasis = cfg?.lodging?.basis || fallbackBasis(cfg?.lodging?.perRoomPerNight != null);
  const foodBasis = cfg?.food?.basis || fallbackBasis(cfg?.food?.perPersonPerDay != null);
  const items = [
    costModel.stayCost({
      nights: costModel.tripNights(days),
      headcount,
      perRoomPerNight: cfg?.lodging?.perRoomPerNight ?? costModel.DEFAULT_PER_ROOM_PER_NIGHT,
      perBedPerNight: cfg?.lodging?.perBedPerNight ?? null,
      peoplePerRoom: cfg?.lodging?.peoplePerRoom ?? 2,
      // stayCfgFor 取到绝对价/床位价时会显式给 tierFactor=1;直接用,免得再乘一遍打两次折
      tierFactor: cfg?.lodging?.tierFactor ?? costModel.tierFactorOf(tier, cfg?.lodging?.tierFactors),
      tierLabel: tier,
      seasonFactor: season.lodging,
      seasonFrom: season.lodgingFrom,
      basisNote: lodgingBasis,
    }),
    costModel.foodCost({
      days,
      headcount,
      perPersonPerDay: cfg?.food?.perPersonPerDay ?? costModel.DEFAULT_PER_PERSON_PER_DAY,
      seasonFactor: season.food,
      seasonFrom: season.foodFrom,
      basisNote: foodBasis,
    }),
  ];
  return items.map((it) => ({
    name: it.name,
    amount: it.amount,
    band: it.key === 'food' ? costModel.BUDGET_BANDS.food : costModel.BUDGET_BANDS.lodging,
    note: `${it.note}${tail}`,
  }));
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
//
// 没查到可购车次时**不再让预算留空洞**:能拿到往返实价估算就填一个"占位价"并说明口径。
// 四种情况要分清(混在一起用户会以为"这条线不通"):
//   presale  = 超出预售期,过些天再查就有
//   error    = 接口失败(实测 12306 会连续 20 分钟返回非 JSON)/网络问题,不是没车
//   复核过仍空 = 隔开重发过一次还是空。**不能断言"没有可购车次"**——
//               它与"被限频挡了"在响应上无法区分(实测踩过:同一查询另一时刻有 40 趟车)
//   其余      = 没有可购车次
function railBudgetItem(leg, label, headcount, fallback = null) {
  if (!leg.chosen) {
    const why = leg.error ? `取价失败(${leg.error})`
      : leg.presale ? '超出预售期(约 15 天)'
        : leg.retried ? '未查到可购车次(已隔开复核一次仍为空,无法排除接口被限频;临近出发请手动复核)'
          : '没有可购车次';
    if (fallback && Number.isFinite(fallback.perPerson)) {
      const oneWay = Math.round(fallback.perPerson / 2);
      return {
        name: label,
        amount: oneWay * headcount,
        band: costModel.BUDGET_BANDS.railEstimate, // 占位估算,比实价票更不确定
        note: `占位估算:${why},按往返 ¥${fallback.perPerson}/人 ÷ 2 × ${headcount} 人;${fallback.note || ''}出发前请复核`,
      };
    }
    return { name: label, amount: null, band: 0, note: `${why},且没取到可用的占位估算` };
  }
  const seat = leg.seat;
  return {
    name: label,
    amount: seat ? seat.price * headcount : null,
    band: costModel.BUDGET_BANDS.railActual, // 12306 实价,不参与浮动
    note: `${leg.chosen.code} ${seat ? seat.label : '票价字段缺失,请核对'}${headcount > 1 ? ` ×${headcount}人` : ''}`,
  };
}

function railBudgetItems(railOut, railBack, headcount, fallback = null) {
  return [
    railBudgetItem(railOut, '火车去程', headcount, fallback),
    railBudgetItem(railBack, '火车回程', headcount, fallback),
  ];
}

// 门票同样按人头(此前只按 1 人计)
function hikeBudgetItem(trail, headcount) {
  // 注意:不写 `?? 0`——未标注 ≠ 不要钱。曾经这里按 0 算并声称"来自线路库门票字段",
  // 而 budget.ticketItem(推荐页那条路径)是如实返回"未标注"的:同一件事两条口径,
  // 行程页会把"没查过"的线路显示成 ¥0(等于告诉用户这段免费)。
  // 2026-10-08 清掉 59 条无出处的 0 之后,这个不一致就藏不住了。
  const tickets = trail?.tickets;
  const src = trail?.ticketSource;
  const srcNote = src ? `(来源:${src.source || ''}${src.checkedAt ? ` ${src.checkedAt} 核对` : ''})` : '';
  if (tickets == null) {
    return {
      name: `徒步费用 ${trail.name}`,
      amount: null,
      band: costModel.BUDGET_BANDS.tickets,
      note: '线路库未标注门票,不计入合计(不是 0 元)——出发前自行核实;观光车/马帮另计',
    };
  }
  return {
    name: `徒步费用 ${trail.name}`,
    amount: tickets * headcount,
    band: costModel.BUDGET_BANDS.tickets,
    note: `来自线路库门票字段${headcount > 1 ? ` ×${headcount} 人` : ''}${srcNote},观光车/马帮另计`,
  };
}

// 逐日天气锚点:驾车日锚在**当天最后一个节点**,徒步日锚在徒步节点。
// 为什么不能只用一个锚点:藏东南 然乌→拉萨 单日 711km,车和人在不同的地方穿行,
// 用徒步点的预报去标驾车日的天气,chip 跟当天所在位置对不上。纯函数,方便单测。
function dayAnchors(schedule, trailNode) {
  const out = [];
  for (const day of schedule || []) {
    if (day.type === 'drive' && day.legs && day.legs.length) {
      out.push({ date: day.date, node: day.legs[day.legs.length - 1].to });
    } else if (day.type === 'hike') {
      const node = day.node || trailNode; // 多线串联时每条线各锚各的节点
      if (node) out.push({ date: day.date, node });
    }
  }
  return out;
}

// 多点预报 → { 日期: {…该日预报, at: 锚点名} }。取不到的点/日直接不出条目,
// 由调用方回退到单点口径并说明,不拿别的点的天气凑数。
function forecastsByDate(anchors, many) {
  const byName = new Map((many || []).map((m) => [m.name, new Map(m.forecast.map((f) => [f.date, f]))]));
  const out = {};
  for (const { date, node } of anchors || []) {
    const wx = byName.get(node)?.get(date);
    if (wx) out[date] = { ...wx, at: node };
  }
  return out;
}

// 存档 id:同条件重生成视为「刷新」,覆盖自己;换了线路或人数就是另一份行程,必须另开一档。
// 此前 id 只由「日期+区域」决定,同日期同区域的两个方案互相冲掉——从档案打开旧行程、
// 改条件重新生成,上一版就无声消失了(而且用户以为档案里还留着)。
// lookup 注入(读盘由调用方给),方便单测不碰文件系统。
function tripIdFor({ base, input, lookup }) {
  const sameConditions = (t) => Boolean(t)
    && (t.input?.trailId ?? null) === (input.trailId ?? null)
    && t.input?.days === input.days
    && t.input?.headcount === input.headcount;
  let id = base;
  let prev = lookup(id);
  if (!prev || sameConditions(prev)) return id;
  for (let n = 2; n < 100; n++) {
    id = `${base}-${n}`;
    prev = lookup(id);
    if (!prev || sameConditions(prev)) return id;
  }
  return `${base}-${Date.now()}`; // 同一天 99 份变体不现实,真到这一步按时间戳另开
}

// 行程输入的硬校验(纯函数,便于单测)。
//
// 为什么 generate 自己要再校验一遍:界面已经校验过,但 `trip:generate` 是直接对渲染层
// 开放的 IPC,校验不能只活在界面里。实测后果:
//   addDays('') → "NaN-NaN-NaN";而 days=NaN 时 `middleDays < 1` 因 NaN 比较恒为 false
//   **不触发拦截**,流程一路往下走并 store.write 落盘一份日期/天数错乱的存档,
//   之后它还会污染「行程档案」列表(排序用的是 startDate 字符串)。
// 日期格式判据复用 budget.validDate(不建 Date 对象,避开时区那一坑)。
const TRIP_DAYS_MIN = 3;
const TRIP_DAYS_MAX = 20;

function validateTripInput(input = {}) {
  const errs = [];
  if (!costModel.validDate(input.startDate)) {
    errs.push(`出发日期非法:${JSON.stringify(input.startDate)}(应为 YYYY-MM-DD,月份 01-12、日 01-31)`);
  }
  const days = Number(input.days);
  if (!Number.isInteger(days) || days < TRIP_DAYS_MIN || days > TRIP_DAYS_MAX) {
    errs.push(`行程天数非法:${JSON.stringify(input.days)}(应为 ${TRIP_DAYS_MIN}-${TRIP_DAYS_MAX} 的整数)`);
  }
  if (!input.originStation || !String(input.originStation).trim()) errs.push('出发站为空');
  return errs.length ? errs : null;
}

async function generate(input) {
  const bad = validateTripInput(input);
  if (bad) throw new Error(`行程输入不合法:${bad.join(';')}`);
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

  const pickedTrails = pickTrails(allTrails, input.regionId, input.trailIds ?? input.trailId, days, { month, ableCap });
  const trail = pickedTrails[0] || null; // 第一条作为"主线路"(地图标记/导出标题用)
  const trailsPlanned = pickedTrails;
  // 自动选线选空不再静默往下走:以前会生成一张"全是驾车日、一个徒步日都没有"的行程,
  // 标题还挂着区域名,预算里也没有徒步费用项——用户看不出这条行程根本没线路(实测 zangdongnan 3 天)。
  if (!trail) throw new Error(noTrailHint(allTrails, input.regionId, days));

  // 环线相邻节点的驾车里程与路线(planDays 的输入,也是驾车日花费/画线的来源)
  // 没配高德 Key 时走直线估算,口径由 kmNote 全程言明
  const loop = region.loop;
  const { legs, estimated: kmEstimated, provider: routeProvider } = await buildLegs(loop, { cfg });
  const kmNote = routeNote(routeProvider);

  const middleDays = days - 2 - trailsPlanned.reduce((n, t) => n + t.days, 0);
  if (middleDays < 1) {
    const hikeDays = trailsPlanned.reduce((n, t) => n + t.days, 0);
    const names = trailsPlanned.map((t) => t.name).join(' + ');
    throw new Error(`天数太少:${days} 天去掉往返火车和 ${hikeDays} 天徒步(${names})后,没有驾车时间:请加天数或减线路`);
  }

  const maxDriveKm = cfg.maxDriveKmPerDay || 400;
  const prePlan = planDays(loop, legs, trailsPlanned, middleDays, maxDriveKm);

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
    ? planDays(loop, legs, trailsPlanned, middleDays, maxDriveKm, { restDays })
    : prePlan;

  // 逐日安排 + 预算。余量天数补成机动日:真实行程本来就要留缓冲,
  // 比虚报一天驾车诚实,也让"天数守恒"这条不变量重新成立(旧版会挂一句"天数不完全对齐")
  const filledPlan = fillSpareDays(dayPlan, days);
  const budgetItems = [];
  const schedule = [];
  const ticketed = new Set();
  let fuelNoteAdded = false; // 油价口径只在首个驾车日言明,免得每段路都重复一遍
  let kmNoteAdded = false; // 里程口径同上
  for (let d = 0; d < filledPlan.length; d++) {
    const day = filledPlan[d];
    const date = addDays(input.startDate, d + 1); // 第 0 天是出发火车日
    if (day.type === 'drive') {
      const dayLegs = day.legIdx.map((i) => {
        const leg = legs[i];
        const costs = amap.calcCosts(leg.km, leg.route.tolls, fuelCfg);
        budgetItems.push({
          name: `自驾 ${leg.from}→${leg.to}`, amount: costs.driveTotal,
          // 里程是真实的(腾讯/高德路网),误差主要来自油耗口径与实际路况;过路费若是估的已标"(估)"
          band: costModel.BUDGET_BANDS.fuel,
          note: `油费约${costs.fuel} + 过路费${costs.tolls}${costs.tollsEstimated ? '(估)' : ''}${fuelNoteAdded ? '' : `,${fuelNote}`}${kmNoteAdded ? '' : `,${kmNote}`}`,
        });
        fuelNoteAdded = true;
        kmNoteAdded = true;
        return {
          from: leg.from, to: leg.to, km: Math.round(leg.km),
          hours: Math.round(leg.route.durationHours * 10) / 10, costs,
          // 估算里程要在逐日卡片上说明:画线和预算都跟着口径走
          ...(leg.estimated ? { estimated: true } : {}),
          // 疑似绕行也要带进日程:不然只有 budgets 层知道,卡片上看不见
          ...(leg.detour ? { detour: leg.detour } : {}),
          // 抽稀后的真实路线画线用;存档体积可控(每段 ≤120 点)
          ...(leg.route.path ? { path: downsamplePolyline(leg.route.path) } : {}),
        };
      });
      schedule.push({ date, type: 'drive', nodes: day.nodes, legs: dayLegs, overKm: day.overKm });
    } else if (day.type === 'hike') {
      const t = trailsPlanned.find((x) => x.name === day.trail) || trail;
      schedule.push({ date, type: 'hike', trail: day.trail, node: day.node, info: grading.describe(t) });
      if (t && !ticketed.has(t.id)) {
        ticketed.add(t.id);
        budgetItems.push(hikeBudgetItem(t, headcount));
      }
    } else if (day.type === 'rest') {
      schedule.push({ date, type: 'rest', spare: Boolean(day.spare) });
    } else {
      schedule.push({ date, type: 'note', text: day.text });
    }
  }
  // 只数"真排了内容的日"(note 是提示不是安排):补完机动日之后应当恰好对齐,
  // 不齐说明是排太多(偏紧),那种情况上面已经挂了偏紧提示,这里不重复刷第二条
  const realDays = schedule.filter((d) => d.type !== 'note').length;
  if (realDays !== days - 1) {
    schedule.push({ date: addDays(input.startDate, days - 1), type: 'note',
      text: `行程排出 ${realDays} 天,与输入的 ${days} 天不一致:请增减天数或调整线路` });
  }

  // 错季提醒:仅在数据标注了结构化 bestMonths 时检查,没标注不猜
  for (const hikeDay of schedule.filter((d) => d.type === 'hike')) {
    const t = trailsPlanned.find((x) => x.name === hikeDay.trail);
    if (!t || !Array.isArray(t.bestMonths) || !t.bestMonths.length) continue;
    const monthOfHike = Number(hikeDay.date.slice(5, 7));
    if (!t.bestMonths.includes(monthOfHike)) {
      hikeDay.seasonWarn = `${monthOfHike} 月不在最佳月份(${t.bestMonths.join('、')} 月)内,风景和路况可能打折`;
    }
  }

  // 往返火车(第 0 天去程,最后一天回程)
  const railOut = await railLeg(input.originStation, region.hub.railStation, input.startDate);
  const backDate = addDays(input.startDate, days - 1);
  const railBack = await railLeg(region.hub.railStation, input.originStation, backDate);
  // 有一程没查到可购车次(预售期外/接口失败/真没车)时,拿推荐页那套往返估算当占位价,
  // 让预算不至于留一个空洞。估算本身也要打 12306,失败就算了(railFallback 保持 null)。
  let railFallback = null;
  if (!railOut.chosen || !railBack.chosen) {
    try {
      const target = recommend.hubTarget(region);
      railFallback = await rail.estimateRoundTrip(input.originStation, region.hub.railStation, target?.xy || null);
    } catch { railFallback = null; }
  }
  budgetItems.unshift(...railBudgetItems(railOut, railBack, headcount, railFallback));
  // 页面要说清"为什么票价是估算的":接口失败与预售期外是两件事,别让用户以为这条线不通
  const railNote = (railOut.error || railBack.error)
    ? `12306 取价失败(${railOut.error || railBack.error}),票价用占位估算,出发前请复核`
    : (!railOut.chosen || !railBack.chosen) && railFallback
      ? '有车次未查到,票价用占位估算(非实时),出发前请复核' : null;

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

  // 住宿与餐饮估算(在火车/自驾/门票之后追加);region.stay 的区域基准覆盖 config 全局口径,
  // 季节表(seasonality.json)按出发日期与该区域取命中档
  const stayCfg = {
    ...recommend.stayCfgFor(cfg, region, input.tier),
    seasonality: store.read('seasonality') || {},
  };
  budgetItems.push(...stayBudget({
    days, headcount, startDate: input.startDate, regionId: input.regionId, cfg: stayCfg, tier: input.tier,
  }));

  // 汇总走与渲染层同一个函数(budget.budgetRollup):生成时与换车次时口径不可能分家
  const rollup = costModel.budgetRollup(budgetItems, headcount);

  // 行前装备清单:线路字段 + 徒步日天气(山顶体感/最大降水)确定性推导,随存档保存
  const tripGear = [];
  const seenGear = new Set();
  const wxByDate = new Map(forecast.map((w) => [w.date, w]));
  for (const t of trailsPlanned) {
    // 山顶体感按每条线自己的最高海拔折算;天气沿用徒步日窗口(同一条行程共用一份预报)
    let summitMin = null;
    let maxHikePrecip = null;
    let daylightHours = null; // 徒步日里最短的那天:那一天早晚最需要照明
    for (const d of schedule.filter((x) => x.type === 'hike' && x.trail === t.name)) {
      const wx = wxByDate.get(d.date);
      if (!wx) continue;
      maxHikePrecip = maxHikePrecip == null ? wx.precipProb : Math.max(maxHikePrecip, wx.precipProb);
      const st = gear.summitTemp(wx.tempMin, wx.elevation, t.maxAltM);
      if (st != null && (summitMin == null || st < summitMin)) summitMin = st;
      const dl = gear.daylightPlan(wx);
      if (dl && (daylightHours == null || dl.hours < daylightHours)) daylightHours = dl.hours;
    }
    for (const it of gear.gearChecklist(t, { summitMin, maxHikePrecip, daylightHours })) {
      if (seenGear.has(it.item)) continue;
      seenGear.add(it.item);
      tripGear.push(it);
    }
  }

  // 逐日天气:再把"每天所在节点"的预报取回来(一次请求带多组经纬度)。
  // 取不到就退回单点口径并说明——单点预报此刻已经在手,不让这次富化失败拖垮整条行程。
  const anchors = dayAnchors(schedule, trail ? trail.node : null);
  const anchorNames = [...new Set(anchors.map((a) => a.node))];
  const anchorNodes = anchorNames.map((nm) => loop.find((n) => n.name === nm)).filter(Boolean);
  let byDate = {};
  let byDateError = null;
  if (anchorNodes.length) {
    try {
      const many = await weather.forecastMany(
        anchorNodes.map((n) => ({ name: n.name, lng: n.lng, lat: n.lat })), 16);
      byDate = forecastsByDate(anchors, many);
    } catch (e) {
      byDateError = e.message;
    }
  }

  const baseId = input.startDate.replace(/-/g, '') + '-' + input.regionId;
  // 换线路/换天数就另开一档,不冲掉同日期同区域的上一版
  const tripId = tripIdFor({ base: baseId, input, lookup: (id) => store.read(`trips/${id}`) });
  const trip = {
    id: tripId, input, regionName: region.name, trail, trails: trailsPlanned, schedule, railOut, railBack,
    gear: tripGear,
    budget: {
      // 汇总字段(total/perPerson/unknownCount/range)一律来自 budgetRollup,不进字面量:
      // 字面量里各算一份,就是"换车次时漏算 range"那类分家的温床。
      items: budgetItems, headcount, ...rollup,
    },
    weather: { node: weatherNode.name, forecast, byDate, byDateError },
    railNote, // 票价为什么是占位估算(接口失败 / 未查到车次);null = 票价来自实时查询
    kmNote, // 里程/过路费口径文案(见 routeNote):存档自带,页面与导出不必各写一份
    distanceEstimated: kmEstimated, // true = 全程里程为直线估算(未配任何路线 Key)
    routeProvider, // amap / tencent / estimate —— 页面与导出据此说清里程来源
    generatedAt: new Date().toISOString(),
  };
  store.write(`trips/${tripId}`, trip);
  return { savedTo: `data/trips/${tripId}.json`, ...trip };
}

module.exports = {
  generate, planDays, pickTrail, addDays, stayBudget, pickCandidates,
  railBudgetItems, railBudgetItem, railLeg, hikeBudgetItem, downsamplePolyline, bestRestDays, hikeWeatherScore, fuelPlan,
  hourOf, buildLegs, noTrailHint, tripIdFor, dayAnchors, forecastsByDate, pickTrails, fillSpareDays, routeNote,
  detourInfo, DETOUR_RATIO, DETOUR_MIN_STRAIGHT_KM, RAIL_EMPTY_RETRY_MS,
  validateTripInput, TRIP_DAYS_MIN, TRIP_DAYS_MAX,
};

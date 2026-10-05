// 智能推荐:在路线库里按「想看的景色 + 人均预算(+天数上限)」做确定性打分,LLM 不参与。
// 落地花费只是口径透明的估算;填了出发站时由 enrichWithTransport 补往返火车实价估算,
// 生成行程后的分项实价仍以行程规划为准。纯函数,trails/cfg 由调用方(main 进程)传入,方便单测。

// 景色词表:trails.json 的 scenery 字段只能取这里的值(test/trails-data.test.mjs 把关);
// 渲染进程的筛选 chips 与此表保持一致(渲染进程拿不到 require)。
const SCENERY = [
  '雪山', '冰川', '湖泊', '云海', '星空', '森林', '草原', '峡谷', '溪瀑',
  '花海', '梯田', '秋色', '冰雪', '沙漠戈壁', '丹霞雅丹', '海岸海岛', '古道人文', '温泉',
  '峰林田园',
];

// 人均落地花费明细:住宿(房费均摊)+ 餐饮 + 门票,口径与 planner.stayBudget 一致
// (未标注门票按 0 计并在 ticketsUnknown 标记,卡片言明而非静默低估);重装露营/马帮/观光车等
// 特殊花费不计入,避免编造。
// cfg.regionStay: { regionId: { perRoomPerNight, perPersonPerDay } } 区域基准,覆盖 config 全局口径。
//
// 住宿晚数口径:多日线 nights = days - 1(最后一晚住在终点/返回);一天线按 1 晚计——
// 1 天徒步人在景区附近过夜是实打实的开支,算 0 晚会让当日往返/当日走完的线系统性低估
// (实测阿布吉措曾估 ¥90、实际住宿+餐费至少 ¥290),而这类线恰恰是入门者最常选的。
function costBreakdown(trail, cfg = {}) {
  const stay = cfg.regionStay?.[trail.regionId] || {};
  const perRoomPerNight = stay.perRoomPerNight ?? cfg.lodging?.perRoomPerNight ?? 200;
  const peoplePerRoom = cfg.lodging?.peoplePerRoom ?? 2;
  const perPersonPerDay = stay.perPersonPerDay ?? cfg.food?.perPersonPerDay ?? 80;
  const nights = trail.days <= 1 ? 1 : Math.max(trail.days - 1, 0);
  const lodging = Math.round(nights * perRoomPerNight / peoplePerRoom);
  const food = trail.days * perPersonPerDay;
  const ticketsUnknown = trail.tickets == null;
  const tickets = trail.tickets || 0;
  return { lodging, food, tickets, ticketsUnknown, total: lodging + food + tickets };
}

// 区域库 → regionStay 映射(推荐打分与渲染层卡片共用一个入口)
function regionStayMap(regions = {}) {
  const map = {};
  for (const [id, r] of Object.entries(regions)) if (r.stay) map[id] = r.stay;
  return map;
}

// 单区域的有效吃住口径:region.stay 覆盖 config,字段级覆盖(只标一项就只覆盖一项)。
// planner 的 stayBudget 用;note 言明口径来源,备注里给用户看。
function stayCfgFor(cfg = {}, region = null) {
  const stay = region?.stay || {};
  return {
    lodging: {
      perRoomPerNight: stay.perRoomPerNight ?? cfg.lodging?.perRoomPerNight ?? 200,
      peoplePerRoom: cfg.lodging?.peoplePerRoom ?? 2,
    },
    food: { perPersonPerDay: stay.perPersonPerDay ?? cfg.food?.perPersonPerDay ?? 80 },
    note: (stay.perRoomPerNight != null || stay.perPersonPerDay != null)
      ? `含区域基准(${region.name})` : undefined,
  };
}

function costPerPerson(trail, cfg = {}) {
  return costBreakdown(trail, cfg).total;
}

// 打分公式:景色命中为主(70)、预算余裕为辅(30)。
// 落地粗排与含交通重打分共用同一公式,只是带入的花费不同。
function scoreOf(hitsLen, sceneryLen, est, budget) {
  const sceneryScore = sceneryLen ? hitsLen / sceneryLen : 0;
  let budgetScore = 0.5; // 没填预算给中立分,不参与拉开差距
  if (budget) {
    // 预算内越省越高(封顶 1),贴着预算线落到 0.5;超预算从 0.5 继续衰减,
    // 保证「刚好超预算」不会反超「用掉 93% 预算」的线(此前的衰减起点在边界上跳变)
    budgetScore = est <= budget
      ? 1 - (est / budget) * 0.5
      : Math.max(0, 0.5 - 0.5 * (est - budget) / budget);
  }
  return Math.round((sceneryScore * 70 + budgetScore * 30) * 10) / 10;
}

// 单条打分:返回 null 表示被硬条件排除(禁入/关闭去不得;超天数/难度上限直接不推)。
// gradeMin/gradeMax 是「门槛闸门」而非打分权重——入门者看到「★5 排在第 8 位」会困惑,
// 「★5 根本不出现」才清晰。缺省 null/不传 = 不设限,行为与接入前完全一致。
function scoreTrail(trail, { scenery = [], budget = null, maxDays = null, gradeMin = null, gradeMax = null }, cfg = {}) {
  if (trail.status === '禁入' || trail.status === '关闭') return null;
  if (maxDays && trail.days > maxDays) return null;
  if (Number.isFinite(gradeMin) && trail.grade < gradeMin) return null;
  if (Number.isFinite(gradeMax) && trail.grade > gradeMax) return null;

  const est = costPerPerson(trail, cfg);
  const hits = scenery.filter((s) => (trail.scenery || []).includes(s));
  return {
    hits, est,
    overBudget: budget ? Math.max(0, est - budget) : 0,
    score: scoreOf(hits.length, scenery.length, est, budget),
  };
}

// 打分排序:分数 → 花费低 → 天数短 → 名称,保证同分时顺序稳定。
// 管控/部分管控不排除(现实里仍可去),留给 UI 挂提示;禁入/关闭在 scoreTrail 里已剔除。
// province/excludeIds 是硬过滤:限定省份、剔除走过的(推荐看新线,走过去路线库翻)。
// gradeMin/gradeMax 同为硬过滤(入门者最需要的门槛闸门),见 scoreTrail 注释。
function rank(input = {}, trails = {}, cfg = {}) {
  const {
    budget = null, maxDays = null, scenery = [], limit = 12,
    province = '', excludeIds = [], gradeMin = null, gradeMax = null,
  } = input;
  const excluded = new Set(excludeIds);
  const scored = [];
  for (const [id, trail] of Object.entries(trails)) {
    if (excluded.has(id)) continue;
    if (province && trail.province !== province) continue;
    const s = scoreTrail(trail, { scenery, budget, maxDays, gradeMin, gradeMax }, cfg);
    if (s) scored.push({ id, trail, ...s });
  }
  scored.sort((a, b) => b.score - a.score || a.est - b.est
    || a.trail.days - b.trail.days || a.trail.name.localeCompare(b.trail.name, 'zh'));
  return scored.slice(0, limit);
}

// 区域 → 大交通估算的目标(枢纽站 + 枢纽坐标):坐标取环线上与 hub.city 同名的节点,
// 供无直达车时按距离挑中转枢纽;没接规划的区域返回 null。推荐与路线库 IPC 共用。
function hubTarget(region) {
  if (!region?.hub?.railStation) return null;
  const node = region.loop?.find((n) => n.name === region.hub.city) || region.loop?.[0];
  return {
    hub: region.hub.railStation,
    xy: node && Number.isFinite(node.lng) ? { lng: node.lng, lat: node.lat } : null,
  };
}

// 大交通富化 + 重打分:rank 的落地估算只含吃住门票,这里把「出发站⇌区域枢纽」的
// 往返火车估算并进 estAll,并把预算分改按含交通口径重打(否则远线靠落地便宜占着高分坑,轻敌雷区)。
// 两段式用法见 main 进程:先 rank(limit:候选池) 粗排,富化后由调用方截取最终条数。
// estimate 注入异步 (fromStation, toStation, toXY) => { perPerson, note } | null,
// 由调用方(main 进程)传 rail12306.estimateRoundTrip,本模块保持可单测的确定性。
// 枢纽查询走 3 路小并发(全串行首点太慢,3 路对 12306 仍算克制);
// 查不到价的条目 transport=null,保持未含口径。
async function enrichWithTransport(scored, {
  originStation, regions = {}, estimate, budget = null, scenery = [], concurrency = 3,
} = {}) {
  const targets = new Map(); // hub → { hub, xy }
  for (const r of scored) {
    const t = hubTarget(regions[r.trail.regionId]);
    if (t) targets.set(t.hub, t);
  }
  const prices = new Map();
  const hubs = [...targets.values()];
  let idx = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, hubs.length) }, async () => {
    while (idx < hubs.length) {
      const { hub, xy } = hubs[idx++];
      prices.set(hub, await estimate(originStation, hub, xy) || null);
    }
  }));

  for (const r of scored) {
    const target = hubTarget(regions[r.trail.regionId]);
    const est = target && prices.get(target.hub);
    r.transport = est ? { hub: target.hub, perPerson: est.perPerson, note: est.note } : null;
    r.estAll = r.est + (r.transport?.perPerson || 0);
    r.overBudget = budget ? Math.max(0, r.estAll - budget) : 0;
    r.score = scoreOf(r.hits.length, scenery.length, r.estAll, budget);
  }
  scored.sort((a, b) => b.score - a.score || a.estAll - b.estAll
    || a.trail.days - b.trail.days || a.trail.name.localeCompare(b.trail.name, 'zh'));
  return scored;
}

// 难度闸门口径回传给渲染层:让结果栏明说「按体能收窄到★N」,而不是让用户猜结果为什么变少了。
// 纯函数以便单测——此处踩过坑:spread 顺序或 auto 判断写错,会让「自动收窄」实际失效或误报。
//
// gateMax:   最终生效的难度上限(null = 未设限)
// auto:      true 仅当「确实是体能自动收窄」且「真的收窄了」:
//            - 用户显式选了档(输入是有限数字)→ 手选优先,auto=false
//            - 用户关掉了联动(useFitness === false)→ 没收窄,auto=false
function difficultyGate({ userPicked, useFitness = true, ableCap = null } = {}) {
  const explicit = Number.isFinite(userPicked);
  const gateMax = explicit ? userPicked : (useFitness === false ? null : ableCap);
  return {
    gradeMax: gateMax,
    auto: !explicit && useFitness !== false && Number.isFinite(gateMax),
  };
}

const api = {
  SCENERY, costPerPerson, costBreakdown, scoreOf, scoreTrail, rank,
  enrichWithTransport, hubTarget, regionStayMap, stayCfgFor, difficultyGate,
};
// 渲染进程没有 require:经 <script> 加载时挂到 window.GushanLib,与主进程共用同一实现
if (typeof module !== 'undefined') module.exports = api;
else (window.GushanLib = window.GushanLib || {}).recommend = api;

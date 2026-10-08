// 智能推荐:在路线库里按「想看的景色 + 人均预算(+天数上限)」做确定性打分,LLM 不参与。
// 落地花费的**公式不在这里**——统一走 lib/budget.js(分项模型 + 季节系数 + 档次),
// 因为历史上 recommend 与 planner 各写一遍吃住公式,一侧修了边界、另一处继续错
// (见 INSTINCTS「口径修正要看真实数据分布」与设计稿 4.2)。
// 本模块要同时被 node require 和浏览器 <script> 加载,所以按 http.js 的办法做条件解析:
// 注意 index.html 里 budget.js 必须排在 recommend.js 之前。
const budget = (typeof require === 'function' && typeof module !== 'undefined')
  ? require('./budget')
  : (typeof window !== 'undefined' && window.GushanLib ? window.GushanLib.budget : null);

// 景色词表:trails.json 的 scenery 字段只能取这里的值(test/trails-data.test.mjs 把关);
// 渲染进程的筛选 chips 与此表保持一致(渲染进程拿不到 require)。
const SCENERY = [
  '雪山', '冰川', '湖泊', '云海', '星空', '森林', '草原', '峡谷', '溪瀑',
  '花海', '梯田', '秋色', '冰雪', '沙漠戈壁', '丹霞雅丹', '海岸海岛', '古道人文', '温泉',
  '峰林田园',
];

// 人均落地花费:交给 budget.landBudget(徒步语义晚数:1 天线按 1 晚计)。
// 留这个入口只为调用点少写参数;公式本身一行都不在这里。
function costPerPerson(trail, cfg = {}, opts = {}) {
  return budget.landBudget(trail, opts, cfg).total;
}

// 区域库 → regionStay 映射(推荐打分与渲染层卡片共用一个入口)
function regionStayMap(regions = {}) {
  const map = {};
  for (const [id, r] of Object.entries(regions)) if (r.stay) map[id] = r.stay;
  return map;
}

// 代码默认口径与 lib/budget.js 同源:那里是数值与文案的唯一来源,
// 这里只取用,不再各写一份 200/80(数字分家 = 备注开始骗人)。
const DEF_PER_ROOM = budget?.DEFAULT_PER_ROOM_PER_NIGHT ?? 200;
const DEF_PER_PERSON = budget?.DEFAULT_PER_PERSON_PER_DAY ?? 80;
// 注意:TIER_ALIAS 不在这里声明顶层变量——lib 的每个文件都是 <script> 加载、共享同一个
// 全局作用域,与 budget.js 的同名 const 会撞成 SyntaxError 让整份脚本静默失效
// (renderer-scope.test.mjs 会当场报红,这条就是它挡下来的)。用时就地取。

// 单区域的有效吃住口径:region.stay 覆盖 config,字段级覆盖(只标一项就只覆盖一项)。
// planner 的 stayBudget 用;basis 逐项言明来源,备注里给用户看。
// tier:区域若标了 `stay.tiers` 的分档绝对价,就取该档价(否则回落"基准价 × 系数")。
function stayCfgFor(cfg = {}, region = null, tier = '客栈') {
  const stay = region?.stay || {};
  const label = region?.name || region?.id;
  const tierAliases = budget?.TIER_ALIAS ?? { 经济: '青旅', 舒适: '客栈' };
  const tierKey = tierAliases[tier] || tier;
  const tierStay = (stay.tiers && stay.tiers[tierKey]) || null;
  // 青旅按**床位**卖,标了床位价就走床位计价(见 budget.stayCost)。三级回落:区域分档 → 区域级 → config 全局。
  // **只认青旅档**——客栈/酒店是按房间卖的,给它们传床位价会算错
  const bedFromRegion = tierKey === '青旅'
    ? (tierStay?.perBedPerNight ?? stay.perBedPerNight ?? null) : null;
  const perBedPerNight = bedFromRegion
    ?? (tierKey === '青旅' ? (cfg.lodging?.perBedPerNight ?? null) : null);
  const hasBedPrice = Number.isFinite(Number(perBedPerNight)) && Number(perBedPerNight) > 0;
  const hasTierPrice = tierStay?.perRoomPerNight != null || hasBedPrice;
  // 来源必须**按字段**判断,不能按"区域有没有 stay"判断:字段级覆盖意味着住宿与餐饮
  // 可能一项来自区域、另一项回落全局。曾共用一个 note —— 只标了餐标的区域
  // (如 dianxibei)连住宿也被说成「含区域基准」,而那个值其实来自 config 或代码默认值,
  // 用户反查会得到错误的来源。备注里说错来源,比不说更糟。
  const basisOf = (regionVal, cfgVal) => (regionVal != null
    ? `区域基准(${label})`
    : (cfgVal != null ? '配置值(config 全局口径)' : '默认估算,config.json 可改'));
  const tierBasis = `区域基准(${label})·${tierKey}档价`;
  const bedBasis = (hasBedPrice && bedFromRegion == null)
    ? 'config 全局床位价' : `区域基准(${label})·青旅床位价`;
  return {
    lodging: {
      perRoomPerNight: tierStay?.perRoomPerNight ?? stay.perRoomPerNight ?? cfg.lodging?.perRoomPerNight ?? DEF_PER_ROOM,
      perBedPerNight: hasBedPrice ? Number(perBedPerNight) : null,
      peoplePerRoom: cfg.lodging?.peoplePerRoom ?? 2,
      // 档次系数表要跟着走,否则用户在 config 里覆盖的 tierFactors 到规划页就丢了
      tierFactors: cfg.lodging?.tierFactors,
      // 已取到该档绝对价(或床位价)→ 系数必须是 1,否则调用方再乘一遍就是**打两次折**
      tierFactor: hasTierPrice ? 1 : undefined,
      basis: hasBedPrice
        ? bedBasis
        : (tierStay?.perRoomPerNight != null
          ? tierBasis : basisOf(stay.perRoomPerNight, cfg.lodging?.perRoomPerNight)),
    },
    food: {
      perPersonPerDay: tierStay?.perPersonPerDay ?? stay.perPersonPerDay ?? cfg.food?.perPersonPerDay ?? DEF_PER_PERSON,
      basis: tierStay?.perPersonPerDay != null
        ? tierBasis : basisOf(stay.perPersonPerDay, cfg.food?.perPersonPerDay),
    },
    note: (stay.perRoomPerNight != null || stay.perPersonPerDay != null)
      ? `含区域基准(${label})` : undefined,
  };
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
// date/headcount/tier 只进花费口径(季节系数 / 房间数 / 档次),不参与闸门。
function scoreTrail(trail, { scenery = [], budget: budgetLimit = null, maxDays = null, gradeMin = null, gradeMax = null, date = null, headcount = 1, tier = '舒适' } = {}, cfg = {}) {
  if (trail.status === '禁入' || trail.status === '关闭') return null;
  if (maxDays && trail.days > maxDays) return null;
  if (Number.isFinite(gradeMin) && trail.grade < gradeMin) return null;
  if (Number.isFinite(gradeMax) && trail.grade > gradeMax) return null;

  const est = costPerPerson(trail, cfg, { date, headcount, tier });
  const hits = scenery.filter((s) => (trail.scenery || []).includes(s));
  return {
    hits, est,
    overBudget: budgetLimit ? Math.max(0, est - budgetLimit) : 0,
    score: scoreOf(hits.length, scenery.length, est, budgetLimit),
  };
}

// 打分排序:分数 → 花费低 → 天数短 → 名称,保证同分时顺序稳定。
// 管控/部分管控不排除(现实里仍可去),留给 UI 挂提示;禁入/关闭在 scoreTrail 里已剔除。
// province/excludeIds 是硬过滤:限定省份、剔除走过的(推荐看新线,走过去路线库翻)。
// gradeMin/gradeMax 同为硬过滤(入门者最需要的门槛闸门),见 scoreTrail 注释。
// 排序只用本地确定性估算,不许往里塞网络项——异步源会让同一条件两次跑出不同顺序。
function rank(input = {}, trails = {}, cfg = {}) {
  const {
    budget = null, maxDays = null, scenery = [], limit = 12,
    province = '', excludeIds = [], gradeMin = null, gradeMax = null,
    date = null, headcount = 1, tier = '舒适',
  } = input;
  const excluded = new Set(excludeIds);
  const scored = [];
  for (const [id, trail] of Object.entries(trails)) {
    if (excluded.has(id)) continue;
    if (province && trail.province !== province) continue;
    const s = scoreTrail(trail, { scenery, budget, maxDays, gradeMin, gradeMax, date, headcount, tier }, cfg);
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

const api_recommend = {
  SCENERY, costPerPerson, scoreOf, scoreTrail, rank,
  enrichWithTransport, hubTarget, regionStayMap, stayCfgFor, difficultyGate,
};
// 渲染进程没有 require:经 <script> 加载时挂到 window.GushanLib,与主进程共用同一实现
if (typeof module !== 'undefined') module.exports = api_recommend;
else (window.GushanLib = window.GushanLib || {}).recommend = api_recommend;

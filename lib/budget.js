// 落地成本模型:分项化 + 季节系数 + 住宿档次。零依赖纯函数,主进程 require、渲染进程经
// <script> 挂 window.GushanLib(与 lib/seat.js 等同构;导出名文件级唯一,INSTINCTS 的渲染作用域教训)。
//
// 设计稿:docs/superpowers/specs/2026-10-07-落地成本模型-design.md(已批准)
//
// 为什么要有这个模块:`recommend.costBreakdown` 与 `planner.stayBudget` 曾经各写一遍吃住公式,
// 一侧修了"1 天线按 1 晚计"、另一侧还在按 0 晚算(INSTINCTS 记过这个后果)。这里只留**一套**公式,
// 差异写在调用点——`nights` 一律由调用方算好传进来,不再让公式自己猜自己是徒步语义还是行程语义。
//
// 三条不变量(违反任何一条都算 bug,不算风格问题):
// 1) `amount === null` 表示未知。**任何情况下都不写 0 冒充未知**——门票没标就 null,
//    合计只累加已知项,未知项数走 unknownCount,由界面挂"未含·需自核"。
// 2) 每个 note 必须写清口径来源(区域基准 / 哪一路季节命中 / 哪个档次),用户要能反查这个数怎么来的。
// 3) 系数是估的,不是实价。界面必须让人看见用的是哪一档。

// 代码默认口径:landBudget 与 planner/recommend 的 stayCfgFor 共用同一组数值。
// 提成常量是为了让"这是默认值、不是你配的"这件事在**备注里也同源**——
// 文案写死"¥200/晚"而默认值哪天改成 250,备注就开始骗人(同 LOOP_FACTOR 的单一来源纪律)。
const DEFAULT_PER_ROOM_PER_NIGHT = 200;
const DEFAULT_PER_PERSON_PER_DAY = 80;

// 各项的误差幅度(估计值,不是实测统计)。作用是让"哪里不确定、不确定多少"可见,
// 而不是宣称一个精确的置信区间——**这些百分比本身也是估的**,所以要写进备注让人看见。
// 实价项(12306 实价票、真实路网里程、真实 toll)幅度为 0;其余按下面取。
const BUDGET_BANDS = {
  lodging: 0.30,      // 区域基准与档次系数都是粗标
  food: 0.25,
  tickets: 0.20,      // 库内参考价,景区可能调价
  extraFees: 0.20,
  railActual: 0,      // 12306 实价
  railEstimate: 0.25, // 占位估算(往返实价 ÷ 2 的粗估)
  fuel: 0.10,         // 实际油耗/路况对 config 口径的偏离
  tollActual: 0,
  tollEstimate: 0.30,
};

// 住宿档次:与 config 的 perRoomPerNight 同性质(都是估的),只是把"住什么档"这件事标得更明。
// 可由 cfg.lodging.tierFactors 覆盖;不放 config.json 本体(那个文件在 .gitignore 里,放进去就不入库、也没法写测试)。
//
// 三档:青旅(床位)/ 客栈(标间)/ 酒店。**系数只是兜底**——区域若标了 `stay.tiers` 的绝对价,
// 就优先用绝对价、不再乘系数(见 landBudget)。酒店那档 ×1.8 是初始估计、没有实测依据,
// 所以备注必须让人看见"用的是系数而不是实价"(同「系数是估的,界面要能看见用的是哪一档」)。
const TIER_FACTORS = { 青旅: 0.6, 客栈: 1.0, 酒店: 1.8 };
// 旧档名兼容:2026-10-08 之前只有 经济/舒适 两档,存档与用户的 config 里可能还写着它们
const TIER_ALIAS = { 经济: '青旅', 舒适: '客栈' };

const MONTH_MIN = 1;
const MONTH_MAX = 12;

function validMonth(m) {
  return Number.isInteger(m) && m >= MONTH_MIN && m <= MONTH_MAX ? m : null;
}

// 季节/节假日表里读月份值:下划线开头的键是注释,不是月份(这条最容易踩)
function monthFactor(map, month) {
  if (!map || validMonth(month) === null) return null;
  const v = map[String(month)];
  return Number.isFinite(v) && v > 0 ? v : null;
}

function validDate(date) {
  if (!(typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date))) return null;
  // 格式对不代表日子对:2026-13-01 也过正则,但拿它去命中任何一档都是错的
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return date;
}

function holidayCovers(h, date) {
  // 字符串日期比较:ISO 格式下字典序即时间序,不用建 Date 对象(也避开了时区那一坑)
  return h && typeof h.from === 'string' && typeof h.to === 'string'
    && date >= h.from && date <= h.to;
}

// 季节系数:四路候选取**最大值**(不叠乘,也不"命中即返回")。
// 取最大是为了不把最贵的时候算便宜:国庆正好落在川西秋色旺季,按优先级会取到区域 1.4
// 把节假日 1.8 压掉;叠乘又会推出 2.52 这种没依据的数。max(1.4, 1.8) = 1.8 才可预测。
// → { lodging, food, lodgingFrom, foodFrom, notes: string[] }
function seasonFactors(date, regionId, seasonality = {}) {
  const notes = [];
  const d = validDate(date);
  if (!d) {
    notes.push('未填出发日期,按中性基准');
    return { lodging: 1, food: 1, lodgingFrom: null, foodFrom: null, notes };
  }
  const month = Number(d.slice(5, 7));
  // 中性基准不参与"取最大":把 1.0 放进候选里,淡季系数(0.9)就永远被它压掉——
  // 1.0 只在"什么都没命中"时兜底。
  const lodgingCands = [];
  const foodCands = [];
  const push = (list, factor, from) => {
    if (Number.isFinite(factor) && factor > 0) list.push({ factor, from });
  };

  // 1) 区域专属旺季
  const reg = seasonality.regions && seasonality.regions[regionId];
  if (reg) {
    push(lodgingCands, monthFactor(reg.months, month), reg.label || `${regionId} 旺季`);
    // 区域表只给 lodging 系数(设计稿字段约定:food 缺省 1.0,不跟随住宿——住宿涨得比吃饭猛)
  }
  // 2) 法定节假日
  const holidays = Array.isArray(seasonality.holidays) ? seasonality.holidays : [];
  const hits = holidays.filter((h) => holidayCovers(h, d));
  for (const h of hits) {
    push(lodgingCands, h.lodging, h.label);
    push(foodCands, h.food, h.label);
  }
  const year = d.slice(0, 4);
  if (!hits.length && !holidays.some((h) => String(h.from || '').startsWith(year))) {
    notes.push(`节假日日历未覆盖 ${year} 年,仅按月份`);
  }
  // 3) 全国性淡旺
  push(lodgingCands, monthFactor(seasonality.months, month), `全国 ${month} 月基准`);
  push(foodCands, monthFactor(seasonality.months, month), `全国 ${month} 月基准`);

  // 命中项里取最大;一个都没命中才落回中性基准 1.0
  const best = (list) => (list.length
    ? list.reduce((a, b) => (b.factor > a.factor ? b : a))
    : { factor: 1, from: '中性基准' });
  const lb = best(lodgingCands);
  const fb = best(foodCands);
  return { lodging: lb.factor, food: fb.factor, lodgingFrom: lb.from, foodFrom: fb.from, notes };
}

function tierFactorOf(tier, cfgTierFactors) {
  const table = cfgTierFactors && Object.keys(cfgTierFactors).length ? cfgTierFactors : TIER_FACTORS;
  // 先按原名查:用户自定义的系数表可能仍用旧档名(经济/舒适),不该被别名逻辑搅乱
  const direct = table[tier];
  if (Number.isFinite(direct) && direct > 0) return direct;
  const alias = TIER_ALIAS[tier];
  const viaAlias = alias ? table[alias] : undefined;
  if (Number.isFinite(viaAlias) && viaAlias > 0) return viaAlias;
  return table.客栈 ?? table.舒适 ?? 1;
}

// 两种"晚数"语义,函数名写死,免得再出现一份公式自己猜:
//   徒步线:1 天线也要在景区附近过夜 → 至少 1 晚(实测阿布吉措按 0 晚算过 ¥90,实际 ≥¥290)
//   行程表:N 天行程住 N-1 晚
function hikeNights(days) {
  const n = Number(days);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n <= 1 ? 1 : n - 1;
}
function tripNights(days) {
  const n = Number(days);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.max(n - 1, 0);
}

// 住宿(**合计**口径):房间数按人数向上取整——一个人也得包整间房。
// 曾有的口径是"房费 ÷ 2",等于永远假设两人同行,1 人出行被算便宜一半。
// 住宿(**合计**口径)。两种计价单位,不能混:
//   房间模式(客栈/酒店):按**房间**卖 → 房间数 = ceil(人数 ÷ 每间人数),一个人也得包整间房
//   床位模式(青旅/通铺):按**床位**卖 → 一人一床,不存在"包整间"
// 床位模式**不是"整间房价打个折"**:用折扣算会让人均随人数阶梯跳动
// (实测 1 人 ¥156 / 2 人 ¥78 / 3 人 ¥104),而青旅人均本来就该等于床位价、与人数无关。
function stayCost({ nights, headcount, perRoomPerNight, perBedPerNight, peoplePerRoom = 2, tierFactor = 1, seasonFactor = 1, tierLabel, seasonFrom, basisNote }) {
  const hc = Math.max(1, Math.round(Number(headcount) || 1));
  const n = Math.max(0, Math.round(Number(nights) || 0));
  const bedPrice = Number(perBedPerNight);
  const price = Number(perRoomPerNight);
  const useBed = Number.isFinite(bedPrice) && bedPrice > 0;
  if ((!useBed && (!Number.isFinite(price) || price <= 0)) || n === 0) {
    return { key: 'lodging', name: `住宿 ${n} 晚`, amount: null, perPerson: null, source: 'unknown',
      note: '住宿基准价未配置或晚数为 0,不计入合计' };
  }
  if (useBed) {
    // 床位:每人每晚一张床。不乘房间数、也不乘档次系数(床位价本身就是绝对价,再乘就是打两次折)
    const bedAmount = Math.round(n * bedPrice * hc * seasonFactor);
    const bedParts = [`${hc} 人 × ¥${bedPrice}/床/晚 × ${n} 晚`];
    if (seasonFactor !== 1) bedParts.push(`季节 ×${seasonFactor}(${seasonFrom || '命中项'})`);
    return {
      key: 'lodging', name: `住宿 ${n} 晚`, amount: bedAmount, perPerson: Math.round(bedAmount / hc), source: 'calc',
      note: `估算:${bedParts.join(' · ')}(按床位计价${basisNote ? `,${basisNote}` : ''})`,
    };
  }
  const rooms = Math.ceil(hc / Math.max(1, Number(peoplePerRoom) || 2));
  const amount = Math.round(n * price * rooms * tierFactor * seasonFactor);
  const parts = [`${rooms} 间 × ¥${price}/晚 × ${n} 晚`];
  // 基准档就是 ×1.0,写进备注只会变成噪音;偏离基准的档次才要说明
  if (tierLabel && tierFactor !== 1) parts.push(`${tierLabel}档 ×${tierFactor}`);
  if (seasonFactor !== 1) parts.push(`季节 ×${seasonFactor}(${seasonFrom || '命中项'})`);
  return {
    key: 'lodging', name: `住宿 ${n} 晚`, amount, perPerson: Math.round(amount / hc), source: 'calc',
    note: `估算:${parts.join(' · ')}(${basisNote || '口径见 config/区域基准'})`,
  };
}

// 餐饮(合计口径):按人头按天,餐标也吃季节系数
function foodCost({ days, headcount, perPersonPerDay, seasonFactor = 1, seasonFrom, basisNote }) {
  const hc = Math.max(1, Math.round(Number(headcount) || 1));
  const d = Math.max(0, Math.round(Number(days) || 0));
  const per = Number(perPersonPerDay);
  if (!Number.isFinite(per) || per <= 0 || d === 0) {
    return { key: 'food', name: `餐饮 ${d} 天`, amount: null, perPerson: null, source: 'unknown',
      note: '餐标未配置或天数为 0,不计入合计' };
  }
  const amount = Math.round(d * per * hc * seasonFactor);
  const parts = [`¥${per}/人/天 × ${hc} 人 × ${d} 天`];
  if (seasonFactor !== 1) parts.push(`季节 ×${seasonFactor}(${seasonFrom || '命中项'})`);
  return {
    key: 'food', name: `餐饮 ${d} 天`, amount, perPerson: Math.round(amount / hc), source: 'calc',
    note: `估算:${parts.join(' × ')}(${basisNote || '餐标见 config/区域基准'})`,
  };
}

// 门票:线路库没标 → amount null(不是 0)。合计按人头,人均就是票价。
function ticketItem(trail, { headcount }) {
  const hc = Math.max(1, Math.round(Number(headcount) || 1));
  const t = trail && trail.tickets;
  if (t === undefined || t === null) {
    return { key: 'tickets', name: '门票', amount: null, perPerson: null, source: 'unknown',
      note: '线路库未标注门票,此处不计入合计(不是 0 元)——出发前自行核实' };
  }
  const v = Number(t);
  if (!Number.isFinite(v) || v < 0) {
    return { key: 'tickets', name: '门票', amount: null, perPerson: null, source: 'unknown',
      note: `门票字段值非法(${JSON.stringify(t)}),按未知处理` };
  }
  return { key: 'tickets', name: '门票', amount: Math.round(v * hc), perPerson: v, source: 'data',
    note: `来自线路库标注 ×${hc} 人(参考值,现价以景区公示为准)` };
}

// 进山费/观光车等附加项:只有线路库真有实数时才产出条目,没数据就**不产出这一项**,
// 绝不估一个数填进去(设计稿非目标第 5 行)。
function extraFeeItems(trail, { headcount }) {
  const list = trail && trail.extraFees;
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list) || !list.length) return [{ key: 'extraFees', name: '附加费用', amount: null,
    perPerson: null, source: 'unknown', note: 'extraFees 字段形状不对(应为数组),已忽略' }];
  const hc = Math.max(1, Math.round(Number(headcount) || 1));
  const items = [];
  const dirty = [];
  for (const f of list) {
    const name = f && typeof f.name === 'string' ? f.name.trim() : '';
    const amount = f ? Number(f.amount) : NaN;
    if (!name || !Number.isFinite(amount) || amount < 0) { dirty.push(JSON.stringify(f)); continue; }
    items.push({ key: `extra:${name}`, name, amount: Math.round(amount * hc), perPerson: amount,
      source: 'data', note: `线路库标注 ×${hc} 人` });
  }
  if (dirty.length) items.push({ key: 'extraFeesDirty', name: '附加费用(有非法条目)', amount: null,
    perPerson: null, source: 'unknown', note: `${dirty.length} 条 extraFees 格式不对,未计入` });
  return items;
}

// 把预算项汇总成区间。**只对有 band 的已知项做浮动**——amount 为 null 的"未含"项不参与
// (那是缺失,不是误差,两回事);band=0 的实价项也不浮动。band 是相对中值的半幅(%),
// contributors 点出究竟是谁贡献了不确定,让"这个区间凭什么"可反查。
function budgetRange(items) {
  let low = 0;
  let high = 0;
  const contributors = [];
  for (const it of items) {
    if (it.amount === null || !Number.isFinite(Number(it.amount))) continue;
    const amount = Number(it.amount);
    const b = Number.isFinite(it.band) && it.band > 0 ? it.band : 0;
    low += Math.round(amount * (1 - b));
    high += Math.round(amount * (1 + b));
    if (b > 0) contributors.push(it.name || it.key || '未命名项');
  }
  const mid = (low + high) / 2;
  return {
    low,
    high,
    band: mid > 0 ? Math.round(((high - low) / 2 / mid) * 100) : 0,
    contributors,
  };
}

// 预算汇总的唯一实现:**生成时(planner)与改动时(换车次)必须走同一个函数**。
// 曾经两处各写一份 —— planner 里算 total/perPerson/unknownCount/range,渲染层 switchTrain
// 只重算前三项、漏掉 range,于是换车次后票价变了而区间还是旧的(2026-10-08 实测)。
// 把汇总收在这里,差异就从"靠人记得同步"变成"结构上不可能分家"。
// headcount 缺省/非法时退回 1,绝不产出 NaN 人均。
function budgetRollup(items, headcount = 1) {
  const hc = Math.max(1, Math.round(Number(headcount) || 1));
  const known = items.filter((b) => b.amount !== null && Number.isFinite(Number(b.amount)));
  const total = known.reduce((s, b) => s + Number(b.amount), 0);
  return {
    total,
    perPerson: Math.round(total / hc),
    knownCount: known.length,
    unknownCount: items.length - known.length,
    range: budgetRange(items),
  };
}

// 人均落地估算:推荐页与路线库卡片的唯一入口。
// cfg = { ...config, regionStay, seasonality } —— 季节表与区域基准都由调用方注入,本模块不读盘。
// → { items, total, perPerson(=total 口径本身), knownCount, unknownCount, season, range }
function landBudget(trail, { date = null, headcount = 1, tier = '客栈', nights = null } = {}, cfg = {}) {
  const stay = (cfg.regionStay && cfg.regionStay[trail?.regionId]) || {};
  // 档次绝对价优先:区域标了 `stay.tiers` 就取那一档的实价,否则回落到"基准价 × 档次系数"。
  // 有了它,同一个区域可以给 青旅/客栈/酒店 三个不同价位,而不是只靠一个系数乘出来。
  const tierKey = TIER_ALIAS[tier] || tier;
  const tierStay = (stay.tiers && stay.tiers[tierKey]) || null;
  // 床位价三级回落:区域分档价 → 区域级 → **config 全局**。三级都没有才回落到"整间房价 × 系数"。
  // 全局那一档是给"没抓到/没标过青旅价的城市"用的——总比一律按整间房打折准。
  const bedFromRegion = tierKey === '青旅'
    ? (tierStay?.perBedPerNight ?? stay.perBedPerNight ?? null) : null;
  const perBedPerNight = bedFromRegion
    ?? (tierKey === '青旅' ? (cfg.lodging?.perBedPerNight ?? null) : null);
  const hasBedPrice = Number.isFinite(Number(perBedPerNight)) && Number(perBedPerNight) > 0;
  const bedFromConfig = hasBedPrice && bedFromRegion == null;
  const perRoomPerNight = tierStay?.perRoomPerNight ?? stay.perRoomPerNight ?? cfg.lodging?.perRoomPerNight ?? DEFAULT_PER_ROOM_PER_NIGHT;
  const peoplePerRoom = cfg.lodging?.peoplePerRoom ?? 2;
  const perPersonPerDay = tierStay?.perPersonPerDay ?? stay.perPersonPerDay ?? cfg.food?.perPersonPerDay ?? DEFAULT_PER_PERSON_PER_DAY;
  // 口径来源必须**按字段**判断:区域基准是字段级覆盖,只标一项就只覆盖一项,
  // 所以住宿与餐饮的来源可能不同。曾共用一个 basisNote —— 只标了餐标的区域,
  // 住宿也会被说成「区域基准(x)」,而那个值其实来自 config 或代码默认值
  // (滇西北只标了餐标,住宿就中了这个坑)。来源标错比不标更糟:用户会以为自己标过。
  const basisOf = (regionVal, cfgVal) => (regionVal != null
    ? `区域基准(${trail?.regionId})`
    : (cfgVal != null ? 'config 全局口径' : '默认估算(config.json 未设此项)'));
  // 用了分档绝对价就说清是"哪一档的价",而不是笼统的"区域基准"
  const tierBasis = `区域基准(${trail?.regionId})·${tierKey}档价`;
  const bedBasis = bedFromConfig
    ? 'config 全局床位价' : `区域基准(${trail?.regionId})·青旅床位价`;
  const lodgingBasis = hasBedPrice
    ? bedBasis
    : (tierStay?.perRoomPerNight != null
      ? tierBasis : basisOf(stay.perRoomPerNight, cfg.lodging?.perRoomPerNight));
  const foodBasis = tierStay?.perPersonPerDay != null
    ? tierBasis : basisOf(stay.perPersonPerDay, cfg.food?.perPersonPerDay);
  const season = seasonFactors(date, trail?.regionId, cfg.seasonality || {});
  // 已取到该档绝对价就不再乘档次系数,否则等于打两次折
  // 取了分档价或床位价就不再乘系数(否则打两次折);床位模式本身也不用它,
  // 但这里显式给 1,免得将来有人在床位分支里误用 tierFactor 时静默打第二次折
  const tierFactor = (hasBedPrice || tierStay?.perRoomPerNight != null) ? 1 : tierFactorOf(tier, cfg.lodging?.tierFactors);
  const hc = Math.max(1, Math.round(Number(headcount) || 1));
  const days = Number(trail?.days) || 0;
  const n = nights === null ? hikeNights(days) : Math.max(0, Math.round(Number(nights) || 0));

  const lodging = stayCost({ nights: n, headcount: hc, perRoomPerNight, perBedPerNight, peoplePerRoom,
    tierFactor, seasonFactor: season.lodging, tierLabel: tier, seasonFrom: season.lodgingFrom, basisNote: lodgingBasis });
  const food = foodCost({ days, headcount: hc, perPersonPerDay,
    seasonFactor: season.food, seasonFrom: season.foodFrom, basisNote: foodBasis });
  // 每项带上误差幅度:区间由 budgetRange 汇总,实价项(band=0)不参与浮动
  const items = [
    { ...lodging, band: BUDGET_BANDS.lodging },
    { ...food, band: BUDGET_BANDS.food },
    { ...ticketItem(trail, { headcount: hc }), band: BUDGET_BANDS.tickets },
    ...extraFeeItems(trail, { headcount: hc }).map((it) => ({ ...it, band: BUDGET_BANDS.extraFees })),
  ];
  // 卡片是"人均"口径:合计项在这里除回人数
  const perPersonItems = items.map((it) => ({ ...it, perPerson: it.amount === null ? null : Math.round(it.amount / hc) }));
  const known = perPersonItems.filter((it) => it.perPerson !== null);
  const total = known.reduce((s, it) => s + it.perPerson, 0);
  return {
    items: perPersonItems,
    total,
    perPerson: total,
    knownCount: known.length,
    unknownCount: perPersonItems.length - known.length,
    ticketsUnknown: trail?.tickets == null, // 旧字段名留着:卡片"门票未标注"角标与既有测试都吃它
    season,
    notes: [...season.notes],
    // 区间是**估算幅度**不是置信区间:band 全是估的,页面必须把 contributors 一并说出来
    range: budgetRange(perPersonItems),
  };
}

// 一次性开销清单(设计稿 4.5):**只列"要不要准备",不给金额**。
// 判据字段全部是线路库里已有的(days/supplies/type/maxAltM/techLevel/bestMonths),
// 不引入任何新数据源;`bestMonths` 只有 177/191 有,缺的线只走日期判据,不猜季节。
// 三条触发规则各自独立,命中几条列几条——不给金额是因为那些价没有可查证的公开口径,
// 编一个数比不写更糟(同 gradng/filters 的"明说不知道"纪律)。
const WINTER_MONTHS = [12, 1, 2];

function oneTimeCosts(trail, { date = null } = {}) {
  const items = [];
  if (!trail) return items;
  const days = Number(trail.days) || 0;
  const supplies = String(trail.supplies || '');
  const type = String(trail.type || '');
  const maxAltM = Number(trail.maxAltM) || 0;
  const techLevel = Number(trail.techLevel) || 0;

  if (days >= 3 && (/无补给|无水源|全程自理/.test(supplies) || /重装/.test(type))) {
    items.push({
      item: '向导 / 马帮 / 背夫',
      reason: `${days} 天且${/重装/.test(type) ? '属重装线' : '沿途无补给'},负重按个人体力另议`,
      amountNote: '需另询当地价',
    });
  }
  if (maxAltM >= 3500 || techLevel >= 3) {
    items.push({
      item: '高原保险 / 应急药品',
      reason: maxAltM >= 3500 ? `最高海拔 ${maxAltM}m` : `技术地形等级 ${techLevel}`,
      amountNote: '按保额与人数另计',
    });
  }
  const month = validDate(date) ? Number(date.slice(5, 7)) : null;
  const bestWinter = Array.isArray(trail.bestMonths)
    && trail.bestMonths.some((m) => WINTER_MONTHS.includes(m));
  if ((month && WINTER_MONTHS.includes(month)) || bestWinter) {
    items.push({
      item: '装备租赁(冰爪 / 雪套)',
      reason: (month && WINTER_MONTHS.includes(month))
        ? `出行日期在 ${month} 月` : '该线路最佳月份含冬季',
      amountNote: '按日租,另计',
    });
  }
  return items;
}

const api_budget = {
  TIER_FACTORS, tierFactorOf, seasonFactors, validMonth, monthFactor, validDate,
  hikeNights, tripNights, stayCost, foodCost, ticketItem, extraFeeItems, landBudget,
  oneTimeCosts, WINTER_MONTHS,
  DEFAULT_PER_ROOM_PER_NIGHT, DEFAULT_PER_PERSON_PER_DAY, TIER_ALIAS,
  BUDGET_BANDS, budgetRange, budgetRollup,
};
if (typeof module !== 'undefined') module.exports = api_budget;
else (window.GushanLib = window.GushanLib || {}).budget = api_budget;

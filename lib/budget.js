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

// 住宿档次:与 config 的 perRoomPerNight 同性质(都是估的),只是把"住什么档"这件事标得更明。
// 可由 cfg.lodging.tierFactors 覆盖;不放 config.json 本体(那个文件在 .gitignore 里,放进去就不入库、也没法写测试)。
const TIER_FACTORS = { 经济: 0.6, 舒适: 1.0 };

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
  const v = table[tier];
  return Number.isFinite(v) && v > 0 ? v : table.舒适 ?? 1;
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
function stayCost({ nights, headcount, perRoomPerNight, peoplePerRoom = 2, tierFactor = 1, seasonFactor = 1, tierLabel, seasonFrom, basisNote }) {
  const hc = Math.max(1, Math.round(Number(headcount) || 1));
  const n = Math.max(0, Math.round(Number(nights) || 0));
  const price = Number(perRoomPerNight);
  if (!Number.isFinite(price) || price <= 0 || n === 0) {
    return { key: 'lodging', name: `住宿 ${n} 晚`, amount: null, perPerson: null, source: 'unknown',
      note: '住宿基准价未配置或晚数为 0,不计入合计' };
  }
  const rooms = Math.ceil(hc / Math.max(1, Number(peoplePerRoom) || 2));
  const amount = Math.round(n * price * rooms * tierFactor * seasonFactor);
  const parts = [`${rooms} 间 × ¥${price}/晚 × ${n} 晚`];
  // 舒适档就是基准本身(×1.0),写进备注只会变成噪音;偏离基准的档次才要说明
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

// 人均落地估算:推荐页与路线库卡片的唯一入口。
// cfg = { ...config, regionStay, seasonality } —— 季节表与区域基准都由调用方注入,本模块不读盘。
// → { items, total, perPerson(=total 口径本身), knownCount, unknownCount, season }
function landBudget(trail, { date = null, headcount = 1, tier = '舒适', nights = null } = {}, cfg = {}) {
  const stay = (cfg.regionStay && cfg.regionStay[trail?.regionId]) || {};
  const perRoomPerNight = stay.perRoomPerNight ?? cfg.lodging?.perRoomPerNight ?? 200;
  const peoplePerRoom = cfg.lodging?.peoplePerRoom ?? 2;
  const perPersonPerDay = stay.perPersonPerDay ?? cfg.food?.perPersonPerDay ?? 80;
  const basisNote = (stay.perRoomPerNight != null || stay.perPersonPerDay != null)
    ? `区域基准(${trail?.regionId})` : undefined;
  const season = seasonFactors(date, trail?.regionId, cfg.seasonality || {});
  const tierFactor = tierFactorOf(tier, cfg.lodging?.tierFactors);
  const hc = Math.max(1, Math.round(Number(headcount) || 1));
  const days = Number(trail?.days) || 0;
  const n = nights === null ? hikeNights(days) : Math.max(0, Math.round(Number(nights) || 0));

  const lodging = stayCost({ nights: n, headcount: hc, perRoomPerNight, peoplePerRoom,
    tierFactor, seasonFactor: season.lodging, tierLabel: tier, seasonFrom: season.lodgingFrom, basisNote });
  const food = foodCost({ days, headcount: hc, perPersonPerDay,
    seasonFactor: season.food, seasonFrom: season.foodFrom, basisNote });
  const items = [lodging, food, ticketItem(trail, { headcount: hc }), ...extraFeeItems(trail, { headcount: hc })];
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
};
if (typeof module !== 'undefined') module.exports = api_budget;
else (window.GushanLib = window.GushanLib || {}).budget = api_budget;

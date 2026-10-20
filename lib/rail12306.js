// 12306 余票查询。只用官方网页自己在调的公开接口,不登录、只读、低频。
// 票价直接编码在余票行的第 39 字段(座位代码+4位价格+5位标记,重复分组),
// 无需再调会 405 的 queryTicketPrice 接口。
// 字段序号若失效,用 npm run smoke:rail 打一次真实查询,对照原始返回调整。
const store = require('./store');
const { httpFetch } = require('./http');

const BASE = 'https://kyfw.12306.cn';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// leftTicket 返回行的字段序号(社区长期沿用的公开映射)
const ROW = {
  trainNo: 2, code: 3, fromCode: 6, toCode: 7,
  startTime: 8, arriveTime: 9, lishi: 10, canWebBuy: 11,
  swz: 32, zy: 31, ze: 30, yz: 29, yw: 28, rw: 23, wz: 26,
};

// 余票行 f39 的座位代码 → 名称(实证:G/D 与 K/Z 车一致)
const SEAT_LABELS = {
  9: '商务座', M: '一等座', O: '二等座', W: '无座',
  1: '硬座', 2: '软座', 3: '硬卧', 4: '软卧', 6: '高级软卧', F: '动卧',
};

// const 而非 let:绑定本身从不重新赋值,变的只是对象内容(缓存条目被 absorbCookies
// 写入)。写 let 会让读代码的人怀疑「哪里又赋值了」。
const cookieJar = {};

// cookie 不是取一次就永远有效:12306 的会话 cookie 会过期,而旧写法
// 「只要 jar 非空就跳过初始化」意味着应用开一整天后,每次查票都带着过期 cookie。
// 失败还会被 planner.railLeg 吞成「取价失败/占位估算」,用户看不出重启就能好。
// 所以按时间刷新;并在"一次查询所有路径都没拿到有效应答"时清空,让下一次重新初始化。
const COOKIE_TTL_MS = 30 * 60 * 1000;
let cookieFetchedAt = 0;

// 纯函数便于单测:什么情况下必须重新取 cookie
function cookieNeedsRefresh(jar = cookieJar, fetchedAt = cookieFetchedAt, now = Date.now()) {
  if (!jar || Object.keys(jar).length === 0) return true; // 从没取过
  return now - fetchedAt >= COOKIE_TTL_MS;
}

function dropCookies() {
  for (const k of Object.keys(cookieJar)) delete cookieJar[k];
  cookieFetchedAt = 0;
}

function absorbCookies(res) {
  // net.fetch 与 node fetch 的 Response 都支持 getSetCookie(Chromium 132+/undici)
  if (typeof res.headers.getSetCookie !== 'function') return;
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(';');
    const eq = pair.indexOf('=');
    if (eq > 0) cookieJar[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
}

function cookieHeader() {
  return Object.entries(cookieJar).map(([k, v]) => `${k}=${v}`).join('; ');
}

// 出网统一走 lib/http.js(Electron 用 net.fetch 吃系统代理,纯 node 回退全局 fetch);
// 12306 的特殊之处只是要养 cookie,见 absorbCookies。
async function fetchWithCookies(url) {
  const res = await httpFetch(url, {
    headers: {
      'User-Agent': UA,
      'Referer': `${BASE}/otn/leftTicket/init`,
      'Accept': 'application/json, text/javascript, */*; q=0.01',
      'X-Requested-With': 'XMLHttpRequest',
      'If-Modified-Since': '0',
      'Cache-Control': 'no-cache',
      'Cookie': cookieHeader(),
    },
  });
  absorbCookies(res);
  return res;
}

async function ensureCookies() {
  if (!cookieNeedsRefresh()) return;
  const res = await fetchWithCookies(`${BASE}/otn/leftTicket/init?linktypeid=dc`);
  if (!res.ok) throw new Error(`12306 初始化失败: HTTP ${res.status}`);
  cookieFetchedAt = Date.now();
}

// 站名→电报码,首次联网拉官方 station_name.js,之后读本地缓存
async function ensureStations() {
  const cached = store.read('stations');
  if (cached) return cached;
  const res = await fetchWithCookies(`${BASE}/otn/resources/js/framework/station_name.js`);
  if (!res.ok) throw new Error(`拉取站名表失败: HTTP ${res.status}`);
  const text = await res.text();
  const stations = parseStationJs(text);
  if (stations.length === 0) throw new Error('站名表解析为空,官方格式可能已变更');
  store.write('stations', stations);
  return stations;
}

function parseStationJs(text) {
  const stations = [];
  for (const entry of text.split('@')) {
    const p = entry.split('|');
    // 条目形如 bjb|北京北|VAP|beijingbei|bjb|0|0357|北京|||
    if (p.length < 3) continue;
    if (!/^[\u4e00-\u9fa5]+$/.test(p[1]) || !/^[A-Z]{2,4}$/.test(p[2])) continue;
    stations.push({ name: p[1], code: p[2] });
  }
  return stations;
}

async function resolveStation(keyword) {
  const stations = await ensureStations();
  const exact = stations.find((s) => s.name === keyword);
  if (exact) return [exact];
  return stations.filter((s) => s.name.includes(keyword)).slice(0, 10);
}

async function stationCode(name) {
  const hits = await resolveStation(name);
  const exact = hits.find((s) => s.name === name);
  if (!exact) throw new Error(`找不到 12306 车站「${name}」,请确认站名(候选: ${hits.map((h) => h.name).join('、') || '无'})`);
  return exact.code;
}

const cache = new Map(); // key: from|to|date → { expires, result }
const QUERY_TTL_MS = 10 * 60 * 1000;

// 两个会话级缓存都只 set 不 delete:过期项只有"再次命中同一 key"时才被覆盖,否则永久驻留。
// 单次会话量不大,但这是典型的无界缓存。写入前顺手扫一遍(与 electron/main.js 里
// pendingGpx 的清理同一写法),把已过期的清掉。
function sweepExpired(map, now = Date.now()) {
  for (const [k, v] of map) if (v && Number.isFinite(v.expires) && v.expires < now) map.delete(k);
  return map;
}

async function queryTrains(fromName, toName, date, { force = false } = {}) {
  const key = `${fromName}|${toName}|${date}`;
  sweepExpired(cache);
  const hit = cache.get(key);
  if (!force && hit && hit.expires > Date.now()) return hit.result;

  const [from, to] = await Promise.all([stationCode(fromName), stationCode(toName)]);
  await ensureCookies();

  const url = (ep) =>
    `${BASE}/otn/leftTicket/${ep}?leftTicketDTO.train_date=${date}` +
    `&leftTicketDTO.from_station=${from}&leftTicketDTO.to_station=${to}&purpose_codes=ADULT`;

  // 官方会随版本切换 query/queryG 等路径,逐个尝试直到拿到 JSON
  let lastErr = '全部查询路径均未返回有效数据';
  let emptyHits = 0; // 有几条路径"结构正确但车次为空"
  let emptyMap = null;
  for (const ep of ['query', 'queryA', 'queryZ', 'queryU', 'queryEx', 'queryG']) {
    let res;
    try {
      res = await fetchWithCookies(url(ep));
    } catch (e) {
      lastErr = `网络错误: ${e.message}`;
      continue;
    }
    if (res.status !== 200) { lastErr = `${ep}: HTTP ${res.status}`; continue; }
    let json;
    try { json = await res.json(); } catch { lastErr = `${ep}: 返回非 JSON`; continue; }
    if (json.status && Array.isArray(json.data?.result)) {
      const trains = json.data.result.map((row) => parseTrain(row, json.data.map || {}));
      if (!trains.length) {
        // 空车次列表是个**二义**响应:可能真的没有匹配车次,也可能是被限频/风控时返回的
        // "结构正确、内容为空"。实测撞到过后一种——同一查询另一时刻返回 40 趟车,
        // 而当时被判成「没有可购车次」,预算直接退化成占位估算。
        // 所以先换路径再试,别拿到第一个空就下结论;全部路径都空才认这是"空结果",
        // 并把二义性往上抛(调用方去确认,见 planner.railLeg 的复核重试)。
        emptyHits += 1;
        emptyMap = json.data.map || emptyMap;
        lastErr = `${ep}: 返回空车次列表`;
        continue;
      }
      const result = { trains, stationNames: json.data.map, queriedAt: new Date().toISOString() };
      cache.set(key, { expires: Date.now() + QUERY_TTL_MS, result });
      return result;
    }
    lastErr = `${ep}: ${json.messages?.join(';') || 'status=false'}`;
  }
  // 至少有一条路径成功应答(只是为空)→ 这是"空结果",不是故障。
  // **不缓存**:限频是瞬时的,缓存会把"被挡了"固化 10 分钟(同 route-cache 的"失败不缓存"纪律),
  // 调用方的一次复核重试必须真的能重发请求。
  if (emptyHits > 0) {
    return {
      trains: [], stationNames: emptyMap || {}, queriedAt: new Date().toISOString(),
      emptyResult: true, emptyHits,
    };
  }
  // 一条路径都没拿到有效应答:很可能是 cookie 过期被挡。清掉让下次查询重新初始化,
  // 而不是让这个会话从此一直带着过期 cookie(旧写法连判断都没有)。
  dropCookies();
  throw new Error(`12306 余票查询失败(${fromName}→${toName} ${date}): ${lastErr}`);
}

// f39 形如 9077400001M040500000O025200000O025203000:
// 每 10 字符一组 = 座位代码(1) + 价格元(4) + 标记位(5)。同名取首个。
function parsePrices(f39) {
  const prices = {};
  if (!f39) return prices;
  for (let i = 0; i + 10 <= f39.length; i += 10) {
    const chunk = f39.slice(i, i + 10);
    const label = SEAT_LABELS[chunk[0]] || `座位代码${chunk[0]}`;
    const price = parseInt(chunk.slice(1, 5), 10);
    if (Number.isFinite(price) && price > 0 && !(label in prices)) prices[label] = price;
  }
  return prices;
}

function parseTrain(row, map) {
  const r = row.split('|');
  const seats = {};
  for (const [field, idx] of [['商务座', ROW.swz], ['一等座', ROW.zy], ['二等座', ROW.ze],
    ['硬座', ROW.yz], ['硬卧', ROW.yw], ['软卧', ROW.rw], ['无座', ROW.wz]]) {
    const v = r[idx];
    if (v && v !== '--' && v !== '') seats[field] = v === '有' || v === '无' ? v : `${v} 张`;
  }
  return {
    trainNo: r[ROW.trainNo], code: r[ROW.code],
    from: map[r[ROW.fromCode]] || r[ROW.fromCode],
    to: map[r[ROW.toCode]] || r[ROW.toCode],
    startTime: r[ROW.startTime], arriveTime: r[ROW.arriveTime], lishi: r[ROW.lishi],
    canWebBuy: r[ROW.canWebBuy] === 'Y', seats,
    prices: parsePrices(r[39]), // 票价来自余票行内嵌编码,无需二次请求
  };
}

// ---------- 坐席与预售期口径 ----------

// 选座口径抽在 lib/seat.js(零依赖,渲染进程 <script> 复用同一实现),这里转发以维持原 API。
// pickEstimateTrain 就是 seat.pickBuyableTrain:挑车与挑座的口径全仓只有那一份,
// planner.railLeg 走的也是它,两侧不可能再各推一趟不同的车。
const { lishiHours, seatPreference, pickSeat, pickBuyableTrain: pickEstimateTrain } = require('./seat');

// 12306 预售期现约 15 天:超期查询返回空列表,不提前说破会被误读成"无车"
const PRESALE_DAYS = 15;
function localDateOf(ms) {
  const d = new Date(ms);
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function beyondPresale(dateStr, now = Date.now()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr || '')) return false;
  // 必须按本地日期算:toISOString().slice(0,10) 在中国时间 0–8 点会退回前一天,
  // 把仍在预售期内的出发日误判成超期。
  return dateStr > localDateOf(now + PRESALE_DAYS * 864e5);
}

// ---------- 往返大交通估算(推荐页/路线库展示用;行程规划仍以实价为准) ----------

// 估算用参考日期:10 天后即可,火车票价与乘车日期基本无关;
// 预售期若收缩,逐日往前借到预售期内为止
function estimateDate(now = Date.now()) {
  const pad = (x) => String(x).padStart(2, '0');
  for (let offset = 10; offset >= 1; offset--) {
    const d = new Date(now + offset * 864e5);
    const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    if (!beyondPresale(date, now)) return date;
  }
  return null;
}

// 从一次余票查询里挑估算车次 —— 实现在 lib/seat.js:pickBuyableTrain(见上方 import 注释)。
// 这里不再抄一份,planner 与推荐页的往返估算共用同一个函数。

// 中转候选大枢纽:目的地没有直达车时,挑离目的地最近的几个试两段组合。
// 站名都是 12306 可解析的真实站;坐标只用来排序,精度要求与 regions.json 同级。
const JUNCTIONS = [
  { name: '成都东', lng: 104.14, lat: 30.59 },
  { name: '重庆北', lng: 106.50, lat: 29.62 },
  { name: '昆明', lng: 102.83, lat: 25.09 },
  { name: '贵阳北', lng: 106.65, lat: 26.66 },
  { name: '西安北', lng: 108.94, lat: 34.37 },
  { name: '兰州', lng: 103.73, lat: 36.10 },
  { name: '乌鲁木齐', lng: 87.51, lat: 43.84 },
  { name: '郑州东', lng: 113.65, lat: 34.75 },
  { name: '武汉', lng: 114.31, lat: 30.60 },
  { name: '长沙南', lng: 113.02, lat: 28.15 },
  { name: '北京西', lng: 116.30, lat: 39.90 },
  { name: '上海虹桥', lng: 121.32, lat: 31.19 },
  { name: '广州南', lng: 113.27, lat: 23.17 },
];

// 离目的地最近的 k 个候选(纯函数,方便单测)
function pickJunctions(toXY, k = 4) {
  if (!toXY || !Number.isFinite(toXY.lng) || !Number.isFinite(toXY.lat)) return [];
  return [...JUNCTIONS]
    .sort((a, b) => (a.lng - toXY.lng) ** 2 + (a.lat - toXY.lat) ** 2
      - ((b.lng - toXY.lng) ** 2 + (b.lat - toXY.lat) ** 2))
    .slice(0, k);
}

// 两段中转:两腿都有可购车次才算成立,往返 = 两腿去程票价相加 ×2。
// query 注入方便单测;单腿网络失败只算这一轮没成,整轮全空且发生过网络错误则抛出(不缓存负结果)。
async function transferEstimate(fromName, toName, toXY, query = queryTrains) {
  let networkErr = false;
  for (const j of pickJunctions(toXY)) {
    if (j.name === fromName || j.name === toName) continue;
    const date = estimateDate();
    if (!date) return null;
    const [a, b] = await Promise.all([
      query(fromName, j.name, date).catch(() => { networkErr = true; return null; }),
      query(j.name, toName, date).catch(() => { networkErr = true; return null; }),
    ]);
    const legA = a && pickEstimateTrain(a.trains || []);
    const legB = b && pickEstimateTrain(b.trains || []);
    if (legA && legB) {
      return {
        perPerson: (legA.seat.price + legB.seat.price) * 2,
        note: `经${j.name}中转(${legA.t.code} ${legA.seat.label} + ${legB.t.code} ${legB.seat.label}),去程价×2`,
        via: j.name,
        queriedAt: new Date().toISOString(),
      };
    }
  }
  if (networkErr) throw new Error('中转估算有查询失败,不宜缓存空结果');
  return null;
}

// 会话级缓存(含 in-flight 去重):同一出发站→枢纽一次点击里只查一次 12306。
// 成功与"查明确实没车"都缓存;网络错误立即删掉,下次展开还能重试。
const estimateCache = new Map(); // key → { expires, pending }
// 这一层原先**没有 TTL**:存的是裸 Promise,一旦写入直到 force 才失效。
// 票价与乘车日期基本无关,所以长期缓存看着无害;但"会话内永不更新"不是我们想要的
// 语义(force 就是为重试准备的),补上与 queryTrains 同档的 TTL。
const ESTIMATE_TTL_MS = 10 * 60 * 1000;

async function cachedEstimate(key, fn) {
  sweepExpired(estimateCache);
  if (!estimateCache.has(key)) {
    const pending = fn().catch((e) => {
      estimateCache.delete(key);
      throw e;
    });
    estimateCache.set(key, { expires: Date.now() + ESTIMATE_TTL_MS, pending });
  }
  try {
    return await estimateCache.get(key).pending;
  } catch {
    return null; // 估算失败降级为"未含",不打断推荐与浏览
  }
}

// 严格版:查询失败时抛错(调用方可区分「确认无车」与「没查上」),force 绕过会话缓存重试
async function estimateRoundTripStrict(fromName, toName, toXY = null, { force = false } = {}) {
  const directKey = `${fromName}|${toName}`;
  const viaKey = `${directKey}|via`;
  if (force) {
    estimateCache.delete(directKey);
    estimateCache.delete(viaKey);
  }
  const direct = await cachedEstimate(directKey, async () => {
    const date = estimateDate();
    if (!date) return null;
    const { trains } = await queryTrains(fromName, toName, date);
    const hit = pickEstimateTrain(trains);
    if (!hit) return null;
    return {
      perPerson: hit.seat.price * 2,
      note: `${hit.t.code} ${hit.seat.label} 去程价×2`,
      queriedAt: new Date().toISOString(),
    };
  });
  if (direct || !toXY) return direct;
  return cachedEstimate(viaKey, () => transferEstimate(fromName, toName, toXY));
}

// 展示层入口:任何失败一律降级为 null,不打断推荐与浏览;要区分失败用 Strict 版
async function estimateRoundTrip(fromName, toName, toXY = null, opts = {}) {
  try {
    return await estimateRoundTripStrict(fromName, toName, toXY, opts);
  } catch {
    return null;
  }
}

module.exports = {
  queryTrains, resolveStation, parseTrain, parsePrices, parseStationJs,
  lishiHours, seatPreference, pickSeat, beyondPresale, PRESALE_DAYS,
  estimateDate, pickEstimateTrain, estimateRoundTrip, estimateRoundTripStrict,
  pickJunctions, transferEstimate, JUNCTIONS,
  cookieNeedsRefresh, dropCookies, COOKIE_TTL_MS,
  sweepExpired, QUERY_TTL_MS, ESTIMATE_TTL_MS,
};

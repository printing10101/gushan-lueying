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
  if (Object.keys(cookieJar).length > 0) return;
  const res = await fetchWithCookies(`${BASE}/otn/leftTicket/init?linktypeid=dc`);
  if (!res.ok) throw new Error(`12306 初始化失败: HTTP ${res.status}`);
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

async function queryTrains(fromName, toName, date, { force = false } = {}) {
  const key = `${fromName}|${toName}|${date}`;
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
      cache.set(key, { expires: Date.now() + 10 * 60 * 1000, result });
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

// 选座口径抽在 lib/seat.js(零依赖,渲染进程 <script> 复用同一实现),这里转发以维持原 API
const { lishiHours, seatPreference, pickSeat } = require('./seat');

// 12306 预售期现约 15 天:超期查询返回空列表,不提前说破会被误读成"无车"
const PRESALE_DAYS = 15;
function beyondPresale(dateStr, now = Date.now()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr || '')) return false;
  return dateStr > new Date(now + PRESALE_DAYS * 864e5).toISOString().slice(0, 10);
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

// 从一次余票查询里挑估算车次,口径与 planner.railLeg 一致(可购车次中优先选座有票的)
function pickEstimateTrain(trains) {
  const buyable = trains.filter((t) => t.canWebBuy);
  const withSeat = buyable.map((t) => ({ t, seat: pickSeat(t.prices, t.lishi) }))
    .filter((x) => x.seat);
  const seatOpen = (x) => {
    const v = x.t.seats[x.seat.label];
    return v && v !== '无';
  };
  return withSeat.find(seatOpen) || withSeat[0] || null;
}

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
// 成功与"查明确实没车"都缓存;网络错误不缓存,下次展开还能重试。
const estimateCache = new Map();

async function cachedEstimate(key, fn) {
  if (!estimateCache.has(key)) {
    const pending = fn().catch((e) => {
      estimateCache.delete(key);
      throw e;
    });
    estimateCache.set(key, pending);
  }
  try {
    return await estimateCache.get(key);
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
};

// 12306 余票查询。只用官方网页自己在调的公开接口,不登录、只读、低频。
// 票价直接编码在余票行的第 39 字段(座位代码+4位价格+5位标记,重复分组),
// 无需再调会 405 的 queryTicketPrice 接口。
// 字段序号若失效,用 npm run smoke:rail 打一次真实查询,对照原始返回调整。
const store = require('./store');

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

let cookieJar = {};

// 传输层:优先用 Electron net.fetch(真实 Chromium 网络栈,和官网页面一致);
// 纯 node 环境(单测/冒烟)退回全局 fetch,余票接口不受影响。
let electronNet = null;
try {
  const e = require('electron');
  if (e && typeof e === 'object' && e.net) electronNet = e;
} catch { /* 纯 node 环境 */ }

async function httpFetch(url, headers) {
  if (electronNet) {
    await electronNet.app.whenReady();
    return electronNet.net.fetch(url, { headers });
  }
  return fetch(url, { headers });
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

async function fetchWithCookies(url) {
  const res = await httpFetch(url, {
    'User-Agent': UA,
    'Referer': `${BASE}/otn/leftTicket/init`,
    'Accept': 'application/json, text/javascript, */*; q=0.01',
    'X-Requested-With': 'XMLHttpRequest',
    'If-Modified-Since': '0',
    'Cache-Control': 'no-cache',
    'Cookie': cookieHeader(),
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

async function queryTrains(fromName, toName, date) {
  const key = `${fromName}|${toName}|${date}`;
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.result;

  const [from, to] = await Promise.all([stationCode(fromName), stationCode(toName)]);
  await ensureCookies();

  const url = (ep) =>
    `${BASE}/otn/leftTicket/${ep}?leftTicketDTO.train_date=${date}` +
    `&leftTicketDTO.from_station=${from}&leftTicketDTO.to_station=${to}&purpose_codes=ADULT`;

  // 官方会随版本切换 query/queryG 等路径,逐个尝试直到拿到 JSON
  let lastErr = '全部查询路径均未返回有效数据';
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
      const result = { trains, stationNames: json.data.map, queriedAt: new Date().toISOString() };
      cache.set(key, { expires: Date.now() + 10 * 60 * 1000, result });
      return result;
    }
    lastErr = `${ep}: ${json.messages?.join(';') || 'status=false'}`;
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

module.exports = { queryTrains, resolveStation, parseTrain, parsePrices, parseStationJs };

// 分省今日油价(金投网 cngold.org 公开页,免 key、只读、低频)。
// 数据源纪律与 12306 相同:解析静态页面,页面改版会响亮失败——调用方(planner)
// 拿不到实价就回退 config 的油价并在预算备注言明,绝不编数。
const store = require('./store');
const { httpFetch } = require('./http');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const BASE = 'https://www.cngold.org/crude/';

// 省份 → 站点页面 slug(来自该站油价频道索引页;注意陕西是 sanxi、山西是 shanxi)
const PROVINCE_SLUG = {
  北京: 'beijing', 上海: 'shanghai', 天津: 'tianjin', 重庆: 'chongqing',
  河北: 'hebei', 山西: 'shanxi', 陕西: 'sanxi', 内蒙古: 'neimenggu',
  辽宁: 'liaoning', 吉林: 'jilin', 黑龙江: 'heilongjiang',
  江苏: 'jiangsu', 浙江: 'zhejiang', 安徽: 'anhui', 福建: 'fujian', 江西: 'jiangxi', 山东: 'shandong',
  河南: 'henan', 湖北: 'hubei', 湖南: 'hunan', 广东: 'guangdong', 广西: 'guangxi', 海南: 'hainan',
  四川: 'sichuan', 贵州: 'guizhou', 云南: 'yunnan', 西藏: 'xizang',
  甘肃: 'gansu', 青海: 'qinghai', 宁夏: 'ningxia', 新疆: 'xinjiang',
};

function todayStr() {
  const d = new Date();
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// "92#汽油" → "92#","0#柴油" → "0#","95号" → "95#"
function normalizeLabel(label) {
  const s = String(label).replace(/汽油|柴油/g, '').trim().replace(/号/g, '#');
  return s.includes('#') ? s : `${s}#`;
}

// 现价表(class="hq_table1"):表头座位标签与同一行的数值按列一一配对;
// 另从历史表抓最近一次调价日期,备注里给用户核对口径用。
function parseOilPage(html) {
  const start = html.indexOf('hq_table1');
  if (start < 0) return { prices: null, updatedOn: null };
  const seg = html.slice(start, html.indexOf('</table>', start));
  const labels = [...seg.matchAll(/<th>([^<]+)<\/th>/g)].map((m) => normalizeLabel(m[1]));
  const cells = [...seg.matchAll(/<td>\s*([0-9]+(?:\.[0-9]+)?)\s*<\/td>/g)].map((m) => Number(m[1]));
  const prices = {};
  labels.forEach((label, i) => {
    if (Number.isFinite(cells[i])) prices[label] = cells[i];
  });
  const dateM = html.match(/class="data">\s*(20\d\d-\d\d-\d\d)/);
  return { prices: Object.keys(prices).length ? prices : null, updatedOn: dateM ? dateM[1] : null };
}

// 当日落盘缓存(data/oilprice.json):一天最多打一次站点,应用重启也复用。
// prices 为 null 也缓存(站点改版当天不再反复打);网络异常不落盘,下次可重试。
function readDayCache() {
  const saved = store.read('oilprice');
  if (saved && saved.date === todayStr() && typeof saved.items === 'object') return saved.items;
  return {};
}

function writeDayCache(items) {
  store.write('oilprice', { date: todayStr(), items });
}

async function fetchProvince(province) {
  const slug = PROVINCE_SLUG[province];
  if (!slug) return null;
  const items = readDayCache();
  if (items[province] !== undefined) return items[province];

  const res = await httpFetch(`${BASE}${slug}.html`, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`油价页 ${province} HTTP ${res.status}`);
  const parsed = parseOilPage(await res.text());
  const entry = { ...parsed, fetchedAt: new Date().toISOString() };
  items[province] = entry;
  writeDayCache(items);
  return entry;
}

// 供规划预算用的口径:指定油种的当日实价,取不到返回 null(调用方回退 config)
async function forFuel(province, gasType = '92#') {
  try {
    const hit = await fetchProvince(province);
    const price = hit?.prices?.[gasType];
    if (!Number.isFinite(price)) return null;
    return { price, type: gasType, province, updatedOn: hit.updatedOn, fetchedAt: hit.fetchedAt };
  } catch {
    return null; // 网络失败不挡规划,预算备注会言明用的是 config 价
  }
}

module.exports = { PROVINCE_SLUG, parseOilPage, normalizeLabel, forFuel, fetchProvince, todayStr };

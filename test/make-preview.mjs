// 生成 test/preview.html:src/index.html 的镜像 + gushan 桥的假数据替身,
// 用于无 Key、无主进程环境下做视觉迭代。每次 src 改动后重新 `node test/make-preview.mjs`。
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const grading = require(path.join(root, 'lib', 'grading.js'));
const recommend = require(path.join(root, 'lib', 'recommend.js'));
const runos = require(path.join(root, 'lib', 'runos.js'));
const gear = require(path.join(root, 'lib', 'gear.js'));

const indexHtml = readFileSync(path.join(root, 'src', 'index.html'), 'utf8');
const regions = JSON.parse(readFileSync(path.join(root, 'data', 'regions.json'), 'utf8'));
const trailsRaw = JSON.parse(readFileSync(path.join(root, 'data', 'trails.json'), 'utf8'));
// 主进程 readData 会给 trails 附加 _grade 派生字段,预览替身保持同一行为
const trails = Object.fromEntries(Object.entries(trailsRaw).map(([id, t]) => [id, { ...t, _grade: grading.computeBreakdown(t) }]));

const pad = (x) => String(x).padStart(2, '0');
const dateAfter = (days) => {
  const d = new Date(Date.now() + days * 864e5);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
// 假行程固定在 2027-03 中旬:徒步日撞"错季",用来验收错季警告的展示
const TRIP_START = '2027-03-12';
const dateFrom = (base, days) => {
  const d = new Date(`${base}T00:00:00`);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

// 假行程:覆盖 drive/hike/rest/note 四种日程、票价齐全与缺失、坐席口径、时刻衔接警告、超限警示、预算未知项
const trip = {
  id: 'preview', input: { regionId: Object.keys(regions)[0], days: 7, startDate: TRIP_START, headcount: 2 },
  regionName: Object.values(regions)[0].name,
  trail: { name: '长坪沟穿越毕棚沟', grade: 4, maxAltM: 4250, start: { lng: 102.9, lat: 31.1 } },
  railOut: {
    chosen: { code: 'G2211', startTime: '07:26', arriveTime: '13:42', lishi: '06:16', seats: { 二等座: '有', 一等座: '12', 商务座: '6' } },
    seat: { label: '二等座', price: 387.5 },
    candidates: [
      { code: 'G2211', startTime: '07:26', arriveTime: '13:42', lishi: '06:16', seats: { 二等座: '有', 一等座: '12' }, prices: { 二等座: 387.5, 一等座: 619 }, seat: { label: '二等座', price: 387.5 } },
      { code: 'G2213', startTime: '09:05', arriveTime: '15:31', lishi: '06:26', seats: { 二等座: '有', 一等座: '无' }, prices: { 二等座: 387.5, 一等座: 619 }, seat: { label: '二等座', price: 387.5 } },
      { code: 'D1917', startTime: '11:44', arriveTime: '18:52', lishi: '07:08', seats: { 二等座: '21', 一等座: '9' }, prices: { 二等座: 319, 一等座: 511 }, seat: { label: '二等座', price: 319 } },
      { code: 'K1363', startTime: '22:02', arriveTime: '11:19+1', lishi: '13:17', seats: { 硬座: '有', 硬卧: '8' }, prices: { 硬座: 152.5, 硬卧: 279.5 }, seat: { label: '硬卧', price: 279.5 } },
    ],
    prices: { 二等座: 387.5, 一等座: 619 },
    fromStation: '西安北', toStation: '成都东', date: TRIP_START,
    evidence: { note: '预览假数据', fields: 39 },
  },
  schedule: [
    { type: 'drive', date: dateFrom(TRIP_START, 1), overKm: false,
      lateArrival: { time: '13:42', station: '成都东' },
      legs: [
        { from: '成都东', to: '四姑娘山镇', km: 230, hours: 4.5, costs: { driveTotal: 316 },
          path: '104.066,30.657;103.9,30.9;103.6,31.0;103.2,31.05;102.912,31.099' },
        { from: '四姑娘山镇', to: '丹巴', km: 112, hours: 2.6, costs: { driveTotal: 153 } },
      ] },
    { type: 'hike', date: dateFrom(TRIP_START, 2), trail: 'mock-trail', seasonWarn: '3 月不在最佳月份(10、11 月)内,风景和路况可能打折', info: {
      name: '长坪沟穿越毕棚沟', climbM: 1800, grade: 4, gradeLabel: '高难', id: 'mock-trail',
      supplies: '日隆镇可补给,营地无水源', summary: '川西经典长线穿越,翻垭口后下行至毕棚沟,秋色极盛。' } },
    { type: 'rest', date: dateFrom(TRIP_START, 3) },
    { type: 'drive', date: dateFrom(TRIP_START, 4), overKm: true,
      earlyDepart: { time: '09:12' },
      legs: [
        { from: '丹巴', to: '新都桥', km: 150, hours: 3.2, costs: { driveTotal: 205 } },
        { from: '新都桥', to: '稻城', km: 380, hours: 7.5, costs: { driveTotal: 520 } },
      ] },
  ],
  gear: gear.gearChecklist(
    { days: 2, type: '长线重装', maxAltM: 4250, techLevel: 1,
      summary: '川西经典长线穿越,翻垭口后下行至毕棚沟',
      risks: ['垭口天气多变'], supplies: '日隆镇可补给,营地无水源' },
    { summitMin: -6, maxHikePrecip: 70 }),
  railBack: {
    chosen: { code: 'K118', startTime: '21:05', arriveTime: '07:40+1', lishi: '10:35', seats: {} },
    prices: null,
    fromStation: '成都西', toStation: '西安', date: dateFrom(TRIP_START, 6),
    seats: {}, evidence: { note: '预览假数据:价格未知分支' },
  },
  budget: {
    items: [
      { name: '火车去程', amount: 775, note: 'G2211 二等座 ×2人' },
      { name: '火车回程', amount: null, note: 'K118,票价字段缺失,请核对' },
      { name: '自驾 成都→四姑娘山镇', amount: 316, note: '油费约186 + 过路费130' },
      { name: '自驾 四姑娘山镇→丹巴', amount: 153, note: '油费约112 + 过路费41' },
      { name: '徒步费用 长坪沟', amount: 270, note: '来自线路库门票字段 ×2 人,观光车/马帮另计' },
      { name: '住宿 6 晚', amount: 1200, note: '估算:1 间 × ¥200/晚 × 6 晚(默认估算,config.json 可改)' },
      { name: '餐饮 7 天', amount: 1120, note: '估算:¥80/人/天 × 2 人(默认估算,config.json 可改)' },
    ],
    total: 3834, headcount: 2, perPerson: 1917, unknownCount: 1,
  },
  weather: {
    node: '四姑娘山镇',
    forecast: Array.from({ length: 16 }, (_, i) => {
      const labels = ['晴', '小雨', '阴', '中雨', '雨夹雪', '小雪'];
      const verdicts = ['宜', '不宜', '观察', '不宜', '宜', '观察'];
      return {
        date: dateFrom(TRIP_START, i), label: labels[i % labels.length],
        tempMin: 2 + (i % 5), tempMax: 14 + (i % 7), precipProb: [10, 70, 45, 70, 30, 15][i % 6],
        windMax: [8, 15, 25, 42, 12, 30][i % 6],
        verdict: verdicts[i % verdicts.length],
        elevation: 3200,
      };
    }),
  },
  savedTo: 'data/trips/preview.json',
};

// 假档案列表:覆盖正常条目与损坏条目两种分支
const archives = [
  { id: '20260920-chuanxi', regionName: '川西小环线', days: 7, startDate: dateAfter(-14),
    total: 3120, trailName: '长坪沟穿越毕棚沟', generatedAt: `${dateAfter(-14)}T21:04:11.220Z` },
  { id: '20260905-chuanxi', regionName: '川西小环线', days: 5, startDate: dateAfter(-28),
    total: 1980, trailName: null, generatedAt: `${dateAfter(-28)}T10:22:40.105Z` },
  { id: 'broken-archive', error: '存档无法解析: Unexpected token } in JSON' },
];

// 假推荐:固定条件(雪山+湖泊、预算 3000)的真实打分结果,验收推荐页样式足够;
// 预览页是静态的,表单改条件不会重算,这是替身的已知边界
const ranked = recommend.rank({ budget: 3000, maxDays: null, scenery: ['雪山', '湖泊'] }, trails, {});

// 假身体状态:端点 fixture 按真实字段名捏造,但走真实的 compose+match 链路,
// 预览页即可验收状态条与三档徽章(耐力 62/爬坡 55 → 上限 ★3:★1-2 适合、★3 有挑战、★4+ 超纲)
const bodyState = runos.composeBodyState({
  trainingStatus: {
    daily: [], baselines: {}, acwr: 1.05, fitness: 48, fatigue: 41, form: 7,
    recovery_time_h: 9,
    status: { key: 'productive', label: '效率良好', detail: '近 16 周 VDOT 趋势 +0.5,训练正在产生回报' },
    readiness: { score: 74, components: [], verdict: '状态良好,正常训练' },
    endurance_score: { score: 62, label: '中等', detail: '周均 32km' },
    hill_score: { score: 55, label: '坡感良好', detail: '周均爬升 280m' },
    athlete: { name: '预览跑者', max_hr: 195, resting_hr: 54, hrv_baseline: 48 },
  },
  metrics: {
    empty: false,
    metrics: [{
      date: dateAfter(-1), weight_kg: null, resting_hr: 52, hrv_rmssd: 52,
      sleep_hours: 7.2, body_fat_pct: null, sleep_score: 85, spo2: null,
      resp_rate: null, stress: 28, body_battery: 72, recovery_pct: 92,
      recovery_level: '', recovery_hours: 0,
    }],
    baseline: {},
  },
  checkin: { advice: { level: 'normal', verdict: '主观状态良好,可以按计划执行' } },
  connections: { connections: [{ platform: 'coros', last_sync_at: `${dateAfter(0)}T08:30:00` }] },
}, trails);

const mockScript = `<script>
// 预览替身:由 test/make-preview.mjs 生成,勿手改
window.gushan = {
  async readData(name) {
    if (name.startsWith('trips/')) {
      return name === 'trips/20260920-chuanxi' ? ${JSON.stringify(trip)} : null;
    }
    const data = { config: {}, regions: ${JSON.stringify(regions)}, trails: ${JSON.stringify(trails)}, marks: {} };
    return data[name];
  },
  async recommendTrails() { return ${JSON.stringify(ranked)}; },
  async runosState() { return ${JSON.stringify(bodyState)}; },
  async listTrips() { return ${JSON.stringify(archives)}; },
  async deleteTrip(id) { return { ok: true }; },
  async writeData() { return { ok: true }; },
  async generateTrip() { return ${JSON.stringify(trip)}; },
  async queryTrains() {
    return { trains: [
      { code: 'K5901', startTime: '08:10', arriveTime: '14:02', lishi: '05:52', canWebBuy: true,
        seats: { 硬座: '有' }, prices: { 硬座: 141.5 } },
      { code: 'T7', startTime: '16:05', arriveTime: '06:20+1', lishi: '14:15', canWebBuy: true,
        seats: { 硬卧: '12', 硬座: '有' }, prices: { 硬座: 152.5, 硬卧: 279.5 } },
    ] };
  },
  async exportTrip() { return { canceled: true }; },
  async resolveStation(kw) {
    return [{ name: kw + '站' }, { name: '成都东' }, { name: '西安北' }];
  },
};
</scr` + `ipt>`;

const previewHtml = indexHtml
  // 预览页在 test/ 下,相对引用改为 ../src/;带时间戳防 Chromium 缓存旧样式
  .replace('href="style.css"', `href="../src/style.css?v=${Date.now()}"`)
  .replace('<script src="app.js"></script>', `${mockScript}\n  <script src="../src/app.js?v=${Date.now()}"></script>`);
writeFileSync(path.join(root, 'test', 'preview.html'), previewHtml);
console.log(`test/preview.html 已生成(${regions && Object.keys(trails).length} 条线路可用)`);

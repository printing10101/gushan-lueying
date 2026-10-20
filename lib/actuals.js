// 实走记录 vs 规划值的差。纯函数,主进程 require、渲染进程经 <script> 挂 window.GushanLib.actuals。
//
// 背景:data/marks.json 已经记了哪天走过(doneAt),但没记"实际走了多少"。
// 而 trails.json 的 days/distanceKm/climbM 没有 source 字段,是抄来的数——走过一次
// 正好是唯一能拿到真值的时刻。本模块把两侧对齐成可判的差值,给卡片显示、给待核清单挑可疑条目。
//
// 三态口径(与 lib/risknotes.js 同一路数:没填不打扰,填了错要吭一声,算不出就不给):
//   没填(undefined/null) → 跳过,不进 rows 也不进 bad
//   填了但非法(非有限数 / <=0) → 进 bad,UI 提示去改 data/marks.json
//   规划值不可用(非有限数 / <=0) → 跳过该行:算不出差就不猜,更不做除零
// 规划值一律要求 number 类型:Number.isFinite('120') 是 false,手改成字符串会当场没行,
// 而不是被隐式转换蒙混过去。

const REVIEW_PCT = 15; // |差| 超过这个百分比 → 标待复核(判据钉在 >15,不是 >=15)

const ACTUAL_METRICS = [
  { key: 'days', actualKey: 'actualDays', label: '天数', unit: '天' },
  { key: 'distanceKm', actualKey: 'actualDistanceKm', label: '里程', unit: 'km' },
  { key: 'climbM', actualKey: 'actualClimbM', label: '累计爬升', unit: 'm' },
];

// → { rows: [{key,label,unit,planned,actual,diffPct,review}], bad: [字段名] }
function actualVsPlanned(trail, mark) {
  const rows = [];
  const bad = [];
  if (!trail || !mark) return { rows, bad };
  for (const m of ACTUAL_METRICS) {
    const raw = mark[m.actualKey];
    if (raw === undefined || raw === null) continue; // 没填:不打扰
    if (!Number.isFinite(raw) || raw <= 0) { bad.push(m.actualKey); continue; }
    const planned = trail[m.key];
    if (!Number.isFinite(planned) || planned <= 0) continue; // 规划值不可用:不给假差值
    const diffPct = Math.round(((raw - planned) / planned) * 100);
    rows.push({
      key: m.key,
      label: m.label,
      unit: m.unit,
      planned,
      actual: raw,
      diffPct,
      review: Math.abs(diffPct) > REVIEW_PCT,
    });
  }
  return { rows, bad };
}

// 实花输入解析:提示语写"留空取消",空串就必须真的取消——Number('') === 0,
// 直接把空串送进数字校验会静默记一笔 ¥0,污染校准数据。
function parseActualCostInput(input) {
  if (typeof input !== 'string' || !input.trim()) return { cancel: true };
  const n = Number(input.trim());
  if (!Number.isFinite(n) || n < 0) return { error: '请输入非负数字' };
  return { value: Math.round(n) };
}

const api_actuals = { actualVsPlanned, parseActualCostInput, REVIEW_PCT, ACTUAL_METRICS };
if (typeof module !== 'undefined') module.exports = api_actuals;
else (window.GushanLib = window.GushanLib || {}).actuals = api_actuals;

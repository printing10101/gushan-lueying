// 风险出处的口径。纯函数,主进程 require、渲染进程经 <script> 挂 window.GushanLib.risknotes。
//
// 背景:trails.json 的 risks 覆盖 167/191 条,但全是无出处的描述句,是全库唯一不带来源
// 口径的字段。riskNotes 是它的**平行**字段(不是替代):lib/gear.js:16 与 lib/quickfacts.js:18
// 都在对 risks 做字符串拼接推导,把 risks 改成对象数组会连带打碎那两个模块的装备/补给判定。
//
// 三条口径:
// 1) 填不出 source 的条目 verified=false,UI 显示「未核实」——不给"看起来有出处"的错觉。
// 2) 脏条目(非对象 / text 空白)计入 dirty 而不是被 filter 掉。INSTINCTS 里那条教训:
//    把脏值悄悄收干净,等于告诉用户"这里没问题"。dirty 由 scripts 汇总成待核清单。
// 3) 本模块不产数据。风险出处必须人核对后手填,任何"由模型补全"都算编造。

const YEAR_MIN = 1900; // 再早的攀登记录不进这个口径
const YEAR_MAX_SLACK = 1; // 次年的年度报告可能提前流出,放一年余量

function validYear(y) {
  if (!Number.isInteger(y)) return null; // '2023' 这种字符串年份一律拒,不做隐式转换
  const max = new Date().getFullYear() + YEAR_MAX_SLACK;
  return y >= YEAR_MIN && y <= max ? y : null;
}

// → { items: [{text, source, year, verified}], dirty }
// riskNotes 缺失 → items 空、dirty 0(向后兼容:当前全库 191 条都还没这个字段);
// riskNotes 存在但不是数组 → 视为一条脏数据(有人手改 JSON 改错了形状)。
function normalizeRiskNotes(trail) {
  const raw = trail && trail.riskNotes;
  if (!Array.isArray(raw)) {
    return { items: [], dirty: raw === undefined || raw === null ? 0 : 1 };
  }
  const items = [];
  let dirty = 0;
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') { dirty += 1; continue; }
    const text = typeof entry.text === 'string' ? entry.text.trim() : '';
    if (!text) { dirty += 1; continue; }
    const source = typeof entry.source === 'string' ? entry.source.trim() : '';
    items.push({
      text,
      source: source || null,
      year: validYear(entry.year),
      verified: Boolean(source),
    });
  }
  return { items, dirty };
}

// 汇总一批线路,供待核清单脚本与测试用。total 恒等于 withSource + withoutSource,
// 这条等式本身就是防线:任何一侧漏计都会立刻红。
function riskNotesSummary(trails) {
  let total = 0;
  let withSource = 0;
  let withoutSource = 0;
  let dirty = 0;
  for (const t of (trails || [])) {
    const r = normalizeRiskNotes(t);
    dirty += r.dirty;
    for (const item of r.items) {
      total += 1;
      if (item.verified) withSource += 1;
      else withoutSource += 1;
    }
  }
  return { total, withSource, withoutSource, dirty };
}

const api_risknotes = { normalizeRiskNotes, riskNotesSummary, validYear };
if (typeof module !== 'undefined') module.exports = api_risknotes;
else (window.GushanLib = window.GushanLib || {}).risknotes = api_risknotes;

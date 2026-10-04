// bestSeason 文本 → 结构化 bestMonths(数字月份数组)。
// trails.json 里 bestSeason 是给人读的("6月中-9月底"、"10月中旬-11月上旬(秋色)、5-6月(春花)"),
// 错季提醒和自动选线需要结构化月份;逐条手标只有 11/187,这里把机械可解析的部分批量转出来。
// 解析不了的返回 null(宁缺毋编,不猜);已有手标 bestMonths 的条目以人工为准,解析器不覆盖。

const SEASON_MONTHS = { 春: [3, 4, 5], 夏: [6, 7, 8], 秋: [9, 10, 11], 冬: [12, 1, 2] };

function clampMonth(n) {
  return Number.isInteger(n) && n >= 1 && n <= 12 ? n : null;
}

// a..b 闭区间;b < a 视为跨年(11月-次年3月 → 11,12,1,2,3)。
// a/b 越界(0、13+)整段作废,交给调用方的单月兜底,绝不硬夹。
function addRange(months, a, b) {
  if (!clampMonth(a) || !clampMonth(b)) return false;
  for (let m = a, i = 0; i < 13; m++, i++) {
    months.add(((m - 1) % 12 + 12) % 12 + 1);
    if ((((m - 1) % 12) + 12) % 12 === (((b - 1) % 12) + 12) % 12) return true;
  }
  return false;
}

// 单段("10月中旬-11月上旬"、"5-6月"、"冬季"、"全年") → 月份集合
function parseSegment(seg) {
  const months = new Set();
  const range = seg.match(/(\d{1,2})\s*月[^0-9]*?[-—~至到]\s*(?:次年|翌年|第二年)?\s*(\d{1,2})\s*月/);
  if (range) {
    addRange(months, +range[1], +range[2]);
    return months;
  }
  // "5-6月" 短横写法(月字只在末尾出现一次)
  const dashShort = seg.match(/(\d{1,2})\s*[-—~至到]\s*(?:次年|翌年)?\s*(\d{1,2})\s*月/);
  if (dashShort) {
    addRange(months, +dashShort[1], +dashShort[2]);
    return months;
  }
  const season = seg.match(/[春夏秋冬]/);
  if (season && /季/.test(seg)) {
    for (const m of SEASON_MONTHS[season[0]]) months.add(m);
    return months;
  }
  for (const m of seg.matchAll(/(\d{1,2})\s*月/g)) {
    const ok = clampMonth(+m[1]);
    if (ok) months.add(ok);
  }
  return months;
}

// 全文 → 月份升序数组;全无月份信息(如"全年""四季皆宜")返回 null——
// 全年皆宜等于不存在错季,标注 null 与"没标注"在下游行为一致。
function parseBestSeason(text) {
  if (!text) return null;
  if (/全年|四季/.test(text)) return null;
  const months = new Set();
  for (const seg of String(text).split(/[、,，;；]/)) {
    for (const m of parseSegment(seg)) months.add(m);
  }
  return months.size ? [...months].sort((a, b) => a - b) : null;
}

module.exports = { parseBestSeason };

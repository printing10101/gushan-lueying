// 出发前的"离线包":一次产出一趟行程上路需要的全部文件(山区没网,一次拿全比来回点四次靠谱)。
//
// 纯函数(给定 trip/region 就返回文件名与内容),写盘交给主进程——这样内容能在单测里逐项钉住。
// 与界面上的"导出 Markdown / 导出 GPX / 打印"共用同一套实现,不另抄一份。
//
// 四个文件与理由:
//   行程.md      —— 逐日安排、预算、天气、日照窗口;手机上直接看
//   驾车轨迹.gpx —— 导进两步路/手表;含徒步起点路点
//   行前清单.md  —— 装备(带触发原因)、一次性开销、补给/风险/报备;打勾用
//   存档.json    —— 生成时的原始数据副本,回来后还能比对/复现
const gpx = require('./gpx');
const markdown = require('./trip-markdown');
const budget = require('./budget');
const permit = require('./permit');
const risknotes = require('./risknotes');
const gear = require('./gear');

// 目录名:日期 + 区域名(去掉文件系统非法字符与空白),便于在文件管理器里排序与辨认
function packDirName(trip) {
  const date = String((trip && trip.input && trip.input.startDate) || '').replace(/-/g, '');
  const region = String((trip && trip.regionName) || '行程').replace(/[\\/:*?"<>|\s]+/g, '');
  return `${date}-${region}-离线包`;
}

// 行前清单:装备 + 一次性开销 + 该线路的补给/风险/报备。数据缺就少写那一段,不留空壳标题。
function checklistMarkdown(trip, opts = {}) {
  const t = trip || {};
  const allTrails = Array.isArray(t.trails) && t.trails.length
    ? t.trails
    : (t.trail ? [t.trail] : []);
  const trail = allTrails[0] || null;
  const lines = [`# 行前清单 · ${t.regionName || ''} · ${(t.input && t.input.days) || '?'} 天`, ''];
  if (trail) {
    const labels = allTrails.map((tr) => {
      const label = (opts.gradeLabels || {})[tr.grade] || '';
      return `${tr.name}(★${tr.grade == null ? '?' : tr.grade} ${label})`;
    });
    lines.push(`线路:${labels.join(' / ')}`, '');
  }

  const items = t.gear || [];
  if (items.length) {
    lines.push(`## 装备(${items.length} 项,每条附触发原因)`, '');
    for (const i of items) lines.push(`- [ ] ${i.item} —— ${i.reason}`);
    lines.push('');
  }
  const oneTime = [];
  for (const tr of allTrails) {
    for (const item of budget.oneTimeCosts(tr, { date: (t.input && t.input.startDate) || null })) {
      oneTime.push({ ...item, trailName: allTrails.length > 1 ? tr.name : null });
    }
  }
  if (oneTime.length) {
    lines.push('## 一次性开销(只列要不要准备,不给金额)', '');
    for (const i of oneTime) {
      const who = i.trailName ? `(${i.trailName})` : '';
      lines.push(`- ${i.item}${who} —— ${i.reason}(${i.amountNote})`);
    }
    lines.push('');
  }
  for (const tr of allTrails) {
    const suffix = allTrails.length > 1 ? ` · ${tr.name}` : '';
    if (tr.supplies) lines.push(`## 补给${suffix}`, '', `${tr.supplies}`, '');
    if (Array.isArray(tr.risks) && tr.risks.length) {
      lines.push(`## 风险${suffix}`, '');
      for (const r of tr.risks) lines.push(`- ${r}`);
      lines.push('');
    }
    const rn = risknotes.normalizeRiskNotes(tr);
    if (rn.items.length) {
      lines.push(`## 风险出处${suffix}`, '');
      for (const r of rn.items) {
        const src = r.verified ? `出处:${r.source}${r.year ? `(${r.year})` : ''}` : '未核实(缺出处)';
        lines.push(`- ${r.text} —— ${src}`);
      }
      lines.push('');
    }
    const pn = permit.permitNotice(tr);
    if (pn) lines.push(`## 报备${suffix}`, '', pn, '');
  }
  // 日照:取徒步日那条(优先逐日锚点),算不出就不写这一段
  const byDate = (t.weather && t.weather.byDate) || {};
  const wxForHike = (t.schedule || []).filter((d) => d.type === 'hike')
    .map((d) => byDate[d.date] || ((t.weather && t.weather.forecast) || []).find((x) => x.date === d.date))
    .find(Boolean) || null;
  const dl = (opts.daylightOf || gear.daylightPlan)(wxForHike);
  if (dl) {
    lines.push('## 日照', '', `日出 ${dl.sunrise} → 日落 ${dl.sunset}(约 ${dl.hours}h),建议 ${dl.lastLight} 前收队`, '');
  }
  lines.push('> 门票/住宿/餐饮的估算口径见行程.md 的预算表;实价以出发前复核为准。');
  return lines.join('\n');
}

// → [{ name, content }]
function packFiles(trip, region = null, opts = {}) {
  const mdOpts = {
    gradeLabels: opts.gradeLabels || {},
    seatOf: opts.seatOf || (() => null),
    daylightOf: opts.daylightOf || gear.daylightPlan,
    // 旧档名(经济/舒适)映射只用 budget 的一份表,不在导出侧另抄
    tierAlias: budget.TIER_ALIAS,
  };
  return [
    { name: '行程.md', content: markdown.tripToMarkdown(trip, mdOpts) },
    { name: '驾车轨迹.gpx', content: gpx.tripToGpx(trip, region) },
    { name: '行前清单.md', content: checklistMarkdown(trip, opts) },
    { name: '存档.json', content: `${JSON.stringify(trip, null, 1)}\n` },
  ];
}

module.exports = { packFiles, packDirName, checklistMarkdown };

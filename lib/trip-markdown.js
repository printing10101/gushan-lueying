// 行程 → Markdown 导出(纯函数,零依赖):node 侧可单测,渲染进程经 <script> 挂 GushanLib。
// 依赖注入:gradeLabels(难度星级文案)与 seatOf(旧档缺 seat 时的兜底选座)由调用方传入,
// 与 lib/grading.js、lib/seat.js 保持同一实现而不必反向依赖它们。

function tripToMarkdown(trip, { gradeLabels = {}, seatOf = () => null } = {}) {
  const lines = [];
  lines.push(`# ${trip.regionName} · ${trip.input.days} 天`);
  lines.push('');
  lines.push(`- 出发:${trip.input.startDate} | ${trip.input.headcount} 人 | 出发站 ${trip.input.originStation || '—'}`);
  if (trip.trail) lines.push(`- 徒步:${trip.trail.name}(★${trip.trail.grade} ${gradeLabels[trip.trail.grade] || ''})`);
  lines.push(`- 生成:${String(trip.generatedAt || '').slice(0, 16).replace('T', ' ')} | 存档 data/trips/${trip.id}.json`);
  lines.push('');
  lines.push('## 逐日安排');
  lines.push('');
  for (const day of trip.schedule) {
    lines.push(`### ${day.date} · ${{ drive: '驾车', hike: '徒步', rest: '休整', note: '提示' }[day.type] || day.type}`);
    if (day.type === 'drive') {
      if (day.lateArrival) lines.push(`> ⚠ 去程 ${day.lateArrival.time} 才到 ${day.lateArrival.station},首日驾车时间紧张`);
      if (day.earlyDepart) lines.push(`> ⚠ 回程 ${day.earlyDepart.time} 即发车,末日别排长驾`);
      for (const l of day.legs) {
        lines.push(`- ${l.from} → ${l.to}:${l.km}km / ${l.hours}h,油+过路 ¥${l.costs.driveTotal}`);
      }
      if (day.overKm) lines.push('> ⚠ 当日驾车超过单日上限,行程偏紧');
    } else if (day.type === 'hike') {
      const t = day.info || {};
      lines.push(`- ${t.name || day.trail}:约 ${t.climbM}m 爬升 · ★${t.grade} ${t.gradeLabel || ''}`);
      if (t.summary) lines.push(`  ${t.summary}`);
      if (day.seasonWarn) lines.push(`> ⚠ ${day.seasonWarn}`);
    } else if (day.type === 'rest') {
      lines.push('- 机动休整:高反适应或天气避让,食宿照常');
    } else {
      lines.push(`- ${day.text}`);
    }
    lines.push('');
  }
  for (const [label, leg] of [['去程火车', trip.railOut], ['回程火车', trip.railBack]]) {
    if (!leg?.chosen) { lines.push(`## ${label}:没有可购车次`); continue; }
    const seat = leg.seat || seatOf(leg.prices, leg.chosen.lishi);
    lines.push(`## ${label}:${leg.chosen.code} ${leg.chosen.startTime}→${leg.chosen.arriveTime}${seat ? `(${seat.label} ¥${seat.price}/人)` : ''}`);
    lines.push('');
  }
  lines.push('## 预算');
  lines.push('');
  lines.push('| 项目 | 金额 | 说明 |');
  lines.push('|---|---|---|');
  for (const b of trip.budget.items) {
    lines.push(`| ${b.name} | ${b.amount === null ? '未知' : `¥${b.amount}`} | ${b.note || ''} |`);
  }
  lines.push(`| **合计** | **¥${trip.budget.total}** | ${trip.input.headcount} 人 · 人均 ¥${trip.budget.perPerson} |`);
  lines.push('');
  const hikes = trip.schedule.filter((d) => d.type === 'hike').map((d) => d.date);
  const wxOf = (date) => (trip.weather?.forecast || []).find((x) => x.date === date);
  if (hikes.length) {
    lines.push(`## 徒步日天气(${trip.weather?.node || ''})`);
    lines.push('');
    for (const date of hikes) {
      const wx = wxOf(date);
      if (wx) lines.push(`- ${date}:${wx.label} ${wx.tempMin}~${wx.tempMax}℃,降水 ${wx.precipProb}% → ${wx.verdict}`);
    }
    lines.push('');
  }
  lines.push('> 票价/油费/过路费来自查询原值;住宿与餐饮为 config 口径估算;实价以出发前复核为准。');
  return lines.join('\n');
}

const api_tripMarkdown = { tripToMarkdown };
if (typeof module !== 'undefined') module.exports = api_tripMarkdown;
else (window.GushanLib = window.GushanLib || {}).tripMarkdown = api_tripMarkdown;

// 行程 → Markdown 导出(纯函数,零依赖):node 侧可单测,渲染进程经 <script> 挂 GushanLib。
// 依赖注入:gradeLabels(难度星级文案)与 seatOf(旧档缺 seat 时的兜底选座)由调用方传入,
// 与 lib/grading.js、lib/seat.js 保持同一实现而不必反向依赖它们。

// daylightOf(wx) 由调用方注入(见 app.js 传 LIB.gear.daylightPlan):本模块零依赖,
// 不能 require gear——那会把整条依赖链带进渲染端(与 gradeLabels/seatOf 同一套做法)。
// tierAlias 同理(别名表在 lib/budget.TIER_ALIAS):只注入表,不 require,免得手抄一份旧档名映射。
// 生成时间是 UTC ISO;打印稿要看本地时间,不能直接 slice(0,16) 把 UTC 当本地。
function localDateTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    + ` ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function tripToMarkdown(trip, { gradeLabels = {}, seatOf = () => null, daylightOf = () => null, tierAlias = {} } = {}) {
  const lines = [];
  lines.push(`# ${trip.regionName} · ${trip.input.days} 天`);
  lines.push('');
  lines.push(`- 出发:${trip.input.startDate} | ${trip.input.headcount} 人 | 出发站 ${trip.input.originStation || '—'}`);
  const allTrails = trip.trails && trip.trails.length ? trip.trails : (trip.trail ? [trip.trail] : []);
  for (const t of allTrails) {
    lines.push(`- 徒步:${t.name}(★${t.grade} ${gradeLabels[t.grade] || ''})`);
  }
  lines.push(`- 生成:${localDateTime(trip.generatedAt)} | 存档 data/trips/${trip.id}.json`);
  // 口径随行程带走:打印出来的人要知道票价是不是占位估算、天气标的是哪个点
  if (trip.railNote) lines.push(`> ⚠ ${trip.railNote}`);
  if (trip.weather?.byDateError) {
    lines.push(`> 逐日天气锚点未取到(${trip.weather.byDateError}),下列天气按徒步点「${trip.weather.node}」的单点预报。`);
  }
  // 里程口径随行程带走:打印出来的人需要知道这些公里数是估算还是实测、过路费是不是估的
  if (trip.kmNote) {
    lines.push(`> 里程口径:${trip.kmNote}`);
  } else if (trip.distanceEstimated) {
    lines.push('> ⚠ 里程为直线×1.3 估算(未配置路线 Key),过路费按 0.45 元/km 估');
  }
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
      for (const l of day.legs.filter((x) => x.detour)) {
        lines.push('> ⚠ ' + l.from + '→' + l.to + ' 真实里程是直线距离的 ' + l.detour.ratio + ' 倍(' + l.detour.straightKm + 'km → ' + l.km + 'km):路网里近路可能不通,本段建议单独核实');
      }
      if (day.overKm) lines.push('> ⚠ 当日驾车超过单日上限,行程偏紧');
    } else if (day.type === 'hike') {
      const t = day.info || {};
      lines.push(`- ${t.name || day.trail}:约 ${t.climbM}m 爬升 · ★${t.grade} ${t.gradeLabel || ''}`);
      if (t.summary) lines.push(`  ${t.summary}`);
      // 注意别用 wxOf:它在这个位置还没定义(const 有 TDZ),这里直接按日期取
      const wxToday = trip.weather?.byDate?.[day.date]
        || (trip.weather?.forecast || []).find((x) => x.date === day.date);
      const dl = daylightOf(wxToday);
      if (dl) {
        lines.push(`- 日照窗口 ${dl.sunrise} → ${dl.sunset}(约 ${dl.hours}h),建议 ${dl.lastLight} 前收队`);
      }
      if (day.seasonWarn) lines.push(`> ⚠ ${day.seasonWarn}`);
    } else if (day.type === 'rest') {
      lines.push(day.spare ? '- 机动/备用日:天数留白,给天气、路况或体力消耗;食宿照常'
        : '- 机动休整:高反适应或天气避让,食宿照常');
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
  // 住宿档次**总是**写明(旧档没有 tier 字段 → 回「客栈」,那正是它当时实际用的档)。
  // 与页面表头刻意不同:表头只在非基准档才写(避免噪音),而打印稿的读者点不开控件、
  // 反查不到这一档,而它就长在这个数字里。口径要说全的地方,宁可冗余。
  const tier = tierAlias[trip.input?.tier] || trip.input?.tier || '客栈';
  lines.push(`> 住宿按「${tier}档」估算、餐饮按 config 口径估算;票价/油费/过路费来自查询原值;实价以出发前复核为准。`);
  lines.push('');
  const hikes = trip.schedule.filter((d) => d.type === 'hike').map((d) => d.date);
  const wxOf = (date) => (trip.weather?.forecast || []).find((x) => x.date === date);
  if (hikes.length) {
    lines.push(`## 徒步日天气(${trip.weather?.node || ''})`);
    lines.push('');
    for (const date of hikes) {
      const at = trip.weather?.byDate?.[date]?.at;
      const wx = trip.weather?.byDate?.[date] || wxOf(date);
      if (wx) lines.push(`- ${date}:${wx.label} ${wx.tempMin}~${wx.tempMax}℃,降水 ${wx.precipProb}% → ${wx.verdict}${at ? `(${at} 预报)` : ''}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

const api_tripMarkdown = { tripToMarkdown };
if (typeof module !== 'undefined') module.exports = api_tripMarkdown;
else (window.GushanLib = window.GushanLib || {}).tripMarkdown = api_tripMarkdown;

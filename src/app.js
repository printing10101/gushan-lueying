// 渲染进程入口:纯 JS,通过 preload 暴露的 window.gushan 与主进程通信。
const $ = (id) => document.getElementById(id);

// 难度星级文案,与 lib/grading.js 保持一致(渲染进程拿不到 require,只在展示层用)
const GRADE_LABELS = { 1: '休闲', 2: '入门', 3: '进阶', 4: '高难', 5: '极限' };

let map = null;
let regionOverlay = null;
let tripOverlay = null;

async function init() {
  initTabs();
  initLibrary();
  const cfg = await gushan.readData('config');
  if (cfg?.amapKeyJs) {
    await loadAmap(cfg.amapKeyJs);
    initMap();
  } else {
    $('config-hint').textContent = '未配置高德 Key:请在 data/config.json 填入 amapKeyJs(地图)与 amapKeyWeb(路径规划)';
    $('map').innerHTML = '<p class="muted" style="padding:20px">地图需要高德 JS API Key,填写后重启应用</p>';
  }

  const regions = await gushan.readData('regions') || {};
  for (const [id, r] of Object.entries(regions)) {
    $('region').append(new Option(r.name, id));
  }
  $('region').onchange = () => drawRegion(regions[$('region').value]);
  drawRegion(regions[$('region').value]);

  const trails = await gushan.readData('trails') || {};
  const regionId = $('region').value;
  for (const [id, t] of Object.entries(trails)) {
    if (t.regionId === regionId) {
      $('trail').append(new Option(`${t.name}(★${t.grade} ${t._grade.label})`, id));
    }
  }

  const d = new Date(Date.now() + 7 * 864e5);
  const pad = (x) => String(x).padStart(2, '0');
  $('start-date').value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  // 出发站输入:输入 2+ 字后联想
  let searchTimer = null;
  $('origin').oninput = () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      const kw = $('origin').value.trim();
      if (kw.length < 2) return;
      try {
        const hits = await gushan.resolveStation(kw);
        $('station-list').innerHTML = '';
        for (const h of hits) $('station-list').append(new Option(h.name, h.name));
      } catch { /* 联想失败不打扰用户,查询时会正式报错 */ }
    }, 300);
  };

  $('generate').onclick = generateTrip;
}

function loadAmap(key) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = `https://webapi.amap.com/maps?v=2.0&key=${key}`;
    s.onload = resolve;
    s.onerror = () => reject(new Error('高德 JS API 加载失败'));
    document.head.append(s);
  });
}

function initMap() {
  map = new AMap.Map('map', { zoom: 8, center: [102.6, 30.6], mapStyle: 'amap://styles/whitesmoke' });
}

function drawRegion(region) {
  if (!map || !region) return;
  if (regionOverlay) map.remove(regionOverlay);
  regionOverlay = [];
  const path = region.loop.map((n) => [n.lng, n.lat]);
  regionOverlay.push(new AMap.Polyline({ path, strokeColor: '#2471a3', strokeWeight: 3 }));
  for (const n of region.loop) {
    regionOverlay.push(new AMap.Marker({
      position: [n.lng, n.lat], label: { content: n.name, direction: 'top' },
    }));
  }
  map.add(regionOverlay);
  map.setFitView(regionOverlay);
}

function drawTrip(trip, region) {
  if (!map) return;
  if (tripOverlay) map.remove(tripOverlay);
  tripOverlay = [];
  for (const day of trip.schedule) {
    if (day.type !== 'drive') continue;
    for (const leg of day.legs) {
      const from = region.loop.find((n) => n.name === leg.from);
      const to = region.loop.find((n) => n.name === leg.to);
      if (from && to) {
        tripOverlay.push(new AMap.Polyline({
          path: [[from.lng, from.lat], [to.lng, to.lat]],
          strokeColor: '#e67e22', strokeWeight: 5, strokeOpacity: 0.8,
        }));
      }
    }
  }
  if (trip.trail) {
    const node = region.loop.find((n) => n.name === trip.trail.node);
    if (node) {
      tripOverlay.push(new AMap.Marker({
        position: [trip.trail.start.lng, trip.trail.start.lat],
        label: { content: `⛰ ${trip.trail.name}`, direction: 'top' },
      }));
    }
  }
  map.add(tripOverlay);
  map.setFitView(tripOverlay);
}

async function generateTrip() {
  $('left-msg').textContent = '';
  $('result').innerHTML = '<p class="muted">正在查询车票、路线与天气…(首次约 10-30 秒)</p>';
  const input = {
    regionId: $('region').value,
    originStation: $('origin').value.trim(),
    startDate: $('start-date').value,
    days: Number($('days').value),
    trailId: $('trail').value || null,
  };
  if (!input.originStation || !input.startDate) {
    $('left-msg').textContent = '请先填出发车站和日期';
    return;
  }
  try {
    const trip = await gushan.generateTrip(input);
    renderResult(trip);
  } catch (e) {
    $('left-msg').textContent = e.message;
    $('result').innerHTML = '<p class="muted">生成失败,原因见左侧提示</p>';
  }
}

const TAG = { drive: ['tag-drive', '驾车'], hike: ['tag-hike', '徒步'], note: ['tag-note', '提示'] };

function railHtml(leg, label) {
  if (!leg.chosen) return `<p class="warn">${label}:没有查到可购车次</p>`;
  const price = leg.prices
    ? `¥${leg.prices['二等座'] ?? leg.prices['硬座'] ?? Object.values(leg.prices)[0]}`
    : `<span class="warn">价格未知</span>`;
  const seats = Object.entries(leg.chosen.seats).map(([k, v]) => `${k}${v}`).join(' / ') || '余票未显示';
  return `<p><b>${label}</b> ${leg.chosen.code} ${leg.chosen.startTime}→${leg.chosen.arriveTime}(历时${leg.chosen.lishi}) ${price}</p>
    <p class="muted">${leg.fromStation}→${leg.toStation} ${leg.date} | ${seats}</p>
    <details><summary>原始数据(核对用)</summary><pre style="font-size:11px">${JSON.stringify(leg.evidence, null, 1)}</pre></details>`;
}

async function renderResult(trip) {
  const html = [];
  html.push(`<div class="day"><h3>${trip.regionName} · ${trip.input.days} 天</h3>${railHtml(trip.railOut, '去程火车')}</div>`);
  for (const day of trip.schedule) {
    const [cls, name] = TAG[day.type];
    let body = '';
    if (day.type === 'drive') {
      body = `<table>${day.legs.map((l) =>
        `<tr><td>${l.from}→${l.to}</td><td>${l.km}km / ${l.hours}h</td><td>油+过路 ¥${l.costs.driveTotal}</td></tr>`).join('')}</table>
        ${day.overKm ? '<p class="warn">当日驾车超过单日上限,行程偏紧</p>' : ''}`;
    } else if (day.type === 'hike') {
      const t = day.info || {};
      body = `<p>${t.name || day.trail}:约${t.climbM}m 爬升 · ★${t.grade} ${t.gradeLabel} · ${t.supplies || ''}</p><p class="muted">${t.summary || ''}</p>`;
    } else {
      body = `<p class="warn">${day.text}</p>`;
    }
    html.push(`<div class="day"><h3>${day.date} <span class="tag ${cls}">${name}</span></h3>${body}</div>`);
  }
  html.push(`<div class="day"><h3>${trip.railBack.date} <span class="tag tag-rail">返程</span></h3>${railHtml(trip.railBack, '回程火车')}</div>`);

  const rows = trip.budget.items.map((b) => `<tr><td>${b.name}</td><td>${b.amount === null ? '未知' : '¥' + b.amount}</td><td class="muted">${b.note || ''}</td></tr>`).join('');
  html.push(`<div class="budget"><h3 style="font-size:14px;margin-bottom:6px">预算(单人,油费按整车算)</h3>
    <table>${rows}
    <tr class="total"><td>合计</td><td>¥${trip.budget.total}${trip.budget.unknownCount ? ` + ${trip.budget.unknownCount} 项未知` : ''}</td><td></td></tr></table>
    <p class="muted" style="margin-top:6px">存档: ${trip.savedTo}</p></div>`);

  $('result').innerHTML = html.join('');
  renderWeather(trip.weather);
  const regions = await gushan.readData('regions');
  drawTrip(trip, regions[trip.input.regionId]);
}

function renderWeather(w) {
  $('weather-strip').innerHTML =
    `<div class="wx" style="flex-basis:100%;text-align:left;background:none"><b>${w.node} · 未来 16 天窗口</b></div>` +
    w.forecast.map((d) => `<div class="wx"><div>${d.date.slice(5)}</div><div>${d.label}</div>
      <div>${d.tempMin}~${d.tempMax}℃</div><div>雨${d.precipProb}%</div>
      <div class="v-${d.verdict}">${d.verdict}</div></div>`).join('');
}

// ---------- 标签页切换 ----------

function initTabs() {
  for (const btn of document.querySelectorAll('#tabs .tab')) {
    btn.onclick = () => {
      document.querySelectorAll('#tabs .tab').forEach((b) => b.classList.toggle('active', b === btn));
      $('view-planner').hidden = btn.dataset.view !== 'planner';
      $('view-library').hidden = btn.dataset.view !== 'library';
    };
  }
}

// ---------- 路线库 ----------

let libTrails = [];

async function initLibrary() {
  const trails = await gushan.readData('trails') || {};
  libTrails = Object.entries(trails).map(([id, t]) => ({ id, ...t }));
  // 下拉选项由数据生成,新增省份/类型不用改 UI
  for (const p of [...new Set(libTrails.map((t) => t.province))].sort()) $('lib-province').append(new Option(p, p));
  for (const ty of [...new Set(libTrails.map((t) => t.type))].sort()) $('lib-type').append(new Option(ty, ty));
  for (const id of ['lib-search', 'lib-province', 'lib-grade', 'lib-type', 'lib-status', 'lib-sort']) {
    $(id).addEventListener('input', renderLibrary);
    $(id).addEventListener('change', renderLibrary);
  }
  renderLibrary();
}

function renderLibrary() {
  const kw = $('lib-search').value.trim().toLowerCase();
  const province = $('lib-province').value;
  const grade = $('lib-grade').value;
  const type = $('lib-type').value;
  const status = $('lib-status').value;
  const hitStatus = (t) => !status
    || (status === '禁入/关闭' ? t.status === '禁入' || t.status === '关闭' : t.status === status);

  const list = libTrails.filter((t) =>
    (!province || t.province === province)
    && (!grade || String(t.grade) === grade)
    && (!type || t.type === type)
    && hitStatus(t)
    && (!kw || `${t.name}${t.province}${t.area}${t.summary}`.toLowerCase().includes(kw)));

  const sorters = {
    grade: (a, b) => b.grade - a.grade || b._grade.total - a._grade.total || a.name.localeCompare(b.name, 'zh'),
    climb: (a, b) => b.climbM - a.climbM,
    days: (a, b) => b.days - a.days || b.distanceKm - a.distanceKm,
    name: (a, b) => a.name.localeCompare(b.name, 'zh'),
  };

  // 按省份分组;组序沿用数据文件的地域编排(新疆→西藏→川渝滇…→港澳台),组内再排序
  const provinceOrder = new Map();
  for (const t of libTrails) if (!provinceOrder.has(t.province)) provinceOrder.set(t.province, provinceOrder.size);
  const groups = new Map();
  for (const t of list) {
    if (!groups.has(t.province)) groups.set(t.province, []);
    groups.get(t.province).push(t);
  }
  const sections = [...groups.entries()]
    .sort((a, b) => provinceOrder.get(a[0]) - provinceOrder.get(b[0]))
    .map(([prov, routes]) =>
      `<h2 class="prov-head">${prov}<span>${routes.length} 条</span></h2>`
      + routes.sort(sorters[$('lib-sort').value]).map(routeHtml).join(''))
    .join('');

  $('lib-count').textContent = `共 ${libTrails.length} 条 · 显示 ${list.length} 条`;
  $('lib-list').innerHTML = sections
    || '<p class="muted" style="padding:12px">没有匹配的线路,换个条件试试</p>';
}

function routeHtml(t) {
  const g = t._grade;
  const statusCls = { 开放: 'st-open', 部分管控: 'st-warn', 管控: 'st-warn', 禁入: 'st-bad', 关闭: 'st-bad' }[t.status];
  // 数据测试保证评级与指标建议相差不超过一级;此提示是兜底,正常不出现
  const gradeHint = Math.abs(t.grade - g.suggested) >= 2
    ? `<p class="warn">评级校验:按量化指标建议为 ★${g.suggested}(${g.label}),请人工核对</p>` : '';
  return `<details class="route">
    <summary><span class="route-title">${t.name}</span>
      <span class="route-sub muted">${t.province} · ${t.area} · ${t.type}</span>
      <span class="grade g${t.grade}">★${t.grade} ${GRADE_LABELS[t.grade]}</span>
      <span class="status ${statusCls}">${t.status}</span></summary>
    <div class="route-body">
      <div class="route-metrics"><span>${t.days} 天</span><span>${t.distanceKm}km</span>
        <span>爬升 ${t.climbM}m</span><span>最高 ${t.maxAltM}m</span>${t.bestSeason ? `<span>${t.bestSeason}</span>` : ''}</div>
      <p>${t.summary}</p>
      ${t.statusNote ? `<p class="warn">${t.statusNote}</p>` : ''}
      <p class="muted">评级明细:强度 ${g.exertion} + 海拔 ${g.altitude} + 技术 ${g.technical}${g.load ? ` + 多日重装 ${g.load}` : ''} = ${g.total}(指标建议 ★${g.suggested})</p>
      ${gradeHint}
      ${t.risks ? `<p><b>风险:</b>${t.risks.join(' / ')}</p>` : ''}
      ${t.supplies ? `<p><b>补给:</b>${t.supplies}</p>` : ''}
      ${t.tickets ? `<p><b>参考门票:</b>¥${t.tickets}</p>` : ''}
      ${t.regionId ? '<p class="muted">已接入行程规划,可在"行程规划"页选择此线路</p>' : ''}
    </div>
  </details>`;
}

init();

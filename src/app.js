// 渲染进程入口:纯 JS,通过 preload 暴露的 window.gushan 与主进程通信。
const $ = (id) => document.getElementById(id);

// 纯函数口径经 <script> 加载 lib/*.js 挂到 GushanLib,与主进程共用同一实现
// (此前这里手抄了 9 份副本,lib 一改就静默漂移)
//
// 全部加前缀解构,不能裸解构:lib/*.js 是普通 <script>(非 ES module),它们顶层
// 的 `function pickSeat` 等声明就落在同一个全局作用域里。裸写 `const { pickSeat } = ...`
// 会与 lib/seat.js 的顶层函数同名 → `SyntaxError: Identifier 'pickSeat' has
// already been declared` → 整个 app.js 挂掉,界面停在未初始化状态。
// 这个坑很隐蔽:主进程用 require 完全正常(有独立模块作用域),只有渲染进程炸,
// 而单测跑不到渲染层——曾实测到 6 个 lib 有 5 个因顶层 `const api` 撞名而静默失败。
const LIB = window.GushanLib;
const { pickSeat: seatPick } = LIB.seat;
const { costBreakdown: costBreakdownOf, SCENERY: SCENERY_TAGS } = LIB.recommend;
const { GRADE_LABELS: GRADE_TEXT } = LIB.grading;
const { summitTemp: summitTempOf, gearChecklist: gearChecklistOf } = LIB.gear;
const { quickFacts: quickFactsOf } = LIB.quickfacts;
const { FIT_LABELS: FIT_TEXT, ADVICE_LABELS: ADVICE_TEXT } = LIB.fitness;

// HTML 转义:数据(手编 JSON/网络返回/存档/报错原文)不该在页面上长成标签或逃出属性
function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// 难度星级文案来自 GushanLib.grading,不再本地手抄

let map = null;
let regionOverlay = null;
let tripOverlay = null;
let currentTrip = null; // 当前展示的行程,车次切换/导出等操作都基于它
let bodyState = null; // RunOS 身体状态与逐线匹配结论,启动时异步拉取
let regionCache = {}; // 启动时一次载入的区域库,画图/行程复用,免反复 IPC
let appCfg = {}; // 启动时一次载入的配置,卡片估算吃住用(渲染进程拿不到 require)
let marks = {}; // 想去/走过标记(data/marks.json),路线库与推荐页共用
let lastRecInput = null; // 最近一次推荐条件,标记变动后重跑推荐用

// 渲染进程拿不到 require,日期工具与 lib/planner.js 的 addDays 保持一致
function addDaysStr(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + n);
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// 本地时区的今天(toISOString 会因时区偏移差一天)
function todayLocal() {
  const d = new Date();
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const VERDICT_RANK = { 不宜: 0, 观察: 1, 宜: 2 };

async function init() {
  try {
    await initInner();
  } catch (e) {
    // 启动链路(载入库/区域/表单)任何一环挂掉都不该白屏:把原因说在页面上
    document.body.insertAdjacentHTML('afterbegin',
      `<p class="warn" style="padding:12px">启动失败:${esc(e.message)}。可尝试重启应用;若反复出现,检查 data/ 下的 JSON 是否被改坏。</p>`);
  }
}

async function initInner() {
  initTabs();
  marks = (await gushan.readData('marks')) || {};
  if (typeof marks !== 'object' || Array.isArray(marks)) marks = {};
  await initLibrary();
  initRecommend();
  refreshBodyState(); // 异步拉取身体状态,不阻塞首屏,回来后各自重渲染
  const cfg = (await gushan.readData('config')) || {};
  appCfg = cfg;
  const regions = await gushan.readData('regions') || {};
  regionCache = regions;
  // 区域住宿/餐饮基准供卡片估算用(与主进程 rank 同一份映射)
  appCfg.regionStay = LIB.recommend.regionStayMap(regions);
  for (const [id, r] of Object.entries(regions)) {
    $('region').append(new Option(r.name, id));
  }
  $('region').onchange = () => {
    drawRegion(regions[$('region').value]);
    renderRegionBrief(regions[$('region').value]);
    refreshTrailOptions($('region').value);
  };
  // 上次规划条件回填(含区域联动),没有存档才落到默认值
  if (!restoreForm()) {
    drawRegion(regions[$('region').value]);
    renderRegionBrief(regions[$('region').value]);
    refreshTrailOptions($('region').value);
    $('start-date').value = addDaysStr(todayLocal(), 7);
  }

  // 高德脚本后台加载,不挡规划表单交互;就绪后补画当前区域与已展示的行程
  if (cfg?.amapKeyJs) bootMap(cfg.amapKeyJs);
  else {
    $('config-hint').textContent = '未配置高德 Key:请在 data/config.json 填入 amapKeyJs(地图)与 amapKeyWeb(路径规划)';
    $('map').innerHTML = '<p class="muted map-empty">地图需要高德 JS API Key,填写后重启应用</p>';
  }

  // 出发站输入:输入 2+ 字后联想(规划页与推荐页共用同一实现)
  wireStationInput($('origin'), $('station-list'));

  $('generate').onclick = generateTrip;
  $('trail').addEventListener('change', updateTrailFitHint);
}

// 地图启动与失败重试:失败后给"重试"按钮,不必为一次网络抖动重启应用
function bootMap(key) {
  loadAmap(key).then(() => {
    initMap();
    drawRegion(regionCache[$('region').value]);
    if (currentTrip) drawTrip(currentTrip, regionCache[currentTrip.input.regionId]);
  }).catch(() => {
    $('map').innerHTML = '<p class="muted map-empty">高德 JS API 加载失败,检查网络后<button id="map-retry" class="mark-btn">重试</button></p>';
    $('map-retry').onclick = () => {
      $('map').innerHTML = '<p class="muted map-empty">正在重新加载…</p>';
      bootMap(key);
    };
  });
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
  // 深蓝底图与夜色主题一体;标记标签的玻璃样式在 style.css 里覆盖 .amap-marker-label
  map = new AMap.Map('map', { zoom: 8, center: [102.6, 30.6], mapStyle: 'amap://styles/darkblue' });
}

function drawRegion(region) {
  if (!map || !region) return;
  if (regionOverlay) map.remove(regionOverlay);
  regionOverlay = [];
  const path = region.loop.map((n) => [n.lng, n.lat]);
  regionOverlay.push(new AMap.Polyline({ path, strokeColor: '#7fb0f2', strokeWeight: 3, strokeOpacity: 0.9 }));
  for (const n of region.loop) {
    regionOverlay.push(new AMap.Marker({
      position: [n.lng, n.lat], label: { content: n.name, direction: 'top' },
    }));
  }
  map.add(regionOverlay);
  map.setFitView(regionOverlay);
}

// 按区域重建徒步线路下拉(切区域必须重建,否则选项还是上个区域的)
// 数据直接用启动时载入的 libTrails,不再每次走 IPC 往返
function refreshTrailOptions(regionId, selectedId = '') {
  $('trail').innerHTML = '<option value="">自动挑选</option>';
  for (const t of libTrails) {
    if (t.regionId === regionId) {
      // 星数与文字必须同用人工评级;_grade.label 是指标建议级,只作详情页交叉校验展示
      $('trail').append(new Option(`${t.name}(★${t.grade} ${GRADE_TEXT[t.grade] || ''})`, t.id));
    }
  }
  $('trail').value = selectedId || '';
  updateTrailFitHint();
}

// 区域提示条:最佳季节与路况提示来自 regions.json,出发前必看
function renderRegionBrief(region) {
  const el = $('region-brief');
  if (!region || (!region.bestSeason && !(region.notes || []).length)) {
    el.hidden = true;
    return;
  }
  el.innerHTML =
    `${region.bestSeason ? `<p><b>最佳季节</b>${esc(region.bestSeason)}</p>` : ''}` +
    ((region.notes || []).length
      ? `<p><b>路况提示</b><ul>${region.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></p>`
      : '');
  el.hidden = false;
}

// 高德 polyline("lng,lat;lng,lat;…")→ [[lng,lat],…],坏点直接丢
function polylineToPath(str) {
  return String(str || '').split(';')
    .map((p) => p.split(',').map(Number))
    .filter((p) => p.length === 2 && p.every(Number.isFinite));
}

function drawTrip(trip, region) {
  if (!map || !region) return; // 存档指向的区域可能已从 regions.json 移除,此时只画不成就行
  if (tripOverlay) map.remove(tripOverlay);
  tripOverlay = [];
  for (const day of trip.schedule) {
    if (day.type !== 'drive') continue;
    for (const leg of day.legs) {
      // 真实驾车路线(生成时抽稀落盘);旧档没有 path 就退回节点直线
      const real = polylineToPath(leg.path);
      if (real.length > 1) {
        tripOverlay.push(new AMap.Polyline({
          path: real, strokeColor: '#e8a54b', strokeWeight: 5, strokeOpacity: 0.85,
        }));
        continue;
      }
      const from = region.loop.find((n) => n.name === leg.from);
      const to = region.loop.find((n) => n.name === leg.to);
      if (from && to) {
        tripOverlay.push(new AMap.Polyline({
          path: [[from.lng, from.lat], [to.lng, to.lat]],
          strokeColor: '#e8a54b', strokeWeight: 5, strokeOpacity: 0.85,
        }));
      }
    }
  }
  if (trip.trail) {
    tripOverlay.push(new AMap.Marker({
      position: [trip.trail.start.lng, trip.trail.start.lat],
      label: { content: `⛰ ${trip.trail.name}`, direction: 'top' },
    }));
  }
  map.add(tripOverlay);
  map.setFitView(tripOverlay);
}

async function generateTrip() {
  const input = {
    regionId: $('region').value,
    originStation: $('origin').value.trim(),
    startDate: $('start-date').value,
    days: Number($('days').value),
    headcount: Number($('headcount').value) || 1,
    trailId: $('trail').value || null,
  };
  if (!input.originStation || !input.startDate) {
    $('left-msg').textContent = '请先填出发车站和日期';
    return;
  }
  if (!Number.isFinite(input.days) || input.days < 3 || input.days > 20) {
    $('left-msg').textContent = '总天数需为 3~20 的数字';
    return;
  }
  if (input.startDate < todayLocal()) {
    $('left-msg').textContent = '出发日期不能在过去';
    return;
  }
  // 防重:全链路查询要 10-30 秒,连点会并发两次查询并互相覆盖存档
  $('generate').disabled = true;
  $('generate').textContent = '生成中…';
  $('left-msg').textContent = '';
  $('result').innerHTML = '<p class="muted">正在查询车票、路线与天气…(首次约 10-30 秒)</p>';
  try {
    const trip = await gushan.generateTrip(input);
    saveForm();
    await renderResult(trip);
  } catch (e) {
    $('left-msg').textContent = e.message;
    $('result').innerHTML = '<p class="muted">生成失败,原因见左侧提示</p>';
  } finally {
    $('generate').disabled = false;
    $('generate').textContent = '生成行程';
  }
}

// 表单记忆:生成成功后把规划条件存进 localStorage,重启免重填
const FORM_KEY = 'gushan-form-v1';
function saveForm() {
  try {
    localStorage.setItem(FORM_KEY, JSON.stringify({
      region: $('region').value, origin: $('origin').value, date: $('start-date').value,
      days: $('days').value, headcount: $('headcount').value, trailId: $('trail').value,
    }));
  } catch { /* 存不了就算了,不影响主流程 */ }
}

function restoreForm() {
  try {
    const s = JSON.parse(localStorage.getItem(FORM_KEY) || 'null');
    if (!s || typeof s !== 'object') return false;
    if (s.region && regionCache[s.region]) {
      $('region').value = s.region;
      $('region').onchange();
    }
    if (s.origin) $('origin').value = s.origin;
    if (s.date) $('start-date').value = s.date;
    if (s.days) $('days').value = s.days;
    if (s.headcount) $('headcount').value = s.headcount;
    if (s.trailId && [...$('trail').options].some((o) => o.value === s.trailId)) {
      $('trail').value = s.trailId;
      updateTrailFitHint();
    }
    return Boolean(s.region || s.origin || s.date);
  } catch {
    return false;
  }
}

const TAG = {
  drive: ['tag-drive', '驾车'], hike: ['tag-hike', '徒步'],
  note: ['tag-note', '提示'], rest: ['tag-rest', '休整'],
};

// 站名联想:输入 2+ 字后查 12306 站名表,命中填进 datalist;失败不打扰(查询时会正式校验)
function wireStationInput(inputEl, listEl) {
  let timer = null;
  inputEl.oninput = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const kw = inputEl.value.trim();
      if (kw.length < 2) return;
      try {
        const hits = await gushan.resolveStation(kw);
        listEl.innerHTML = '';
        for (const h of hits) listEl.append(new Option(h.name, h.name));
      } catch { /* 联想失败不打扰用户 */ }
    }, 300);
  };
}

// 出发站在规划页与推荐页是同一事实,统一记进规划表单的记忆,两边回填同源
function rememberOrigin(origin) {
  if (!origin) return;
  try {
    const saved = JSON.parse(localStorage.getItem(FORM_KEY) || '{}');
    saved.origin = origin;
    localStorage.setItem(FORM_KEY, JSON.stringify(saved));
  } catch { /* 存不了就算了,不影响主流程 */ }
}

// 当前生效的出发站:推荐页填了以它为准,否则用规划页的
function currentOrigin() {
  return $('rec-origin').value.trim() || $('origin').value.trim();
}

// 与 lib/rail12306.js 的 pickSeat 口径一致(渲染进程拿不到 require);
// 只在旧档缺 seat 字段时兜底,新生成的行程主进程已算好 leg.seat
const seatFromPrices = seatPick;

function railHtml(leg, label, legKey) {
  if (!leg.chosen) {
    const why = leg.presale
      ? `${label}:超出 12306 预售期(约 15 天),临近出发再查`
      : `${label}:没有查到可购车次`;
    // 邻日查询是显式点击才发请求,不违反 12306 低频纪律;只作参考,不改行程预算
    return `<div class="rail"><p class="warn">${esc(why)}</p>
      <div class="adj-ops"><span class="muted">邻日参考:</span>
        <button class="rail-cand" data-adj="${legKey}|-1">前一日</button>
        <button class="rail-cand" data-adj="${legKey}|1">后一日</button>
        <button class="rail-cand" data-flight="${legKey}" title="火车没辙时的兜底:打开携程机票列表(不查价)">查机票</button></div>
      <div id="adj-${legKey}" class="adj-result"></div></div>`;
  }
  const seatInfo = leg.seat || seatFromPrices(leg.prices, leg.chosen.lishi);
  const price = seatInfo
    ? `¥${seatInfo.price}<i class="seat-label">${esc(seatInfo.label)}</i>`
    : '<span class="warn">价格未知</span>';
  const seats = Object.entries(leg.chosen.seats).map(([k, v]) => `${esc(k)}${esc(v)}`).join(' / ') || '余票未显示';
  // 候选车次:同一次余票查询的结果,点击本地切换,不发新请求
  const cands = (leg.candidates || []).filter((c) => c.code !== leg.chosen.code).map((c) => {
    const seat = c.seat || seatFromPrices(c.prices, c.lishi);
    const seatTxt = seat ? `${seat.label}¥${seat.price}` : (c.seats?.['二等座'] || c.seats?.['硬座'] || '余票未显示');
    return `<button class="rail-cand" data-train="${legKey}|${esc(c.code)}"
      title="${esc(`${c.code} ${c.startTime}→${c.arriveTime} 历时${c.lishi} · ${seatTxt}`)}">${esc(c.code)} ${esc(c.startTime)}${seat ? ` ¥${seat.price}` : ''}</button>`;
  }).join('');
  return `<div class="rail">
    <div class="rail-line"><b>${esc(label)}</b><span class="rail-code">${esc(leg.chosen.code)}</span>
      <span class="rail-time">${esc(leg.chosen.startTime)}→${esc(leg.chosen.arriveTime)} 历时${esc(leg.chosen.lishi)}</span>
      <span class="rail-price">${price}</span></div>
    <p class="rail-meta muted">${esc(leg.fromStation)}→${esc(leg.toStation)} ${esc(leg.date)} | ${seats}</p>
    ${cands ? `<div class="rail-cands"><span class="muted">换车次:</span>${cands}</div>` : ''}
    <details class="evidence"><summary>原始数据(核对用)</summary><pre>${esc(JSON.stringify(leg.evidence, null, 1))}</pre></details>
  </div>`;
}

// 邻日车次参考:显式点击查询,结果只列出来看,不改行程不进预算
async function queryAdjacent(legKey, delta, btn) {
  const leg = currentTrip?.[legKey];
  const box = $(`adj-${legKey}`);
  if (!leg || !box) return;
  if (btn) btn.disabled = true; // 查询期间禁点,不向 12306 发并发请求
  box.innerHTML = '<p class="muted">查询中…</p>';
  try {
    const date = addDaysStr(leg.date, delta);
    const { trains } = await gushan.queryTrains(leg.fromStation, leg.toStation, date);
    const rows = trains.filter((t) => t.canWebBuy).slice(0, 6).map((t) => {
      const seat = seatFromPrices(t.prices, t.lishi);
      return `<li><b>${esc(t.code)}</b> ${esc(t.startTime)}→${esc(t.arriveTime)} 历时${esc(t.lishi)} · ${seat ? `${esc(seat.label)} ¥${seat.price}` : '价格未知'}</li>`;
    }).join('');
    box.innerHTML = `<p class="muted">${date} 可购车次(仅参考;要改期请回表单重新生成行程,预算才会计入)</p>
      <ul class="adj-list">${rows || '<li class="muted">该日也没有可购车次</li>'}</ul>`;
  } catch (e) {
    box.innerHTML = `<p class="warn">邻日查询失败:${esc(e.message)}</p>`;
  } finally {
    if (btn) btn.disabled = false;
  }
}

// 机票兜底:12306 无可购车次(无直达/超预售)时,打开携程机票列表页(不查价,只给入口)。
// 出发城市拼音来自 config.flightCityPinyin,目的地取区域库 hub.flightCity。
async function openFlightPage(legKey) {
  const leg = currentTrip?.[legKey];
  const region = regionCache[currentTrip?.input.regionId];
  const from = appCfg.flightCityPinyin;
  const to = region?.hub?.flightCity;
  if (!leg?.date || !from || !to) {
    alert('机票跳转缺配置:请在 data/config.json 填 flightCityPinyin(出发城市拼音),区域库 hub 需有 flightCity');
    return;
  }
  const url = `https://flights.ctrip.com/online/list/oneway-${from}-${to}?depdate=${leg.date}`;
  try {
    await gushan.openExternal(url);
  } catch (e) {
    alert(`打开浏览器失败:${e.message}`);
  }
}

// 出发日 ±3 天扫描:整体平移行程,徒步日落在预报里的哪一天只随日期变化,
// 所以用已取回的 16 天预报就能算,零新增请求。返回 null 表示没有更优解。
function suggestShiftStart(trip) {
  const forecast = trip.weather?.forecast || [];
  const hikeDates = trip.schedule.filter((d) => d.type === 'hike').map((d) => d.date);
  if (!hikeDates.length || !forecast.length) return null;
  const rankAt = (date) => {
    const wx = forecast.find((x) => x.date === date);
    return wx ? VERDICT_RANK[wx.verdict] ?? -1 : -1;
  };
  const worst = (dates) => Math.min(...dates.map(rankAt));
  const current = worst(hikeDates);
  if (current < 0) return null; // 徒步日本来就在预报窗口外,扫了也没依据
  let best = null;
  for (let s = -3; s <= 3; s++) {
    if (!s) continue;
    const score = worst(hikeDates.map((d) => addDaysStr(d, s)));
    if (score > current && (!best || score > best.score)) best = { s, score };
  }
  if (!best) return null;
  return {
    startDate: addDaysStr(trip.input.startDate, best.s),
    days: Math.abs(best.s),
    earlier: best.s < 0,
    verdict: best.score === 2 ? '宜' : best.score === 1 ? '观察' : '不宜',
  };
}

// 山顶体感气温文案:折算公式用 lib/gear.js 的 summitTemp(单一来源),不再手抄 6.5℃/km
function summitLineHtml(trip, date) {
  const trail = trip.trail;
  const wx = (trip.weather?.forecast || []).find((x) => x.date === date);
  if (!trail || !wx || !Number.isFinite(wx.elevation) || !Number.isFinite(trail.maxAltM)) return '';
  if (trail.maxAltM - wx.elevation < 500) return ''; // 高差太小,折算没有意义
  const lo = summitTempOf(wx.tempMin, wx.elevation, trail.maxAltM);
  const hi = summitTempOf(wx.tempMax, wx.elevation, trail.maxAltM);
  if (lo == null || hi == null) return '';
  const drop = Math.round(((trail.maxAltM - wx.elevation) / 1000) * 6.5);
  return `<p class="muted">山顶(${trail.maxAltM}m)体感约 ${lo}~${hi}℃,比预报点低约 ${drop}℃</p>`;
}

function gearHtml(trip) {
  const items = trip.gear || [];
  if (!items.length) return '';
  return `<details class="gear"><summary>行前准备(${items.length})<span class="muted">由线路字段与天气确定性推导,逐条带原因</span></summary>
    <ul>${items.map((i) => `<li><b>${esc(i.item)}</b><span class="muted">${esc(i.reason)}</span></li>`).join('')}</ul></details>`;
}

function tripOpsHtml() {
  return `<div class="trip-ops">
    <button id="trip-export">导出 Markdown</button>
    <button id="trip-print">打印</button></div>`;
}

async function exportTripMd() {
  if (!currentTrip) return;
  if (!gushan.exportTrip) { alert('当前环境(预览页)不支持导出'); return; }
  try {
    const res = await gushan.exportTrip(`行程-${currentTrip.id}.md`,
      LIB.tripMarkdown.tripToMarkdown(currentTrip, { gradeLabels: GRADE_TEXT, seatOf: seatFromPrices }));
    if (!res.canceled) $('left-msg').textContent = `已导出:${res.filePath}`;
  } catch (e) {
    alert(`导出失败:${e.message}`);
  }
}

async function renderResult(trip) {
  currentTrip = trip;
  const html = [];
  // 逐日天气对齐:徒步/休整日看宜否,驾车日只报天气本身(宜否是徒步口径,别张冠李戴)
  const wxMap = new Map((trip.weather?.forecast || []).map((d) => [d.date, d]));
  const wxChip = (date, type) => {
    const wx = wxMap.get(date);
    if (!wx) return '';
    const tip = `${wx.label} ${wx.tempMin ?? '—'}~${wx.tempMax ?? '—'}℃ · 降水${wx.precipProb ?? '—'}% · 风${wx.windMax ?? '—'}km/h`;
    if (type === 'drive') {
      return `<span class="day-wx v-info" title="${esc(tip)}">${esc(wx.label)} 雨${wx.precipProb ?? '—'}%</span>`;
    }
    return `<span class="day-wx v-${esc(wx.verdict)}" title="${esc(tip)}">${esc(wx.verdict)}</span>`;
  };
  html.push(`<div class="day"><div class="day-head"><h3>${esc(trip.regionName)} · ${trip.input.days} 天</h3></div>${railHtml(trip.railOut, '去程火车', 'railOut')}</div>`);
  const shift = suggestShiftStart(trip);
  for (const day of trip.schedule) {
    const [cls, name] = TAG[day.type] || ['tag-note', day.type];
    let body = '';
    if (day.type === 'drive') {
      body = `<table>${day.legs.map((l) =>
        `<tr><td>${esc(l.from)}→${esc(l.to)}</td><td>${l.km}km / ${l.hours}h</td><td>油+过路 ¥${l.costs.driveTotal}</td></tr>`).join('')}</table>
        ${day.overKm ? '<p class="warn">当日驾车超过单日上限,行程偏紧</p>' : ''}
        ${day.lateArrival ? `<p class="warn">去程 ${esc(day.lateArrival.time)} 才到 ${esc(day.lateArrival.station)},首日驾车时间紧张,备好夜路预案</p>` : ''}
        ${day.earlyDepart ? `<p class="warn">回程 ${esc(day.earlyDepart.time)} 即发车,末日别排长驾,预留进站时间</p>` : ''}`;
    } else if (day.type === 'hike') {
      const t = day.info || {};
      body = `<p>${esc(t.name || day.trail)}:约${t.climbM}m 爬升 · ★${t.grade} ${esc(t.gradeLabel)} · ${esc(t.supplies || '')}</p><p class="muted">${esc(t.summary || '')}</p>`;
      body += summitLineHtml(trip, day.date);
      // 体能匹配按线路 id 查(自动选线的 id 就在 day.info 里),没有匹配结论就不显示
      body += fitLineHtml(bodyState?.matches?.[t.id || trip.input.trailId]);
      if (day.seasonWarn) body += `<p class="warn">错季提醒:${esc(day.seasonWarn)}</p>`;
      if (wxMap.get(day.date)?.verdict === '不宜') {
        body += '<p class="warn">当日天气不宜徒步,建议前后调整日期</p>';
      }
      if (shift) {
        body += `<p class="hint">若整体改期 <b>${esc(shift.startDate)}</b>(${shift.earlier ? '提前' : '推后'} ${shift.days} 天),徒步日天气可到「${esc(shift.verdict)}」</p>`;
      }
    } else if (day.type === 'rest') {
      body = '<p class="muted">机动休整:高反适应或天气避让,食宿照常</p>';
    } else {
      body = `<p class="warn">${esc(day.text)}</p>`;
    }
    html.push(`<div class="day"><div class="day-head"><h3>${day.date}</h3><span class="tag ${cls}">${name}</span>${wxChip(day.date, day.type)}</div><div class="day-body">${body}</div></div>`);
  }
  html.push(`<div class="day"><div class="day-head"><h3>${trip.railBack.date}</h3><span class="tag tag-rail">返程</span></div>${railHtml(trip.railBack, '回程火车', 'railBack')}</div>`);
  html.push(gearHtml(trip));

  const rows = trip.budget.items.map((b) => `<tr><td>${esc(b.name)}</td><td>${b.amount === null ? '未知' : '¥' + b.amount}</td><td class="muted">${esc(b.note || '')}</td></tr>`).join('');
  const headcount = headcountOf(trip);
  html.push(`<div class="budget"><h3>预算<span>${headcount} 人 · 油费整车均摊,火车票/门票按人头</span></h3>
    <table>${rows}
    <tr class="total"><td>合计</td><td>¥${trip.budget.total}${trip.budget.unknownCount ? ` + ${trip.budget.unknownCount} 项未知` : ''}</td><td></td></tr>
    ${headcount > 1 ? `<tr class="total"><td>人均</td><td>¥${trip.budget.perPerson ?? Math.round(trip.budget.total / headcount)}</td><td></td></tr>` : ''}
    </table>
    ${tripOpsHtml()}
    <p class="muted budget-saved">存档 · ${esc(trip.savedTo || `data/trips/${trip.id}.json`)}</p></div>`);

  $('result').innerHTML = html.join('');
  for (const btn of $('result').querySelectorAll('[data-train]')) {
    const [legKey, code] = btn.dataset.train.split('|');
    btn.onclick = () => switchTrain(legKey, code);
  }
  for (const btn of $('result').querySelectorAll('[data-adj]')) {
    const [legKey, delta] = btn.dataset.adj.split('|');
    btn.onclick = () => queryAdjacent(legKey, Number(delta), btn);
  }
  for (const btn of $('result').querySelectorAll('[data-flight]')) {
    btn.onclick = () => openFlightPage(btn.dataset.flight);
  }
  const exportBtn = $('trip-export');
  if (exportBtn) exportBtn.onclick = exportTripMd;
  const printBtn = $('trip-print');
  if (printBtn) printBtn.onclick = () => window.print();
  renderWeather(trip.weather);
  drawTrip(trip, regionCache[trip.input.regionId]);
}

// 人数兜底:旧档 budget 上没有 headcount 字段,回退表单值
const headcountOf = (trip) => trip.budget?.headcount ?? trip.input.headcount ?? 1;

// 换车次:纯本地操作(候选来自生成时同一次余票查询),联动预算并写回存档
async function switchTrain(legKey, code) {
  const trip = currentTrip;
  const leg = trip?.[legKey];
  const cand = leg?.candidates?.find((c) => c.code === code);
  if (!cand) return;
  leg.chosen = cand;
  leg.seat = cand.seat || seatFromPrices(cand.prices, cand.lishi);
  leg.prices = cand.prices;
  const hc = headcountOf(trip);
  const label = legKey === 'railOut' ? '火车去程' : '火车回程';
  const item = trip.budget.items.find((b) => b.name === label);
  if (item) {
    item.amount = leg.seat ? leg.seat.price * hc : null;
    item.note = `${cand.code} ${leg.seat ? leg.seat.label : '票价字段缺失,请核对'}${hc > 1 ? ` ×${hc}人` : ''}`;
  }
  const known = trip.budget.items.filter((b) => b.amount !== null);
  trip.budget.total = known.reduce((s, b) => s + b.amount, 0);
  trip.budget.unknownCount = trip.budget.items.length - known.length;
  trip.budget.perPerson = Math.round(trip.budget.total / hc);
  renderResult(trip);
  // savedTo 是返回值附带的展示字段,不落盘。用 rest siblings 写法剔除,
  // 而不是解构出 const { savedTo, ...archive } —— 后者会留下一个没人用的绑定,
  // no-unused-vars 会报,且它是真的「没用」,不是「暂时没用」。
  const archive = { ...trip };
  delete archive.savedTo;
  try {
    await gushan.writeData(`trips/${trip.id}`, archive);
  } catch (e) {
    // 界面已切到新车次,写盘失败要说破,别让存档静默停在旧价上
    alert(`存档写回失败,行程档案里还是旧车次:${e.message}`);
  }
}

function renderWeather(w, note = '') {
  const first = w.forecast[0]?.date?.slice(5) || '';
  const lastWx = w.forecast[w.forecast.length - 1];
  const tripEnd = currentTrip
    ? addDaysStr(currentTrip.input.startDate, (currentTrip.input.days || 1) - 1) : null;
  const beyond = lastWx && tripEnd && tripEnd > lastWx.date;
  $('weather-strip').innerHTML =
    `<div class="wx-head"><b>${esc(w.node)} · 未来 16 天窗口</b>
      <span class="muted">${first} ~ ${lastWx?.date?.slice(5) || ''}</span>
      ${beyond ? '<span class="warn">行程后段超出预报窗口,无天气数据</span>' : ''}${note}</div>
    <div class="wx-row">${w.forecast.map((d) => `<div class="wx">
      <div class="wx-date">${esc(d.date.slice(5))}</div><div class="wx-label">${esc(d.label)}</div>
      <div class="wx-temp">${d.tempMin ?? '—'}~${d.tempMax ?? '—'}℃</div><div class="wx-rain">雨${d.precipProb ?? '—'}%</div>
      <div class="wx-v v-${esc(d.verdict)}">${esc(d.verdict)}</div></div>`).join('')}</div>`;
}

// ---------- 标签页切换 ----------

function initTabs() {
  for (const btn of document.querySelectorAll('#tabs .tab')) {
    btn.onclick = () => {
      document.querySelectorAll('#tabs .tab').forEach((b) => {
        b.classList.toggle('active', b === btn);
        b.setAttribute('aria-selected', String(b === btn));
      });
      for (const view of document.querySelectorAll('[id^="view-"]')) {
        view.hidden = view.id !== `view-${btn.dataset.view}`;
      }
      // 档案页每次进入都重新列,反映最新存档
      if (btn.dataset.view === 'archive') renderArchive();
    };
  }
}

// ---------- 行程档案 ----------

async function renderArchive() {
  $('arch-list').innerHTML = '<p class="muted" style="padding:12px">载入中…</p>';
  let list;
  try {
    list = await gushan.listTrips();
  } catch (e) {
    $('arch-count').textContent = '';
    $('arch-list').innerHTML = `<p class="warn" style="padding:12px">档案列表读取失败:${esc(e.message)}</p>`;
    return;
  }
  $('arch-count').textContent = list.length ? `共 ${list.length} 次行程,点开重看,无需重新查询` : '';
  $('arch-list').innerHTML = list.map((t) => t.error
    ? `<div class="arch"><div class="arch-head"><b>${esc(t.id)}</b></div><p class="warn">${esc(t.error)}</p></div>`
    : `<div class="arch">
        <div class="arch-head"><b>${esc(t.regionName)} · ${t.days} 天</b><span class="arch-date">${esc(t.startDate)}</span></div>
        <p class="muted">${t.trailName ? `徒步 ${esc(t.trailName)} · ` : ''}预算 ¥${t.total ?? '未知'} · 生成于 ${esc(String(t.generatedAt || '').slice(0, 10))}${t.actualCost != null ? ` · 实花 ¥${t.actualCost}` : ''}</p>
        <div class="arch-ops"><button data-open="${esc(t.id)}">打开</button><button data-actual="${esc(t.id)}">记实花</button><button class="danger" data-del="${esc(t.id)}">删除</button></div>
      </div>`).join('')
    || '<p class="muted" style="padding:12px">还没有存档,去「行程规划」生成一次吧</p>';

  for (const btn of $('arch-list').querySelectorAll('[data-open]')) {
    btn.onclick = () => openArchive(btn.dataset.open);
  }
  for (const btn of $('arch-list').querySelectorAll('[data-actual]')) {
    btn.onclick = () => recordActualCost(btn.dataset.actual);
  }
  for (const btn of $('arch-list').querySelectorAll('[data-del]')) {
    btn.onclick = async () => {
      if (!confirm(`删除存档 ${btn.dataset.del}?此操作不可恢复`)) return;
      try {
        await gushan.deleteTrip(btn.dataset.del);
      } catch (e) {
        alert(`删除失败:${e.message}`);
      }
      renderArchive();
    };
  }
}

// 记一笔实际花费:估算参数(住宿/餐饮/油费)靠真实数据慢慢校准,数字进存档与档案列表
async function recordActualCost(id) {
  const input = prompt('这次行程实际花了多少(元,按总花费计)?留空取消');
  if (input === null) return;
  const amount = Number(input);
  if (!Number.isFinite(amount) || amount < 0) { alert('请输入非负数字'); return; }
  try {
    const trip = await gushan.readData(`trips/${id}`);
    if (!trip) { alert(`存档 ${id} 不存在`); return; }
    trip.actualCost = Math.round(amount);
    await gushan.writeData(`trips/${id}`, trip);
    renderArchive();
  } catch (e) {
    alert(`实花记录失败:${e.message}`);
  }
}

// 打开档案:回填规划要素并切到规划页,方便在旧行程基础上改条件重新生成
async function openArchive(id) {
  const trip = await gushan.readData(`trips/${id}`);
  if (!trip) { alert(`存档 ${id} 不存在,可能已被删除`); return; }
  // 区域可能已从 regions.json 删除:行程照常展示,只是不再回填表单、地图不画环线
  if (!regionCache[trip.input.regionId]) {
    alert(`该存档的区域「${trip.input.regionId}」已不在区域库里,只展示行程,不回填表单`);
  } else {
    $('region').value = trip.input.regionId;
    $('region').onchange();
    await refreshTrailOptions(trip.input.regionId, trip.input.trailId || '');
    if (trip.input.startDate) $('start-date').value = trip.input.startDate;
    if (trip.input.days) $('days').value = trip.input.days;
    if (trip.input.headcount) $('headcount').value = trip.input.headcount;
  }
  document.querySelector('#tabs [data-view="planner"]').click();
  await renderResult(trip);
  // 存档里的天气是生成当天的快照:拉一次最新预报重刷;失败就明示快照日期,不静默装新
  try {
    const region = regionCache[trip.input.regionId];
    const node = region?.loop?.find((n) => n.name === trip.weather?.node);
    if (node && gushan.weatherForecast) {
      trip.weather.forecast = await gushan.weatherForecast(node.lng, node.lat, 16);
      await renderResult(trip);
      renderWeather(trip.weather, '<span class="muted">已刷新为最新预报</span>');
    }
  } catch {
    renderWeather(trip.weather, `<span class="muted">天气为 ${String(trip.generatedAt || '').slice(0, 10)} 快照,刷新失败</span>`);
  }
}

// ---------- RunOS 身体状态联动 ----------

// 档位文案来自 GushanLib.fitness(FIT_LABELS/ADVICE_LABELS),不再本地手抄

// 启动时异步拉一次;RunOS 没跑也会拿到 available=false 的状态对象,UI 只提示不报错
async function refreshBodyState(force = false) {
  try {
    bodyState = await gushan.runosState({ force });
  } catch (e) {
    bodyState = { available: false, dataReady: false, reason: e.message, matches: {} };
  }
  renderBodyPanel();
  renderLibrary(); // 卡片体能徽章随状态重刷
  updateTrailFitHint();
  // 行程页已打开的徒步日体能文案一并重刷(此前只刷路线库,行程页停在旧状态)
  if (currentTrip) renderResult(currentTrip);
}

// 身体状态条:路线库顶部的联动概览,未连接/无数据/正常三态 + 数据新鲜度
function renderBodyPanel() {
  const el = $('lib-fitness');
  const parts = [];
  if (!bodyState.available) {
    parts.push(`<span class="warn">RunOS 未连接</span><span class="muted">${esc(bodyState.reason || '')}</span>`);
  } else if (!bodyState.dataReady) {
    parts.push(`<span class="muted">${esc(bodyState.reason || 'RunOS 已连接,暂无身体数据')}</span>`);
  } else {
    const r = bodyState.readiness || {};
    const end = bodyState.endurance?.score;
    parts.push(`<span class="body-tag" title="${esc(bodyState.status?.detail || '')}">${esc(bodyState.status?.label || '状态未知')}</span>`);
    parts.push(`<span class="muted">准备度 ${r.score ?? '—'} · ${esc(r.verdict || '')}</span>`);
    if (Number.isFinite(end)) {
      parts.push(`<span class="muted">耐力 ${end}${bodyState.hill?.label ? ` · 爬坡「${esc(bodyState.hill.label)}」` : ''}</span>`);
    }
    if (bodyState.todayAdvice) {
      parts.push(`<span class="muted">今日建议「${ADVICE_TEXT[bodyState.todayAdvice.level] || esc(bodyState.todayAdvice.level)}」</span>`);
    }
  }
  if (bodyState.staleDays != null && bodyState.staleDays >= 3) {
    parts.push(`<span class="warn">身体数据已 ${bodyState.staleDays} 天未同步,建议打开 RunOS 同步</span>`);
  }
  el.innerHTML = `${parts.join('')}<button id="body-refresh" class="body-refresh">刷新</button>`;
  el.hidden = false;
  $('body-refresh').onclick = () => {
    $('body-refresh').textContent = '刷新中…';
    refreshBodyState(true);
  };
}

// 规划页:选中具体线路时给一句体能匹配结论
function updateTrailFitHint() {
  const el = $('trail-fit');
  const fit = bodyState?.matches?.[$('trail').value];
  if (!fit || !FIT_TEXT[fit.level]) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = `<span class="fit-badge ft-${esc(fit.level)}">${FIT_TEXT[fit.level]}</span><span>${esc(fit.reasons.join(';'))}</span>`;
}

// 卡片与行程页共用的匹配文案:主结论 + 不动档位的提醒
function fitLineHtml(fit) {
  if (!fit || !FIT_TEXT[fit.level]) return '';
  const notes = fit.notes.length ? `。另:${fit.notes.join(';')}` : '';
  return `<p class="fit-line"><b>体能匹配</b>${esc(fit.reasons.join(';'))}${esc(notes)}</p>`;
}

// ---------- 路线库 ----------

let libTrails = [];

// 载入(或重载)线路库数据并重建筛选下拉;保留当前筛选选择
async function loadLibraryData() {
  const trails = await gushan.readData('trails') || {};
  libTrails = Object.entries(trails).map(([id, t]) => ({ id, ...t }));
  const keepProvince = $('lib-province').value;
  const keepType = $('lib-type').value;
  $('lib-province').innerHTML = '<option value="">全部省份</option>';
  $('lib-type').innerHTML = '<option value="">全部类型</option>';
  // 下拉选项由数据生成,新增省份/类型不用改 UI
  for (const p of [...new Set(libTrails.map((t) => t.province))].sort()) $('lib-province').append(new Option(p, p));
  for (const ty of [...new Set(libTrails.map((t) => t.type))].sort()) $('lib-type').append(new Option(ty, ty));
  if ([...$('lib-province').options].some((o) => o.value === keepProvince)) $('lib-province').value = keepProvince;
  if ([...$('lib-type').options].some((o) => o.value === keepType)) $('lib-type').value = keepType;
}

async function initLibrary() {
  await loadLibraryData();
  for (const id of ['lib-search', 'lib-province', 'lib-grade', 'lib-type', 'lib-status', 'lib-mark', 'lib-sort']) {
    $(id).addEventListener('change', renderLibrary);
    // 搜索框逐键 input 会全量重建整个路线库卡片,防抖后再渲染;其余控件数据量小可即时
    if (id !== 'lib-search') $(id).addEventListener('input', renderLibrary);
  }
  let searchTimer = null;
  $('lib-search').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(renderLibrary, 150);
  });
  // 手改 trails.json 后不用重启:重载数据并连带刷新规划下拉与身体状态匹配
  $('lib-reload').onclick = async () => {
    const btn = $('lib-reload');
    btn.disabled = true;
    btn.textContent = '重载中…';
    try {
      await loadLibraryData();
      refreshTrailOptions($('region').value);
      renderLibrary();
      await refreshBodyState(true);
    } finally {
      btn.disabled = false;
      btn.textContent = '重载线路库';
    }
  };
  renderLibrary();
}

function renderLibrary() {
  const kw = $('lib-search').value.trim().toLowerCase();
  const province = $('lib-province').value;
  const grade = $('lib-grade').value;
  const type = $('lib-type').value;
  const status = $('lib-status').value;
  const markFilter = $('lib-mark').value;
  const hitStatus = (t) => !status
    || (status === '禁入/关闭' ? t.status === '禁入' || t.status === '关闭' : t.status === status);
  const hitMark = (t) => !markFilter
    || (markFilter === 'wanted' && marks[t.id]?.wanted)
    || (markFilter === 'done' && marks[t.id]?.doneAt);

  const list = libTrails.filter((t) =>
    (!province || t.province === province)
    && (!grade || String(t.grade) === grade)
    && (!type || t.type === type)
    && hitStatus(t)
    && hitMark(t)
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
      `<h2 class="prov-head"><span class="prov-name">${prov}</span><span class="prov-count">${routes.length} 条</span></h2>`
      + routes.sort(sorters[$('lib-sort').value]).map(routeHtml).join(''))
    .join('');

  $('lib-count').textContent = `共 ${libTrails.length} 条 · 显示 ${list.length} 条`;
  $('lib-list').innerHTML = sections
    || '<p class="muted" style="padding:12px">没有匹配的线路,换个条件试试</p>';

  wirePlanButtons($('lib-list'));
  wireMarkButtons($('lib-list'));
  wireTransportLookups($('lib-list'));
}

// 「用这条线规划行程」按钮:路线库与推荐页共用,点击切到规划页并预选该线路
function wirePlanButtons(root) {
  for (const btn of root.querySelectorAll('[data-plan]')) {
    const [trailId, regionId] = btn.dataset.plan.split('|');
    btn.onclick = () => planFromLibrary(trailId, regionId);
  }
}

// 想去/走过标记按钮:写 data/marks.json,写完重刷路线库与推荐
function wireMarkButtons(root) {
  for (const btn of root.querySelectorAll('[data-want]')) {
    btn.onclick = async () => {
      const id = btn.dataset.want;
      if (marks[id]?.wanted) delete marks[id].wanted;
      else (marks[id] = marks[id] || {}).wanted = true;
      await saveMarks();
    };
  }
  for (const btn of root.querySelectorAll('[data-done]')) {
    btn.onclick = async () => {
      const id = btn.dataset.done;
      const input = prompt('走过日期(YYYY-MM-DD);清空内容并确定可取消标记:',
        marks[id]?.doneAt || new Date().toISOString().slice(0, 10));
      if (input === null) return;
      const date = input.trim();
      if (!date) delete marks[id]?.doneAt;
      else if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { alert('日期格式应为 YYYY-MM-DD'); return; }
      else (marks[id] = marks[id] || {}).doneAt = date;
      await saveMarks();
    };
  }
}

async function saveMarks() {
  try {
    await gushan.writeData('marks', marks);
  } catch (e) {
    alert(`标记保存失败:${e.message}`);
    return;
  }
  renderLibrary();
  if (lastRecInput) runRecommend(); // 推荐已排除走过线,标记变了就重算
}

// 路线库一键规划:切到规划页并预选区域与该线路,填好日期即可生成
async function planFromLibrary(trailId, regionId) {
  document.querySelector('#tabs [data-view="planner"]').click();
  $('region').value = regionId;
  $('region').onchange();
  await refreshTrailOptions(regionId, trailId);
}

// 入门速览:把全程总量折算成日均口径,回答「一天走多少、要爬多少、最长多久没补给」。
// 数据来自 GushanLib.quickfacts(纯函数,主进程同源),每项都带数字来源;warn 项标黄提醒。
function quickFactsHtml(t) {
  const facts = quickFactsOf(t);
  if (!facts.length) return '';
  const items = facts.map((f) =>
    `<span class="qf${f.warn ? ' qf-warn' : ''}" title="${esc(f.why)}"><b>${esc(f.label)}</b>${esc(f.value)}</span>`
  ).join('');
  return `<p class="qf-row">${items}</p>`;
}

// 装备清单预览:复用 lib/gear.js 的确定性推导(与生成行程时同一套实现,不手抄第二份)。
// 此处不传天气上下文,只给「按线路字段必然要带」的项;生成行程后会带上天气推导的完整版。
function gearPreviewHtml(t) {
  const items = gearChecklistOf(t);
  if (!items.length) return '';
  const shown = items.slice(0, 4).map((i) => esc(i.item)).join(' / ');
  const more = items.length > 4 ? ` <span class="muted">等 ${items.length} 项,生成行程后看完整清单</span>` : '';
  return `<p class="muted gear-preview"><b>行前要带:</b>${shown}${more}</p>`;
}

// 落地明细段:住宿+餐饮+门票,口径来自 GushanLib.recommend.costBreakdown
function costLandPart(t, bd) {
  return `住宿 ¥${bd.lodging} + 餐饮 ¥${bd.food} + ${t.tickets == null ? '门票未标按 0' : `门票 ¥${bd.tickets}`} = 落地 ¥${bd.total}`;
}

// 卡片的人均花费行,路线库与推荐结果共用。推荐结果已查到的火车价由 _transport 带入;
// 路线库卡片展开后再按出发站补估(见 wireTransportLookups)。tp.note 是 12306 网络源,入 HTML 前过 esc
function costLineHtml(t) {
  const bd = costBreakdownOf(t, appCfg);
  const landPart = costLandPart(t, bd);
  if (t._transport) {
    const tp = t._transport;
    return `<p class="cost-est" data-cost="${esc(t.id)}" data-land="${bd.total}" data-transport-done="1">${esc(`人均约 ¥${bd.total + tp.perPerson}(${landPart} + 往返火车约 ¥${tp.perPerson},${tp.note})`)}</p>`;
  }
  const tpNote = currentOrigin()
    ? ';往返火车未含(展开后按出发站补估)'
    : ';未含往返大交通,填出发站可估';
  return `<p class="cost-est" data-cost="${esc(t.id)}" data-land="${bd.total}">${esc(`人均落地约 ¥${bd.total}(${landPart}`)}<span data-tp>${esc(tpNote)}</span>${esc(')')}</p>`;
}

// 卡片展开是显式动作,往返火车估算在此按需查询(主进程会话内按枢纽缓存),不拖累列表首屏
function wireTransportLookups(root) {
  for (const details of root.querySelectorAll('details.route')) {
    details.addEventListener('toggle', () => {
      const line = details.querySelector('[data-cost]');
      if (!details.open || !line || line.dataset.transportDone) return;
      const origin = currentOrigin();
      if (!origin) return;
      lookupTransport(line, origin, false);
    });
  }
}

// 单卡补估:成功改写整行;确认无直达改口径说明;查询失败给可点的重试(force 绕过会话缓存)
async function lookupTransport(line, origin, force) {
  const note = line.querySelector('[data-tp]');
  if (note) note.textContent = ';往返火车查询中…';
  let res;
  try {
    res = await gushan.transportForTrail({ trailId: line.dataset.cost, originStation: origin, force });
  } catch {
    res = { error: '网络异常' };
  }
  if (res && res.error) {
    if (!note) return;
    note.textContent = ';往返火车查询失败,';
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'mark-btn';
    retry.textContent = '点此重试';
    retry.onclick = () => lookupTransport(line, origin, true);
    note.append(retry);
    return;
  }
  if (!res) {
    if (note) note.textContent = ';往返火车未估到(可能无直达车),规划行程看实价';
    return;
  }
  line.dataset.transportDone = '1';
  const land = Number(line.dataset.land);
  line.textContent = `人均约 ¥${land + res.perPerson}(落地 ¥${land} + 往返火车约 ¥${res.perPerson},${res.note})`;
}

function routeHtml(t) {
  const g = t._grade;
  const statusCls = { 开放: 'st-open', 部分管控: 'st-warn', 管控: 'st-warn', 禁入: 'st-bad', 关闭: 'st-bad' }[t.status];
  // 数据测试保证评级与指标建议相差不超过一级;此提示是兜底,正常不出现。
  // 指标数据不足时(grading 返回 usable:false)不给建议级,改说数据不足——
  // 不能拿一个编出来的星级去和人工评级比,那会让兜底提示自己变成一句假话。
  const gradeHint = g.usable && Math.abs(t.grade - g.suggested) >= 2
    ? `<p class="warn">评级校验:按量化指标建议为 ★${g.suggested}(${esc(g.label)}),请人工核对</p>` : '';
  const gradeLine = g.usable
    ? `<p class="muted">评级明细:强度 ${g.exertion} + 海拔 ${g.altitude} + 技术 ${g.technical}${g.load ? ` + 多日重装 ${g.load}` : ''} = ${g.total}(指标建议 ★${g.suggested})</p>`
    : '<p class="warn">量化指标不完整(里程/爬升缺失或非法),无法给出评级建议——上方星级为人工评级,仅供参考</p>';
  const fit = bodyState?.matches?.[t.id];
  const fitBadge = fit && FIT_TEXT[fit.level]
    ? `<span class="fit-badge ft-${esc(fit.level)}" title="${esc(fit.reasons.join(';'))}">${FIT_TEXT[fit.level]}</span>` : '';
  const mk = marks[t.id] || {};
  const markBadges = `${mk.wanted ? '<span class="fit-badge ft-want">想去</span>' : ''}
    ${mk.doneAt ? `<span class="fit-badge ft-done" title="走过记录">已走 ${esc(String(mk.doneAt).slice(5))}</span>` : ''}`;
  return `<details class="route">
    <summary><span class="route-title">${esc(t.name)}</span>
      <span class="grade g${t.grade}">★${t.grade} ${GRADE_TEXT[t.grade] || ''}</span>${fitBadge}${markBadges}
      <span class="status ${statusCls}">${esc(t.status)}</span>
      <span class="route-chev"><svg width="11" height="7" viewBox="0 0 12 8"><path d="M1 1.5 L6 6.5 L11 1.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
      <span class="route-sub muted">${esc(t.province)} · ${esc(t.area)} · ${esc(t.type)}</span></summary>
    <div class="route-body">
      <div class="route-metrics"><span>${t.days} 天</span><span>${t.distanceKm}km</span>
        <span>爬升 ${t.climbM}m</span><span>最高 ${t.maxAltM}m</span>${t.bestSeason ? `<span>${esc(t.bestSeason)}</span>` : ''}</div>
      <p>${esc(t.summary)}</p>
      ${t.statusNote ? `<p class="warn">${esc(t.statusNote)}</p>` : ''}
      ${gradeLine}
      ${fitLineHtml(fit)}
      ${gradeHint}
      ${quickFactsHtml(t)}
      ${t.risks ? `<p><b>风险:</b>${t.risks.map(esc).join(' / ')}</p>` : ''}
      ${t.supplies ? `<p><b>补给:</b>${esc(t.supplies)}</p>` : ''}
      ${gearPreviewHtml(t)}
      ${costLineHtml(t)}
      <p class="mark-ops">
        <button class="mark-btn${mk.wanted ? ' on' : ''}" data-want="${t.id}">${mk.wanted ? '★ 已在想去' : '☆ 想去'}</button>
        <button class="mark-btn${mk.doneAt ? ' on' : ''}" data-done="${t.id}">${mk.doneAt ? `✓ 已走过 ${String(mk.doneAt).slice(5)}` : '标记走过'}</button>
      </p>
      ${t.regionId
        ? `<p><button class="lib-plan" data-plan="${t.id}|${t.regionId}">用这条线规划行程</button></p>`
        : '<p class="muted">未接入行程规划(线路需标注 regionId 与环线节点)</p>'}
    </div>
  </details>`;
}

// ---------- 智能推荐 ----------

// 景色词表直接用 GushanLib.recommend.SCENERY(单一来源),不再手抄副本

const recSelected = new Set();

function initRecommend() {
  // chips 由词表生成,数字是路线库内可命中的条数,零命中的词不显示
  const counts = {};
  for (const t of libTrails) for (const s of t.scenery || []) counts[s] = (counts[s] || 0) + 1;
  for (const tag of SCENERY_TAGS) {
    if (!counts[tag]) continue;
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'scn-chip';
    chip.dataset.tag = tag;
    chip.setAttribute('aria-pressed', 'false');
    chip.textContent = `${tag} · ${counts[tag]}`;
    chip.onclick = () => {
      const on = chip.classList.toggle('on');
      chip.setAttribute('aria-pressed', String(on));
      if (on) recSelected.add(tag); else recSelected.delete(tag);
    };
    $('rec-scenery').append(chip);
  }
  // 省份限定:想"只看新疆"时不用翻整库
  for (const p of [...new Set(libTrails.map((t) => t.province))].sort()) {
    $('rec-province').append(new Option(p, p));
  }
  $('rec-go').onclick = runRecommend;
  // 难度是「门槛」不是「偏好」:改了即刻重算,不要求用户再点一次「帮我推荐」。
  // 只在已经推荐过、或已填了条件时才自动跑,避免刚进页面就发请求。
  $('rec-grade').addEventListener('change', () => {
    const hasCriteria = toPositive($('rec-budget').value) !== null
      || recSelected.size > 0 || $('rec-province').value || $('rec-origin').value.trim();
    if (hasCriteria) runRecommend();
  });
  for (const id of ['rec-budget', 'rec-days', 'rec-origin']) {
    $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') runRecommend(); });
  }
  // 出发站与规划页共用同一份记忆:规划页填过就直接带出来,不用重填
  try {
    const saved = JSON.parse(localStorage.getItem(FORM_KEY) || 'null');
    if (saved?.origin) $('rec-origin').value = saved.origin;
    if (saved?.recGrade) $('rec-grade').value = String(saved.recGrade);
  } catch { /* 记忆坏了当没填 */ }
  wireStationInput($('rec-origin'), $('rec-station-list'));
}

async function runRecommend() {
  $('rec-msg').textContent = '';
  const budget = toPositive($('rec-budget').value);
  const maxDays = toPositive($('rec-days').value);
  const scenery = [...recSelected];
  const province = $('rec-province').value;
  const originStation = $('rec-origin').value.trim();
  // 难度闸门:留空 = null,交给主进程按体能自动收窄;显式选档则以此为准(手选优先)
  const gradeMax = toPositive($('rec-grade').value);
  if (budget === null && !scenery.length && !province && !originStation) {
    $('rec-msg').textContent = '填一个人均预算或出发站,点几个想看的景色,或限定省份,至少给一个方向';
    return;
  }
  const input = { budget, maxDays, scenery, province, originStation, gradeMax };
  lastRecInput = input;
  if (originStation) $('rec-msg').textContent = '正在按出发站估算往返火车实价…(每个枢纽只查一次,首条推荐稍慢)';
  $('rec-go').disabled = true; // 推荐期间禁点:连点会对 12306 并发两轮估算
  try {
    renderRecommend(await gushan.recommendTrails(input), input);
    $('rec-msg').textContent = '';
    rememberOrigin(originStation);
  } catch (e) {
    $('rec-msg').textContent = `推荐失败:${e.message}`;
  } finally {
    $('rec-go').disabled = false;
    // 难度档位记住:下次进来还是同一档,不用重新选
    try {
      const saved = JSON.parse(localStorage.getItem(FORM_KEY) || 'null') || {};
      saved.recGrade = $('rec-grade').value;
      localStorage.setItem(FORM_KEY, JSON.stringify(saved));
    } catch { /* 记忆写不进去不影响推荐 */ }
  }
}

// 数字输入收敛:空/0/负数一律视为没填
function toPositive(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function criteriaText({ budget, maxDays, scenery, province, gradeMax }, gate = null) {
  const parts = [];
  if (scenery.length) parts.push(`景色「${scenery.join('、')}」`);
  if (province) parts.push(`限 ${province}`);
  if (budget) parts.push(`人均预算 ¥${budget}`);
  if (maxDays) parts.push(`≤${maxDays} 天`);
  // 难度闸门:显式选的写「★N 以内」;自动收窄的写清是体能给的,让用户知道结果为什么变少
  if (Number.isFinite(gradeMax)) parts.push(`★${gradeMax} 以内`);
  else if (gate?.auto && Number.isFinite(gate.gradeMax)) parts.push(`体能上限★${gate.gradeMax} 以内`);
  return parts.join(' + ');
}

function renderRecommend(list, input) {
  const gate = list.__gate || null;
  const caliber = input.originStation
    ? '花费含往返火车实价估算(去程价×2)+ 吃住门票'
    : '花费是吃住+门票的落地估算,未含往返大交通';
  const gateNote = gate?.auto && Number.isFinite(gate.gradeMax)
    ? ` · 已按 ${gate.bodyHint || '体能'}自动排除更高难度`
    : '';
  $('rec-count').textContent = list.length
    ? `按 ${criteriaText(input, gate)} 推荐 ${list.length} 条 · 走过的已排除 · ${caliber}${gateNote}`
    : `按 ${criteriaText(input, gate)} 没有匹配的线路,放宽预算/天数或难度上限再试`;
  $('rec-list').innerHTML = list.map((r, i) => recCardHtml(r, i, input)).join('');
  wirePlanButtons($('rec-list'));
  wireMarkButtons($('rec-list'));
  wireTransportLookups($('rec-list'));
}

function recCardHtml(r, i, input) {
  const t = r.trail;
  // 口径:填了出发站且查到实价 → 人均 = 落地 + 往返火车估算;否则仅落地,卡片言明未含
  const est = r.estAll ?? r.est;
  const fit = input.budget
    ? (r.overBudget
      ? `<span class="status st-bad">超预算 ¥${r.overBudget}</span>`
      : '<span class="status st-open">预算内</span>')
    : '';
  const hits = r.hits.length ? `<span class="rec-hit">景色命中:${esc(r.hits.join('、'))}</span>` : '';
  // 门票未标注要显式挂出来:costBreakdown 按 0 计,不说就等于默默低估预算
  const tk = t.tickets == null
    ? `<span class="status st-bad" title="线路库未标注门票数据，此处按 0 元计，实际花费更高">门票未标注</span>` : '';
  // 规划器未覆盖:不能一键生成行程,但路线本身仍然可选——说清原因,不静默没按钮
  const noPlan = (t.regionId && t.node)
    ? ''
    : `<span class="status st-open" title="线路库未标注所属环线区域，无法自动串进行程规划；仍可参考下方逐日安排自行安排交通">需自行前往</span>`;
  return `<div class="rec">
    <div class="rec-why"><span class="rec-rank">荐 ${i + 1}</span>${hits}${tk}${noPlan}${fit}
      <span class="rec-est">预计人均 ¥${est}<i>(${r.transport ? '含往返火车' : '未含大交通'})</i></span></div>
    ${routeHtml({ ...t, id: r.id, _transport: r.transport })}
  </div>`;
}

init();

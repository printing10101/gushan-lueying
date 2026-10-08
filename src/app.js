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
const { SCENERY: SCENERY_TAGS } = LIB.recommend;
// 落地花费的公式只在 lib/budget.js 一份(推荐页与路线库卡片都用它),这里加前缀解构防撞名
const { landBudget: budgetLand, oneTimeCosts: oneTimeOf } = LIB.budget;
// 地图实现层:高德 / 腾讯 GL 两套 SDK 藏在 lib/map-impl.js 后面,这里不出现任何一家的 API 名
const { pickMapImpl: pickMapOf, centerOf: mapCenterOf } = LIB.mapImpl;
const { GRADE_LABELS: GRADE_TEXT } = LIB.grading;
const { summitTemp: summitTempOf, gearChecklist: gearChecklistOf, daylightPlan: daylightPlanOf } = LIB.gear;
const { quickFacts: quickFactsOf } = LIB.quickfacts;
const { FIT_LABELS: FIT_TEXT, ADVICE_LABELS: ADVICE_TEXT } = LIB.fitness;
// 海拔分档口径在 lib/filters.js(与单测同源);名字一律加后缀,避免与 lib 顶层声明撞名
const { ALT_BANDS: ALT_BAND_LIST, hitAltBand: hitAltBandOf, byAlt: byAltDesc } = LIB.filters;
const { normalizeRiskNotes: riskNotesOf } = LIB.risknotes;
const { actualVsPlanned: actualVsPlannedOf } = LIB.actuals;
const { permitNotice: permitNoticeOf } = LIB.permit;

// HTML 转义:数据(手编 JSON/网络返回/存档/报错原文)不该在页面上长成标签或逃出属性
function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// 难度星级文案来自 GushanLib.grading,不再本地手抄

// 地图状态已收进 mapCtx(见 lib/map-impl.js):这里不再持有 SDK 对象与图层引用
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
  // 季节系数表:卡片的人均估算要按"哪天出行"算,这张表由主进程读 data/seasonality.json 给过来
  appCfg.seasonality = (await gushan.readData('seasonality')) || {};
  for (const [id, r] of Object.entries(regions)) {
    $('region').append(new Option(r.name, id));
  }
  $('region').onchange = () => {
    drawRegion(regions[$('region').value]);
    renderRegionBrief(regions[$('region').value]);
    refreshTrailOptions($('region').value);
    checkOriginVsHub();
  };
  // 出发站与区域枢纽是否同站:切区域、改站名都要即时判(默认值是成都东,选川西就会撞)
  $('origin').addEventListener('input', checkOriginVsHub);
  // 上次规划条件回填(含区域联动),没有存档才落到默认值
  if (!restoreForm()) {
    drawRegion(regions[$('region').value]);
    renderRegionBrief(regions[$('region').value]);
    refreshTrailOptions($('region').value);
    $('start-date').value = addDaysStr(todayLocal(), 7);
  }
  checkOriginVsHub(); // 回填后也要判一次:上次存的站可能正等于这次选的区域枢纽

  // 地图后台加载,不挡规划表单交互;就绪后补画当前区域与已展示的行程。
  // 实现层决定用哪家(腾讯需要非 file:// 来源)。**必须 catch**:不接的话任何异常
  // 都会变成未处理的 promise 拒绝——页面上什么都不显示,看着像"地图就是不出现",
  // 实际是报错被吞了(本地 http 来源 spike 时就这么被吞过一次)。
  bootMap().catch((e) => {
    $('config-hint').textContent = `地图初始化异常:${e.message}`;
  });
  renderConfigGaps(cfg);

  // 出发站输入:输入 2+ 字后联想(规划页与推荐页共用同一实现)
  wireStationInput($('origin'), $('station-list'));

  $('generate').onclick = generateTrip;
  $('trail').addEventListener('change', updateTrailFitHint);
}

// 配置漂移提示:example 有而 config 没有的键位(主进程 readData('config') 附带 _gaps)。
// ensureConfig 只在文件不存在时拷一次,此后 example 新增的键不会自动补进来——
// 缺 flightCityPinyin 时「查机票」是点了必报错的那种,不能让它藏在文件里。
// 这里只报不补:补配置等于改用户的文件,得他自己动手。
function renderConfigGaps(cfg) {
  const gaps = Array.isArray(cfg?._gaps) ? cfg._gaps : [];
  if (!gaps.length) return;
  const broken = gaps.filter((g) => g.severity === 'blocking').map((g) => g.path);
  const defaulted = gaps.filter((g) => g.severity !== 'blocking').map((g) => g.path);
  const parts = [];
  if (broken.length) parts.push(`缺 ${broken.join('、')} —— 相关功能点了会直接报错`);
  if (defaulted.length) parts.push(`缺 ${defaulted.join('、')} —— 正在用代码默认值,想改口径补进文件即可`);
  const box = $('config-hint');
  const span = document.createElement('span');
  span.className = 'warn';
  span.textContent = `${box.textContent ? ' | ' : ''}配置比 config.example.json 少项:${parts.join(';')}`;
  box.append(span);
}

// 出发站 == 该区域铁路枢纽时,查出来的车次毫无意义(planner 会硬报错)。
// 表单默认出发站写死「成都东」,一进来选川西就撞——所以选区域/改站名时就当场说破,别等点「生成行程」。
function checkOriginVsHub() {
  const box = $('left-msg');
  const hub = regionCache[$('region').value]?.hub?.railStation;
  const origin = $('origin').value.trim();
  if (!hub || !origin || origin !== hub) {
    if (box.dataset.hubWarn) { delete box.dataset.hubWarn; box.textContent = ''; }
    return;
  }
  box.dataset.hubWarn = '1';
  box.textContent = `出发站「${hub}」就是该区域的枢纽站,同站车次没有意义:请改成你真正出发的车站`;
}

// 按区域重建徒步线路下拉(切区域必须重建,否则选项还是上个区域的)
// 数据直接用启动时载入的 libTrails,不再每次走 IPC 往返
function refreshTrailOptions(regionId, selectedId = '', secondId = '') {
  $('trail').innerHTML = '<option value="">自动挑选</option>';
  $('trail2').innerHTML = '<option value="">不加</option>';
  for (const t of libTrails) {
    if (t.regionId === regionId) {
      // 星数与文字必须同用人工评级;_grade.label 是指标建议级,只作详情页交叉校验展示
      const label = `${t.name}(★${t.grade} ${GRADE_TEXT[t.grade] || ''})`;
      $('trail').append(new Option(label, t.id));
      $('trail2').append(new Option(label, t.id));
    }
  }
  $('trail').value = selectedId || '';
  $('trail2').value = secondId || '';
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

// ---------- 地图 ----------
// 实现层决定用高德还是腾讯(见 lib/map-impl.js),这里只管"什么时候加载、失败怎么办"。
// 腾讯 GL 不接受 file:// 来源:file:// 下即使配了腾讯 Key 也不会选它(那会白屏),
// 而是给出一句可执行的提示(用 GUSHAN_SERVE=1 以 http://127.0.0.1 启动)。
let mapCtx = null; // { impl, handle } —— 地图实现与画布句柄

function drawRegion(region) {
  if (mapCtx && region) mapCtx.impl.drawRegion(mapCtx.handle, region);
}

function drawTrip(trip, region) {
  if (mapCtx && region) mapCtx.impl.drawTrip(mapCtx.handle, trip, region);
}

async function bootMap() {
  const pick = pickMapOf(appCfg);
  if (!pick.impl) {
    $('map').innerHTML = `<p class="muted map-empty">${esc(pick.reason)}</p>`;
    if (pick.blocked === 'tencent') {
      $('config-hint').textContent = '腾讯地图需要在本地 http 来源下使用(官方不支持 file://):'
        + '用 `GUSHAN_SERVE=1 npm run app` 启动即可出图';
    } else {
      $('config-hint').textContent = '未配置地图 Key:请在 data/config.json 填 amapKeyJs(高德)或 tencentKeyJs(腾讯)';
    }
    return;
  }
  try {
    await pick.impl.load(pick.key, { securityCode: appCfg.amapSecurityJsCode });
    const region = regionCache[$('region').value];
    mapCtx = { impl: pick.impl, handle: pick.impl.make($('map'), { center: mapCenterOf(region), zoom: 8 }) };
    drawRegion(region);
    if (currentTrip) drawTrip(currentTrip, regionCache[currentTrip.input.regionId]);
  } catch (e) {
    $('map').innerHTML = `<p class="muted map-empty">${esc(pick.impl.label)}地图加载失败(${esc(e.message)}),`
      + '检查网络后<button id="map-retry" class="mark-btn">重试</button></p>';
    $('map-retry').onclick = () => {
      $('map').innerHTML = '<p class="muted map-empty">正在重新加载…</p>';
      bootMap();
    };
  }
}
async function generateTrip() {
  const input = {
    regionId: $('region').value,
    originStation: $('origin').value.trim(),
    startDate: $('start-date').value,
    days: Number($('days').value),
    headcount: Number($('headcount').value) || 1,
    // 只交 trailIds 一个口径:老字段 trailId 与它并存会让"到底走几条线"各说一套
    trailIds: [$('trail').value, $('trail2').value].filter(Boolean),
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
      days: $('days').value, headcount: $('headcount').value,
      trailIds: [$('trail').value, $('trail2').value].filter(Boolean),
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
    const savedIds = Array.isArray(s.trailIds) ? s.trailIds : (s.trailId ? [s.trailId] : []);
    if (savedIds[0] && [...$('trail').options].some((o) => o.value === savedIds[0])) {
      $('trail').value = savedIds[0];
    }
    if (savedIds[1] && [...$('trail2').options].some((o) => o.value === savedIds[1])) {
      $('trail2').value = savedIds[1];
    }
    updateTrailFitHint();
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
    <button id="trip-gpx" title="导成 GPX 带到手机/手表:山区没信号时按清单要求得有离线轨迹">导出 GPX</button>
    <button id="trip-pack" title="一次产出四个文件(行程/轨迹/行前清单/存档),山区没网时一次拿全">导出离线包</button>
    <button id="trip-print">打印</button></div>`;
}

async function exportTripMd() {
  if (!currentTrip) return;
  if (!gushan.exportTrip) { alert('当前环境(预览页)不支持导出'); return; }
  try {
    const res = await gushan.exportTrip(`行程-${currentTrip.id}.md`,
      LIB.tripMarkdown.tripToMarkdown(currentTrip, {
        gradeLabels: GRADE_TEXT, seatOf: seatFromPrices, daylightOf: daylightPlanOf,
      }));
    if (!res.canceled) $('left-msg').textContent = `已导出:${res.filePath}`;
  } catch (e) {
    alert(`导出失败:${e.message}`);
  }
}

// 导出 GPX:轨迹由主进程用 lib/gpx.js 拼,这里只交 tripId(存档 id)。
// 导出结果里的 note 要说破——没真实路线时导出的只是起点路点,不能让人以为拿到了路书。
async function exportTripGpx() {
  if (!currentTrip) return;
  if (!gushan.exportGpx) { alert('当前环境(预览页)不支持导出 GPX'); return; }
  try {
    const res = await gushan.exportGpx(currentTrip.id);
    if (res.canceled) return;
    $('left-msg').textContent = `已导出 GPX:${res.filePath}`
      + ` —— 轨迹点 ${res.points} 个${res.note ? `,${res.note}` : ''}`;
  } catch (e) {
    alert(`导出 GPX 失败:${e.message}`);
  }
}

// 导出离线包:一次产出"行程.md / 驾车轨迹.gpx / 行前清单.md / 存档.json"到一个新文件夹。
// 返回里带逐文件清单,少写一个都要说出来——批量导出最容易在这里骗人。
async function exportTripPack() {
  if (!currentTrip) return;
  if (!gushan.exportPack) { alert('当前环境(预览页)不支持导出离线包'); return; }
  try {
    const res = await gushan.exportPack(currentTrip.id);
    if (res.canceled) return;
    $('left-msg').textContent = `已导出离线包:${res.dir}(共 ${res.written.length} 个文件:${res.written.join('、')})`;
  } catch (e) {
    alert(`导出离线包失败:${e.message}`);
  }
}

async function renderResult(trip) {
  currentTrip = trip;
  const html = [];
  // 逐日天气对齐:徒步/休整日看宜否,驾车日只报天气本身(宜否是徒步口径,别张冠李戴)。
  // 优先用「当天所在节点」的预报(新档有 byDate);旧档没有就退回单点预报,并在下方明示用的是哪个点。
  const wxMap = new Map((trip.weather?.forecast || []).map((d) => [d.date, d]));
  const byDate = trip.weather?.byDate || {};
  const wxChip = (date, type) => {
    const wx = byDate[date] || wxMap.get(date);
    if (!wx) return '';
    const at = byDate[date]?.at ? `@${byDate[date].at} ` : '';
    const tip = `${at}${wx.label} ${wx.tempMin ?? '—'}~${wx.tempMax ?? '—'}℃ · 降水${wx.precipProb ?? '—'}% · 风${wx.windMax ?? '—'}km/h`;
    if (type === 'drive') {
      return `<span class="day-wx v-info" title="${esc(tip)}">${esc(wx.label)} 雨${wx.precipProb ?? '—'}%</span>`;
    }
    return `<span class="day-wx v-${esc(wx.verdict)}" title="${esc(tip)}">${esc(wx.verdict)}</span>`;
  };
  const trailNames = (trip.trails && trip.trails.length ? trip.trails : (trip.trail ? [trip.trail] : []))
    .map((t) => `${t.name} ★${t.grade}`).join(' + ');
  html.push(`<div class="day"><div class="day-head"><h3>${esc(trip.regionName)} · ${trip.input.days} 天</h3>`
    + `<span class="muted">${esc(trailNames)}${trip.trails && trip.trails.length > 1 ? `(${trip.trails.length} 条串联)` : ''}</span></div>`
    + `${railHtml(trip.railOut, '去程火车', 'railOut')}</div>`);
  // 里程口径:没配高德 Key 时全程是直线×1.3 估算,必须在最显眼处说清,不能只藏在预算备注里
  // 里程口径:存档自带文案(planner 的 routeNote),旧档没有就按 distanceEstimated 兜底
  if (trip.kmNote) {
    const warn = trip.routeProvider === 'estimate';
    html.push(`<${warn ? 'p class="warn"' : 'p class="muted"'}>里程口径:${esc(trip.kmNote)}`
      + `${warn ? '。填好 data/config.json 的 amapKeyWeb 或 tencentKeyWeb 后重新生成即为真实驾车路线' : ''}</p>`);
  } else if (trip.distanceEstimated) {
    html.push('<p class="warn">里程为直线×1.3 估算(未配置路线 Key):里程只保证不低估、'
      + '过路费按 0.45 元/km 估、地图无真实路线。</p>');
  }
  // 票价为什么是估算的:接口失败 / 未查到车次 / 预售期外,三件事都得说清,别让人以为这条线不通
  if (trip.railNote) html.push(`<p class="warn">${esc(trip.railNote)}</p>`);
  if (trip.weather?.byDateError) {
    html.push(`<p class="muted">逐日天气锚点未取到(${esc(trip.weather.byDateError)}),下面按徒步点`
      + `「${esc(trip.weather.node)}」的单点预报展示。</p>`);
  }
  const shift = suggestShiftStart(trip);
  for (const day of trip.schedule) {
    const [cls, name] = TAG[day.type] || ['tag-note', day.type];
    let body = '';
    if (day.type === 'drive') {
      body = `<table>${day.legs.map((l) =>
        `<tr><td>${esc(l.from)}→${esc(l.to)}</td><td>${l.km}km / ${l.hours}h${l.estimated ? ' <span class="muted">(估算里程)</span>' : ''}</td><td>油+过路 ¥${l.costs.driveTotal}</td></tr>`).join('')}</table>
        ${(day.legs || []).filter((l) => l.detour).map((l) => '<p class="warn">' + esc(l.from) + '→' + esc(l.to) + ' 真实里程是直线距离的 ' + l.detour.ratio + ' 倍(' + l.detour.straightKm + 'km → ' + l.km + 'km):路网里近路可能不通,算法绕了一大圈——本段建议单独核实,别当成一天能开完的路</p>').join('')}
        ${day.overKm ? '<p class="warn">当日驾车超过单日上限,行程偏紧</p>' : ''}
        ${day.lateArrival ? `<p class="warn">去程 ${esc(day.lateArrival.time)} 才到 ${esc(day.lateArrival.station)},首日驾车时间紧张,备好夜路预案</p>` : ''}
        ${day.earlyDepart ? `<p class="warn">回程 ${esc(day.earlyDepart.time)} 即发车,末日别排长驾,预留进站时间</p>` : ''}`;
    } else if (day.type === 'hike') {
      const t = day.info || {};
      body = `<p>${esc(t.name || day.trail)}:约${t.climbM}m 爬升 · ★${t.grade} ${esc(t.gradeLabel)} · ${esc(t.supplies || '')}</p><p class="muted">${esc(t.summary || '')}</p>`;
      // 日照窗口:纯徒步日的出发/收队时间(缺日出日落就不显示,不猜)
      const wxToday = byDate[day.date] || wxMap.get(day.date); // 当日天气(逐日锚点优先)
      const dl = daylightPlanOf(wxToday);
      if (dl) {
        body += `<p class="muted">日照窗口 ${esc(dl.sunrise)} → ${esc(dl.sunset)}(约 ${dl.hours}h),`
          + `建议 <b>${esc(dl.lastLight)}</b> 前收队(留 1 小时余量)</p>`;
      }
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
      body = day.spare
        ? '<p class="muted">机动/备用日:天数留白,给天气、路况或体力消耗;食宿照常</p>'
        : '<p class="muted">机动休整:高反适应或天气避让,食宿照常</p>';
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
  const gpxBtn = $('trip-gpx');
  if (gpxBtn) gpxBtn.onclick = exportTripGpx;
  const packBtn = $('trip-pack');
  if (packBtn) packBtn.onclick = exportTripPack;
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
      <div class="wx-temp">${d.tempMin ?? '—'}~${d.tempMax ?? '—'}℃</div>
      ${d.sunrise && d.sunset ? `<div class="wx-sun" title="日出 ${esc(d.sunrise)} / 日落 ${esc(d.sunset)}">${esc(d.sunrise)}–${esc(d.sunset)}</div>` : ''}<div class="wx-rain">雨${d.precipProb ?? '—'}%</div>
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
    const backIds = trip.input.trailIds || (trip.input.trailId ? [trip.input.trailId] : []);
    await refreshTrailOptions(trip.input.regionId, backIds[0] || '', backIds[1] || '');
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
  const keepAlt = $('lib-alt').value;
  $('lib-province').innerHTML = '<option value="">全部省份</option>';
  $('lib-type').innerHTML = '<option value="">全部类型</option>';
  $('lib-alt').innerHTML = '<option value="">全部海拔</option>';
  // 下拉选项由数据生成,新增省份/类型不用改 UI;海拔档位由 lib 生成,改分档口径也不用改 UI
  for (const p of [...new Set(libTrails.map((t) => t.province))].sort()) $('lib-province').append(new Option(p, p));
  for (const ty of [...new Set(libTrails.map((t) => t.type))].sort()) $('lib-type').append(new Option(ty, ty));
  for (const b of ALT_BAND_LIST) $('lib-alt').append(new Option(b.label, b.key));
  if ([...$('lib-province').options].some((o) => o.value === keepProvince)) $('lib-province').value = keepProvince;
  if ([...$('lib-type').options].some((o) => o.value === keepType)) $('lib-type').value = keepType;
  if ([...$('lib-alt').options].some((o) => o.value === keepAlt)) $('lib-alt').value = keepAlt;
}

async function initLibrary() {
  await loadLibraryData();
  for (const id of ['lib-search', 'lib-province', 'lib-grade', 'lib-type', 'lib-alt', 'lib-status', 'lib-mark', 'lib-sort']) {
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
  const alt = $('lib-alt').value;
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
    && (!alt || hitAltBandOf(t, alt))
    && hitStatus(t)
    && hitMark(t)
    && (!kw || `${t.name}${t.province}${t.area}${t.summary}`.toLowerCase().includes(kw)));

  const sorters = {
    grade: (a, b) => b.grade - a.grade || b._grade.total - a._grade.total || a.name.localeCompare(b.name, 'zh'),
    climb: (a, b) => b.climbM - a.climbM,
    // 海拔排序走 lib/filters.js 的 byAlt:缺 maxAltM 的行沉底,不像 climb 那样让脏值长出 NaN 序
    alt: byAltDesc,
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
  wireTicketSources($('lib-list'));
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
  // 实测量与 GPX 导入:与「想去/走过」同一入口区,数据分别落 marks.json / trails.json
  for (const btn of root.querySelectorAll('[data-actual]')) {
    btn.onclick = () => recordActuals(btn.dataset.actual);
  }
  for (const btn of root.querySelectorAll('[data-gpx]')) {
    btn.onclick = () => importGpxFor(btn.dataset.gpx, btn);
  }
}

// 记实走:把实测量(天数/里程/爬升)记进 marks.json,与线路库标称值对比。
// 三项逗号分隔,留空或 `-` 表示这项不动;填 0 表示清除这项。
// 不要求一次填全——走过一条线能记住的往往只有其中一个数。
const ACTUAL_KEYS = ['actualDays', 'actualDistanceKm', 'actualClimbM'];
async function recordActuals(id) {
  const mk = marks[id] || {};
  const input = prompt(
    '实走记录:天数, 里程km, 爬升m(留空或 - 表示不改该项;填 0 清除该项)\n'
    + `当前:${[mk.actualDays, mk.actualDistanceKm, mk.actualClimbM].map((v) => v ?? '—').join(' , ')}`,
    [mk.actualDays ?? '', mk.actualDistanceKm ?? '', mk.actualClimbM ?? ''].join(', '));
  if (input === null) return;
  const parts = input.split(/[,，]/).map((s) => s.trim());
  if (parts.length !== 3) { alert('需要三项:天数, 里程km, 爬升m'); return; }
  const next = { ...mk };
  let changed = false;
  for (let i = 0; i < 3; i++) {
    const p = parts[i];
    if (!p || p === '-') continue;
    if (p === '0') { if (next[ACTUAL_KEYS[i]] !== undefined) { delete next[ACTUAL_KEYS[i]]; changed = true; } continue; }
    const v = Number(p);
    if (!Number.isFinite(v) || v <= 0) { alert(`${ACTUAL_KEYS[i]} 需要正数或 0,收到「${p}」`); return; }
    next[ACTUAL_KEYS[i]] = v;
    changed = true;
  }
  if (!changed) return; // 什么都没改就不写盘,也别顺手把「走过」给标上
  if (!next.doneAt) next.doneAt = todayLocal(); // 记了实测量就说明走过,不用他再点一次
  marks[id] = next;
  await saveMarks();
}

// 导入 GPX:主进程选文件并算好「实测 vs 标称」,这里负责摊开对比表并要一次确认。
// 有 review 项时即便确认也不写(主进程挡着),界面把原因原样转达。
async function importGpxFor(id, btn) {
  if (!gushan.importGpx) { alert('当前环境(预览页)不能选文件'); return; }
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = '解析中…';
  let res;
  try {
    res = await gushan.importGpx({ trailId: id });
  } catch (e) {
    alert(`导入失败:${e.message}`);
    return;
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
  if (!res || res.canceled) return;
  if (res.error) { alert(`这个 GPX 不能用:${res.error}(有效点 ${res.points},丢弃 ${res.skipped})`); return; }
  const trail = libTrails.find((t) => t.id === id) || {};
  const m = res.measured || {};
  const line = (key, unit) => `${key === 'distanceKm' ? '里程' : key === 'climbM' ? '爬升' : '最高海拔'}:`
    + `标称 ${trail[key] ?? '—'}${unit} / 实测 ${m[key] ?? '未测出'}${unit}`;
  const review = (res.d?.review || [])
    .map((r) => `⚠ ${r.field} 差 ${r.diffPct}%(标称 ${r.planned} vs 实测 ${r.measured})`).join('\n');
  const will = (res.willWrite || []).join('、') || '无';
  const ok = confirm(`解析到 ${m.points} 个轨迹点\n\n`
    + `${['distanceKm', 'climbM', 'maxAltM'].map((k, i) => line(k, ['km', 'm', 'm'][i])).join('\n')}\n\n`
    + `将写入:${will}\n`
    + (review ? `\n${review}\n—— 差超阈值,按纪律不自动覆盖,即使确认也不写(请人工裁决)\n` : '')
    + `\n确认写入 data/trails.json?`);
  if (!ok) return;
  let done;
  try {
    done = await gushan.importGpx({ token: res.token, confirmed: true });
  } catch (e) {
    alert(`写入失败:${e.message}`);
    return;
  }
  if (done.blocked) { alert(`未写入:${done.blocked}`); return; }
  // 标称值变了 → 重载线路库(卡片指标、评级、体能匹配全部跟着重算),否则界面还在显示旧数
  await loadLibraryData();
  renderLibrary();
  alert(`已写入 ${done.wrote.join('、')}:${done.wrote.map((k) => `${k}=${done.apply[k]}`).join(' ')}`);
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

// 卡片花费的口径参数:推荐页三个控件优先,没渲染出来(如预览页)才退回规划页的日期与人数。
// 日期决定季节系数、人数决定房间数、档次决定住宿倍数——这就是"数字会跟着你改的东西"。
function costInputs() {
  return {
    date: $('rec-date')?.value || $('start-date')?.value || null,
    headcount: toPositive($('rec-headcount')?.value) || 1,
    tier: $('rec-tier')?.value || '舒适',
  };
}

// 分项一行:未知项写「未含」,绝不写成 ¥0 冒充已知(INSTINCTS:amount null 不是 0)
function costItemChip(it) {
  const val = it.perPerson === null ? '<b>未含</b>' : `¥${it.perPerson}`;
  return `<span class="qf" title="${esc(it.note)}"><b>${esc(it.name)}</b>${val}</span>`;
}

// 季节/档次注脚:让用户看得见这个数被哪一档、哪一路命中项乘过
function costFactorNote(bd) {
  const s = bd.season || {};
  const parts = [];
  if (s.lodging !== 1) parts.push(`住 ×${s.lodging}(${esc(s.lodgingFrom)})`);
  if (s.food !== 1) parts.push(`餐 ×${s.food}(${esc(s.foodFrom)})`);
  if (bd.unknownCount) parts.push(`${bd.unknownCount} 项未含`);
  for (const n of bd.notes || []) parts.push(esc(n));
  return parts.length ? ` <span class="muted">(${parts.join(';')})</span>` : '';
}

// 卡片的人均花费行,路线库与推荐结果共用。公式只在 lib/budget.js 一份。
// 推荐结果已查到的火车价由 _transport 带入;路线库卡片展开后再按出发站补估(见 wireTransportLookups)。
// tp.note 是 12306 网络源,入 HTML 前过 esc
function costLineHtml(t) {
  const bd = budgetLand(t, costInputs(), appCfg);
  const chips = `<span class="qf-row">${bd.items.map(costItemChip).join('')}</span>`;
  const factor = costFactorNote(bd);
  if (t._transport) {
    const tp = t._transport;
    return `<p class="cost-est" data-cost="${esc(t.id)}" data-land="${bd.total}" data-transport-done="1">`
      + `${esc(`人均约 ¥${bd.total + tp.perPerson}(落地 ¥${bd.total} + 往返火车约 ¥${tp.perPerson},${tp.note})`)}`
      + `${factor}${chips}</p>`;
  }
  const tpNote = currentOrigin()
    ? ';往返火车未含(展开后按出发站补估)'
    : ';未含往返大交通,填出发站可估';
  return `<p class="cost-est" data-cost="${esc(t.id)}" data-land="${bd.total}">`
    + `${esc(`人均落地约 ¥${bd.total}`)}<span data-tp>${esc(tpNote)}</span>${factor}${chips}</p>`;
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

// 风险出处:口径在 lib/risknotes.js(与单测同源)。有出处就写出处,填不出就明说「未核实」;
// 格式不对的条目必须留一行脏提示——否则"数据坏了"会伪装成"这条线没风险"。
function riskNotesHtml(t) {
  const { items, dirty } = riskNotesOf(t);
  const lines = items.map((r) => `<p class="muted">· ${esc(r.text)} —— ${
    r.verified ? `出处:${esc(r.source)}${r.year ? `(${r.year})` : ''}` : '未核实(缺出处)'}</p>`);
  if (dirty) {
    lines.push(`<p class="warn">· 风险出处有 ${dirty} 条格式不对,未显示——请核对 data/trails.json 的 riskNotes</p>`);
  }
  return lines.length ? '<p><b>风险出处:</b></p>' + lines.join('') : '';
}

// 实走 vs 规划:口径在 lib/actuals.js(与单测同源)。只在记过实测量时出现,不给 191 张老卡加噪音。
// 差值超阈值就标「待复核」——这条线库里的标称值可能是错的,而不是"我走多了"。
function actualLineHtml(t) {
  const mk = marks[t.id] || {};
  const { rows, bad } = actualVsPlannedOf(t, mk);
  const lines = rows.map((r) => `<p class="muted">· ${esc(r.label)}:规划 ${r.planned}${r.unit}`
    + ` / 实走 ${r.actual}${r.unit} —— ${r.diffPct > 0 ? '+' : ''}${r.diffPct}%`
    + `${r.review ? '<b>(差得多,待复核)</b>' : ''}</p>`);
  if (bad.length) {
    lines.push(`<p class="warn">· 实走数据有 ${bad.length} 项不是正数(${bad.map(esc).join(',')}),`
      + '已忽略——请核对 data/marks.json</p>');
  }
  if (lines.length) return '<p><b>实走记录:</b></p>' + lines.join('');
  // 走过但没记实测量:给按钮,不再让人去手改 data/marks.json
  if (mk.doneAt) {
    return '<p><b>实走记录:</b> <span class="muted">已走过,未记实测量——点下方「记实走」'
      + '(或「导入 GPX」)即可与规划值对比。</span></p>';
  }
  return '';
}

// 一次性开销清单:只列"要不要准备",不给金额(那些价没有可查证的公开口径,编一个数比不写更糟)。
// 触发规则在 lib/budget.js 的 oneTimeCosts,与单测同源。
function oneTimeHtml(t) {
  const items = oneTimeOf(t, { date: costInputs().date });
  if (!items.length) return '';
  return '<details class="gear"><summary>一次性开销(要准备什么)'
    + '<span class="muted">只列要不要准备,不给金额;这些价按当地现询</span></summary>'
    + `<ul>${items.map((i) => `<li><b>${esc(i.item)}</b><span class="muted">${esc(i.reason)} · ${esc(i.amountNote)}</span></li>`).join('')}</ul></details>`;
}

// 门票来源的"看原文":走 gushan.openExternal(https 白名单),不在应用内打开
function wireTicketSources(root) {
  for (const btn of root.querySelectorAll('[data-ticketsrc]')) {
    btn.onclick = () => {
      if (!gushan.openExternal) return; // 预览页没有这个 IPC
      gushan.openExternal(btn.dataset.ticketsrc).catch((e) => alert(`打开链接失败:${e.message}`));
    };
  }
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
      ${t.ticketSource ? `<p class="muted">门票参考来源:${esc(t.ticketSource.source || '')}(${esc(t.ticketSource.checkedAt || '')} 核对)`
        + (t.ticketSource.url ? ` <button class="mark-btn" data-ticketsrc="${esc(t.ticketSource.url)}">看原文</button>` : '') + '</p>' : ''}
      ${t.ticketNote ? `<p class="muted">门票口径:${esc(t.ticketNote)}</p>` : ''}
      ${permitNoticeOf(t) ? `<p class="muted">${esc(permitNoticeOf(t))}</p>` : ''}
      ${gradeLine}
      ${fitLineHtml(fit)}
      ${gradeHint}
      ${quickFactsHtml(t)}
      ${actualLineHtml(t)}
      ${t.risks ? `<p><b>风险:</b>${t.risks.map(esc).join(' / ')}</p>` : ''}
      ${riskNotesHtml(t)}
      ${t.supplies ? `<p><b>补给:</b>${esc(t.supplies)}</p>` : ''}
      ${gearPreviewHtml(t)}
      ${oneTimeHtml(t)}
      ${costLineHtml(t)}
      <p class="mark-ops">
        <button class="mark-btn${mk.wanted ? ' on' : ''}" data-want="${t.id}">${mk.wanted ? '★ 已在想去' : '☆ 想去'}</button>
        <button class="mark-btn${mk.doneAt ? ' on' : ''}" data-done="${t.id}">${mk.doneAt ? `✓ 已走过 ${String(mk.doneAt).slice(5)}` : '标记走过'}</button>
        <button class="mark-btn${mk.actualDistanceKm || mk.actualDays || mk.actualClimbM ? ' on' : ''}" data-actual="${t.id}"
          title="记下实走的天数/里程/爬升,与线路库标称值对比">记实走</button>
        <button class="mark-btn" data-gpx="${t.id}" title="选一个 GPX(两步路/六只脚/Strava 导出),用它量出的实测量校标称值;差太多的不写,要人判">导入 GPX</button>
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
  // 日期/人数/档次只改花费口径,但结果行与分项都得跟着变,所以同样即时重算(与难度档一致)
  for (const id of ['rec-date', 'rec-tier', 'rec-headcount']) {
    $(id).addEventListener('change', () => {
      const hasCriteria = toPositive($('rec-budget').value) !== null
        || recSelected.size > 0 || $('rec-province').value || $('rec-origin').value.trim();
      if (hasCriteria) runRecommend();
    });
  }
  // 出发站与规划页共用同一份记忆:规划页填过就直接带出来,不用重填
  try {
    const saved = JSON.parse(localStorage.getItem(FORM_KEY) || 'null');
    if (saved?.origin) $('rec-origin').value = saved.origin;
    if (saved?.recGrade) $('rec-grade').value = String(saved.recGrade);
    if (saved?.recDate) $('rec-date').value = saved.recDate;
    if (saved?.recHeadcount) $('rec-headcount').value = String(saved.recHeadcount);
    if (saved?.recTier) $('rec-tier').value = saved.recTier;
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
  const input = {
    budget, maxDays, scenery, province, originStation, gradeMax,
    // 花费口径三要素:日期(季节系数)/人数(房间数)/档次(住宿倍数)
    date: $('rec-date').value || null,
    headcount: toPositive($('rec-headcount').value) || 1,
    tier: $('rec-tier').value || '舒适',
  };
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
    // 难度档与花费口径记住:下次进来还是同一套条件,不用重新选
    try {
      const saved = JSON.parse(localStorage.getItem(FORM_KEY) || 'null') || {};
      saved.recGrade = $('rec-grade').value;
      saved.recDate = $('rec-date').value;
      saved.recHeadcount = $('rec-headcount').value;
      saved.recTier = $('rec-tier').value;
      localStorage.setItem(FORM_KEY, JSON.stringify(saved));
    } catch { /* 记忆写不进去不影响推荐 */ }
  }
}

// 数字输入收敛:空/0/负数一律视为没填
function toPositive(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function criteriaText({ budget, maxDays, scenery, province, gradeMax, date, headcount, tier }, gate = null) {
  const parts = [];
  if (scenery.length) parts.push(`景色「${scenery.join('、')}」`);
  if (province) parts.push(`限 ${province}`);
  if (budget) parts.push(`人均预算 ¥${budget}`);
  if (maxDays) parts.push(`≤${maxDays} 天`);
  // 花费口径三要素要写在结果行上:否则用户改了日期/人数看到数字变了,却不知道是它变的
  parts.push(date ? `${date} 出行` : '未填日期(中性基准)');
  if (Number(headcount) > 1) parts.push(`${headcount} 人同行`);
  if (tier && tier !== '舒适') parts.push(`${tier}档`);
  // 难度闸门:显式选的写「★N 以内」;自动收窄的写清是体能给的,让用户知道结果为什么变少
  if (Number.isFinite(gradeMax)) parts.push(`★${gradeMax} 以内`);
  else if (gate?.auto && Number.isFinite(gate.gradeMax)) parts.push(`体能上限★${gate.gradeMax} 以内`);
  return parts.join(' + ');
}

function renderRecommend(list, input) {
  const gate = list.__gate || null;
  const caliber = `落地估算按「${input.date || '未填日期(中性基准)'} / ${input.headcount || 1} 人 / ${input.tier || '舒适'}档」`
    + (input.originStation ? ',花费含往返火车实价估算(去程价×2)' : ',未含往返大交通');
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
  wireTicketSources($('rec-list'));
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
  // 门票没标就要显式挂出来:现在未知项不进合计(旧口径按 0 计),不说就等于让人以为不用买票
  const tk = t.tickets == null
    ? `<span class="status st-bad" title="线路库未标注门票数据,合计里这一项按未含处理(不是 0 元),实际花费更高">门票未标注</span>` : '';
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

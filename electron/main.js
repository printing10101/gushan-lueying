const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const fs = require('fs');
const http = require('http');
const path = require('path');
// 无头/远程会话下 whenReady 才能可靠 resolve——这个限制只存在于那两类会话,
// 本地会话保留 GPU 合成:全屏云层动画 + 玻璃拟态(backdrop-filter)在软渲染下
// 每帧都要 CPU 重绘,滚动和动画会明显卡。强制软渲染:设 GUSHAN_SOFTWARE_RENDER=1
const sessionName = process.env.SESSIONNAME || '';
if (process.env.GUSHAN_SOFTWARE_RENDER === '1' || !sessionName || sessionName.startsWith('RDP-')) {
  app.disableHardwareAcceleration();
}

const store = require('../lib/store');
const { resolveStaticPath } = require('../lib/static-guard');
const { decideServe } = require('../lib/serve-policy');
const rail = require('../lib/rail12306');
const weather = require('../lib/weather');
const planner = require('../lib/planner');
const grading = require('../lib/grading');
const gpxLib = require('../lib/gpx');
const recommend = require('../lib/recommend');
const runos = require('../lib/runos');
const fitness = require('../lib/fitness');

// 本地只读静态服务(绑回环,随机端口):给"必须非 file:// 来源"的地图 JS API 用。
// 腾讯 GL 的官方原文是"不再支持 file:// 方式使用 Javascript API GL",而本应用一直用 loadFile,
// 所以要先能给出一个 http 来源(白名单才有东西可填)。
// 只在 GUSHAN_SERVE=1 时启用:默认路径完全不变,行为可回退(先验证可行性再决定是否默认开)。
// 安全面:只监听 127.0.0.1、只读仓库内文件、拒绝目录穿越、不解析也不执行任何东西。
const SERVE_ALLOW_TOP = new Set(['src', 'lib']); // 本地静态服务只服务这两个目录

function startLocalServer() {
  const ROOT = path.join(__dirname, '..');
  const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
  };
  const server = http.createServer((req, res) => {
    // 路径守卫抽在 lib/static-guard.js:它没法从渲染层测(浏览器会先把 ../ 规范化掉),
    // 所以只有原始 HTTP 请求会撞上它,靠单测盯着。
    // 只放行 src/ 与 lib/:页面要的脚本样式都在这里,而 data/(Key、行程)一律不出网口
    const file = resolveStaticPath(ROOT, req.url, { allowTop: SERVE_ALLOW_TOP });
    if (!file) { res.writeHead(403); res.end('forbidden'); return; }
    let st;
    try { st = fs.statSync(file); } catch { res.writeHead(404); res.end('not found'); return; }
    if (st.isDirectory()) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

let serveOrigin = null; // 非空 = 走本地 http 来源(仅 GUSHAN_SERVE=1 时)

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    title: '孤山掠影',
    backgroundColor: '#0a1526', // 与主题底色一致,消除启动白闪
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
    },
  });
  // CSP 与 contextIsolation 是两道纵深防御,都不能替代这一道:只要渲染层可导航,
  // 一个注入的 <a href> 或 window.location 就能把整个窗口变成任意网页的执行环境,
  // 而 preload 注入的 window.gushan 仍在那儿——IPC 白名单会被直接暴露给那个页面。
  // 应用是纯本地单页,除了自己的 index.html 没有任何需要导航到的页面,全部拒绝。
  win.webContents.on('will-navigate', (event, url) => {
    event.preventDefault();
    console.error(`已阻止窗口导航到 ${url}`);
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    // 外链一律交给 shell 打开系统浏览器,而不是在应用内开新窗口。
    // 这里不复用 shell:openExternal 的 https 白名单判断,因为该 handler 只接受
    // IPC 传来的字符串;这里要挡的是渲染层自己发起的 window.open。
    if (/^https:\/\/.+/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  if (serveOrigin) win.loadURL(`${serveOrigin}/src/index.html`);
  else win.loadFile(path.join(__dirname, '..', 'src', 'index.html'));
}

app.whenReady().then(async () => {
  store.ensureConfig();
  // 来源策略见 lib/serve-policy.js:默认自动(有腾讯地图 Key 且无高德 JS Key 就走本地 http,
  // 因为腾讯 GL 拒绝 file://);GUSHAN_SERVE=0 强制回 file://,=1 强制开。
  const policy = decideServe({ env: process.env, cfg: store.read('config') || {} });
  console.log(`[来源策略] ${policy.mode} —— ${policy.reason}`);
  if (policy.serve) {
    const server = await startLocalServer();
    const { port } = server.address();
    serveOrigin = `http://127.0.0.1:${port}`;
    console.log(`[本地服务] ${serveOrigin}(只放行 src/ 与 lib/,data/ 不出网口)`);
  }
  createWindow();
});
app.on('window-all-closed', () => app.quit());

// 线路库附上评级明细(_grade = 派生字段,勿手改),渲染进程拿去展示与筛选
function readData(name) {
  const data = store.read(name);
  if (name === 'trails' && data) {
    for (const trail of Object.values(data)) trail._grade = grading.computeBreakdown(trail);
  }
  // config:把"example 有而 config 没有"的键位随读返回,由界面提示(派生字段,不写盘)
  // 为什么只报不补:ensureConfig 只在文件不存在时拷,此后 example 新增的键不会进已有 config,
  // 缺 flightCityPinyin 时「查机票」是点了必报错的那种(代码里没有默认值)。补谁的配置由用户自己定。
  if (name === 'config' && data) data._gaps = store.configGaps();
  return data;
}

const wrap = (fn) => async (_event, payload) => fn(payload);

ipcMain.handle('data:read', wrap(readData));
ipcMain.handle('data:write', wrap(({ name, content }) => store.write(name, content)));
// 行程档案列表:只取概要字段;单个损坏的存档标 error 交给 UI 响亮展示,不拖垮整个列表
ipcMain.handle('trips:list', () => store.listDir('trips').map((id) => {
  try {
    const t = store.read(`trips/${id}`);
    return {
      id, regionName: t.regionName, days: t.input?.days, startDate: t.input?.startDate,
      total: t.budget?.total ?? null, trailName: t.trail?.name || null, generatedAt: t.generatedAt,
      actualCost: t.actualCost ?? null, // 走完后回填的实际花费,用于校准估算口径
    };
  } catch (e) {
    return { id, error: `存档无法解析: ${e.message}` };
  }
}).sort((a, b) => (b.startDate || '').localeCompare(a.startDate || '')
  || (b.generatedAt || '').localeCompare(a.generatedAt || '')));
ipcMain.handle('trips:delete', wrap(({ id }) => store.remove(`trips/${id}`)));
ipcMain.handle('trip:generate', wrap((input) => planner.generate(input)));
// 智能推荐:两段式打分。第一段按落地估粗排取候选池(30 条),填了出发站则富化往返火车
// 实价后按含交通口径重打分,最后截取 12 条——只按落地取 12 会漏掉「落地贵但近」的好线。
// 走过的线路自动排除(推荐看新线),足迹存在 data/marks.json。
ipcMain.handle('trails:recommend', wrap(async (input) => {
  const marks = store.read('marks') || {};
  const doneIds = Object.entries(marks).filter(([, m]) => m?.doneAt).map(([id]) => id);
  const regions = store.read('regions') || {};
  // cfg 里带两份口径:区域吃住基准 + 季节系数表(推荐页的落地估算要用)
  const cfg = {
    ...(store.read('config') || {}),
    regionStay: recommend.regionStayMap(regions),
    seasonality: store.read('seasonality') || {},
  };

  // 体能上限做默认难度闸门:RunOS 有数据就自动收窄到「当前能驾驭的难度」,取不到就不设限
  const picked = input || {};
  // 手选优先于自动:显式传了有限数字就用手选的,没传(或传 null)才回落到体能上限。
  // 判定与 auto 标记都在 recommend.difficultyGate(纯函数、可单测)里做,
  // 这里只负责取体能上限——不要在两处各判一次,逻辑会漂。
  // 注意 spread 顺序:...picked 必须在最前,否则 picked.gradeMax=null 会覆盖后面算好的 gate.gradeMax,
  // 导致「未选难度时按体能自动收窄」静默失效(已踩过一次)。
  const ableCap = await currentAbleCap();
  const gate = recommend.difficultyGate({
    userPicked: picked.gradeMax, useFitness: picked.useFitness, ableCap,
  });

  const list = recommend.rank({
    ...picked,
    excludeIds: doneIds,
    gradeMin: Number.isFinite(picked.gradeMin) ? picked.gradeMin : null,
    gradeMax: gate.gradeMax,
    limit: 30,
  }, readData('trails') || {}, cfg);
  const bodyHint = gate.auto && ableCap != null ? `体能上限★${ableCap}` : null;
  if (!picked.originStation) return withHint(list, gate, bodyHint);
  const enriched = await recommend.enrichWithTransport(list, {
    originStation: picked.originStation,
    regions,
    budget: picked.budget || null,
    scenery: picked.scenery || [],
    estimate: rail.estimateRoundTrip,
  });
  return withHint(enriched.slice(0, 12), gate, bodyHint);
}));

// 当前体能对应的难度上限:RunOS 有数据才算,算不出返回 null(退化为不设限,宁缺毋编)。
// fetchBodyState 自带 10 分钟缓存,未启动时返回 dataReady:false 而非抛错,不拖累推荐。
async function currentAbleCap() {
  try {
    const state = await runos.fetchBodyState(store.read('config') || {}, {});
    return state?.dataReady ? fitness.ableGrade(state) : null;
  } catch {
    return null;
  }
}

// 闸门口径随结果一起回传,渲染端据此在结果栏说明「为什么变少了」
function withHint(list, gate, bodyHint) {
  return Object.assign(list, { __gate: { ...gate, bodyHint } });
}
// 线路库卡片展开时按需估算该线所属区域枢纽的往返火车;没接规划/出发站即枢纽的返回 null。
// 带上枢纽坐标:无直达车时 rail12306 会按距离挑中转枢纽估两段价。
// 严格版:查询失败抛错转 { error },与「确认无车」(null)区分,渲染端给重试;
// 只读这一条线取 regionId,不为一张卡片重算全库评级。
ipcMain.handle('rail:transportForTrail', wrap(({ trailId, originStation, force = false }) => {
  if (!originStation) return null;
  const trail = (store.read('trails') || {})[trailId];
  const target = trail && recommend.hubTarget((store.read('regions') || {})[trail.regionId]);
  if (!target || target.hub === originStation) return null;
  try {
    return rail.estimateRoundTripStrict(originStation, target.hub, target.xy, { force });
  } catch (e) {
    return { error: e.message };
  }
}));
// RunOS 联动:只读拉取身体状态并算好每条线的匹配;RunOS 没跑也只返回未连接状态,不报错
ipcMain.handle('runos:state', wrap((opts) =>
  runos.fetchBodyState(store.read('config') || {}, readData('trails') || {}, opts || {})));
ipcMain.handle('rail:query', wrap(({ fromStation, toStation, date }) =>
  rail.queryTrains(fromStation, toStation, date)));
ipcMain.handle('rail:resolveStation', wrap((keyword) => rail.resolveStation(keyword)));
// amap 只在主进程 planner 内部使用,不暴露渲染层 IPC(驾车路线由行程生成时一并取回)
ipcMain.handle('weather:forecast', wrap(({ lng, lat, days }) => weather.forecast(lng, lat, days)));
// 行程导出 Markdown:弹系统保存框,路径由用户定,应用不越权写 data/ 之外的地方
ipcMain.handle('trip:export', async (_event, { defaultName, markdown }) => {
  const win = BrowserWindow.getAllWindows()[0];
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    defaultPath: defaultName || '行程.md',
    filters: [{ name: 'Markdown', extensions: ['md'] }],
  });
  if (canceled || !filePath) return { canceled: true };
  try {
    fs.writeFileSync(filePath, markdown, 'utf8');
  } catch (e) {
    throw new Error(`写入 ${filePath} 失败: ${e.message}`);
  }
  return { canceled: false, filePath };
});
// 行程 → GPX(离线带到手机/手表)。轨迹在**主进程**用 lib/gpx.js 的纯函数拼,渲染层只交 tripId。
// 为什么读存档而不是收整个 trip:存档是生成时落盘的权威副本,既不用把大对象再 IPC 一次,
// 也不给渲染层一个"伪造行程写进用户磁盘"的入口。
ipcMain.handle('trip:exportGpx', async (_event, { tripId }) => {
  if (!/^[A-Za-z0-9_-]+$/.test(String(tripId || ''))) throw new Error(`非法的行程 id: ${tripId}`);
  const trip = store.read(`trips/${tripId}`);
  if (!trip) throw new Error(`存档 ${tripId} 不存在,无法导出 GPX`);
  const region = (store.read('regions') || {})[trip.input?.regionId];
  const gpx = gpxLib.tripToGpx(trip, region);
  const win = BrowserWindow.getAllWindows()[0];
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    defaultPath: `轨迹-${tripId}.gpx`,
    filters: [{ name: 'GPX 轨迹', extensions: ['gpx'] }],
  });
  if (canceled || !filePath) return { canceled: true };
  try {
    fs.writeFileSync(filePath, gpx, 'utf8');
  } catch (e) {
    throw new Error(`写入 ${filePath} 失败: ${e.message}`);
  }
  const points = (gpx.match(/<trkpt/g) || []).length;
  return {
    canceled: false,
    filePath,
    points,
    // 轨迹点为 0 时只有一条徒步起点路点,必须说破,别让人以为导出了路线
    note: points ? '' : '无驾车轨迹数据(存档里没有真实路线),本次只导出线路起点路点',
  };
});
// 卡片「导入 GPX」:选文件 → 解析实测量 → 与标称值比 → 小差异才写盘。
// 两阶段(用一次性 token 串起来,不让用户选两次文件,也不让渲染层随意指定路径):
//   第一次 {trailId}            → 弹选择框、解析、算 diff,返回 token 与对比表(dryRun)
//   第二次 {token, confirmed}   → 凭 token 落盘
// **有 review 项一律不写**:差超 GPX_REVIEW_PCT 说明"抄来的数"与"量出来的数"至少有一个错,
// 谁覆盖谁必须人判(lib/gpx.js 的既定纪律,这里不放宽)。
// 写盘格式安全:data/trails.json 实测与 JSON.stringify(…,null,2) 逐字节一致,整体重写不产生无意义 diff。
// (这条只对 trails.json 成立;regions.json 是手工格式,严禁走这条路径。)
const pendingGpx = new Map(); // token → { trailId, apply, reviewCount, filePath }
const GPX_TOKEN_TTL_MS = 5 * 60 * 1000;

function issueGpxToken(payload) {
  const token = `gx${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  pendingGpx.set(token, { ...payload, expires: Date.now() + GPX_TOKEN_TTL_MS });
  // 顺手清掉过期项:用户中途取消的话 token 不会有人消费
  for (const [k, v] of pendingGpx) if (v.expires < Date.now()) pendingGpx.delete(k);
  return token;
}

ipcMain.handle('gpx:import', wrap(async ({ trailId, token, confirmed = false }) => {
  if (confirmed) {
    const held = token && pendingGpx.get(token);
    if (!held || held.expires < Date.now()) throw new Error('确认已过期,请重新选择 GPX 文件');
    pendingGpx.delete(token);
    const trails = store.read('trails') || {};
    const trail = trails[held.trailId];
    if (!trail) throw new Error(`线路 ${held.trailId} 不存在`);
    if (held.reviewCount) {
      return { written: false, trailId: held.trailId,
        blocked: `有 ${held.reviewCount} 项与标称值差超 ${gpxLib.GPX_REVIEW_PCT}%,按纪律不覆盖,请人工裁决` };
    }
    const fields = Object.keys(held.apply);
    if (!fields.length) return { written: false, trailId: held.trailId, blocked: '没有可写字段' };
    for (const f of fields) trail[f] = held.apply[f];
    store.write('trails', trails);
    return { written: true, trailId: held.trailId, wrote: fields, apply: held.apply };
  }
  const trails = store.read('trails') || {};
  const trail = trails[trailId];
  if (!trail) throw new Error(`线路 ${trailId} 不存在`);
  const win = BrowserWindow.getAllWindows()[0];
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: `选择「${trail.name}」的 GPX 轨迹`,
    filters: [{ name: 'GPX 轨迹', extensions: ['gpx'] }],
    properties: ['openFile'],
  });
  if (canceled || !filePaths[0]) return { canceled: true };
  const file = filePaths[0];
  const size = fs.statSync(file).size;
  if (size > 20 * 1024 * 1024) throw new Error(`GPX 文件过大(${Math.round(size / 1048576)}MB),不解析`);
  const measured = gpxLib.parseGpx(fs.readFileSync(file, 'utf8'));
  if (!measured.ok) {
    return { canceled: false, file, error: measured.error, points: measured.points, skipped: measured.skipped };
  }
  const d = gpxLib.mergeMeasured(trail, {
    distanceKm: measured.distanceKm,
    // climbM/maxAltM 缺高程时是 null:mergeMeasured 归入 rejected,不会写脏字段
    climbM: measured.climbM,
    maxAltM: measured.maxAltM,
  });
  const issuedToken = issueGpxToken({
    trailId, apply: d.apply, reviewCount: d.review.length, filePath: file,
  });
  return { canceled: false, file, measured, token: issuedToken, d, willWrite: Object.keys(d.apply), dryRun: true };
}));
// 外链兜底(如无火车票时查机票):只放行 https,防止渲染层被诱导开任意协议
ipcMain.handle('shell:openExternal', wrap((url) => {
  if (typeof url !== 'string' || !/^https:\/\/.+/.test(url)) throw new Error(`只允许打开 https 链接: ${url}`);
  return shell.openExternal(url);
}));

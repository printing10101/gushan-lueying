const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const fs = require('fs');
const path = require('path');
// 无头/远程会话下 whenReady 才能可靠 resolve——这个限制只存在于那两类会话,
// 本地会话保留 GPU 合成:全屏云层动画 + 玻璃拟态(backdrop-filter)在软渲染下
// 每帧都要 CPU 重绘,滚动和动画会明显卡。强制软渲染:设 GUSHAN_SOFTWARE_RENDER=1
const sessionName = process.env.SESSIONNAME || '';
if (process.env.GUSHAN_SOFTWARE_RENDER === '1' || !sessionName || sessionName.startsWith('RDP-')) {
  app.disableHardwareAcceleration();
}

const store = require('../lib/store');
const rail = require('../lib/rail12306');
const weather = require('../lib/weather');
const planner = require('../lib/planner');
const grading = require('../lib/grading');
const recommend = require('../lib/recommend');
const runos = require('../lib/runos');

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
  win.loadFile(path.join(__dirname, '..', 'src', 'index.html'));
}

app.whenReady().then(() => {
  store.ensureConfig();
  createWindow();
});
app.on('window-all-closed', () => app.quit());

// 线路库附上评级明细(_grade = 派生字段,勿手改),渲染进程拿去展示与筛选
function readData(name) {
  const data = store.read(name);
  if (name === 'trails' && data) {
    for (const trail of Object.values(data)) trail._grade = grading.computeBreakdown(trail);
  }
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
  // 区域基准(region.stay)并进口径,落地估算即按区域区分
  const cfg = { ...(store.read('config') || {}), regionStay: recommend.regionStayMap(regions) };
  const list = recommend.rank({ excludeIds: doneIds, ...(input || {}), limit: 30 },
    readData('trails') || {}, cfg);
  if (!input?.originStation) return list;
  const enriched = await recommend.enrichWithTransport(list, {
    originStation: input.originStation,
    regions,
    budget: input.budget || null,
    scenery: input.scenery || [],
    estimate: rail.estimateRoundTrip,
  });
  return enriched.slice(0, 12);
}));
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
// 外链兜底(如无火车票时查机票):只放行 https,防止渲染层被诱导开任意协议
ipcMain.handle('shell:openExternal', wrap((url) => {
  if (typeof url !== 'string' || !/^https:\/\/.+/.test(url)) throw new Error(`只允许打开 https 链接: ${url}`);
  return shell.openExternal(url);
}));

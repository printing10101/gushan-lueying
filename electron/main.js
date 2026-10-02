const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
app.disableHardwareAcceleration(); // 无头/远程会话下 whenReady 才能可靠 resolve

const store = require('../lib/store');
const rail = require('../lib/rail12306');
const amap = require('../lib/amap');
const weather = require('../lib/weather');
const planner = require('../lib/planner');

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    title: '孤山掠影',
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

const wrap = (fn) => async (_event, payload) => fn(payload);

ipcMain.handle('data:read', wrap((name) => store.read(name)));
ipcMain.handle('data:write', wrap(({ name, content }) => store.write(name, content)));
ipcMain.handle('trip:generate', wrap((input) => planner.generate(input)));
ipcMain.handle('rail:query', wrap(({ fromStation, toStation, date }) =>
  rail.queryTrains(fromStation, toStation, date)));
ipcMain.handle('rail:resolveStation', wrap((keyword) => rail.resolveStation(keyword)));
ipcMain.handle('amap:drive', wrap(({ from, to }) => amap.drivingRoute(from, to)));
ipcMain.handle('weather:forecast', wrap(({ lng, lat, days }) => weather.forecast(lng, lat, days)));

// 腾讯 GL JS API 探针(一次性 spike,不进测试链):用**现有 Key** 在 http://127.0.0.1:端口 的来源下
// 试着加载 GL 地图,把控制台报错原样抓回来。目的只有一个:搞清"白名单要不要、填什么"。
//
// 为什么用本地 http 来源而不是 file://:腾讯官方明确"不再支持 file:// 方式使用 Javascript API GL",
// 要验的就是"换成 http://127.0.0.1 之后放不放行"。
// 用法:GUSHAN_KEY=xxx npx electron test/gl-probe.cjs
const http = require('http');
const { app, BrowserWindow } = require('electron');

app.disableHardwareAcceleration();
const KEY = process.env.GUSHAN_KEY
  || JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '..', 'data', 'config.json'), 'utf8')).tencentKeyWeb;
const mask = (k) => (k ? `${k.slice(0, 6)}…${k.slice(-4)}(len ${k.length})` : '(空)');

const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<script>
  window.__probe = { scriptLoaded: false, scriptError: null, mapOk: false, mapError: null, console: [] };
  window.addEventListener('error', (e) => { window.__probe.console.push('error: ' + (e.message || '')); }, true);
</script>
<script src="https://map.qq.com/api/gljs?v=1.exp&key=${KEY}"
  onload="window.__probe.scriptLoaded = true"
  onerror="window.__probe.scriptError = 'script 加载失败'"></script>
</head><body><div id="map" style="width:600px;height:400px"></div>
<script>
  setTimeout(() => {
    try {
      if (typeof TMap === 'undefined') { window.__probe.mapError = 'TMap 未定义(脚本没生效)'; return; }
      const m = new TMap.Map(document.getElementById('map'), { center: new TMap.LatLng(39.904, 116.407), zoom: 10 });
      window.__probe.mapOk = true;
      window.__probe.mapError = null;
    } catch (e) { window.__probe.mapError = String(e && e.message || e); }
  }, 2500);
</script></body></html>`;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(PAGE);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  console.log(`探针来源 ${origin}(腾讯 GL 不接受 file://,这是最接近真实场景的来源)`);
  console.log(`用的 Key:${mask(KEY)}`);

  const win = new BrowserWindow({ width: 800, height: 600, show: false, webPreferences: { contextIsolation: true } });
  const logs = [];
  win.webContents.on('console-message', (_e, level, msg) => logs.push(`${level}: ${String(msg).slice(0, 300)}`));
  win.webContents.on('did-fail-load', (_e, code, desc, url) => logs.push(`did-fail-load ${code} ${desc} ${url}`));

  await win.loadURL(`${origin}/probe.html`);
  await sleep(6000);
  const probe = await win.webContents.executeJavaScript('JSON.stringify(window.__probe)');
  console.log('\n--- 探测结果 ---');
  console.log(probe);
  console.log('--- 控制台/网络(原样) ---');
  for (const l of logs) console.log('  ' + l);
  server.close();
  app.exit(0);
});

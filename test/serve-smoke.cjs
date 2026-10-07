// 「本地 http 来源」冒烟:验证 GUSHAN_SERVE=1 时应用能从 http://127.0.0.1:端口 正常跑起来。
//
// 为什么单列一条:GUSHAN_SERVE 是为了绕开"腾讯 GL JS API 不支持 file://"才加的,
// 它一旦成为默认加载方式,应用的来源就从 file:// 变成了 http://127.0.0.1(任何本机进程
// 都能访问这个端口),这是安全面的变化,必须有一条测试盯着它到底干了什么。
//
// 路径守卫(../ 越权)**不在这里测**:浏览器发请求前就会把 /../ 与 /%2e%2e/ 规范化掉,
// 页面里怎么 fetch 都碰不到那条分支——它在 test/static-guard.test.mjs 里用纯函数钉住。
//
// 用法:npx electron test/serve-smoke.cjs   (全部通过 exit 0)
process.env.GUSHAN_SERVE = '1'; // 必须在 require main.js 之前设置
const { app, BrowserWindow } = require('electron');

app.disableHardwareAcceleration();
require('../electron/main.js');

const results = [];
let failures = 0;
const check = (name, ok, detail) => {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures += 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForWindow() {
  for (let i = 0; i < 60; i++) {
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
    if (win && !win.webContents.isLoading()) return win;
    await sleep(500);
  }
  return null;
}

app.whenReady().then(async () => {
  const win = await waitForWindow();
  if (!win) {
    check('窗口起来了', false, '等 30s 仍无窗口');
    return finish(1);
  }
  win.hide();
  const evalIn = (code) => win.webContents.executeJavaScript(`(async () => {${code}})()`);

  try {
    // ---- 启动横幅:任何 initInner 抛错都会在这里留一条「启动失败:…」 ----
    // 这是「删函数 / 锚点改错」这类事故唯一可靠的抓手:页面大部分照样渲染(卡片来自 initLibrary,
    // 它在抛错点之前),所以只查「卡片有没有」会漏掉整段功能静默失效 —— 本轮真踩过一次。
    const bootBanner = await evalIn("return ([...document.querySelectorAll('body > p.warn')].map((p) => p.textContent).find((t) => t.includes('启动失败')) || '').slice(0, 160);");
    check('没有启动失败横幅', bootBanner === '', bootBanner || '(无)');

    const loc = await evalIn('return { href: location.href, origin: location.origin };');
    check('页面来源是 http://127.0.0.1:端口(不是 file://)',
      /^http:\/\/127\.0\.0\.1:\d+$/.test(loc.origin), loc.origin);
    check('入口是 src/index.html', /\/src\/index\.html$/.test(loc.href), loc.href);
    check('preload 的 gushan API 在(http 来源下 contextIsolation 照常)',
      (await evalIn('return typeof window.gushan;')) === 'object');

    // 区域下拉排在 libTrails 与身体状态之后,要轮询等它填满(之前用固定 2.5s 等出过假失败)
    let regions = 0;
    for (let i = 0; i < 20 && regions < 15; i++) {
      await sleep(500);
      regions = await evalIn("return document.getElementById('region') ? document.getElementById('region').options.length : 0;");
    }
    check('区域下拉装满了(18 个区域)', regions >= 15, `选项 ${regions}`);
    const cards = await evalIn("return document.querySelectorAll('#lib-list details.route').length;");
    check('线路库卡片渲染出来了', cards > 100, `卡片 ${cards}`);

    // ---- 地图:http 来源下应真的用腾讯 GL 出图(这是加 GUSHAN_SERVE 的全部理由) ----
    // 判据不依赖具体标签名:SDK 有没有加载 + 容器里有没有它生成的内容。
    let mapReady = { tmap: 'undefined', children: 0 };
    for (let i = 0; i < 24; i++) {
      await sleep(500);
      mapReady = await evalIn("return { tmap: typeof TMap, children: document.getElementById('map').children.length, hint: (document.getElementById('config-hint').textContent || '').slice(0, 80) };");
      if (mapReady.children > 0) break;
    }
    check('腾讯 GL 的 SDK 在页面里加载了(http 来源 + 已配 Key)', mapReady.tmap === 'object', `TMap=${mapReady.tmap} | 提示:${mapReady.hint}`);
    check('地图容器里有 SDK 渲染出的内容(不是空白)', mapReady.children > 0, `子节点 ${mapReady.children}`);
    // 记录事实:http 来源下同机进程能 GET 到仓库内的数据文件(这是换来源的固有代价)
    const probe = await evalIn(`
      const r = await fetch('/data/config.json');
      return { status: r.status, len: (await r.text()).length };`);
    results.push(`INFO  http 来源下 /data/config.json 可读(状态 ${probe.status}, ${probe.len} 字节)`
      + ' —— 把来源从 file:// 换成 http://127.0.0.1 的固有代价,换默认前要让用户知情');
  } catch (e) {
    check('执行冒烟脚本', false, e.message);
  }
  finish(failures ? 1 : 0);
});

function finish(code) {
  for (const line of results) console.log(line);
  console.log(code ? `\n✗ 本地来源冒烟失败 ${failures} 项` : '\n✓ 本地来源冒烟全通过');
  app.exit(code);
}

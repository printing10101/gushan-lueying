// 本地静态服务的路径守卫:这是"来源换 http"路径上唯一的越权面,而它**测不到于渲染层**
// (浏览器会把 /../ 与 /%2e%2e/ 在发请求前规范化掉,页面里怎么 fetch 都绕不过去)。
// 所以在这里把边界逐个钉住。
import { createRequire } from 'module';
const require = createRequire(new URL('../package.json', import.meta.url));
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { resolveStaticPath } = require('./lib/static-guard.js');
const ROOT = path.resolve('E:/repo-root'); // 只用它做前缀比较,不落盘

test('正常路径能解析到根下', () => {
  assert.equal(resolveStaticPath(ROOT, '/src/index.html'), path.join(ROOT, 'src', 'index.html'));
  assert.equal(resolveStaticPath(ROOT, '/'), ROOT);
  assert.equal(resolveStaticPath(ROOT, ''), ROOT);
  assert.equal(resolveStaticPath(ROOT, '/?x=1'), ROOT, '查询串要丢掉');
  assert.equal(resolveStaticPath(ROOT, '/data/a.json'), path.join(ROOT, 'data', 'a.json'));
});

test('双点段一律挡住(含百分号编码与反斜杠这些变体)', () => {
  const BS = String.fromCharCode(92);
  const bads = ['/../package.json', '/%2e%2e/package.json', '/..%2fpackage.json',
    '/src/../../package.json', '/..' + BS + 'package.json', BS + '..' + BS + 'package.json',
    '/%2E%2E/x', '/src/%2e%2e/%2e%2e/x'];
  for (const bad of bads) {
    assert.equal(resolveStaticPath(ROOT, bad), null, '应拒绝: ' + JSON.stringify(bad));
  }
});

test('绝对路径/盘符/空字节/坏编码一律拒绝', () => {
  assert.equal(resolveStaticPath(ROOT, 'C:/Windows/win.ini'), null, '盘符注入会让 path.join 跳到根外');
  assert.equal(resolveStaticPath(ROOT, '/src/%00/index.html'), null);
  assert.equal(resolveStaticPath(ROOT, '/%zz'), null, '非法百分号编码不抛错,直接拒');
  // UNC 写法的 URL 路径不含双点段,解析结果仍在根内(它拿不到共享盘):这条是事实记录,不是缺陷
  const unc = resolveStaticPath(ROOT, '//server/share/x');
  assert.ok(unc && unc.startsWith(ROOT), 'UNC 风格不会逃出根: ' + unc);
});
test('返回的永远是根内绝对路径(不逃逸)', () => {
  const p = resolveStaticPath(ROOT, '/lib/../src/app.js');
  assert.equal(p, path.join(ROOT, 'src', 'app.js'), '中间的双点段在根内是合法的');
  assert.ok(p.startsWith(ROOT + path.sep));
  assert.equal(resolveStaticPath(null, '/x'), null);
  assert.equal(resolveStaticPath(ROOT, null), ROOT, 'null 当作根请求,不抛错');
});

// ---- 目录白名单:把"整仓库可读"收窄成"只有源码可读" ----
// 这条是实测出来的必要防线:本地 http 来源一旦成为默认,GUSHAN_SERVE 端口上的 data/config.json
// 就是同机任何进程都能 GET 的东西(里面有地图 Key)。地图只需要 src/ 与 lib/,别的都不放行。
test('allowTop:给了白名单就只放行那几个顶层目录,data/ 一律拒绝', () => {
  const allow = new Set(['src', 'lib']);
  assert.ok(resolveStaticPath(ROOT, '/src/index.html', { allowTop: allow }));
  assert.ok(resolveStaticPath(ROOT, '/lib/planner.js', { allowTop: allow }));
  for (const p of ['/data/config.json', '/data/trips/x.json', '/package.json', '/electron/main.js', '/']) {
    assert.equal(resolveStaticPath(ROOT, p, { allowTop: allow }), null, '不该放行: ' + p);
  }
  // 不带白名单时行为不变(其它调用方/测试仍按整仓库语义)
  assert.ok(resolveStaticPath(ROOT, '/data/config.json'));
  // 目录穿越在白名单下依然被挡(两道防线叠加,顺序不影响结论)
  assert.equal(resolveStaticPath(ROOT, '/src/../../data/config.json', { allowTop: allow }), null);
});

// ---- 依赖与版本策略 ----
// 运行时锁死、工具链带 ^:混着来会让"哪天 electron 悄悄升了级"这种事没人负责。
test('package.json 声明了 engines,且版本策略有文字说明', () => {
  const fs = require('fs');
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(pkg.engines && pkg.engines.node, '要声明 node 版本要求(用到 AbortSignal.timeout 等较新 API)');
  assert.ok(pkg._dependencyPolicy && pkg._dependencyPolicy.length > 20,
    '要写清"运行时锁死 / 工具链带 ^"的策略,免得下一个人随手改');
  assert.equal(pkg.devDependencies.electron, pkg.devDependencies.electron.replace(/^[\^~]/, ''),
    'electron 必须锁死精确版本');
  assert.equal(pkg.devDependencies['electron-builder'],
    pkg.devDependencies['electron-builder'].replace(/^[\^~]/, ''),
    'electron-builder 必须锁死精确版本');
});

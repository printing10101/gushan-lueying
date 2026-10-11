// IPC 通道契约测试。
//
// 为什么需要:main.js 注册了 16 个 ipcMain.handle,preload.js 暴露 16 个方法。
// 这条对应关系**此前没有任何测试钉住**——实测 test/ 与 src/ 里对通道名的字符串
// 引用数为 0(渲染层走的是 window.gushan.xxx,看不到通道名)。
// 于是"改了 handler 名"、"preload 少暴露一个"、"参数形状对不上"这类断口,
// 只有真起 Electron 窗口才可能发现,而本沙箱起不了窗口。
//
// 所以在这里做双向静态契约检查:
//   ① preload 调用的每个通道,main 必须注册过;
//   ② main 注册的每个通道,preload 必须真的暴露出去(注册了没人用 = 死代码或改断了)。
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
const require = createRequire(new URL('../package.json', import.meta.url));
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAIN = fs.readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf8').replace(/\r\n/g, '\n');
const PRELOAD = fs.readFileSync(path.join(ROOT, 'electron', 'preload.js'), 'utf8').replace(/\r\n/g, '\n');

// ipcRenderer.invoke('xxx', …) —— preload 真正会发出的通道
const calledByPreload = [...PRELOAD.matchAll(/invoke\(\s*'([^']+)'/g)].map((m) => m[1]);
// ipcMain.handle('xxx', …) —— 主进程真正注册的通道
const registered = [...MAIN.matchAll(/ipcMain\.handle\(\s*'([^']+)'/g)].map((m) => m[1]);

test('preload 与主进程都解析出了通道(否则下面的断言是空跑的假绿)', () => {
  assert.ok(calledByPreload.length >= 10, `preload 通道太少:${calledByPreload.length}`);
  assert.ok(registered.length >= 10, `main 注册太少:${registered.length}`);
});

test('preload 调用的每个通道,主进程都必须注册过', () => {
  const missing = calledByPreload.filter((c) => !registered.includes(c));
  assert.deepEqual(missing, [], `preload 调了未注册的通道:${missing.join(', ')}`);
});

test('主进程注册的每个通道,preload 都必须暴露(注册了没人用 = 改断了或死代码)', () => {
  const unused = registered.filter((c) => !calledByPreload.includes(c));
  assert.deepEqual(unused, [], `注册了但 preload 没暴露:${unused.join(', ')}`);
});

test('通道名不重复注册(重复注册会让第二个静默覆盖第一个)', () => {
  const dup = registered.filter((c, i) => registered.indexOf(c) !== i);
  assert.deepEqual([...new Set(dup)], [], `重复注册的通道:${dup.join(', ')}`);
});

test('preload 只暴露白名单里的通道方法,不多不少(与 main 一一对应)', () => {
  const exposed = [...PRELOAD.matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]);
  assert.equal(exposed.length, calledByPreload.length,
    `暴露的方法数(${exposed.length})应与调用的通道数(${calledByPreload.length})一致`);
  for (const name of exposed) assert.ok(/^[a-z][A-Za-z0-9]*$/.test(name), `方法名风格异常:${name}`);
});

// 参数形状:handler 里解构的字段必须真的是调用点传进来的对象字段。
// 这条最容易被"改了参数名"击穿——运行时只是拿到 undefined,不报错。
//
// 两种传参方式都要认:
//   ① preload 直接写字面量 `invoke('x', { a, b })` → 在 preload 里核对;
//   ② preload 透传整个变量 `invoke('x', payload)` → 字段在**渲染层调用点**里
//      (如 `gushan.importGpx({ trailId: id })`),要去 src/app.js 里找,并且要把
//      同一方法的**所有**调用点拼起来(importGpx 有 dryRun 与 confirmed 两次调用,
//      只看第一处会把 token/confirmed 判成"没传")。
const APP = fs.readFileSync(path.join(ROOT, 'src', 'app.js'), 'utf8').replace(/\r\n/g, '\n');

function methodForChannel(channel) {
  const m = new RegExp(`(\\w+):\\s*\\([^)]*\\)\\s*=>\\s*ipcRenderer\\.invoke\\('${channel}'`).exec(PRELOAD);
  return m ? m[1] : null;
}

function appCallSites(method) {
  if (!method) return '';
  const needle = `gushan.${method}({`;
  let out = '';
  let from = 0;
  for (;;) {
    const i = APP.indexOf(needle, from);
    if (i < 0) break;
    out += `${APP.slice(i, i + 200)} `;
    from = i + 1;
  }
  return out;
}

test('解构式 handler 的参数字段与调用点传的形状一致', () => {
  const destructured = [...MAIN.matchAll(/ipcMain\.handle\('([^']+)',\s*wrap\(\s*(?:async\s*)?\(\{([^}]*)\}\)/g)];
  assert.ok(destructured.length >= 3, `没解析到解构式 handler(实得 ${destructured.length}),检查正则`);
  for (const [, channel, fields] of destructured) {
    // 必须只取**这一个** invoke 调用的第二个参数:直接 indexOf 切片会带上下一个通道的
    // 字面量(如 gpx:import 后面紧跟 exportPack 的 { tripId }),把"传变量"误判成"传字面量"。
    const m = new RegExp(`invoke\\('${channel}'\\s*,\\s*([\\s\\S]{0,140})`).exec(PRELOAD);
    assert.ok(m, `preload 里找不到通道 ${channel} 的调用`);
    const seg = m[1];
    const isLiteral = seg.trimStart().startsWith('{');
    // 传变量(透传 payload)时,字段在渲染层调用点里
    const haystack = isLiteral ? seg : appCallSites(methodForChannel(channel));
    assert.ok(haystack.length > 0, `通道 ${channel} 找不到任何传参点,无法核对`);
    for (const raw of fields.split(',')) {
      const field = raw.trim().split('=')[0].trim();
      if (!field) continue;
      assert.ok(haystack.includes(field),
        `通道 ${channel} 的 handler 解构了 ${field},但调用点没传它:${haystack.slice(0, 100)}`);
    }
  }
});

test('外链与写盘的硬约束仍在(这两条是安全边界,不能被重构悄悄删掉)', () => {
  assert.ok(/只允许打开 https 链接/.test(MAIN), 'shell:openExternal 必须只放行 https');
  assert.ok(/will-navigate/.test(MAIN) && /preventDefault\(\)/.test(MAIN), '导航劫持必须还在');
  assert.ok(/setWindowOpenHandler/.test(MAIN), '新窗口必须被拒');
  assert.ok(/contextIsolation:\s*true/.test(MAIN), '必须开 contextIsolation');
});

// ---- 写盘白名单 ----
// store.resolvePath 只挡路径穿越,挡不住"渲染层写错/改坏配置文件"。
// 实测渲染层的 data:write 调用点只有 trips/* 与 marks 三类,所以按用途收口。
test('data:write 必须有写入名白名单(不能是任意数据名)', () => {
  const at = MAIN.indexOf("ipcMain.handle('data:write'");
  assert.ok(at > 0, '找不到 data:write handler');
  const body = MAIN.slice(at, at + 400);
  assert.ok(/WRITABLE_NAMES|白名单/.test(body), '要有白名单判定');
  assert.ok(body.includes('throw new Error'), '越权写入必须抛错,不能静默拒绝');
  assert.ok(/trips\//.test(body) && /marks/.test(body), '白名单要放行 trips/* 与 marks');
});

test('静态服务读流要有 error 处理(否则出错时响应悬着)', () => {
  assert.ok(/createReadStream/.test(MAIN), '找不到静态服务的读流');
  assert.ok(/stream\.on\('error'/.test(MAIN),
    "读流必须挂 error:不加的话请求会挂到客户端超时,页面表现为'转圈但没报错'");
});

test('GPX token 不能只靠下次签发时清理(要有定时清理且不拖住退出)', () => {
  const at = MAIN.indexOf('function issueGpxToken');
  assert.ok(at > 0, '找不到 issueGpxToken');
  const body = MAIN.slice(at, MAIN.indexOf('\n}\n', at));
  assert.ok(body.includes('setTimeout'), '要挂定时清理,否则导一次后就不再操作会一直留到进程结束');
  assert.ok(body.includes('unref'), '定时器必须 unref(),不然会拖住应用退出');
});

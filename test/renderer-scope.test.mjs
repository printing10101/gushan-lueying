import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const require = createRequire(new URL('../package.json', import.meta.url));
const test = require('node:test');
const assert = require('node:assert');

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const INDEX_HTML = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');

// index.html 里按顺序加载的所有 <script src>,也就是渲染进程真实会执行的顶层作用域。
// 顺序很重要:app.js 必须排在 lib 之后(它启动时就解构 GushanLib)。
function rendererScripts() {
  const srcs = [...INDEX_HTML.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
  return srcs.map((s) => path.join(ROOT, 'src', s));
}

// 抓顶层声明(缩进 0 的才算顶层;函数体内的局部变量天然有独立作用域,不算冲突)。
// 三种形态都要抓:普通声明、解构声明、函数/类声明。
// 解构这一类最容易漏:app.js 里 `const { pickSeat } = LIB.seat` 与 lib/seat.js 的顶层
// `function pickSeat` 在浏览器共享作用域里是同一个名字,同样报
// Identifier 'pickSeat' has already been declared。初版测试只抓了普通声明,
// 真实 Electron 实测里 app.js 仍然报 SCENERY 冲突——补上解构形态才彻底。
function topLevelDeclarations(file) {
  const src = fs.readFileSync(file, 'utf8');
  const out = [];
  const decl = /^(?:const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm; // 普通声明
  const destruct = /^(?:const|let|var)\s*\{([^}]*)\}\s*=/gm; // 解构声明
  const fn = /^function\s+([A-Za-z_$][\w$]*)/gm; // 函数声明
  let m;
  while ((m = decl.exec(src))) out.push(m[1]);
  while ((m = fn.exec(src))) out.push(m[1]);
  while ((m = destruct.exec(src))) {
    for (const part of m[1].split(',')) {
      const t = part.trim();
      if (!t) continue;
      // `a` → a;`a: b` → b(取的是绑定名);`a = 默认值` → a
      const bind = t.includes(':') ? t.slice(t.indexOf(':') + 1) : t;
      const name = bind.split('=')[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) out.push(name);
    }
  }
  return out;
}

// 这条测试挡住的是一类静默故障:lib/*.js 以普通 <script> 加载(不是 ES module),
// 它们的顶层声明全部落进同一个全局作用域,谁跟谁重名就会
// `SyntaxError: Identifier 'xxx' has already been declared`,整个脚本不执行。
//
// 为什么它能一路逃过主进程测试:require 有独立模块作用域,主进程 require 完全正常;
// 只有渲染进程会炸。而单测跑的是 lib 的 require 侧,压根碰不到渲染层的共享作用域。
// 曾实测:6 个 lib 里有 5 个因为顶层都叫 `const api` 而全部加载失败,
// app.js 里 `const { pickSeat } = LIB.seat` 又与 lib/seat.js 的顶层函数撞名——
// 表现是界面停在未初始化状态,主进程侧一切正常。
test('渲染进程脚本之间无顶层同名声明(否则整个脚本被 SyntaxError 静默丢弃)', () => {
  const files = rendererScripts();
  const seen = new Map();
  const conflicts = [];
  for (const file of files) {
    for (const name of topLevelDeclarations(file)) {
      const rel = path.relative(ROOT, file).replace(/\\/g, '/');
      if (seen.has(name)) {
        conflicts.push(`${name}(${seen.get(name)} 与 ${rel})`);
      } else {
        seen.set(name, rel);
      }
    }
  }
  assert.equal(conflicts.length, 0,
    `以下顶层声明在渲染进程共享全局作用域里撞名,声明它的脚本会整份不执行:\n   ${conflicts.join('\n   ')}`);
});

test('app.js 之前已加载全部 lib 脚本(否则解构 GushanLib 时拿到空)', () => {
  const srcs = [...INDEX_HTML.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
  const appIdx = srcs.indexOf('app.js');
  assert.ok(appIdx >= 0, 'index.html 里找不到 app.js 的 script 标签');
  const libsBeforeApp = srcs.slice(0, appIdx).filter((s) => s.includes('/lib/'));
  assert.ok(libsBeforeApp.length > 0, 'app.js 之前没有任何 lib 脚本');
});

// app.js 用到的每个 GushanLib.X,必须有对应的 <script src="../lib/X.js">。
// 曾实测:app.js 里 LIB.tripMarkdown.tripToMarkdown(...) 对应缺 script 标签,
// 点「导出行程」才炸(undefined 读属性),那条路径不点测不出来。
// 文件名允许与导出名不同(trip-markdown → GushanLib.tripMarkdown,连字符转驼峰),
// 所以匹配时把 X 的首字母小写形式与「去连字符的同名文件」都算命中。
test('app.js 访问的每个 GushanLib.X 都有对应 script 标签', () => {
  const appSrc = fs.readFileSync(path.join(ROOT, 'src', 'app.js'), 'utf8');
  const used = [...new Set([...appSrc.matchAll(/LIB\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]))];
  const loaded = [...INDEX_HTML.matchAll(/<script src="\.\.\/lib\/([^"]+)"><\/script>/g)].map((m) => m[1]);
  // loaded 里带 .js 后缀,LibX 不带,两边统一后再比
  const kebab = (s) => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase() + '.js';
  const hit = (lib) => loaded.includes(lib + '.js') || loaded.includes(kebab(lib));
  const missing = used.filter((lib) => !hit(lib));
  assert.equal(missing.length, 0,
    `app.js 用了 ${missing.map((m) => 'LIB.' + m).join(' / ')} 但 index.html 里没有对应 script 标签`);
});

// 每个 lib 都必须真的能被浏览器侧挂上 GushanLib.<name>。导出名允许与文件名不同
// (trip-markdown.js → GushanLib.tripMarkdown),但**必须有**挂载语句——
// 没有它时 require 侧测试全绿,只有渲染层永远拿不到这个模块。
test('每个 lib 都有 window.GushanLib 挂载语句,且导出名与 app.js 的取用一致', () => {
  const appSrc = fs.readFileSync(path.join(ROOT, 'src', 'app.js'), 'utf8');
  const used = new Set([...appSrc.matchAll(/LIB\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]));
  const files = rendererScripts().filter((f) => f.includes(`${path.sep}lib${path.sep}`));
  const problems = [];
  for (const file of files) {
    const name = path.basename(file, '.js');
    const src = fs.readFileSync(file, 'utf8');
    const m = src.match(/window\.GushanLib = window\.GushanLib \|\| \{\}\)\.(\w+)\s*=/);
    if (!m) {
      problems.push(`${name}: 找不到 window.GushanLib 挂载语句,渲染进程永远拿不到它`);
      continue;
    }
    // app.js 按 GushanLib.X 取用时,要能落到这个文件上(驼峰/连字符两种命名都要认)
    const kebab = m[1].replace(/([A-Z])/g, (c) => '-' + c.toLowerCase());
    const camel = kebab.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (m[1] !== name && kebab !== name && camel !== name) {
      problems.push(`${name}: 挂到 GushanLib.${m[1]},文件名对不上(期望 ${name})`);
    }
  }
  assert.equal(problems.length, 0, problems.join('\n   '));
  assert.ok(used.size > 0, 'app.js 里没解析到任何 LIB.X 取用,测试本身失效了');
});

// app.js 里 `gushan.X(...)` 用到的每一个方法,preload 都必须真的暴露。
// 缺一个的症状与当年「LIB.tripMarkdown 没写 script 标签」一模一样:
// 平时不炸,只有点到那个按钮才炸,而单测与主进程都碰不到。
test('app.js 用到的每个 gushan.X 都在 preload 里暴露(导出 GPX 等新入口靠它兜住)', () => {
  const app = fs.readFileSync(path.join(ROOT, 'src', 'app.js'), 'utf8');
  const preload = fs.readFileSync(path.join(ROOT, 'electron', 'preload.js'), 'utf8');
  const used = new Set([...app.matchAll(/\bgushan\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]));
  const missing = [...used].filter((k) => !new RegExp(`\\b${k}\\s*:`).test(preload));
  assert.ok(used.size >= 10, `只解析到 ${used.size} 个 gushan.X,大概率为提取式失效`);
  assert.deepEqual(missing, [], `preload 未暴露:${missing.join(', ')}`);
});

// 实测量与 GPX 导入必须有界面入口。文案里出现「去手改 data/marks.json」就说明入口又没了——
// 这条只能做静态断言:跑 DOM 冒烟时库里没有走过标记,那句提示本来不会出现。
test('实测量/GPX 的录入入口必须存在于 app.js', () => {
  const app = fs.readFileSync(path.join(ROOT, 'src', 'app.js'), 'utf8');
  for (const needle of ['data-actual="', 'data-gpx="', 'recordActuals', 'importGpxFor',
    'trip-gpx', 'exportTripGpx']) {
    assert.ok(app.includes(needle), `app.js 缺录入入口要素:${needle}`);
  }
  assert.ok(!app.includes('在 data/marks.json 该线路下加'),
    '实测量要有界面入口,不能只留一句"去手改 data/marks.json"');
});

// 预算汇总只允许一条路径。症状与「漏了 switchTrain 的 range」完全一样:平时看着对,
// 只有点了某个按钮才静默出错,而渲染层在本沙箱跑不起 DOM 冒烟,单测碰不到。
// 所以用静态断言把它钉住:改 items 的地方必须重新汇总,谁也不许手写汇总字段。
test('预算汇总只能走 rollupBudget,app.js 不得手写 total/perPerson/unknownCount/range', () => {
  // 归一化行尾:core.autocrlf=true 下新 clone 检出的是 CRLF,而下面要按 '\n}\n' 取函数体
  const app = fs.readFileSync(path.join(ROOT, 'src', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
  const handWritten = [...app.matchAll(/budget\.(total|perPerson|unknownCount|range)\s*=[^=]/g)]
    .map((m) => m[0].trim());
  assert.deepEqual(handWritten, [], `汇总字段要由 rollupBudget 统一写,别各处手算:${handWritten.join(', ')}`);
  assert.ok(app.includes('LIB.budget.budgetRollup('),
    'rollupBudget 必须调用 lib 里的同一个函数,而不是在渲染层再写一份等价逻辑');
  // 换车次直接改了 items 里的金额与 band,改完不重新汇总 → 区间停在旧值
  const at = app.indexOf('async function switchTrain');
  assert.ok(at > 0, '找不到 switchTrain');
  const body = app.slice(at, app.indexOf('\n}\n', at));
  assert.ok(body.includes('rollupBudget('), 'switchTrain 改了票价就必须重算汇总(含区间)');
});
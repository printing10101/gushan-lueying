// 渲染层的两条"只看源码就能钉住、跑 DOM 冒烟反而碰不到"的纪律。
//
// 为什么非要静态断言:
//  1) hidden 失效:DOM 冒烟在本沙箱跑不起来(GPU 进程崩),而"空盒子挂在页面上"这种
//     视觉缺陷,就算跑起来了也得有人盯着截图看才认得出。CSS 层叠规则是确定的,静态可判。
//  2) 档次提示:改下拉→看提示,是一次交互;而"某个入口忘了重判提示"恰恰是漏网高发区,
//     所以钉"重判只有 renderResult 一处"这个结构,而不是试着去模拟点击。
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const require = createRequire(new URL('../package.json', import.meta.url));
const test = require('node:test');
const assert = require('node:assert');

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// 行尾统一成 LF 再断言。仓库开了 core.autocrlf=true,开发机上工作区是 LF,
// 但新 clone / CI 检出的是 CRLF —— 用 '\n}\n' 取函数体的断言在这种目录下会 indexOf 返回 -1,
// slice(0,-1) 反而把整份文件当成函数体(实测:导出到干净目录跑,这条用例红)。
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

// 取 markers 之后的函数体,到第一个顶层 `}` 为止(容忍 CRLF:read 已归一化,
// 但这里再兜一次,免得将来有人把 read 改回去)
function fnBody(src, marker) {
  const at = src.indexOf(marker);
  if (at < 0) return '';
  const end = src.indexOf('\n}\n', at);
  return end < 0 ? src.slice(at) : src.slice(at, end);
}

// 极简 CSS 规则切分:先去掉注释,再按「选择器 { 声明 }」抓。
// @media 这类外层块自身含大括号,匹配不到;内层规则照常被抓到(我们只关心 display)。
function cssRules(css) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(clean))) {
    for (const sel of m[1].split(',')) out.push({ sel: sel.trim(), body: m[2] });
  }
  return out;
}

// index.html 里带 hidden 属性的元素(排除 aria-hidden——那是无障碍属性,不影响显示)
function hiddenElements(html) {
  const out = [];
  const tagRe = /<([a-z][a-z0-9]*)\b([^>]*)>/gi;
  let m;
  while ((m = tagRe.exec(html))) {
    const attrs = m[2];
    if (!/(^|\s)hidden(\s|=|$)/.test(attrs)) continue;
    const id = (attrs.match(/\bid="([^"]+)"/) || [])[1] || null;
    const cls = ((attrs.match(/\bclass="([^"]+)"/) || [])[1] || '').split(/\s+/).filter(Boolean);
    out.push({ tag: m[1], id, cls, raw: m[0] });
  }
  return out;
}

// 一条规则是否可能命中这个元素(按 id / class 粗匹配,宁可多算不可漏算:
// 多算只会让断言更严,漏算会让真正的缺陷溜过去)
function touches(rule, el) {
  if (el.id && rule.sel.includes(`#${el.id}`)) return true;
  return el.cls.some((c) => rule.sel.includes(`.${c}`));
}

test('带 hidden 的元素必须真的藏住:设了 display 就必须有 [hidden] 覆盖', () => {
  const rules = cssRules(read('src/style.css'));
  const els = hiddenElements(read('src/index.html'));
  assert.ok(els.length >= 4, `只解析到 ${els.length} 个 hidden 元素,大概是提取式失效`);

  const problems = [];
  for (const el of els) {
    const label = el.id ? `#${el.id}` : `<${el.tag} class="${el.cls.join(' ')}">`;
    // 会命中它、且声明了非 none 的 display 的规则
    const visible = rules.filter((r) => touches(r, el) && /\bdisplay\s*:/.test(r.body)
      && !/display\s*:\s*none/.test(r.body));
    if (!visible.length) continue; // 只有 UA 的 [hidden]{display:none} 管它 → 本来就正常
    // 那就必须有一条命中它的 [hidden] → display:none 把它盖回去
    const covered = rules.some((r) => r.sel.includes('[hidden]')
      && /display\s*:\s*none/.test(r.body)
      && (r.sel === '[hidden]' || touches(r, el)));
    if (!covered) {
      problems.push(`${label} 被 ${visible.map((r) => `「${r.sel}」`).join('')} 设了 display,`
        + '但没有任何 [hidden] 覆盖 → hidden 属性失效,元素会一直显示(空盒子)');
    }
  }
  assert.deepEqual(problems, [], `\n   ${problems.join('\n   ')}`);
});

test('改档次必须当场提示"需重新生成",且提示只在一处重判', () => {
  const app = read('src/app.js');
  // 控件监听要有,且提示里两件事都说清:现在选的档、当前显示的是按哪档算的
  assert.match(app, /\$\('tier'\)\.addEventListener\('change', checkTierVsGenerated\)/,
    '改档次不重算预算,必须有 change 监听当场说破');
  assert.match(app, /function checkTierVsGenerated/);
  assert.match(app, /住宿档次已改成/, '要说清现在选的是哪一档');
  assert.match(app, /当前显示的/, '要说清页面上那个数是按哪一档算的');
  // 两侧都必须走归一化:旧存档没有 tier 字段、旧名是 经济/舒适,
  // 直接比原始值会让"一进来就误报"或"改了却不报"
  const body = fnBody(app, 'function checkTierVsGenerated');
  assert.ok(body, '取不到 checkTierVsGenerated 的函数体');
  assert.equal((body.match(/tierValueFor\(/g) || []).length, 2,
    '现在的档与生成时用的档都要归一化后再比,少一侧就会误报/漏报');
  // 重判只在 renderResult 里做:展示的行程换了(生成/开档/换车次)就必然重判,
  // 散在多个入口就会漏——这正是"某条路径忘了清提示"的来源
  assert.ok(fnBody(app, 'async function renderResult').includes('checkTierVsGenerated()'),
    'renderResult 末尾要重判一次档次提示');
  // 提示元素必须存在于页面上(否则 checkTierVsGenerated 里 $('tier-msg') 拿到 null 静默不提示)
  assert.match(read('src/index.html'), /id="tier-msg"/, '提示容器必须真的在 index.html 里');
});

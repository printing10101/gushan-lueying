// 渲染层 DOM 冒烟:把**真实主进程**拉起来(electron/main.js 的 IPC 白名单、preload、
// CSP、导航拦截全走原路径),再对真窗口逐档切筛选、读计数。
//
// 为什么单测不够:test/filters.test.mjs 只证明 lib/filters.js 的分档算法对;
// 它证明不了 index.html 里有那个下拉框、app.js 的 change 监听数组里有 lib-alt、
// 也证明不了 lib/filters.js 的 <script> 标签真的加在 app.js 之前。
// renderer-scope.test.mjs 也挡不住这类断口(它只做静态名字检查)。
//
// 期望值在这里**独立算一遍**(阈值写死在本文件,不 require lib/filters.js),
// 否则实现错、期望也跟着错,两边一起绿。
//
// 用法:npx electron test/dom-smoke.cjs   (全部通过 exit 0)
process.env.GUSHAN_SERVE = '0'; // 这条冒烟专门测 file:// 那条路径(自动开之后必须显式锁住)
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

app.disableHardwareAcceleration();

// 只要副作用:注册 ipcMain 与创建窗口。不 require 它的话渲染层拿不到 window.gushan 的后端,
// 实测症状就是下拉框只有「全部海拔」、计数恒为 0——那是测试缺后端,不是筛选坏了。
require('../electron/main.js');

const ROOT = path.join(__dirname, '..');
const trails = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'trails.json'), 'utf8'));
const all = Object.values(trails);
const store = require('../lib/store');
const regionsAll = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'regions.json'), 'utf8'));
const chuanxiHub = regionsAll.chuanxi.hub.railStation;
const storeExample = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'config.example.json'), 'utf8'));

const EXPECT = {
  lt2000: (m) => m < 2000,
  '2000-3500': (m) => m >= 2000 && m < 3500,
  '3500-4500': (m) => m >= 3500 && m < 4500,
  ge4500: (m) => m >= 4500,
};
const expectedCount = (key) => all.filter((t) => EXPECT[key](t.maxAltM)).length;

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
  const finish = (code) => {
    for (const line of results) console.log(line);
    console.log(failures ? `\n✗ DOM 冒烟失败 ${failures} 项` : '\n✓ DOM 冒烟全通过');
    if (win && !win.isDestroyed()) win.destroy();
    app.exit(code);
  };
  if (!win) {
    check('主进程窗口起来了', false, '等 30s 仍无窗口');
    return finish(1);
  }
  win.hide(); // 不打扰用户桌面;DOM 与 JS 照常执行
  await sleep(3000); // 等 initLibrary 的异步数据载入

  // 在页面里切一个下拉框并回读计数;exec 返回 null 表示脚本自己炸了(下面逐条判空)
  const evalIn = (code) => win.webContents.executeJavaScript(`(() => {${code}})()`);

  try {
    // ---- 启动横幅:任何 initInner 抛错都会在这里留一条「启动失败:…」 ----
    // 这是「删函数 / 锚点改错」这类事故唯一可靠的抓手:页面大部分照样渲染(卡片来自 initLibrary,
    // 它在抛错点之前),所以只查「卡片有没有」会漏掉整段功能静默失效 —— 本轮真踩过一次。
    const bootBanner = await evalIn("return ([...document.querySelectorAll('body > p.warn')].map((p) => p.textContent).find((t) => t.includes('启动失败')) || '').slice(0, 160);");
    check('没有启动失败横幅', bootBanner === '', bootBanner || '(无)');

    const opts = await evalIn(`
      const sel = document.getElementById('lib-alt');
      if (!sel) return null;
      return [...sel.options].map((o) => o.value + '|' + o.textContent).join(',');`);
    check('lib-alt 下拉框存在', opts !== null);
    check('lib-alt 含「全部海拔」+ 4 档', !!opts && opts.split(',').length === 5, opts || '拿不到选项');

    for (const key of Object.keys(EXPECT)) {
      const shown = await evalIn(`
        const sel = document.getElementById('lib-alt');
        sel.value = ${JSON.stringify(key)};
        sel.dispatchEvent(new Event('change'));
        const m = /显示\\s*(\\d+)\\s*条/.exec(document.getElementById('lib-count').textContent);
        return m ? Number(m[1]) : null;`);
      const exp = expectedCount(key);
      check(`档位 ${key} 筛出条数`, shown === exp, `界面 ${shown} / 期望 ${exp}`);
    }

    // 路线库是按省份分组渲染的(组序沿用数据编排,组内才排序),
    // 所以"按海拔排序"的正确断言是:**每个省组内部**降序,而不是全库降序。
    const sortDump = await evalIn(`
      document.getElementById('lib-alt').value = '';
      document.getElementById('lib-alt').dispatchEvent(new Event('change'));
      const s = document.getElementById('lib-sort');
      s.value = 'alt';
      s.dispatchEvent(new Event('change'));
      // 按 #lib-list 的子节点顺序走:遇到省标题就开一组,组内的卡才要求降序
      const groups = [];
      let bad = [];
      for (const node of document.getElementById('lib-list').children) {
        if (node.classList.contains('prov-head')) { groups.push({ prov: node.textContent.trim(), alts: [] }); continue; }
        for (const card of (node.matches && node.matches('details.route') ? [node] : [...node.querySelectorAll('details.route')])) {
          const m = /最高\\s*(\\d+)m/.exec(card.textContent);
          const v = m ? Number(m[1]) : null;
          const g = groups[groups.length - 1];
          if (!g) { bad.push('卡片出现在省标题之前'); continue; }
          if (g.alts.length && v !== null && g.alts[g.alts.length - 1] < v) {
            bad.push(g.prov + ': ' + g.alts[g.alts.length - 1] + ' 后面出现更高的 ' + v);
          }
          if (v !== null) g.alts.push(v);
        }
      }
      return JSON.stringify({ nGroups: groups.length, bad,
        first: groups.length ? groups[0].alts.slice(0, 4) : null,
        cards: document.querySelectorAll('#lib-list details.route').length });`);
    const dump = JSON.parse(sortDump || '{}');
    check('海拔排序在每个省组内都生效',
      dump.nGroups > 0 && Array.isArray(dump.bad) && dump.bad.length === 0
        && dump.cards === all.length,
      `组 ${dump.nGroups} / 卡 ${dump.cards}(应 ${all.length}) / 首个组前 4 张 ${(dump.first || []).join('>')}`
        + (dump.bad && dump.bad.length ? ` / 违例: ${dump.bad.slice(0, 3).join(' ; ')}` : ''));

    const back = await evalIn(`
      const s = document.getElementById('lib-sort');
      s.value = 'grade'; s.dispatchEvent(new Event('change'));
      const sel = document.getElementById('lib-alt');
      sel.value = ''; sel.dispatchEvent(new Event('change'));
      const m = /显示\\s*(\\d+)\\s*条/.exec(document.getElementById('lib-count').textContent);
      return m ? Number(m[1]) : null;`);
    check('清空海拔条件后回到全量', back === all.length, `界面 ${back} / 全库 ${all.length}`);

    // 5) 风险出处的渲染接线:直接走 routeHtml(它就是 #lib-list 的唯一生产者),
    //    用库里第一条真线路当底,只换 riskNotes,免得自己拼一个缺字段的假对象。
    const rn = await evalIn(`
      const base = libTrails[0];
      const withSrc = routeHtml(Object.assign({}, base, { riskNotes: [
        { text: '测试风险甲', source: '测试报告 2024 卷', year: 2024 }] }));
      const noSrc = routeHtml(Object.assign({}, base, { riskNotes: [{ text: '测试风险乙' }] }));
      const dirty = routeHtml(Object.assign({}, base, { riskNotes: [null, { text: '  ' }] }));
      const plain = routeHtml(Object.assign({}, base, { riskNotes: undefined }));
      // 只截该条风险所在的那一段:整卡里本来就有「风险出处:」这个小标题,
      // 拿整卡做"不含出处:"的否定断言会被小标题误伤(第一版就是这么假红的)。
      const seg = (html, key) => {
        const i = html.indexOf(key);
        if (i < 0) return '';
        const end = html.indexOf('</p>', i);
        return html.slice(i, end < 0 ? html.length : end);
      };
      return JSON.stringify({ withSeg: seg(withSrc, '测试风险甲'), noSeg: seg(noSrc, '测试风险乙'),
        dirty, plain });`);
    const rnHtml = JSON.parse(rn || '{}');
    check('riskNotes 有出处时该条写出出处与年份',
      rnHtml.withSeg && rnHtml.withSeg.includes('出处:测试报告 2024 卷(2024)'),
      `该段: ${String(rnHtml.withSeg).slice(0, 80)}`);
    check('riskNotes 缺出处时该条写「未核实」而不是留个空出处冒充',
      rnHtml.noSeg && rnHtml.noSeg.includes('未核实') && !rnHtml.noSeg.includes('出处:'),
      `该段: ${String(rnHtml.noSeg).slice(0, 80)}`);
    check('riskNotes 脏条目在卡片上留脏提示(不伪装成"没风险")',
      String(rnHtml.dirty || '').includes('格式不对'), '');
    check('没有 riskNotes 的老线路不出这一节(191 张卡不加噪音)',
      !String(rnHtml.plain || '').includes('风险出处'), '');

    // 6) 实走记录:marks 是 app.js 的顶层 let,可以在页面里临时换掉再还原。
    //    实测量按 base 自己的规划值算倍率,免得测试把 120km/5500m 这种数字钉死。
    const ac = await evalIn(`
      const base = libTrails[0];
      const savedMarks = marks;
      const htmlFor = (actual) => {
        marks = Object.assign({}, savedMarks, { [base.id]: Object.assign({ doneAt: '2026-08-01' }, actual) });
        return routeHtml(base);
      };
      const seg = (html) => {
        const i = html.indexOf('实走记录');
        if (i < 0) return '';
        const end = html.indexOf('mark-ops', i);
        return html.slice(i, end < 0 ? html.length : end);
      };
      const out = {
        big: seg(htmlFor({ actualDistanceKm: base.distanceKm * 1.2 })),
        small: seg(htmlFor({ actualDistanceKm: base.distanceKm * 1.05 })),
        bad: seg(htmlFor({ actualDistanceKm: '十三' })),
        hint: seg(htmlFor({})),
      };
      marks = savedMarks;
      out.none = seg(routeHtml(Object.assign({}, base, { id: '__never_marked__' })));
      return JSON.stringify(out);`);
    const acHtml = JSON.parse(ac || '{}');
    check('实走差超阈值时写出百分比并标待复核',
      String(acHtml.big).includes('+20%') && String(acHtml.big).includes('待复核'),
      `片段: ${String(acHtml.big).slice(0, 90)}`);
    check('差在阈值内时不标待复核(不制造假警报)',
      String(acHtml.small).includes('+5%') && !String(acHtml.small).includes('待复核'),
      `片段: ${String(acHtml.small).slice(0, 90)}`);
    check('实走值非法时明说并忽略',
      String(acHtml.bad).includes('不是正数') && !String(acHtml.bad).includes('实走 十三'),
      `片段: ${String(acHtml.bad).slice(0, 90)}`);
    check('走过但没记实测量时指向界面入口,而不是叫用户手改 JSON',
      String(acHtml.hint).includes('记实走') && !String(acHtml.hint).includes('actualDistanceKm'),
      `片段: ${String(acHtml.hint).slice(0, 60)}`);
    check('没走过的线路不出实走这一节', String(acHtml.none) === '', '');

    // 7) 报备提示的渲染接线:开放线路安静,受限线路必须出声
    const pm = await evalIn(`
      const base = libTrails[0];
      const seg = (html) => {
        const i = html.indexOf('报备');
        if (i < 0) return '';
        const end = html.indexOf('</p>', i);
        return html.slice(i, end < 0 ? html.length : end);
      };
      return JSON.stringify({
        open: seg(routeHtml(Object.assign({}, base, { status: '开放', permit: undefined }))),
        restricted: seg(routeHtml(Object.assign({}, base, { status: '管控', permit: undefined }))),
        filled: seg(routeHtml(Object.assign({}, base, {
          status: '部分管控',
          permit: { needed: true, how: '身份证 + 行程单', where: '县文旅局', leadDays: 3 } }))),
        free: seg(routeHtml(Object.assign({}, base, { status: '禁入', permit: { needed: false } }))),
      });`);
    const pmHtml = JSON.parse(pm || '{}');
    check('开放线路卡片不出报备一句', String(pmHtml.open) === '', `片段: ${String(pmHtml.open).slice(0, 60)}`);
    check('受限线路未填 permit 时卡片写「未核实」',
      String(pmHtml.restricted).includes('报备要求未核实'), `片段: ${String(pmHtml.restricted).slice(0, 70)}`);
    check('填了 permit 后材料与受理点原样带出',
      String(pmHtml.filled).includes('需报备') && String(pmHtml.filled).includes('身份证 + 行程单')
        && String(pmHtml.filled).includes('县文旅局') && String(pmHtml.filled).includes('提前 3 天'),
      `片段: ${String(pmHtml.filled).slice(0, 90)}`);
    check('核实为无需报备时不再说明',
      String(pmHtml.free).includes('无需报备') && !String(pmHtml.free).includes('未核实'),
      `片段: ${String(pmHtml.free).slice(0, 60)}`);

    // ---- 录入入口:实测量与 GPX ----
    // lib/gpx.js / lib/actuals.js 的算法单测过、渲染路径也验过,但"入口在不在、接没接线"
    // 只有起真窗口才测得到——此前 GPX 只有命令行能用,卡片上让用户手改 marks.json。
    const ui = await evalIn(`
      const cards = [...document.querySelectorAll('#lib-list details.route')];
      const first = cards[0];
      const act = first && first.querySelector('[data-actual]');
      const gpx = first && first.querySelector('[data-gpx]');
      const count = (sel) => document.querySelectorAll('#lib-list ' + sel).length;
      return {
        cards: cards.length,
        actualBtns: count('[data-actual]'), gpxBtns: count('[data-gpx]'),
        actWired: !!(act && typeof act.onclick === 'function'),
        gpxWired: !!(gpx && typeof gpx.onclick === 'function'),
        actId: act ? act.dataset.actual : null,
        gpxId: gpx ? gpx.dataset.gpx : null,
        apiExportGpx: typeof window.gushan.exportGpx,
        apiImportGpx: typeof window.gushan.importGpx,
      };`);
    check('每张卡片都有「记实走」按钮', ui && ui.actualBtns === ui.cards,
      `按钮 ${ui && ui.actualBtns} / 卡片 ${ui && ui.cards}`);
    check('每张卡片都有「导入 GPX」按钮', ui && ui.gpxBtns === ui.cards,
      `按钮 ${ui && ui.gpxBtns} / 卡片 ${ui && ui.gpxBtns}`);
    check('「记实走」按钮真的绑上了处理函数(不是只有标签)', ui && ui.actWired);
    check('「导入 GPX」按钮真的绑上了处理函数', ui && ui.gpxWired);
    check('按钮 data-* 带的是线路 id',
      ui && typeof ui.actId === 'string' && ui.actId === ui.gpxId && ui.actId.length > 0,
      `actual=${ui && ui.actId} gpx=${ui && ui.gpxId}`);
    // 「不要再让用户手改 marks.json」这条放在 renderer-scope.test.mjs 里做静态断言:
    // 本文件跑的时候库里没有走过标记,那句提示本来就不会出现在 DOM 里,在这儿断言是条抓不住变异的假绿。
    check('preload 暴露了 exportGpx / importGpx',
      ui && ui.apiExportGpx === 'function' && ui.apiImportGpx === 'function',
      `export=${ui && ui.apiExportGpx} import=${ui && ui.apiImportGpx}`);

    // ---- 出发站 == 区域枢纽:当场说破,而不是等点「生成行程」才报错 ----
    // 期望值独立算:直接从 regions.json 取该区域枢纽站,不 require planner 的判定。
    const hubWarn = await evalIn(`
      document.getElementById('origin').value = ${JSON.stringify(chuanxiHub)};
      document.getElementById('region').value = 'chuanxi';
      document.getElementById('region').dispatchEvent(new Event('change'));
      return document.getElementById('left-msg').textContent;`);
    check('出发站等于该区域枢纽时即时提示',
      String(hubWarn).includes(chuanxiHub) && String(hubWarn).includes('枢纽'),
      `提示: ${String(hubWarn).slice(0, 60)}`);
    const noWarn = await evalIn(`
      document.getElementById('origin').value = '西安北';
      document.getElementById('origin').dispatchEvent(new Event('input'));
      return document.getElementById('left-msg').textContent;`);
    check('改成不同站后提示消失(不留僵尸警告)', String(noWarn).trim() === '', `残留: ${noWarn}`);

    // ---- 高德安全密钥:必须在脚本加载前挂到 window ----
    // 高德自 2021-12-02 起要求 Key + 安全密钥配对;不挂的后果是"地图空白 + 高德内部报 INVALID_USER_SCODE",
    // 页面自己看不出来,所以这条必须由冒烟挡住。
    const sec = await evalIn(`
      delete window._AMapSecurityConfig;
      // 先测"没配":干净的 window 上调一次空值,不应该凭空造出一个空配置对象
      const noCode = applyAmapSecurityCode('');
      const afterEmpty = !!window._AMapSecurityConfig;
      // 再测"配了":必须在脚本加载前就挂上
      const withCode = applyAmapSecurityCode('smoke-code');
      const after = window._AMapSecurityConfig && window._AMapSecurityConfig.securityJsCode;
      return { noCode, afterEmpty, withCode, after };`);
    check('安全密钥会被挂到 window._AMapSecurityConfig', sec && sec.withCode === true && sec.after === 'smoke-code',
      `实得 ${JSON.stringify(sec)}`);
    check('没配安全密钥时不凭空写一个空对象(旧 Key 不需要它)', sec && sec.noCode === false && sec.afterEmpty === false,
      `实得 ${JSON.stringify(sec)}`);

    // ---- 规划页的"顺路再加一条"下拉 ----
    const trailsUi = await evalIn(`
      const t1 = document.getElementById('trail'), t2 = document.getElementById('trail2');
      return { has1: !!t1, has2: !!t2,
        options1: t1 ? t1.options.length : 0, options2: t2 ? t2.options.length : 0,
        first2: t2 && t2.options[0] ? t2.options[0].textContent : null };`);
    check('规划页有第二个徒步线路下拉(多线串联入口)', trailsUi && trailsUi.has2 === true);
    check('第二个下拉初始是「不加」,不替用户多选', trailsUi && trailsUi.first2 === '不加', `实得 ${trailsUi && trailsUi.first2}`);
    check('切区域后两个下拉都被重建(条数一致)', trailsUi && trailsUi.options1 === trailsUi.options2,
      `${trailsUi && trailsUi.options1} vs ${trailsUi && trailsUi.options2}`);

    // ---- 一次性开销清单:只列要不要准备,不给金额 ----
    const ot = await evalIn(`
      const secs = [...document.querySelectorAll('#lib-list details.gear')]
        .filter((el) => el.textContent.includes('一次性开销'));
      const txt = secs.map((el) => el.textContent).join(' ');
      return { sections: secs.length, hasAmount: /¥\s*\d/.test(txt), hasNote: /另计|另询/.test(txt),
        sample: txt.slice(0, 120) };`);
    check('卡片上有一次性开销清单(命中规则的线路)', ot && ot.sections > 0, `命中 ${ot && ot.sections} 张卡`);
    check('一次性开销只列要不要准备,绝不出现金额', ot && ot.hasAmount === false, `片段: ${ot && ot.sample}`);
    check('每条都注明"另计/另询"', ot && ot.hasNote === true);

    // ---- 配置漂移提示:界面说的缺项必须与文件实际差集一致 ----
    const gaps = store.diffConfig(storeExample, store.read('config'));
    const hintText = await evalIn(`return document.getElementById('config-hint').textContent;`);
    const expectMissing = gaps.map((g) => g.path);
    const mentioned = expectMissing.filter((p) => String(hintText).includes(p.split('.')[0]));
    check(expectMissing.length ? 'config 缺项都在界面上报到' : '配置齐时不多嘴',
      expectMissing.length === 0
        ? !String(hintText).includes('配置比 config.example.json 少项')
        : mentioned.length === expectMissing.length,
      `期望缺 ${expectMissing.join(',')} | 界面命中 ${mentioned.length}/${expectMissing.length} | 实得: ${String(hintText).slice(0, 120)}`);
    // ---- 渲染一份合成行程:此前"只有真渲染才炸"的路径完全没有覆盖 ----
    // 实测价值:日照那一行曾引用了作用域里不存在的 wx,单测全绿、现有冒烟全绿,只有真渲染才炸。
    // 这里造一份结构完整的行程(含驾车/徒步/无票火车/绕行段/装备),断言关键区块都渲染出来。
    const synthTrip = {
      id: 'synthetic', regionName: '合成环线', input: { days: 3, headcount: 2, startDate: '2026-10-20', originStation: 'X', regionId: 'chuanxi' },
      generatedAt: '2026-10-08T00:00:00.000Z', kmNote: '里程、时长与过路费来自腾讯真实驾车路线', routeProvider: 'tencent',
      trail: { name: '合成线', grade: 2, start: { lng: 103, lat: 30 }, tickets: 115,
    ticketNote: '按旺季价计,淡季可能更低',
    ticketSource: { source: '某景区官网', url: 'https://example.com/tickets', checkedAt: '2026-10-08' } },
      trails: [{ name: '合成线', grade: 2 }],
      railOut: { date: '2026-10-20', chosen: null, presale: true, candidates: [] },
      railBack: { date: '2026-10-22', chosen: null, presale: false, error: 'queryG 返回非 JSON', candidates: [] },
      schedule: [
        { date: '2026-10-21', type: 'drive', nodes: ['A', 'B'], legs: [
          { from: 'A', to: 'B', km: 1890, hours: 37.3, costs: { driveTotal: 900, fuel: 800, tolls: 100, tollsEstimated: false },
            detour: { straightKm: 50, ratio: 38 }, path: '103,30;103.5,30.5' }] },
        { date: '2026-10-22', type: 'hike', trail: '合成线', node: 'B', info: { name: '合成线', climbM: 700, grade: 2, gradeLabel: '入门', summary: '测试摘要', supplies: '有补给' } },
      ],
      gear: [{ item: '头灯与备用电池', reason: '徒步日日照仅 8.5 小时' }],
      budget: { items: [{ name: '火车去程', amount: 300, note: '占位估算' }], total: 300, perPerson: 150, headcount: 2, unknownCount: 1 },
      weather: { node: 'B', byDateError: null, forecast: [{ date: '2026-10-22', label: '晴', tempMin: 5, tempMax: 18, precipProb: 10, verdict: '宜', sunrise: '06:28', sunset: '17:20' }],
        byDate: { '2026-10-22': { date: '2026-10-22', label: '晴', tempMin: 5, tempMax: 18, precipProb: 10, verdict: '宜', sunrise: '06:28', sunset: '17:20', at: 'B' } } },
    };
    const tripUi = await evalIn(`
      return (async () => {
        const trip = ${JSON.stringify(synthTrip)};
        let err = null;
        try { await window.renderResult(trip); } catch (e) { err = String((e && e.message) || e); }
        const hike = [...document.querySelectorAll('#result .day')].find((d) => d.textContent.includes('徒步'));
        return { err,
          hikeText: hike ? hike.textContent.replace(/\s+/g, ' ') : '',
          strip: (document.getElementById('weather-strip').textContent || '').replace(/\s+/g, ' '),
          resultText: (document.getElementById('result').textContent || '').replace(/\s+/g, ' ').slice(0, 400) };
      })();`);
    check('合成行程渲染不抛错', tripUi && tripUi.err === null, `err: ${tripUi && tripUi.err}`);
    check('徒步日卡片画出日照窗口与收队时间(缺数据不写)',
      /日照窗口 06:28 → 17:20/.test(tripUi.hikeText) && /建议 16:20 前收队/.test(tripUi.hikeText),
      tripUi.hikeText.slice(0, 140));
    check('天气条每格带日出–日落', /06:28–17:20/.test(tripUi.strip), tripUi.strip.slice(0, 120));
    check('绕行段给出独立提示', /真实里程是直线距离的 38 倍/.test(tripUi.resultText), tripUi.resultText.slice(0, 160));
    const packBtn = await evalIn(`
      const b = document.getElementById('trip-pack');
      return { has: !!b, wired: !!(b && typeof b.onclick === 'function'), label: b ? b.textContent : '' };`);
    check('合成行程上出现「导出离线包」按钮', packBtn.has === true, JSON.stringify(packBtn));
    check('「导出离线包」按钮已接线(不是只有标签)', packBtn.wired === true);
    const tk = await evalIn(`
      const html = window.routeHtml({ id: 'x', name: '合成线', grade: 2, province: 'X', area: 'Y', type: 'Z',
        days: 1, distanceKm: 10, climbM: 500, maxAltM: 1500, status: '开放', summary: 's',
        tickets: 115, ticketNote: '按旺季价计',
        ticketSource: { source: '某景区官网', url: 'https://example.com/t', checkedAt: '2026-10-08' },
        _grade: { usable: true, suggested: 2, label: '入门', exertion: 1, altitude: 1, technical: 0 } });
      const div = document.createElement('div'); div.innerHTML = html;
      const btn = div.querySelector('[data-ticketsrc]');
      return { hasSrc: /门票参考来源/.test(div.textContent), noteShown: /门票口径/.test(div.textContent),
        date: /2026-10-08 核对/.test(div.textContent), btnWired: false,
        href: btn ? btn.dataset.ticketsrc : null, hasBtn: !!btn };`);
    check('路线库卡片显示门票参考来源与核对日期', tk.hasSrc === true && tk.date === true, JSON.stringify(tk));
    check('卡片同时显示门票口径说明(数字不是孤零零一个)', tk.noteShown === true);
    check('卡片上「看原文」按钮带的是 https 链接',
      tk.hasBtn === true && String(tk.href).startsWith('https://'), String(tk.href));
    check('去程没票时写明原因(预售期 / 真没车 / 取价失败三者之一)',
      /超出 12306 预售期|没有可购车次|取价失败/.test(tripUi.resultText), tripUi.resultText.slice(0, 160));

  } catch (e) {
    check('执行 DOM 冒烟脚本', false, e.message);
  }
  finish(failures ? 1 : 0);
});

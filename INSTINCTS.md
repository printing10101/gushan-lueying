# INSTINCTS · 孤山掠影项目教训

任务开始先读这里召回教训;修完非平凡的 bug 把新条目 harvest 回来(带日期)。

## 数据文件是手工格式,脚本化改写必须保格式

- 2026-10-04:`data/regions.json` 的 loop 节点是内联一行风格、坐标有尾零(30.030)。用
  `JSON.parse + JSON.stringify` 整文件重写会重排格式、丢尾零,污染整文件 diff——本项目发生过两次。
  规矩:能 Edit 局部就别整文件重写;必须脚本化改写时,写前 `JSON.parse` 校验、
  写后跑 `node scripts/fmt-regions.mjs` 恢复原格式(该脚本会回填数字字面量,幂等可反复跑)。
- 2026-10-04:脚本读写 `data/trails.json` 一律用 `new URL('../data/trails.json', import.meta.url)`
  锚定仓库位置,不用 CWD 相对路径;零变更时跳过写文件,避免无意义 diff。

## 免 key 数据源要先验证再接

- 2026-10-04:接分省油价时 qiyoujiage.com 失联、youjia.chemcp.com 返回 JS 挑战页,
  cngold.org 可用但其省份 slug 有坑(陕西 = `sanxi`,山西 = `shanxi`)。
  规矩:接任何新数据源前,先用一次真实请求确认存活与页面结构,把结构样例存进测试夹具。

## 测试写法的坑

- 2026-10-04:精确日期断言(`equal(date, '2026-10-14')`)随时区漂移——日期函数多用本地时区,
  测试里 hardcoded `+08:00` 的 now 会挂。断言性质(格式、区间、与实现的相对关系),不断言字面量。
- 2026-10-04:函数签名先看再调:runos `fetchBodyState(cfg, trails, { force })` 的 force 在第三位,
  测试里传错位不报错只是静默不生效。amap 测试要 patch 同一 store 实例注入 key(真实 config 的 key 为空)。
- 2026-10-04:mock 网络统一走 `globalThis.fetch` 替换 + finally 还原;lib/http.js 的纯 node
  回退分支在调用时才解析全局 fetch,mock 才能生效。

## 渲染进程与主进程的边界

- 2026-10-04:渲染进程没有 require。纯函数口径(选座/花费/词表/评级行情)放零依赖模块,
  尾部 `module.exports + window.GushanLib` 双端导出,渲染端 `<script>` 引真函数——手抄副本必漂移。
- 2026-10-04:任何数据(手编 JSON、12306/RunOS 网络返回、报错原文)进 innerHTML 前过 `esc()`,
  title 属性同样要过;`<button data-x="${esc(v)}">` 属性转义对 dataset 读取是透明的,放心用。

## 打包与隐私

- 2026-10-04:electron-builder 的 `files: ["data/**"]` 会把 gitignore 掉的 config.json(高德 key)、
  trips/(个人行程)打进分发包。运行时私有文件必须在 build.files 里显式 `!` 排除,数据种子和隐私文件分开。

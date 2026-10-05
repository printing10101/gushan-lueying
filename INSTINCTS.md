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
- 2026-10-05:`assert.deepEqual` 比整个对象——给返回结构**加字段**会让所有深比较的单测同时挂。
  本次给 `costBreakdown` 加 `ticketsUnknown` 就撞了这个,4 处 deepEqual 一起红。
  规矩:改返回结构时先 `grep deepEqual` 找全受影响的断言,别等测试跑完再逐个猜。

## 数据集完整性要有断言

- 2026-10-05:`data/trails.json` 长期存在同名条目(`gamagou` 与 `zhufeng-dongpo` 都叫
  「珠峰东坡·嘎玛沟」,且 days 11/9、distanceKm 100/90 互相矛盾),UI 会渲染出两张无法区分的卡片。
  既有 `trails-data.test.mjs` 只校验字段/坐标/评级,**没有查重名**,所以 102 个测试全绿也照样漏过去。
  规矩:凡是会在 UI 上并列展示的实体,数据集层必须有一条断言(线路名唯一、区域 id 唯一、枢纽名唯一)。
  加完断言要做**变异验证**:临时注入一条违规数据,确认单测真的红,再还原——不然可能写了条永远绿的假断言。

## 口径修正要看真实数据分布,别只按公式想当然

- 2026-10-05:`costBreakdown` 的 `nights = max(days-1, 0)` 对 1 天线恒为 0,导致当日往返/当日走完的线
  落地估系统性低估(实测阿布吉措 ¥90 vs 实际 ≥¥290)。公式本身对多日线是对的,错的是没考虑单日线。
  教训:改任何"日均/按天折算"的公式前,先跑一遍全库分布看有没有边界情况被公式漏掉,
  别只拿一个典型例子验。

## 渲染进程与主进程的边界

- 2026-10-04:渲染进程没有 require。纯函数口径(选座/花费/词表/评级行情)放零依赖模块,
  尾部 `module.exports + window.GushanLib` 双端导出,渲染端 `<script>` 引真函数——手抄副本必漂移。
- 2026-10-04:任何数据(手编 JSON、12306/RunOS 网络返回、报错原文)进 innerHTML 前过 `esc()`,
  title 属性同样要过;`<button data-x="${esc(v)}">` 属性转义对 dataset 读取是透明的,放心用。

## 打包与隐私

- 2026-10-04:electron-builder 的 `files: ["data/**"]` 会把 gitignore 掉的 config.json(高德 key)、
  trips/(个人行程)打进分发包。运行时私有文件必须在 build.files 里显式 `!` 排除,数据种子和隐私文件分开。

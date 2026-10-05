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

## 渲染进程共享全局作用域:顶层重名会让整份脚本静默失效

- 2026-10-06:独立盲评时发现 186 条线路只有 35 条带 `regionId`,`planner.pickTrail`
  按 `regionId === regionId` 硬过滤,其余151 条在规划器里根本不存在。**但这不是最要紧的**——
  用真实 Electron 起窗口实测控制台日志,才看到真正的元凶:
  `Uncaught SyntaxError: Identifier 'api' has already been declared`,重复 5 次。
- 根因:`lib/*.js` 经 `<script>` 加载(不是 ES module),每个文件尾部的 `const api = {...}`
  全部落进同一个全局作用域。**6 个 lib 里有 5 个因为都叫 `api` 而整份不执行**,
  只有 `seat.js` 侥幸排第一活了下来。紧接着 `src/app.js` 的 `const { pickSeat } = LIB.seat`
  又与 `lib/seat.js` 的顶层 `function pickSeat` 撞名,app.js 整份挂掉。
- 为什么一路逃过验证:主进程用 `require`,有独立模块作用域,完全正常;单测跑的也是 require 侧,
  **压根碰不到渲染层的共享作用域**。只有真起一个窗口看控制台才暴露。
  另一个坑:`app.js` 里 `LIB.tripMarkdown.tripToMarkdown(...)` 对应的 script 标签根本没写进 index.html,
  不点「导出行程」永远不会炸。
- 规矩(已落 `test/renderer-scope.test.mjs`,4 条断言):
  1. lib 顶部导出对象名必须文件级唯一(`api_seat` / `api_grading` / …),不许都叫 `api`;
  2. app.js 里从 `LIB.X` 取用的名字一律**加前缀解构**(`{ pickSeat: seatPick }`),
     绝不能裸写 `{ pickSeat }` —— 它与 lib 的顶层函数同处一个作用域;
  3. app.js 用到的每个 `LIB.X` 必须有对应的 `<script src="../lib/X.js">`;
  4. 冲突检测必须同时抓**普通声明与解构声明**——初版只抓普通声明,
     真实 Electron 实测里 app.js 仍报 `SCENERY` 冲突,补上解构形态才彻底。
- 教训:**「主进程跑得好好的」不等于「渲染进程没坏」**。凡是用 `<script>` 而非 module 的代码,
  顶层作用域是共享的,这类冲突必须靠静态断言 + 真机控制台日志两道验证。

## NaN 会穿过所有阈值判断,静默落到最后一个 else

- 2026-10-06:`grading.computeBreakdown` 里 `days: 'abc'` 算出 `exertion = NaN`,
  于是 `NaN < 2.6` / `< 3.8` / `< 5.2` / `< 6.6` 全部为 false,直接落到最后的 `else` 得 **★5 极限**。
  对入门者是方向性误导:本该被难度闸门挡掉的线,反而顶着最高难度出现在推荐里,还不带任何警告。
- 反向的坑同样存在:第一版修复把脏值收成 0 继续算,`total=0` → **★1 休闲**。
  换了方向照样是编答案——用户以为这是轻松线,点进去发现啥也没写。
- 最终规矩:核心指标(`distanceKm`/`climbM`)缺失或非法时,`computeBreakdown` 返回
  `usable: false` + `suggested: null` + `label: '数据不足'`,UI 改走
  「量化指标不完整,上方星级为人工评级,仅供参考」——**明说不知道,不猜方向**。
- 附带一条:`??` 与 `||` 在 `TECH_SCORE[trail.techLevel]` 处结果完全相同(`TECH_SCORE[0]` 本就是 0),
  改 `||`→`??` 造不出任何可观测差异。写了条抓不住变异的断言,只会给人「这里有防线」的错觉——
  **测试断言必须真的能红**,否则宁可删掉。

## 区域归属不能按省份映射,必须按地理

- 2026-10-06:9 个 `region` 是**具体自驾环线**(节点是成都-映秀-四姑娘山镇-丹巴…这类市镇),
  不是省份概念。按 `province` 回填 `regionId` 会把贵州线路塞进「滇西北环线」,
  生成一条从丽江出发根本开不过去的行程——而且静默,用户看不出来。
- 正确判据是球面距离:线路 `start` 到各环线节点的 haversine 距离,取最近。
  实测该方法与已有的 35 条人工标注 **35/35 完全一致**,判据可信。
- 阈值 80km(自驾一天舒适半径)的来由是实测边界:≤30km 13 条、30-50km 4 条、50-80km 9 条
  逐条核对全部地理正确;80-120km 起出现错配(峨眉山后山穿越在乐山、离川西环线 113km),
  >120km 完全错(冈仁波齐转山离伊犁昭苏 1352km)。宁可少覆盖,不硬凑。
- 另一条教训:离群检测最初用「同区域中位数的倍数」,被**级联反应**咬了——
  剔除一条离群 → 中位数被拉低 → 下一条正常项立刻成新离群 → 再剔除,无限循环,
  最后逼着人把阈值放到能放过真错配的尺度。绝对距离没有这个问题,直接对应现实语义。
- 还有一条:人工标注**允许**超距。新疆伊犁环线在伊宁河谷,而夏特/孟克德在昭苏西南、
  尼勒克东部山区,直线距离 82–158km,但都在伊犁州境内、与环线节点同县,标注是对的。
  用 80km 去卡人工标注是否定正确的判断。跨省才是硬错误。

## CSP 与窗口导航拦截

- 2026-10-06:`src/index.html` 加了 CSP(`default-src 'none'` + 高德白名单),
  `electron/main.js` 加了 `will-navigate` + `setWindowOpenHandler`。
  实测确认 `loadFile` 不走 `will-navigate`(主进程主动加载不触发该事件),所以无需白名单,
  应用能正常启动;导航到 `https://evil.example.com` 与本地 `package.json` 都被拦下,窗口原地不动。
- CSP 里 `script-src` 必须含 `'unsafe-inline' 'unsafe-eval'` 与 `webapi.amap.com`——
  高德 JS API 的硬要求,收不掉。若哪天要彻底去掉,唯一路径是换自托管瓦片渲染,代价远大于收益。
  Electron 会因此打一条 `Insecure Content-Security-Policy` warning,属预期,不是配置失败。
- 沙箱内实测 Electron 的两个必要条件:`app.disableHardwareAcceleration()` +
  `app.commandLine.appendSwitch('in-process-gpu')`,否则 GPU 进程崩溃
  (`exit_code=-1073741819`)导致 `loadFile` 直接 ERR_FAILED,看起来像代码写错了。

## `Number(String(x || '').slice(0,2))` 的 0 点陷阱

- 2026-10-13:`planner.js` 在回程没查到可购车次时崩在
  `Cannot read properties of null (reading 'startTime')`。看着像数据问题,其实是老代码缺陷。
- 根因是三层叠加:`railBack.chosen?.startTime` 在 chosen 为 null 时得 `undefined`,
  `undefined || ''` 得 `''`,`Number('')` 得 **0**(不是 NaN!),而 `0 < 10` 成立——
  于是「回程没票」反而进了「清晨发车」分支,进去后才解引用 `null.chosen`。
  早到分支(`>= 15`)没这个毛病,因为 0 过不了那道门,纯属运气。
- 修法不是加 `?? 0` 之类的包装,而是让「解析不出」和「0 点」可区分:
  `hourOf()` 对空/脏值返回 `null`,分支写成 `hourHour !== null && hour < 10`。
- 同类模式一律警惕:`Number()` 对 `''`/`[]`/`false` 都返回 0,`isFinite(0)` 为真。
  凡是想表达「有这个字段且值有效」,就不能拿 `Number.isFinite` 当门槛。
- 教训延伸:**冒烟跑不通时要先分清是数据错还是代码错**。本例数据完全合法
  (成都东→拉萨 7 天内确实没有可购车次),是 planner 原有的空值处理缺陷,跟新区域无关。

## 贪心累积切分:超长 leg 会拖垮同一天

- `planDays` 原本按 `km >= maxDriveKm` 切分,遇到「单条 leg 自身就超上限」时会失手:
  藏东南 `然乌→拉萨` 单条 711km(直线估算×1.3),前面已累积 96+65+90=251km,
  结果一天排出 **962km / 21h**。
- 修法:加入 leg 前先看它自身是否超上限,超了就把当日已累积的 leg 冲掉,让它独占一天。
  改完 995km → 711km(仍超,但那是一条真路,拆不成两天),并保留 `overKm` 标记让 UI 提示。
- **动手前先量化影响面**:15 个区域逐个模拟修前修后,结果只有 `zangdongnan` 变化,
  其余 14 个完全不变——这才敢改共享算法。
- 修不掉的要说清:修后最差日仍超 400km 的区域还有 chuanxi(623)、sanxia(524)、
  gannan(491)、qinghaihu(413)、jinbei(407)。这些是环线本身太长,
  只能靠 `overKm` 提示 + 让用户自己加天数,**不要假装算法能解决**。

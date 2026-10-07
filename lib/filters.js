// 路线库的海拔分档筛选与海拔排序。纯函数,主进程 require、渲染进程经 <script> 挂
// window.GushanLib.filters,两边同一实现(与 lib/quickfacts.js 同构)。
//
// 为什么单独成模块:maxAltM 这个字段此前只被 src/app.js 拿去算山顶体感、被 lib/grading.js
// 拿去算海拔分项,路线库的筛选下拉里从来没有海拔这一维。入门者问的第一句话是
// 「这线我能上到多高」,界面答不了。分档口径一旦写进渲染层就会变成手抄副本
// (README 里删过 9 份那种),所以放 lib。
//
// 口径两条:
// 1) 区间是半开的 [min, max)。2000/3500/4500 这些整值只落一档,不重不漏;
//    test/filters.test.mjs 里既有边界断言,也有"全库每条恰好命中一档"的不变量兜底。
// 2) 缺 maxAltM(或非法值)不命中任何档。宁可被筛掉,也不给假命中——
//    同 lib/quickfacts.js 的「未标注」与 lib/grading.js 的 usable:false:明说不知道,不猜方向。

// 最低档下沿取 -1000 而不是 0:中国陆地最低点是艾丁湖(-154m),这类线路将来可能进库,
// 用 0 会让它悄悄落不进任何一档(全库不变量测试会红,但那是数据没错、口径错)。
const ALT_BANDS = [
  { key: 'lt2000', label: '2000m 以下', min: -1000, max: 2000 },
  { key: '2000-3500', label: '2000–3500m', min: 2000, max: 3500 },
  { key: '3500-4500', label: '3500–4500m', min: 3500, max: 4500 },
  // 最高档上不封顶:max 留 null,test 里靠它找"封顶档"做直算交叉校验
  { key: 'ge4500', label: '4500m 及以上', min: 4500, max: null },
];

// 线路是否落在某档。key 不存在也返回 false(不抛错:筛选会遍历全库,脏 key 不该炸列表)。
function hitAltBand(trail, key) {
  const band = ALT_BANDS.find((b) => b.key === key);
  if (!band || !trail || !Number.isFinite(trail.maxAltM)) return false;
  const m = trail.maxAltM;
  return m >= band.min && (band.max === null || m < band.max);
}

// 海拔降序比较器。缺海拔值的行一律沉底,且结论不依赖参数顺序
// (sort 引擎两侧都会调用,写反一次就会出现"缺值随机插队")。
function byAlt(a, b) {
  const av = a && Number.isFinite(a.maxAltM) ? a.maxAltM : null;
  const bv = b && Number.isFinite(b.maxAltM) ? b.maxAltM : null;
  if (av === null && bv === null) return 0;
  if (av === null) return 1;
  if (bv === null) return -1;
  return bv - av;
}

const api_filters = { ALT_BANDS, hitAltBand, byAlt };
if (typeof module !== 'undefined') module.exports = api_filters;
else (window.GushanLib = window.GushanLib || {}).filters = api_filters;

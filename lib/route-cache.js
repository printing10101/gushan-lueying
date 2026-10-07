// 路线查询的会话级缓存(高德/腾讯/以后任何 provider 共用)。
//
// 为什么必须有:planner 按 loop[i]→loop[i+1] 逐条查,一个环线就有 3~8 条 leg,
// 每生成一次行程都要重查一遍——个人 Key 的 QPS 通常只有 3,会被打爆;配额也按调用次数计。
// 节点坐标是静态数据,路线不会变,缓存没有失效风险。
//
// 三条纪律(踩过坑才写下来):
// 1) **失败不缓存**:留重试机会,否则一次限频会让该 leg 在整个会话内永久失败。
// 2) **in-flight 去重**:同一对节点并发调用只发一次请求。
// 3) **坏坐标不进缓存**:坏值会撞同一个 key,把真正的失败缓存住,还会盖掉更友好的报错
//    (早先在缓存层直接读 from.lng,传入 undefined 时抛 "Cannot read properties of undefined",
//    把「路径规划坐标非法」那条准确报错盖掉了)。坏坐标的 key 用自增序号,既不误命中也不缓存。
const stores = new WeakMap(); // owner(provider 模块) → Map,不同 provider 互不污染
let badSeq = 0;

function routeCacheKey(from, to) {
  const c = (p) => (p && Number.isFinite(Number(p.lng)) && Number.isFinite(Number(p.lat))
    ? `${Number(p.lng)},${Number(p.lat)}` : null);
  const a = c(from);
  const b = c(to);
  if (a === null || b === null) return `bad:${badSeq += 1}`;
  return `${a}|${b}`;
}

// 命中缓存直接返回;未命中则调 fetcher,失败时把缓存项删掉再抛出
function cachedRoute(owner, key, fetcher) {
  let store = stores.get(owner);
  if (!store) {
    store = new Map();
    stores.set(owner, store);
  }
  if (store.has(key)) return store.get(key);
  const pending = fetcher().catch((e) => {
    store.delete(key);
    throw e;
  });
  store.set(key, pending);
  return pending;
}

function clear(owner) {
  const store = stores.get(owner);
  if (store) store.clear();
}

module.exports = { routeCacheKey, cachedRoute, clear };

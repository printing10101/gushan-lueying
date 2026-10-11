// 坐席选择口径(纯函数,零依赖):主进程 rail12306/planner 用,渲染进程经 <script>
// 挂到 window.GushanLib 复用同一实现——旧档兜底选座不再靠手抄副本。
// node 侧走 module.exports,浏览器侧挂 GushanLib.seat。

// "18:35" → 18.58;解析失败按 0(短途口径,选座回退到二等座)
function lishiHours(lishi) {
  const [h, m] = String(lishi || '').split(':').map(Number);
  return (h || 0) + (m || 0) / 60;
}

// 坐席优先级:≥10 小时的夜车/长途卧铺才现实(硬座 20h 不是人坐的),短途以二等座为主
function seatPreference(lishi) {
  return lishiHours(lishi) >= 10
    ? ['硬卧', '动卧', '软卧', '二等座', '硬座']
    : ['二等座', '硬座', '一等座'];
}

// 从票价表里按优先级选一个坐席,没有命中就取第一个有价的;全空返回 null
function pickSeat(prices, lishi) {
  if (!prices || !Object.keys(prices).length) return null;
  for (const label of seatPreference(lishi)) {
    if (Number.isFinite(prices[label])) return { label, price: prices[label] };
  }
  const [label, price] = Object.entries(prices)[0];
  return { label, price };
}

// 从一次余票查询结果里挑「要坐的那趟车」:可购车次 → 按历时选座 → 优先选该坐席还有票的。
//
// 为什么放在这里而不是留在调用方:planner.railLeg(行程规划取价)与 rail12306 的往返估算
// 曾经各抄了一份,两边的注释还互相写着「口径与对方一致」——那是漂移的预告,不是保障。
// 这里是双端共用的唯一实现,改口径只改一处。
function pickBuyableTrain(trains) {
  const buyable = (trains || []).filter((t) => t && t.canWebBuy);
  const withSeat = buyable.map((t) => ({ t, seat: pickSeat(t.prices, t.lishi) })).filter((x) => x.seat);
  // 12306 用「无」表示"有这个席别但没票","有"/"N 张"都算有票
  const seatOpen = (x) => {
    const v = x.t.seats?.[x.seat.label];
    return v && v !== '无';
  };
  return withSeat.find(seatOpen) || withSeat[0] || null;
}

const api_seat = { lishiHours, seatPreference, pickSeat, pickBuyableTrain };
if (typeof module !== 'undefined') module.exports = api_seat;
else (window.GushanLib = window.GushanLib || {}).seat = api_seat;

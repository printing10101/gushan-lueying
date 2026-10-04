// 统一 HTTP 传输层:Electron 主进程走 net.fetch(真实 Chromium 网络栈,跟随系统代理);
// 纯 node 环境(单测/冒烟脚本)回退全局 fetch。所有出网模块共用,默认 10 秒超时——
// 没有超时的出网调用会无限期卡死主流程(此前只有 runos 有超时,amap/weather 裸奔)。
let electronNet = null;
try {
  const e = require('electron');
  if (e && typeof e === 'object' && e.net) electronNet = e;
} catch { /* 纯 node 环境 */ }

const DEFAULT_TIMEOUT_MS = 10_000;

async function httpFetch(url, { headers, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const signal = AbortSignal.timeout(timeoutMs);
  if (electronNet) {
    await electronNet.app.whenReady();
    return electronNet.net.fetch(url, { headers, signal });
  }
  return fetch(url, { headers, signal });
}

module.exports = { httpFetch, DEFAULT_TIMEOUT_MS };

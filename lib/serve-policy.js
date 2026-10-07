// 本地 http 来源的启用策略(纯函数,可单测;electron/main.js 用它决定怎么加载页面)。
//
// 背景:腾讯 GL 明确"不再支持 file:// 方式",而地图要它才出图,所以本地 http 来源成了默认路径。
// 三条规则,顺序即优先级:
//   1. GUSHAN_SERVE=0 → 强制关(逃生开关:排查问题、或不想开端口时用)。加载回 file://。
//   2. GUSHAN_SERVE=1 → 强制开(不看有没有 Key,便于排查"端口/白名单"这类问题)。
//   3. 未设置 → **自动**:配了腾讯地图 Key(tencentKeyJs / tencentKeyWeb)且没配高德 JS Key 时开。
//      为什么要"且没有高德 Key":高德那条在 file:// 下可用且带夜色主题,有它就优先走 file://,
//      没必要为了地图开一个本地端口(安全面能小就小)。
// 注:静态服务只放行 src/ 与 lib/(见 electron/main.js 的 SERVE_ALLOW_TOP),data/ 不出网口。

const ON = 'on';
const OFF = 'off';
const AUTO = 'auto';

function decideServe({ env = {}, cfg = {} } = {}) {
  const raw = env.GUSHAN_SERVE;
  if (raw === '0') return { serve: false, mode: OFF, reason: 'GUSHAN_SERVE=0:按要求回到 file:// 加载' };
  if (raw === '1') return { serve: true, mode: ON, reason: 'GUSHAN_SERVE=1:强制本地 http 加载' };
  const hasTencent = Boolean(cfg.tencentKeyJs || cfg.tencentKeyWeb);
  const hasAmapJs = Boolean(cfg.amapKeyJs);
  if (hasAmapJs) {
    return { serve: false, mode: AUTO, reason: '有高德 JS Key:file:// 下即可出图,不开本地端口' };
  }
  if (hasTencent) {
    return { serve: true, mode: AUTO, reason: '有腾讯地图 Key 且无高德 JS Key:自动用本地 http 来源出图' };
  }
  return { serve: false, mode: AUTO, reason: '未配置任何地图 Key:保持 file://(配了腾讯 Key 会自动切换)' };
}

module.exports = { decideServe, ON, OFF, AUTO };

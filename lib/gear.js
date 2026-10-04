// 行前准备清单:由线路字段与天气上下文确定性推导,每条都带触发原因,不编造。
// trail 由调用方传入(路线库条目或行程里的 trail);ctx 可缺省,缺什么就少推什么。

// 山顶体感气温:预报点(通常是山下镇子)按气温递减率 ~6.5℃/km 折算到最高海拔
function summitTemp(tempAtNode, nodeElevationM, maxAltM) {
  if (!Number.isFinite(tempAtNode) || !Number.isFinite(nodeElevationM) || !Number.isFinite(maxAltM)) return null;
  if (maxAltM <= nodeElevationM) return null; // 预报点不低于最高海拔,无需折算
  return Math.round(tempAtNode - ((maxAltM - nodeElevationM) / 1000) * 6.5);
}

// ctx: { summitMin: 折算后的徒步日山顶最低温(可 null), maxHikePrecip: 徒步日最大降水概率(可 null) }
function gearChecklist(trail, ctx = {}) {
  if (!trail) return [];
  const items = [];
  const push = (item, reason) => items.push({ item, reason });
  const text = `${trail.summary || ''}${(trail.risks || []).join('')}${trail.supplies || ''}`;

  // 打底盘:任何线都成立,但只列这三样,别把清单灌成百科
  push('身份证与少量现金', '住宿/购票实名,山区移动支付可能没信号');
  if (trail.days >= 2) {
    push('头灯与备用电池', `多日行程(${trail.days} 天),早晚摸黑是常态`);
    push('急救包与常用药品', '多日行程远离补给点,自备兜底');
    push('离线轨迹/GPS 轨迹', '山区无手机信号,导航不能依赖网络');
  }

  // 扎营重装:长线重装类型,或补给描述里言明需扎营/无补给
  if (trail.days >= 2 && (trail.type === '长线重装' || /重装|扎营|露营|无补给/.test(text))) {
    push('帐篷/睡袋/炉灶全套重装', `全程需扎营或无补给(${trail.type}${trail.supplies ? `:${trail.supplies}` : ''})`);
  }
  // 涉水:风险或描述里点名的,防水保护是硬要求
  if (/涉水/.test(text)) {
    push('防水袋与备用鞋袜', '路线含涉水段,装备防水是硬要求');
  }
  // 复杂地形:碎石达坂/雪地/丛林无路
  if ((trail.techLevel || 0) >= 1) {
    push('登山杖与护膝', '路线含碎石/雪地/无路地形,膝盖保护优先');
  }

  // 海拔是独立维度:高反不看你体力多好
  if (trail.maxAltM >= 4000) {
    push('高反预防(药物/缓升/下撤预案)', `最高海拔 ${trail.maxAltM}m,高反风险实质存在`);
  } else if (trail.maxAltM >= 3000) {
    push('留意高反信号', `最高海拔 ${trail.maxAltM}m`);
  }
  if (trail.maxAltM >= 3500) {
    push('防晒霜与墨镜', '高海拔紫外线强,雪面反射加倍');
  }

  // 天气上下文:有预报才推,没有不猜
  if (Number.isFinite(ctx.maxHikePrecip) && ctx.maxHikePrecip >= 40) {
    push('雨具与防水袋', `徒步日最大降水概率 ${ctx.maxHikePrecip}%`);
  }
  if (Number.isFinite(ctx.summitMin)) {
    if (ctx.summitMin <= -10) {
      push('冰爪/雪套等四件套', `山顶体感约 ${ctx.summitMin}℃,路面大概率结冰`);
    } else if (ctx.summitMin <= 0) {
      push('保暖层(羽绒/抓绒)', `山顶体感约 ${ctx.summitMin}℃`);
    }
  }
  return items;
}

const api = { gearChecklist, summitTemp };
if (typeof module !== 'undefined') module.exports = api;
else (window.GushanLib = window.GushanLib || {}).gear = api;

// 行前准备清单:由线路字段与天气上下文确定性推导,每条都带触发原因,不编造。
// trail 由调用方传入(路线库条目或行程里的 trail);ctx 可缺省,缺什么就少推什么。

// 山顶体感气温:预报点(通常是山下镇子)按气温递减率 ~6.5℃/km 折算到最高海拔
function summitTemp(tempAtNode, nodeElevationM, maxAltM) {
  if (!Number.isFinite(tempAtNode) || !Number.isFinite(nodeElevationM) || !Number.isFinite(maxAltM)) return null;
  if (maxAltM <= nodeElevationM) return null; // 预报点不低于最高海拔,无需折算
  return Math.round(tempAtNode - ((maxAltM - nodeElevationM) / 1000) * 6.5);
}

// 日照窗口:纯徒步日的出发/收队时间就靠它,不靠"大概天亮了吧"。
// 输入是 weather.forecast 的逐日对象(含 sunrise/sunset,HH:MM)。缺任一项就返回 null——
// 不猜时间(同 summitTemp 的纪律:算不出就不给)。
// bufferHours:建议收队提前量,默认 1 小时(留出下撤与意外的时间)。
function daylightPlan(wx, { bufferHours = 1 } = {}) {
  const toMin = (hhmm) => {
    const m = /^(\d{2}):(\d{2})$/.exec(String(hhmm || ''));
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  };
  const rise = toMin(wx && wx.sunrise);
  const set = toMin(wx && wx.sunset);
  if (rise === null || set === null || set <= rise) return null;
  const lastLight = set - Math.round(bufferHours * 60);
  const fmt = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
  return {
    sunrise: wx.sunrise,
    sunset: wx.sunset,
    lastLight: fmt(lastLight),
    hours: Math.round(((set - rise) / 60) * 10) / 10,
  };
}

// ctx: { summitMin, maxHikePrecip, daylightHours(徒步日最短日照小时数,可 null) }
function gearChecklist(trail, ctx = {}) {
  if (!trail) return [];
  const items = [];
  const seen = new Set();
  const push = (item, reason) => {
    if (seen.has(item)) return; // 同一条只列一次(多条规则可能命中同一件装备)
    seen.add(item);
    items.push({ item, reason });
  };
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

  // 日照短(冬季):早晚都在路上,照明是硬需求。与"多日行程"那条分开写,
  // 因为 1 天线遇到短日照同样需要——两条都命中时由 dedupe 去重,不重复列。
  if (Number.isFinite(ctx.daylightHours) && ctx.daylightHours < 10) {
    push('头灯与备用电池', `徒步日日照仅 ${ctx.daylightHours} 小时,出发与收队时段需要照明`);
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

const api_gear = { gearChecklist, summitTemp, daylightPlan };
if (typeof module !== 'undefined') module.exports = api_gear;
else (window.GushanLib = window.GushanLib || {}).gear = api_gear;

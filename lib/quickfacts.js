// 入门速览:把线路的总量字段折算成「一天要面对多少」的日均口径,回答入门者最先关心的三个数——
// 每天走多少公里、每天爬多少米、最长多久没有补给。
//
// 为什么需要它:trails.json 存的是全程总量(distanceKm/climbM/days),
// 入门者看「乌孙古道 100km 爬升6000m」无从判断自己扛不扛得住,得自己除以天数。
// 这里替他除,直接给日均。确定性折算,无天气依赖,缺字段就少给一项,不编造。
//
// 与 grading.computeBreakdown 的区别:后者算「难度评级分项」(强度/海拔/技术/重装),
// 面向评级与筛选;这里算「体力量级」(日均里程/爬升/单日最长段),面向出发前的心理预期。
// 两套口径互不替代,不要合并——评级的分项权重是标定过的,混进日均会破坏单测里的评级交叉校验。

const DAY_KM_WARN = 15;   // 日均里程超过这个量级,多数新手会明显吃力
const DAY_CLIMB_WARN = 800; // 日均爬升超过这个量级(与 grading 的分项除数同量级),属高强度日

// 最长无补给天数:优先看 supplies 原文里点名的「无补给/需马帮」,其次按类型推断多日重装。
// 判定不了就返回 null——入门者宁可看到「未标注」也不要看到一个编出来的数字。
function resupplyGap(trail) {
  const text = `${trail.summary || ''}${trail.supplies || ''}${(trail.risks || []).join('')}`;
  if (/全程无补给|无补给|需马帮|全程马帮/.test(text)) return trail.days;
  if (trail.days >= 2 && trail.type === '长线重装') return trail.days;
  if (trail.days >= 2 && /重装|扎营/.test(text)) return trail.days;
  return null;
}

// 速览条目:只给能算准的字段,每条都带数字来源说明,不给「大概」「通常」这类模糊话。
function quickFacts(trail) {
  if (!trail) return [];
  const facts = [];
  const days = trail.days || 1;

  if (Number.isFinite(trail.distanceKm)) {
    const perDay = Math.round(trail.distanceKm / days);
    facts.push({
      label: '日均里程',
      value: `约 ${perDay} km/天`,
      warn: perDay > DAY_KM_WARN,
      why: `全程 ${trail.distanceKm}km ÷ ${days} 天`,
    });
  }
  if (Number.isFinite(trail.climbM)) {
    const perDay = Math.round(trail.climbM / days);
    facts.push({
      label: '日均爬升',
      value: `约 ${perDay} m/天`,
      warn: perDay > DAY_CLIMB_WARN,
      why: `全程爬升 ${trail.climbM}m ÷ ${days} 天`,
    });
  }
  if (Number.isFinite(trail.maxAltM)) {
    facts.push({
      label: '最高海拔',
      value: `${trail.maxAltM} m`,
      warn: trail.maxAltM >= 4000, // 高反是独立于体能的维度,不能因为里程短就说没事
      why: trail.maxAltM >= 4000 ? '高反风险实质存在,需提前适应' : '按常规海拔控制',
    });
  }
  const gap = resupplyGap(trail);
  facts.push({
    label: '最长无补给',
    value: gap == null ? '未标注' : gap >= trail.days ? '全程无补给' : `约 ${gap} 天`,
    warn: gap != null && gap >= 3,
    why: gap == null
      ? '线路库未标注补给情况,出发前需自行确认'
      : (trail.supplies ? `原文:${trail.supplies}` : '多日重装,按全程无补给准备'),
  });
  return facts;
}

const api = { quickFacts, resupplyGap, DAY_KM_WARN, DAY_CLIMB_WARN };
if (typeof module !== 'undefined') module.exports = api;
else (window.GushanLib = window.GushanLib || {}).quickfacts = api;

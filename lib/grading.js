// 难度评级:五星制(1 休闲 / 2 入门 / 3 进阶 / 4 高难 / 5 极限),国内驴友圈通行口径。
// grade 字段由维护者按社区共识标注;computeBreakdown 用可量化指标
// (日均里程、日均爬升、最高海拔、技术地形、多日重装)算出建议级别做交叉校验,
// 数据测试保证两者差不大于一级 —— 评级可解释、可追溯,而不是拍脑袋。
const GRADE_LABELS = { 1: '休闲', 2: '入门', 3: '进阶', 4: '高难', 5: '极限' };

// techLevel: 0=成熟步道/牧道, 1=碎石达坂/涉水/雪地/丛林无路, 2=冰川/攀爬/无人区
const TECH_SCORE = { 0: 0, 1: 1, 2: 2.5 };

// 海拔单独打分:高反风险是独立于体力的维度
function altitudeScore(maxAltM) {
  if (maxAltM >= 5000) return 4;
  if (maxAltM >= 4500) return 3;
  if (maxAltM >= 4000) return 2;
  if (maxAltM >= 3000) return 1;
  return 0;
}

const round1 = (x) => Math.round(x * 10) / 10;

function computeBreakdown(trail) {
  const days = trail.days || 1;
  const exertion = (trail.distanceKm || 0) / days / 12 + (trail.climbM || 0) / days / 800;
  const altitude = altitudeScore(trail.maxAltM || 0);
  const technical = TECH_SCORE[trail.techLevel || 0];
  // 多日重装的补给/扎营负担另计,长线因此比日指标相同的短线更高
  const load = days >= 8 ? 1.2 : days >= 5 ? 0.7 : 0;
  const total = exertion + altitude + technical + load;
  const suggested = total < 2.6 ? 1 : total < 3.8 ? 2 : total < 5.2 ? 3 : total < 6.6 ? 4 : 5;
  return {
    exertion: round1(exertion),
    altitude,
    technical,
    load,
    total: round1(total),
    suggested,
    label: GRADE_LABELS[suggested],
  };
}

// 给行程渲染用:保留线路原字段并附上评级文案
function describe(trail) {
  return { ...trail, gradeLabel: GRADE_LABELS[trail.grade] };
}

module.exports = { GRADE_LABELS, computeBreakdown, describe };

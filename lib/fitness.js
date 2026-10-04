// 身体状态 × 路线难度匹配:确定性规则,LLM 不参与。
// state 是 lib/runos.js 从本机 RunOS 服务取回的身体状态摘要(字段见 runos.js);
// 纯函数,trail/state 由调用方传入,方便单测。
//
// 口径:匹配基准是 trail.grade(社区共识五星),与 grading.js 一致;
// 高反风险独立于体力——耐力再好,海拔线照样提示。

// 由耐力得分锚定、爬坡得分微调的「当前能驾驭的建议难度上限」。
// 封顶 4:★5 极限长线不给自动放行,再好的数据也替代不了对重装长线的敬畏。
function ableGrade(state = {}) {
  const end = state.endurance?.score;
  if (!Number.isFinite(end)) return null;
  let grade = end >= 75 ? 4 : end >= 50 ? 3 : end >= 30 ? 2 : 1;
  const hill = state.hill?.score;
  if (Number.isFinite(hill)) {
    if (hill >= 75 && end >= 50) grade += 1; // 山地型跑者,爬坡能力上浮
    else if (hill < 25) grade -= 1;          // 平路型,爬升是短板
  }
  return Math.max(1, Math.min(4, grade));
}

// 单条匹配:level 是徽章档位,reasons 是主结论(引用真实数字),notes 是不改变档位的提醒。
// state 缺数据(dataReady=false 或耐力分缺失)一律 unknown——宁缺毋编。
function matchTrail(trail, state) {
  if (!state?.dataReady) return { level: 'unknown', reasons: [], notes: [] };
  let cap = ableGrade(state);
  if (cap == null) return { level: 'unknown', reasons: [], notes: [] };

  const reasons = [];
  const notes = [];

  // 当前状态修正:负荷过高/训练中断/准备度低迷都把上限往下压,只降不升
  const statusKey = state.status?.key;
  if (statusKey === 'strained') {
    cap -= 1;
    reasons.push(`ACWR ${state.acwr} 负荷过高,本周体能上限下调`);
  }
  if (statusKey === 'detached') {
    cap -= 1;
    reasons.push(`训练中断(${state.status?.detail || ''}),先从低难度线找回状态`);
  }
  const readiness = state.readiness?.score;
  if (Number.isFinite(readiness) && readiness < 40) {
    cap -= 1;
    reasons.push(`准备度仅 ${readiness}(${state.readiness.verdict || '疲劳积累'})`);
  }
  cap = Math.max(1, cap);

  const grade = trail.grade;
  const level = grade <= cap - 1 ? 'fit' : grade === cap ? 'stretch' : 'over';
  const hillPart = state.hill?.label ? `、爬坡「${state.hill.label}」` : '';
  reasons.unshift({
    fit: `耐力得分 ${state.endurance.score}${hillPart},驾驭 ★${cap} 及以下有余`,
    stretch: `当前体能上限约 ★${cap},这条 ★${grade} 正在上限,行前按最近一次长距离拉练评估`,
    over: `当前体能上限约 ★${cap},这条 ★${grade} 超出现阶段,建议先积累再战`,
  }[level]);

  // 提醒类:不动档位,但值得看见
  if (statusKey === 'recovering' && grade >= 3) notes.push('减量恢复期,硬线出发前先热身试状态');
  if (Number.isFinite(state.form) && state.form < -15) notes.push(`疲劳积累(形态值 ${state.form}),行程别排满`);
  const advice = state.todayAdvice;
  if (advice && (advice.level === 'easy' || advice.level === 'rest') && trail.days >= 2) {
    notes.push(`今日身体建议「${advice.level === 'rest' ? '休息' : '仅轻松活动'}」,连走多日线前先缓一缓`);
  }
  if (trail.days >= 3) notes.push(`连续 ${trail.days} 天负重行走,对恢复要求高`);
  if (trail.maxAltM >= 4000) notes.push(`最高海拔 ${trail.maxAltM}m:高反独立于体能,提前适应并备下撤预案`);
  else if (trail.maxAltM >= 3000) notes.push(`最高海拔 ${trail.maxAltM}m,留意高反信号`);

  return { level, cap, reasons, notes };
}

// 档位展示词表:主进程与渲染进程共用这一份(此前渲染层手抄,漂移即文案错位)
const FIT_LABELS = { fit: '适合', stretch: '有挑战', over: '超现阶段' };
const ADVICE_LABELS = { normal: '正常', reduce: '减量', easy: '仅轻松活动', rest: '休息' };

const api = { ableGrade, matchTrail, FIT_LABELS, ADVICE_LABELS };
if (typeof module !== 'undefined') module.exports = api;
else (window.GushanLib = window.GushanLib || {}).fitness = api;

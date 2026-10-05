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

// 数值字段收敛:只接受有限数,其余(字符串/null/NaN/负数)一律回落到 fallback。
// 这一层必须有,不是因为脏数据一定会来,而是因为一旦来了,下游的算术不会报错——
// 它会算出 NaN,而 NaN 跟任何阈值比较都是 false,于是穿过全部 if 落到最后的 else,
// 把一条数据不明的线路判成「★5 极限」。对入门者这是方向性误导:本该被难度闸门
// 排除的线,反而顶着最高难度出现在推荐结果里,还不带任何警告。
function num(v, fallback = 0) {
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

function computeBreakdown(trail) {
  // days 单独处理:它是除数,0 会造出 Infinity,非数会造出 NaN,负数没有物理意义。
  const days = num(trail.days, 1) || 1;
  const distanceKm = num(trail.distanceKm);
  const climbM = num(trail.climbM);
  // 评级建立在「日均里程 + 日均爬升」上,这两个原值缺失就没有评级可言。
  // 只收成 0 去继续算,会把一条啥数据都没有的线路判成「★1 休闲」——
  // 和之前的「★5 极限」一样是编答案,只是方向反过来。对入门者同样有害:
  // 他会以为这是条轻松线路,结果点进去发现啥也没写。
  const hasCoreMetrics = Number.isFinite(trail.distanceKm) && trail.distanceKm >= 0
    && Number.isFinite(trail.climbM) && trail.climbM >= 0;
  const exertion = distanceKm / days / 12 + climbM / days / 800;
  const altitude = altitudeScore(num(trail.maxAltM));
  // 用 ?? 而不是 ||:语义上更准(0 是有效档位「成熟步道」,不是缺省)。
  // 但要说清——此处两者**结果完全相同**,因为 TECH_SCORE[0] 本来就是 0,
  // || 把 0 兜到 0 上还是 0。这不是行为修复,只是把意图写准,别让下一个人
  // 以为改这里有性能或正确性收益。(实测 0/1/2/undefined/null 五种输入下
  // || 与 ?? 逐一同值。)
  const technical = TECH_SCORE[trail.techLevel] ?? 0;
  // 多日重装的补给/扎营负担另计,长线因此比日指标相同的短线更高
  const load = days >= 8 ? 1.2 : days >= 5 ? 0.7 : 0;
  const total = exertion + altitude + technical + load;
  // 兜底:算完了还是非有限数,同样不给评级。「数据不足」比编一个 ★1 或 ★5 诚实。
  const usable = hasCoreMetrics && Number.isFinite(total);
  const suggested = !usable ? null
    : total < 2.6 ? 1 : total < 3.8 ? 2 : total < 5.2 ? 3 : total < 6.6 ? 4 : 5;
  return {
    exertion: round1(exertion),
    altitude,
    technical,
    load,
    total: round1(total),
    suggested,
    label: suggested == null ? '数据不足' : GRADE_LABELS[suggested],
    // 数据不足时 UI 不该继续展示「强度 NaN + 海拔 0 + 技术 0 = NaN」这种文案,
    // 由调用方读这个标记改走提示分支(见 src/app.js routeHtml)。
    usable,
  };
}

// 给行程渲染用:保留线路原字段并附上评级文案
function describe(trail) {
  return { ...trail, gradeLabel: GRADE_LABELS[trail.grade] };
}

const api_grading = { GRADE_LABELS, TECH_SCORE, computeBreakdown, describe };
if (typeof module !== 'undefined') module.exports = api_grading;
else (window.GushanLib = window.GushanLib || {}).grading = api_grading;

// 管控/禁入线路的报备口径。纯函数,主进程 require、渲染进程经 <script> 挂 window.GushanLib.permit。
//
// 背景:data/trails.json 的 status 实测分布 开放146 / 管控21 / 部分管控15 / 关闭1 / 禁入8,
// 也就是有 45 条会被拦下,但界面此前只说"有警示"——没告诉用户"要怎么办才能走"。
// 借鉴 Summitra 路线库右上角那个「山峰申请」入口:管控不等于死路,报备路径才是有用的信息。
//
// 纪律(与 lib/risknotes.js 同一条):本模块不产数据。填不出来的走「未核实」,
// 绝不写"通常需提前申请"这类听起来像真话的通用话术——那是把不知道包装成建议。

// 受限状态:这几种才出报备提示。'开放' 不在名单里(150 条正常卡不加噪音),
// 名单长度由 test/permit.test.mjs 钉住,加状态时必须同步。
const RESTRICTED = ['部分管控', '管控', '关闭', '禁入'];

function trimmedText(v) {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

// → { state: 'needed'|'free'|'prohibited'|'unknown', how, where, leadDays, source, checkedAt, dirty }
// permit 缺失 → unknown 且 dirty 0(数据还没填,不是填错);
// permit 存在但 needed 不是布尔 → unknown 且 dirty 1(有人写了字段却写错形状,得留痕)。
function normalizePermit(trail) {
  const p = trail && trail.permit;
  const empty = { state: 'unknown', how: null, where: null, leadDays: null, source: null, checkedAt: null, dirty: 0 };
  if (p === undefined || p === null) return empty;
  if (typeof p !== 'object' || Array.isArray(p)) return { ...empty, dirty: 1 };
  const base = {
    how: trimmedText(p.how),
    where: trimmedText(p.where),
    // leadDays 只收非负整数:字符串 '3' 与 1.5 天都不做隐式转换,丢了这一项也不猜
    leadDays: Number.isInteger(p.leadDays) && p.leadDays >= 0 ? p.leadDays : null,
    source: trimmedText(p.source),
    checkedAt: trimmedText(p.checkedAt),
  };
  // 官方明令禁止的线路与"需报备"是两种状态:不能把禁止通告渲染成"需报备"。
  if (p.prohibited === true) return { ...base, state: 'prohibited', dirty: 0 };
  if (typeof p.needed !== 'boolean') return { ...base, state: 'unknown', dirty: 1 };
  return { ...base, state: p.needed ? 'needed' : 'free', dirty: 0 };
}

// 卡片上那一句。返回纯文本,转义由渲染层负责。
function permitNotice(trail) {
  if (!trail || !RESTRICTED.includes(trail.status)) return '';
  const r = normalizePermit(trail);
  const src = r.source ? `(出处:${r.source}${r.checkedAt ? ` ${r.checkedAt} 核对` : ''})` : '';
  if (r.state === 'prohibited') {
    const parts = ['禁止前往'];
    if (r.how) parts.push(r.how);
    if (r.where) parts.push(`发布:${r.where}`);
    return `${parts.join(' · ')}。${src}`;
  }
  if (r.state === 'free') return `报备:该线路无需报备(已核实)。${src}`;
  if (r.state === 'needed') {
    const parts = ['需报备'];
    if (r.how) parts.push(`材料:${r.how}`);
    if (r.where) parts.push(`受理:${r.where}`);
    if (r.leadDays !== null) parts.push(`提前 ${r.leadDays} 天`);
    return `报备:${parts.join(' · ')}。${src}`;
  }
  const dirtyNote = r.dirty ? '(data/trails.json 的 permit 字段有 1 条格式不对,已忽略)' : '';
  return `报备要求未核实——该线路处于「${trail.status}」,出发前请自行向当地确认。${dirtyNote}`;
}

const api_permit = { RESTRICTED, normalizePermit, permitNotice };
if (typeof module !== 'undefined') module.exports = api_permit;
else (window.GushanLib = window.GushanLib || {}).permit = api_permit;

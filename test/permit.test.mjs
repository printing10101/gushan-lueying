// 管控/禁入线路的报备口径。纯函数,渲染层经 window.GushanLib.permit 取同一实现。
//
// 背景:status 实测分布 开放146 / 管控21 / 部分管控15 / 关闭1 / 禁入8 —— 有 45 条被拦,
// 但界面只说"有警示",没告诉用户"要怎么办才能走"。借鉴 Summitra 路线库右上角那个
// 「山峰申请」入口:管控不等于死路,报备路径本身才是有用的信息。
//
// 与 lib/risknotes.js 同一条纪律:本模块不产数据。填不出来的统一走「未核实」,
// 绝不写"通常需要提前申请"这种听起来像真话的通用话术。
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(new URL('../package.json', import.meta.url));
const test = require('node:test');
const assert = require('node:assert');

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TRAILS = require(path.join(ROOT, 'data', 'trails.json'));
const { normalizePermit, permitNotice, RESTRICTED } = require('./lib/permit.js');

test('开放线路不出报备提示(不给 150 张正常卡片加噪音)', () => {
  assert.equal(RESTRICTED.includes('开放'), false);
  assert.equal(permitNotice({ status: '开放' }), '');
  assert.equal(permitNotice({ status: '开放', permit: { needed: true, how: 'x' } }), '');
});

test('受限线路没填 permit 时说「未核实」,不含糊其辞', () => {
  for (const status of RESTRICTED) {
    const n = permitNotice({ status, name: '测试线' });
    assert.ok(n, `${status} 线路必须给一句报备提示`);
    assert.ok(n.includes('未核实'), `${status}: 期望含「未核实」,实得 ${n}`);
  }
});

test('permit.needed=false 明确写「无需报备」', () => {
  const n = permitNotice({ status: '管控', permit: { needed: false } });
  assert.ok(n.includes('无需报备'), n);
  assert.ok(!n.includes('未核实'), `已核实为无需报备就不该再说明: ${n}`);
});

test('permit.needed=true 时把材料与地点带出来', () => {
  const n = permitNotice({
    status: '部分管控',
    permit: { needed: true, how: '身份证 + 行程单', where: '县文旅局', leadDays: 3 },
  });
  assert.ok(n.includes('需报备'), n);
  assert.ok(n.includes('身份证 + 行程单'), n);
  assert.ok(n.includes('县文旅局'), n);
  assert.ok(n.includes('提前 3 天'), n);
});

test('prohibited:官方禁止通告要显示为禁止前往,不能伪装成"需报备"', () => {
  const n = permitNotice({
    status: '禁入',
    permit: {
      prohibited: true,
      how: '禁止非法穿越',
      where: '太白县人民政府/太白山保护区管理局',
      source: '太白县政府 2025-02-11 通告',
      checkedAt: '2026-10-20',
    },
  });
  assert.ok(n.includes('禁止前往'), n);
  assert.ok(n.includes('禁止非法穿越'), n);
  assert.ok(n.includes('太白县人民政府'), n);
  assert.ok(n.includes('2025-02-11'), n);
  assert.ok(!n.includes('需报备'), `禁止通告不该说需报备:${n}`);
});

test('prohibited 状态可被 normalizePermit 识别,且不产脏数据', () => {
  const r = normalizePermit({ permit: { prohibited: true, how: '禁止进入' } });
  assert.equal(r.state, 'prohibited');
  assert.equal(r.dirty, 0);
  assert.equal(r.how, '禁止进入');
});

test('leadDays 非法只丢这一项,材料/地点照常显示(不做隐式转换)', () => {
  for (const bad of ['3', -1, 1.5, null, {}]) {
    const n = permitNotice({
      status: '管控',
      permit: { needed: true, how: '身份证', where: '乡政府', leadDays: bad },
    });
    assert.ok(n.includes('身份证'), `材料不该被连带丢掉: ${JSON.stringify(bad)}`);
    assert.ok(!n.includes('提前'), `非法 leadDays ${JSON.stringify(bad)} 不该长出天数`);
  }
  const ok = permitNotice({ status: '管控', permit: { needed: true, leadDays: 0 } });
  assert.ok(ok.includes('提前 0 天'), `0 是合法值(当天可报): ${ok}`);
});

test('needed 不是布尔时判未核实并留脏痕(形状写错不能伪装成"已核实过")', () => {
  for (const bad of ['true', 1, undefined, 'yes']) {
    const r = normalizePermit({ permit: { needed: bad, how: 'x' } });
    assert.equal(r.state, 'unknown', `needed=${JSON.stringify(bad)} 应判 unknown`);
    assert.equal(r.dirty, 1, `needed=${JSON.stringify(bad)} 应计 1 条脏`);
  }
  assert.equal(normalizePermit({}).state, 'unknown');
  assert.equal(normalizePermit({}).dirty, 0, '压根没填不是脏数据,不该计脏');
});

test('全库不变量:45 条受限线路过 normalize 都不抛错、不留脏,且受限名单没膨胀', () => {
  const all = Object.entries(TRAILS);
  const restricted = all.filter(([, t]) => RESTRICTED.includes(t.status));
  assert.ok(restricted.length >= 40,
    `受限线路应有 40+ 条,实得 ${restricted.length}(status 口径变了要同步这里)`);
  assert.equal(RESTRICTED.length, 4, '受限名单固定 4 态:部分管控/管控/关闭/禁入');
  const problems = [];
  for (const [id, t] of restricted) {
    try {
      const r = normalizePermit(t);
      if (r.dirty) problems.push(`${id}: ${r.dirty} 条脏 permit`);
    } catch (e) {
      problems.push(`${id}: 抛错 ${e.message}`);
    }
  }
  assert.equal(problems.length, 0, problems.join('\n   '));
});

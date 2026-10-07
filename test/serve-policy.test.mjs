// 本地 http 来源的启用策略:它是"默认行为"的决定点,而且带着一个安全面(开回环端口),
// 所以三条规则的优先级必须在单测里钉住,不能靠读 main.js 猜。
import { createRequire } from 'module';
const require = createRequire(new URL('../package.json', import.meta.url));
const test = require('node:test');
const assert = require('node:assert');

const { decideServe } = require('./lib/serve-policy.js');

test('GUSHAN_SERVE=0 是逃生开关:无论有没有 Key 都回 file://', () => {
  const r = decideServe({ env: { GUSHAN_SERVE: '0' }, cfg: { tencentKeyJs: 't' } });
  assert.equal(r.serve, false);
  assert.equal(r.mode, 'off');
  assert.match(r.reason, /file:\/\//);
  // 其它"看起来像关"的值不该被当成关(避免 'false'/'no' 这类猜谜)
  assert.equal(decideServe({ env: { GUSHAN_SERVE: 'false' }, cfg: { tencentKeyJs: 't' } }).serve, true);
});

test('GUSHAN_SERVE=1 强制开,不看 Key(便于排查端口问题)', () => {
  const r = decideServe({ env: { GUSHAN_SERVE: '1' }, cfg: {} });
  assert.equal(r.serve, true);
  assert.equal(r.mode, 'on');
});

test('默认自动:有腾讯地图 Key 就开;有高德 JS Key 就不开(那条 file:// 可用且带夜色主题)', () => {
  assert.equal(decideServe({ cfg: { tencentKeyJs: 't' } }).serve, true);
  assert.equal(decideServe({ cfg: { tencentKeyWeb: 'w' } }).serve, true, '一把 Key 通吃:只填 WebService 也认');
  assert.equal(decideServe({ cfg: { amapKeyJs: 'a' } }).serve, false);
  // 两个都配:高德优先(file:// 可用,少开一个端口)
  assert.equal(decideServe({ cfg: { amapKeyJs: 'a', tencentKeyJs: 't' } }).serve, false);
  // 都没有:保持 file://,并说明"配了腾讯 Key 会自动切换"
  const none = decideServe({ cfg: {} });
  assert.equal(none.serve, false);
  assert.match(none.reason, /腾讯/);
});

test('脏输入不抛错(env/cfg 缺省、null 值都当没有)', () => {
  assert.equal(decideServe().serve, false);
  assert.equal(decideServe({ env: {}, cfg: { tencentKeyJs: '', tencentKeyWeb: null } }).serve, false);
});

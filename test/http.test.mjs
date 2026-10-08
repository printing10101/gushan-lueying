// 统一出网传输层的超时纪律。这个模块只有 21 行,此前没有直接单测——
// 但它是**所有出网模块的共同底座**(amap / tencent / weather / rail12306 / oilprice / runos),
// 而 INSTINCTS 记着它诞生时的原因:「没有超时的出网调用会无限期卡死主流程
// (此前只有 runos 有超时,amap/weather 裸奔)」。
//
// 这里测的是纯 node 回退分支(Electron 分支走 net.fetch,由 dom-smoke 真起窗口覆盖)。
// 之所以 mock globalThis.fetch 能生效:http.js 在**调用时**才解析全局 fetch,
// 不是在模块加载时把它抓住——这条性质本身也是被这个文件钉住的。
import { createRequire } from 'module';
const require = createRequire(new URL('../package.json', import.meta.url));
const test = require('node:test');
const assert = require('node:assert');

const { httpFetch, DEFAULT_TIMEOUT_MS } = require('./lib/http.js');

const withFetch = (impl) => {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  return () => { globalThis.fetch = real; };
};

test('默认超时是 10 秒——这是所有出网模块共用的那条纪律', () => {
  assert.equal(DEFAULT_TIMEOUT_MS, 10000,
    '少了超时,任何一次网络不响应都会把主流程无限期挂住(amap/weather 曾经裸奔)');
});

test('纯 node 环境走全局 fetch,并把 headers 与超时 signal 原样传下去', async () => {
  let seen = null;
  const restore = withFetch((url, opts) => { seen = { url, opts }; return Promise.resolve({ ok: true }); });
  try {
    const r = await httpFetch('https://example.test/x', { headers: { 'X-Test': '1' } });
    assert.equal(r.ok, true);
    assert.equal(seen.url, 'https://example.test/x');
    assert.deepEqual(seen.opts.headers, { 'X-Test': '1' }, '调用方给的 headers 必须原样传下去');
    assert.ok(seen.opts.signal instanceof AbortSignal, '必须带 signal,否则"超时"只是个摆设');
  } finally { restore(); }
});

test('不传选项也能调用:仍然带 signal,只是没有 headers', async () => {
  let seen = null;
  const restore = withFetch((_url, opts) => { seen = opts; return Promise.resolve({ ok: true }); });
  try {
    await httpFetch('https://example.test/y');
    assert.equal(seen.headers, undefined);
    assert.ok(seen.signal instanceof AbortSignal, '默认路径也必须受超时保护');
  } finally { restore(); }
});

test('超时真的会中断请求:abort 必须传导到 fetch,而不是只挂了个 signal 字段', async () => {
  let abortedBySignal = false;
  const restore = withFetch((_url, opts) => new Promise((_res, rej) => {
    opts.signal.addEventListener('abort', () => { abortedBySignal = true; rej(new Error('请求被超时中断')); });
  }));
  try {
    const p = httpFetch('https://example.test/slow', { timeoutMs: 40 });
    p.catch(() => {}); // 下面要先等一段,期间它已 reject,这里接住避免 unhandled rejection
    // 必须自己 await 一个 ref 的计时器:AbortSignal.timeout 的计时器是 unref 的,
    // 不然事件循环会先空掉,测试被判 cancelledByParent 而不是通过(这个坑踩过一次)。
    await new Promise((r) => setTimeout(r, 150));
    assert.ok(abortedBySignal, 'signal 的 abort 必须真的传导到 fetch,否则请求根本不会中断');
    await assert.rejects(p, /超时中断/);
  } finally { restore(); }
});

test('timeoutMs 可覆盖:传 40ms 就必须在 40ms 量级 abort,而不是等默认的 10 秒', async () => {
  let captured = null;
  const restore = withFetch((_url, opts) => { captured = opts.signal; return Promise.resolve({ ok: true }); });
  try {
    await httpFetch('https://example.test/x', { timeoutMs: 40 });
    assert.equal(captured.aborted, false, '刚发出时不该已经超时');
    await new Promise((r) => setTimeout(r, 160));
    assert.ok(captured.aborted, 'timeoutMs=40 的 signal 此时必须已 abort——没 abort 说明传进去的默认值被忽略了');
  } finally { restore(); }
});

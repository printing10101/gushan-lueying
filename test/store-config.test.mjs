// ensureConfig / bootstrapDataDir 的读盘路径。
//
// 为什么单独一个文件:store.js 在**模块加载时**就根据 GUSHAN_DATA_DIR 定死 DATA_DIR,
// 所以必须在 require 它之前把环境变量设好。既有的 store.test.mjs 已经在用真实 data/
// 了(它测的是 resolvePath 这类纯逻辑),这里的用例要把整个目录换掉。
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
const require = createRequire(new URL('../package.json', import.meta.url));
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gushan-store-cfg-'));
// 顺序不能反:必须在 require('./lib/store.js') 之前
process.env.GUSHAN_DATA_DIR = TMP;
const store = require('./lib/store.js');

test.after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 临时目录,删不掉也无所谓 */ }
});

test('ensureConfig:config.json 不存在时按 example 生成一份', () => {
  fs.copyFileSync(path.join(ROOT, 'data', 'config.example.json'), path.join(TMP, 'config.example.json'));
  const cfgPath = path.join(TMP, 'config.json');
  if (fs.existsSync(cfgPath)) fs.unlinkSync(cfgPath);

  store.ensureConfig();
  assert.ok(fs.existsSync(cfgPath), '首次运行必须自动生成 config.json,否则应用起不来');
  const generated = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const example = JSON.parse(fs.readFileSync(path.join(TMP, 'config.example.json'), 'utf8'));
  assert.deepEqual(generated, example, '生成的内容要与 example 一致');
});

test('ensureConfig:已有 config.json 时绝不覆盖(用户填的 Key 不能被冲掉)', () => {
  const cfgPath = path.join(TMP, 'config.json');
  fs.writeFileSync(cfgPath, '{"amapKeyWeb":"MY-KEY"}', 'utf8');
  store.ensureConfig();
  assert.equal(fs.readFileSync(cfgPath, 'utf8'), '{"amapKeyWeb":"MY-KEY"}',
    '已存在的配置必须原样保留');
});

test('ensureConfig:写在 GUSHAN_DATA_DIR 指向的目录,不是仓库里的 data/', () => {
  assert.equal(store.DATA_DIR, path.resolve(TMP), `DATA_DIR 应被环境变量接走,实得 ${store.DATA_DIR}`);
  assert.notEqual(store.DATA_DIR, store.BUNDLED_DATA_DIR, '不能写回开发目录');
});

test('bootstrapDataDir:只补缺的文件,已存在的一律不覆盖', () => {
  const dst = fs.mkdtempSync(path.join(os.tmpdir(), 'gushan-boot-'));
  try {
    // 目标目录里先放一份"用户自己改过的" trails.json
    fs.writeFileSync(path.join(dst, 'trails.json'), '{"mine":1}', 'utf8');
    const r = store.bootstrapDataDir(dst);
    assert.ok(r.copied.includes('regions.json'), `种子文件要补:${r.copied.join(',')}`);
    assert.ok(!r.copied.includes('trails.json'), '已存在的不能进 copied 清单');
    assert.equal(fs.readFileSync(path.join(dst, 'trails.json'), 'utf8'), '{"mine":1}',
      '已存在的文件绝不能被覆盖');
  } finally {
    try { fs.rmSync(dst, { recursive: true, force: true }); } catch { /* 同上 */ }
  }
});

test('bootstrapDataDir:对开发目录(== 种子目录)直接返回,不做任何复制', () => {
  assert.deepEqual(store.bootstrapDataDir(store.BUNDLED_DATA_DIR), { copied: [] });
});

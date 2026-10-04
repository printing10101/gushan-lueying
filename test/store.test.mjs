import { createRequire } from 'module';
const require = createRequire(new URL('../package.json', import.meta.url));
const store = require('./lib/store.js');
const test = require('node:test');
const assert = require('node:assert');

test('resolvePath:拒绝路径穿越,放行合法子路径', () => {
  assert.throws(() => store.resolvePath('../secrets'), /非法的数据名/);
  assert.throws(() => store.resolvePath('trips/../../config'), /非法的数据名/);
  assert.throws(() => store.resolvePath('trips/a\\b'), /非法的数据名/);
  assert.doesNotThrow(() => store.resolvePath('trips/20261003-chuanxi'));
});

test('listDir/remove:写入后可见,删除后消失', () => {
  const name = 'trips/__store_test__';
  try {
    store.write(name, { hello: 1 });
    assert.ok(store.listDir('trips').includes('__store_test__'));
    assert.equal(store.remove(name).ok, true);
    assert.ok(!store.listDir('trips').includes('__store_test__'));
    // 删不存在的不报错,返回 ok:false
    assert.equal(store.remove(name).ok, false);
  } finally {
    store.remove(name); // 中途断言失败也要清场,不污染 data/
  }
});

test('read:损坏 JSON 不再反复炸,改名留档并返回 null 走自举', () => {
  const fs = require('fs');
  const name = 'trips/__store_broken__';
  const file = store.resolvePath(name);
  try {
    fs.writeFileSync(file, '{ 这不是 JSON', 'utf8');
    assert.equal(store.read(name), null);
    assert.ok(fs.existsSync(`${file}.broken`), '原始内容应改名留档');
  } finally {
    fs.rmSync(file, { force: true });
    fs.rmSync(`${file}.broken`, { force: true });
  }
});

test('read:不存在的名字返回 null,与损坏区分', () => {
  assert.equal(store.read('trips/__store_absent__'), null);
});

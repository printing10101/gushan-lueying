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

// ---- 配置漂移:example 加了键位,已有 config 不会自动补,必须报得出来 ----
test('diffConfig:整块缺失只报父键一次,不重复报子键', () => {
  const example = { runos: { baseUrl: 'http://127.0.0.1:8000' }, _说明: '注释不计' };
  const r = store.diffConfig(example, {});
  assert.deepEqual(r.map((x) => x.path), ['runos'], `实得:${r.map((x) => x.path).join(',')}`);
});

test('diffConfig:分 blocking 与 defaulted 两档', () => {
  const example = { flightCityPinyin: 'xian', lodging: { perRoomPerNight: 200 }, brandNew: 1 };
  const r = store.diffConfig(example, { lodging: { perRoomPerNight: 200 } });
  const byPath = Object.fromEntries(r.map((x) => [x.path, x.severity]));
  assert.equal(byPath.flightCityPinyin, 'blocking', '机票跳转没有代码默认值,缺了一点就报错');
  assert.ok(!byPath.lodging, '已配齐的不报');
  assert.equal(byPath.brandNew, 'defaulted', '未知新键按"有默认值"档处理');
});

test('diffConfig:模拟当前这份 config 的真实缺项(fuel.gasType 与四个顶层块)', () => {
  const example = {
    amapKeyWeb: '', amapKeyJs: '',
    fuel: { consumptionLPer100km: 8, pricePerL: 8.2, gasType: '92#' },
    maxDriveKmPerDay: 400, flightCityPinyin: 'xian',
    runos: { baseUrl: 'http://127.0.0.1:8000' },
    lodging: { perRoomPerNight: 200, peoplePerRoom: 2 },
    food: { perPersonPerDay: 80 },
  };
  // 用户实际那份:只有 amap 两项空串 + fuel(无 gasType) + maxDriveKmPerDay
  const cfg = {
    amapKeyWeb: '', amapKeyJs: '',
    fuel: { consumptionLPer100km: 8, pricePerL: 8.2 },
    maxDriveKmPerDay: 400,
  };
  const paths = store.diffConfig(example, cfg).map((x) => x.path).sort();
  assert.deepEqual(paths, ['flightCityPinyin', 'food', 'fuel.gasType', 'lodging', 'runos'].sort(),
    `paths: ${paths.join(',')}`);
});

test('diffConfig:配置齐了就不报,不能有无病呻吟的提示', () => {
  const example = { flightCityPinyin: 'xian', fuel: { gasType: '92#' } };
  assert.deepEqual(store.diffConfig(example, { flightCityPinyin: 'xian', fuel: { gasType: '95#' } }), []);
});

test('write:结尾补换行,与 data/*.json 的存盘格式一致', () => {
  const file = store.resolvePath('trips/__store_nl__');
  try {
    store.write('trips/__store_nl__', { a: 1 });
    const text = require('fs').readFileSync(file, 'utf8');
    assert.ok(text.endsWith('}\n'), '丢结尾换行会让 trails.json 一重写就出一条无意义 diff');
    assert.equal(JSON.parse(text).a, 1, '补换行不能破坏可解析性');
  } finally {
    store.remove('trips/__store_nl__');
  }
});

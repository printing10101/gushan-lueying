// 地图实现层:两家 SDK 的差异被挡在这一层,所以这里的纯逻辑(坐标转换/选型/安全密钥)必须钉死。
//
// 其中"选型"那条尤其重要:腾讯 GL 官方不接受 file:// 来源,若在 file:// 下选了腾讯,
// 表现是**地图区域一片空白且不报错**——用户只会以为"地图坏了"。
import { createRequire } from 'module';
const require = createRequire(new URL('../package.json', import.meta.url));
const test = require('node:test');
const assert = require('node:assert');

const M = require('./lib/map-impl.js');

const region = {
  loop: [
    { name: 'A', lng: 100, lat: 30 },
    { name: 'B', lng: 101, lat: 31 },
    { name: '脏点', lng: 'x', lat: 31 },
  ],
};

test('parsePathString:高德的 "lng,lat;…" 与坏点处理', () => {
  assert.deepEqual(M.parsePathString('100,30;101,31'), [[100, 30], [101, 31]]);
  assert.deepEqual(M.parsePathString('100,30;坏;a,b;101,31;'), [[100, 30], [101, 31]], '坏点直接丢,不抛错');
  assert.deepEqual(M.parsePathString(''), []);
  assert.deepEqual(M.parsePathString(undefined), []);
});

test('pointsOf:环线节点转坐标时丢掉非法的,不产出 NaN 点', () => {
  const pts = M.pointsOf(region);
  assert.deepEqual(pts, [[100, 30], [101, 31]], '脏节点被过滤(画到 (0,0) 比不画更糟)');
  assert.deepEqual(M.pointsOf(null), []);
});

test('tripSegments:优先真实路线,没有就退回节点直线,非驾车日不画', () => {
  const trip = {
    schedule: [
      { type: 'drive', legs: [
        { from: 'A', to: 'B', path: '100,30;100.5,30.5;101,31' },
        { from: 'B', to: 'A', path: '' },
      ] },
      { type: 'hike', trail: 'x' },
    ],
  };
  const segs = M.tripSegments(trip, region);
  assert.equal(segs.length, 2, '徒步日不产线段');
  assert.equal(segs[0].real, true);
  assert.equal(segs[0].path.length, 3);
  assert.equal(segs[1].real, false, '没有 path 时用两端节点连直线');
  assert.deepEqual(segs[1].path, [[101, 31], [100, 30]]);
  // 节点缺失时整段不画(而不是画到 0,0)
  assert.equal(M.tripSegments({ schedule: [{ type: 'drive', legs: [{ from: 'X', to: 'Y', path: '' }] }] }, region).length, 0);
});

test('pickMapImpl:高德 Key 优先;腾讯 Key 在 file:// 下必须被挡下并给出可执行提示', () => {
  const amap = M.pickMapImpl({ amapKeyJs: 'a', tencentKeyJs: 't' });
  assert.equal(amap.impl.name, 'amap');
  assert.equal(amap.key, 'a');

  const httpTencent = M.pickMapImpl({ tencentKeyJs: 't' }, { isFileOrigin: false });
  assert.equal(httpTencent.impl.name, 'tencent', '非 file 来源下腾讯可用');
  assert.equal(httpTencent.key, 't');

  const fileTencent = M.pickMapImpl({ tencentKeyJs: 't' }, { isFileOrigin: true });
  assert.equal(fileTencent.impl, null, 'file:// 下不能选腾讯,否则空白且不报错');
  assert.equal(fileTencent.blocked, 'tencent');
  assert.ok(fileTencent.reason.includes('GUSHAN_SERVE=1'), '提示里要给出可执行的命令: ' + fileTencent.reason);

  // 腾讯一把 Key 通吃:没填 tencentKeyJs 时回落 tencentKeyWeb
  assert.equal(M.pickMapImpl({ tencentKeyWeb: 'w' }, { isFileOrigin: false }).key, 'w');

  const none = M.pickMapImpl({});
  assert.equal(none.impl, null);
  assert.ok(none.reason.includes('未配置'));
});

test('applyAmapSecurityCode:配了就挂到 window,没配不写空对象;node 下调它不抛错', () => {
  assert.equal(M.applyAmapSecurityCode(''), false, 'node 环境没 window,应当返回 false 而不是炸');
  assert.equal(M.applyAmapSecurityCode('code'), false);
  const fake = {};
  globalThis.window = fake;
  try {
    assert.equal(M.applyAmapSecurityCode('k1'), true);
    assert.deepEqual(fake._AMapSecurityConfig, { securityJsCode: 'k1' });
    assert.equal(M.applyAmapSecurityCode(''), false, '空值不写');
    assert.equal(M.applyAmapSecurityCode(null), false);
  } finally {
    delete globalThis.window;
  }
});

test('centerOf:有环线就取首节点,没有就用兜底中心', () => {
  assert.deepEqual(M.centerOf(region), { lng: 100, lat: 30 });
  const fallback = M.centerOf(null);
  assert.ok(Number.isFinite(fallback.lng) && Number.isFinite(fallback.lat));
});

// 交叉一致性:同一份口径的两处实现必须给同一个结果。
//
// 为什么用"交叉断言"而不是强行合并:
//   - haversineKm 有两份(lib/amap.js 与 lib/gpx.js),后者多一个 clamp;
//   - polyline 解析有两份(lib/gpx.js 的 polylinePoints 与 lib/map-impl.js 的 parsePathString),
//     后者原**不做**经纬度范围校验——实测差异:同一条坏 polyline 在导出时被丢弃,
//     在地图上却被画出来(画到 91° 纬度那种地方)。已统一到严格版,这里钉住防止再分开。
// 合并成一份要动渲染层的加载顺序(map-impl 是 <script> 加载的,gpx 现在只在主进程),
// 代价大于收益;用断言锁住等价性更稳。
import { createRequire } from 'module';
const require = createRequire(new URL('../package.json', import.meta.url));
const test = require('node:test');
const assert = require('node:assert');

const amap = require('./lib/amap.js');
const gpx = require('./lib/gpx.js');
const mapImpl = require('./lib/map-impl.js');

// 真实环线节点对(川西 / 京西 / 跨省),量级覆盖 70km ~ 1070km
const PAIRS = [
  [{ lng: 104.07, lat: 30.66 }, { lng: 103.48, lat: 31.06 }],   // 成都 → 映秀
  [{ lng: 116.404, lat: 39.911 }, { lng: 115.575, lat: 40.014 }], // 北京 → 斋堂
  [{ lng: 116.407, lat: 39.904 }, { lng: 121.47, lat: 31.23 }],  // 北京 → 上海
  [{ lng: 0, lat: 0 }, { lng: 1, lat: 1 }],                       // 低纬度
  [{ lng: -73.98, lat: 40.75 }, { lng: 2.35, lat: 48.86 }],       // 纽约 → 巴黎
];

test('两份 haversineKm 对合法坐标必须给同一个值(差 < 1e-9 km)', () => {
  for (const [a, b] of PAIRS) {
    const viaAmap = amap.haversineKm({ lng: a.lng, lat: a.lat }, { lng: b.lng, lat: b.lat });
    // gpx 那边的参数形状是 {lat, lon}
    const viaGpx = gpx.haversineKm({ lat: a.lat, lon: a.lng }, { lat: b.lat, lon: b.lng });
    assert.ok(Math.abs(viaAmap - viaGpx) < 1e-9,
      `两份实现分家了:${JSON.stringify(a)}→${JSON.stringify(b)} amap=${viaAmap} gpx=${viaGpx}`);
  }
});

test('haversineKm 的量级要站得住(成都→映秀约 72km,北京→上海约 1060km)', () => {
  const short = amap.haversineKm({ lng: 104.07, lat: 30.66 }, { lng: 103.48, lat: 31.06 });
  const long = amap.haversineKm({ lng: 116.407, lat: 39.904 }, { lng: 121.47, lat: 31.23 });
  assert.ok(short > 60 && short < 85, `成都→映秀实得 ${short}`);
  assert.ok(long > 1000 && long < 1120, `北京→上海实得 ${long}`);
});

test('两份 polyline 解析对合法点给同一个结果', () => {
  const s = '116.404,39.911;116.0,39.95;115.575,40.014';
  assert.deepEqual(mapImpl.parsePathString(s), [[116.404, 39.911], [116, 39.95], [115.575, 40.014]]);
  // gpx 那份返回的是 {lat,lon} 对象数组,逐值对齐比较(形状不同是各自用途决定的)
  const g = gpx.polylinePoints(s);
  assert.equal(g.length, 3);
  g.forEach((p, i) => {
    assert.equal(p.lon, mapImpl.parsePathString(s)[i][0]);
    assert.equal(p.lat, mapImpl.parsePathString(s)[i][1]);
  });
});

test('两份 polyline 解析都丢弃越界/非法点(地图不能画出跑到国外的线)', () => {
  // 116,91 是纬度越界(>90);abc,def 不是数字
  const bad = 'abc,def;116.404,39.911;116,91';
  assert.equal(mapImpl.parsePathString(bad).length, 1, 'map-impl 也该只留合法的那一个');
  assert.equal(gpx.polylinePoints(bad).length, 1, 'gpx 侧同样只留一个');
  const m = mapImpl.parsePathString(bad)[0];
  const gp = gpx.polylinePoints(bad)[0];
  assert.equal(m[0], gp.lon);
  assert.equal(m[1], gp.lat);
});

test('polyline 解析对空串/非字符串不抛错,返回空数组', () => {
  for (const bad of ['', null, undefined, ';;;']) {
    assert.deepEqual(mapImpl.parsePathString(bad), [], `map-impl 在 ${String(bad)} 上应给 []`);
    assert.deepEqual(gpx.polylinePoints(bad), [], `gpx 在 ${String(bad)} 上应给 []`);
  }
});

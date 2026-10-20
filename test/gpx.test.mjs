// GPX 解析与"实测值 vs 标称值"的合并判定。
//
// 为什么要它:trails.json 的 distanceKm/climbM/maxAltM 没有 source 字段,是从攻略/文档抄来的。
// 而两步路/六只脚/Strava 上大量线路有现成 GPX。导一次 GPX 就能把这三个数从"抄来的"
// 变成"量过的"——这是全库数据等级最高的一次提升,也是条目 4(真实里程字段化)的上游。
//
// 口径:
// - 距离按相邻点累加;两点都有高程时用 3D(坡面上 2D 会系统性低估),否则退化为 2D。
// - 爬升/最高海拔**只在所有点都带高程时**才给。缺高程还报一个爬升数,等于报一个必然偏小的假完整值。
// - 合并判定:与标称值差 >GPX_REVIEW_PCT 的进 review(不写盘),小差异才 apply。
import { createRequire } from 'module';
const require = createRequire(new URL('../package.json', import.meta.url));
const test = require('node:test');
const assert = require('node:assert');

const { parseGpx, mergeMeasured, tripToGpx, GPX_REVIEW_PCT } = require('./lib/gpx.js');

const gpx = (pts) => `<?xml version="1.0"?><gpx version="1.1"><trk><trkseg>`
  + pts.map(([lat, lon, ele]) => `<trkpt lat="${lat}" lon="${lon}">`
    + `${ele === undefined ? '' : `<ele>${ele}</ele>`}</trkpt>`).join('')
  + `</trkseg></trk></gpx>`;
const near = (v, expect, tol, msg) => assert.ok(Math.abs(v - expect) <= tol, `${msg}: 实得 ${v}, 期望 ${expect}±${tol}`);

test('正 north 1 度 ≈ 111.195km(用已知量级钉住坐标换算)', () => {
  const r = parseGpx(gpx([[0, 0], [1, 0]]));
  assert.equal(r.ok, true);
  near(r.distanceKm, 111.195, 0.05, '纬度 1 度的地面距离');
  assert.equal(r.points, 2);
});

test('爬升只累计上升,下降不算进爬升', () => {
  const r = parseGpx(gpx([[30, 100, 1000], [30.001, 100, 2000], [30.002, 100, 1500]]));
  assert.equal(r.climbM, 1000, '1000→2000→1500 的累计上升是 1000m');
  assert.equal(r.maxAltM, 2000);
});

test('坡面上距离按 3D 算(水平 100m + 上升 100m ≈ 141m,不是 100m)', () => {
  const flat = parseGpx(gpx([[30, 100, 1000], [30.0008983, 100, 1000]])); // ≈90m 水平
  const steep = parseGpx(gpx([[30, 100, 1000], [30.0008983, 100, 1100]])); // 同水平 +100m 爬升
  near(flat.climbM, 0, 0.001, '平路爬升为 0');
  assert.ok(steep.distanceKm > flat.distanceKm * 1.4,
    `3D 距离应明显大于 2D: 2D ${flat.distanceKm} vs 3D ${steep.distanceKm}`);
});

test('任一点缺高程 → climbM/maxAltM 给 null,但距离仍算(不给偏小的假完整值)', () => {
  const r = parseGpx(gpx([[30, 100, 1000], [30.01, 100, undefined], [30.02, 100, 1500]]));
  assert.equal(r.ok, true);
  assert.equal(r.climbM, null);
  assert.equal(r.maxAltM, null);
  assert.equal(r.eleGaps, 2, '两个相邻段缺高程,要如实报缺口数');
  assert.ok(r.distanceKm > 2 && r.distanceKm < 2.3, `2D 距离仍应算出: ${r.distanceKm}`);
});

test('有效点不足 2 个 / 垃圾输入一律 ok:false 且不抛错', () => {
  for (const bad of ['', 'not xml at all', '<html><body>x</body></html>',
    gpx([]), gpx([[30, 100, 10]]), gpx([[91, 0], [0, 0]]), gpx([[NaN, 0], [0, 0]]),
    gpx([[30, 181], [30, 0]])]) {
    const r = parseGpx(bad);
    assert.equal(r.ok, false, `应判失败: ${JSON.stringify(String(bad).slice(0, 30))}`);
    assert.ok(typeof r.error === 'string' && r.error, '失败必须带原因');
  }
});

test('非法坐标的点被跳过,合法点仍成链', () => {
  const r = parseGpx('<gpx><trk><trkseg>'
    + '<trkpt lat="999" lon="0"><ele>1</ele></trkpt>'
    + '<trkpt lat="30" lon="100"><ele>1000</ele></trkpt>'
    + '<trkpt lat="30.01" lon="100"><ele>1200</ele></trkpt>'
    + '</trkseg></trk></gpx>');
  assert.equal(r.ok, true);
  assert.equal(r.points, 2, '非法点不该混进点数');
  assert.equal(r.climbM, 200);
});

test('超长轨迹(20 万点)不崩:最高海拔必须走循环,不能用 Math.max(...spread)', () => {
  // 为什么钉这条:Math.max(...pts.map(p => p.ele)) 会把每个点压进调用栈,实测 20 万点直接
  // RangeError。而主进程允许导入 20MB GPX(带高程 trkpt 约 62 字节/点 ≈ 30 万点),
  // 也就是说崩溃落在**自设的允许范围内**——不是理论边界,是会真撞上的。
  const N = 200000;
  const pts = Array.from({ length: N }, (_, i) => [30 + i * 0.0001, 100 + i * 0.0001, 1000 + (i % 50)]);
  const r = parseGpx(gpx(pts));
  assert.equal(r.ok, true, '20 万点必须解析成功,不能抛 RangeError');
  assert.equal(r.points, N);
  assert.equal(r.maxAltM, 1049, '最高海拔仍要算对(1000 + 最大余数 49)');
  // 高程按 i%50 锯齿:每 50 点里上升 49 次、回落到 1000 一次 → 4000 个周期 × 49
  assert.equal(r.climbM, 196000, '爬升同理(锯齿高程的累计上升)');
});

test('合并判定:小差异 apply,超阈值进 review,无基线也 apply 但标出来', () => {
  assert.equal(GPX_REVIEW_PCT, 10);
  const small = mergeMeasured({ distanceKm: 100 }, { distanceKm: 109 });
  assert.deepEqual(Object.keys(small.apply), ['distanceKm']);
  assert.equal(small.apply.distanceKm, 109);
  assert.equal(small.review.length, 0);

  const big = mergeMeasured({ distanceKm: 100 }, { distanceKm: 130 });
  assert.deepEqual(big.apply, {}, '差 30% 不许静默覆盖标称值');
  assert.equal(big.review.length, 1);
  assert.equal(big.review[0].field, 'distanceKm');
  assert.equal(big.review[0].planned, 100);
  assert.equal(big.review[0].measured, 130);

  const noBase = mergeMeasured({}, { distanceKm: 109 });
  assert.equal(noBase.apply.distanceKm, 109);
  assert.equal(noBase.appliedReason.distanceKm, 'no-baseline', '填补空字段要说明是补,不是纠');
});

test('合并判定:实测为 null 的字段进 rejected,不产生任何写入', () => {
  const r = mergeMeasured({ climbM: 5500, maxAltM: 3830 }, { climbM: null, maxAltM: 3830 });
  assert.equal(r.rejected.length, 1);
  assert.equal(r.rejected[0].field, 'climbM');
  assert.deepEqual(Object.keys(r.apply), ['maxAltM'], 'maxAltM 与标称一致仍可按需写入');
  assert.equal(r.apply.maxAltM, 3830);
});

test('合并只碰这三个字段,标称值里的其它内容一律不动', () => {
  const r = mergeMeasured(
    { distanceKm: 100, climbM: 5000, maxAltM: 3800, days: 7, name: '乌孙古道' },
    { distanceKm: 101, climbM: 5010, maxAltM: 3810, extraField: '不该被读' });
  assert.deepEqual(Object.keys(r.apply).sort(), ['climbM', 'distanceKm', 'maxAltM']);
});

// ---------- 反方向:行程 → GPX ----------
// 为什么必须有:lib/gear.js 给多日线开的清单里写着「离线轨迹/GPS 轨迹:山区无手机信号」,
// 而应用此前只能导 Markdown——清单让带的东西,软件自己给不出来。

const gpxRegion = {
  loop: [
    { name: '北京', lng: 116.404, lat: 39.911 },
    { name: '斋堂', lng: 115.575, lat: 40.014 },
    { name: '涿鹿', lng: 115.219, lat: 40.369 },
    { name: '北京', lng: 116.404, lat: 39.911 },
  ],
};
const mkTrip = (legs, over = {}) => ({
  id: '20261014-jingxi',
  regionName: '京西太行',
  input: { days: 7, startDate: '2026-10-14', regionId: 'jingxi' },
  generatedAt: '2026-10-07T10:00:00.000Z',
  schedule: [{ date: '2026-10-15', type: 'drive', legs }],
  trail: { name: '香八拉(香山—八大处)', grade: 1, days: 1, start: { lng: 116.2, lat: 39.95 } },
  ...over,
});
const countTrkpt = (s) => (s.match(/<trkpt/g) || []).length;
const trkptsOf = (s) => (s.match(/<trkpt[^>]*\/>/g) || []);

test('tripToGpx:有高德 polyline 时逐点写出,并声明来源是真实路线', () => {
  const path = '116.404,39.911;116.0,39.95;115.575,40.014';
  const out = tripToGpx(mkTrip([{ from: '北京', to: '斋堂', km: 81, path }]), gpxRegion);
  assert.ok(out.startsWith('<?xml'), '必须是 XML 文档');
  assert.ok(out.includes('<gpx version="1.1"'), '带 GPX 1.1 声明');
  assert.equal(countTrkpt(out), 3, 'polyline 三个点就该有三个 trkpt');
  // 坐标轴必须对:polyline 是 "lng,lat",GPX 是 lat/lon 两个属性——写反了一格就跑到国外
  assert.ok(out.includes('lat="39.911" lon="116.404"'), `第一点应 lat=39.911/lon=116.404,实得:${trkptsOf(out)[0] || '无'}`);
  assert.match(out, /驾车轨迹来自高德真实路线/);
  assert.ok(out.trimEnd().endsWith('</gpx>'), '文档必须闭合');
});

test('tripToGpx:腾讯路线不能冒充高德;多线要把每条线的起点都写出来', () => {
  const path = '116.404,39.911;115.575,40.014';
  const a = { name: '甲线', grade: 2, days: 1, start: { lng: 116.2, lat: 39.95 } };
  const b = { name: '乙线', grade: 3, days: 2, start: { lng: 115.8, lat: 40.1 } };
  const out = tripToGpx(mkTrip([{ from: '北京', to: '斋堂', km: 81, path }], {
    routeProvider: 'tencent', trail: a, trails: [a, b],
  }), gpxRegion);
  assert.match(out, /腾讯真实路线/, '来源必须与 routeProvider 一致');
  assert.ok(!out.includes('驾车轨迹来自高德真实路线'), '腾讯路线不能写高德');
  assert.equal((out.match(/<wpt /g) || []).length, 2, '多线应写全部徒步起点');
  assert.ok(out.includes('徒步起点 甲线') && out.includes('徒步起点 乙线'), out.slice(0, 500));
  assert.equal(parseGpx(out).ok, true, '多线 GPX 也必须能被自家解析器读回');
});

test('tripToGpx:没 polyline 时用节点直线骨架,并把"不是真实路线"写进 metadata', () => {
  const out = tripToGpx(mkTrip([{ from: '北京', to: '斋堂', km: 81, path: '', estimated: true }],
    { distanceEstimated: true }), gpxRegion);
  assert.equal(countTrkpt(out), 2, '直线骨架只有起终点两个');
  // 曾经真实写过 `lon="${to.lat}"`(两个属性都取纬度),点数与结构都对、只有坐标是错的——
  // 所以这里必须逐值断言,只数点数会放过这类缺陷
  assert.ok(out.includes('lat="39.911" lon="116.404"'), 'from 端取 loop 节点的 lat/lng');
  assert.ok(out.includes('lat="40.014" lon="115.575"'), 'to 端不能把 lon 写成 lat');
  assert.match(out, /未配路线 Key,全部为节点直线骨架\(仅作方向参考,不能当路书用\)/);
  assert.match(out, /里程为直线×1\.3 估算/, '当天有估算里程就得在 trk 的 desc 里说');
});

test('tripToGpx:坏 polyline 点丢掉,不写进轨迹', () => {
  // 前两段坐标非法(文字/NaN),第三段纬度越界
  const out = tripToGpx(mkTrip([{ from: '北京', to: '斋堂', km: 81,
    path: 'abc,def;NaN,10;115.575,40.014;116,91' }]), gpxRegion);
  assert.equal(countTrkpt(out), 2, '只剩 1 个合法点 <2 → 整段退化为节点直线');
  assert.ok(!out.includes('NaN'), '输出里不允许出现 NaN 坐标');
});

test('tripToGpx:徒步段没有轨迹数据,只给起点路点并明说', () => {
  const out = tripToGpx(mkTrip([{ from: '北京', to: '斋堂', km: 81,
    path: '116.404,39.911;115.575,40.014' }]), gpxRegion);
  assert.equal((out.match(/<wpt /g) || []).length, 1, '只一个徒步起点路点');
  assert.match(out, /<name>徒步起点 香八拉\(香山—八大处\)<\/name>/);
  assert.match(out, /应用内无该段轨迹数据/, '不编一条"看起来像"的徒步轨迹');
});

test('tripToGpx:文本进 XML 前转义(线路名带 < & \' 也不能撑破文档)', () => {
  const trip = mkTrip([{ from: '北京', to: '斋堂', km: 81, path: '1,2;3,4' }]);
  trip.trail.name = 'A&B<C>D\'E';
  const out = tripToGpx(trip, gpxRegion);
  assert.match(out, /A&amp;B&lt;C&gt;D&apos;E/);
  assert.ok(!out.includes('<name>A&B'), '原文不允许裸进标签');
});

test('tripToGpx:节点定不了位就整段不写,但文档仍然合法', () => {
  const out = tripToGpx(mkTrip([{ from: '不存在的镇', to: '也没这个村', km: 50, path: '' }]), gpxRegion);
  assert.equal(countTrkpt(out), 0, '两端坐标都不知道 → 宁可不画');
  assert.ok(out.includes('</gpx>'), '仍是闭合文档,不能抛错也不能产出半个 XML');
  assert.match(out, /<wpt /, '至少还有徒步起点路点可用');
});

test('tripToGpx 的输出能被自家 parseGpx 回读(导出方向与解析方向互认)', () => {
  const path = '116.404,39.911;116.0,39.95;115.575,40.014;115.219,40.369';
  const out = tripToGpx(mkTrip([{ from: '北京', to: '涿鹿', km: 100, path }]), gpxRegion);
  const back = parseGpx(out);
  assert.equal(back.ok, true, back.error);
  assert.equal(back.points, 4, '导出几个点,解析就该读回几个');
  // 这条是"量级"防线:4 个点沿京西一路向西,真实约 120km。
  // 一旦坐标轴写反(曾真的发生过:lon 被写成 lat),回读距离会跳到几万 km 量级——
  // 只断言 points/distance>0 是抓不住的,必须钉住量级。
  assert.ok(back.distanceKm > 80 && back.distanceKm < 160,
    `回读距离应落在 80~160km 量级,实得 ${back.distanceKm}km(坐标轴写反会得到几千 km)`);
});

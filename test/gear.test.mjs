import { createRequire } from 'module';
const require = createRequire(new URL('../package.json', import.meta.url));
const { gearChecklist, summitTemp } = require('./lib/gear.js');
const test = require('node:test');
const assert = require('node:assert');

// 典型重装长线:贡嘎一圈的画像
const heavyTrail = {
  name: '测试重装线', days: 7, type: '长线重装', maxAltM: 4500, techLevel: 1,
  summary: '绕雪山一周,垭口碎石', risks: ['垭口天气多变'], supplies: '无补给,需马帮',
};

test('summitTemp:按 6.5℃/km 递减折算,低差与缺参不折', () => {
  // 4500 - 3200 = 1300m → 降 8.45 → 镇上 8℃ → 山顶 -0(四舍五入)
  assert.equal(summitTemp(8, 3200, 4500), -0);
  assert.equal(summitTemp(2, 3200, 4500), -6);
  // 最高海拔不比预报点高,无需折算
  assert.equal(summitTemp(8, 4500, 3200), null);
  assert.equal(summitTemp(null, 3200, 4500), null);
});

test('gearChecklist:重装长线推出全套,每条带可解释原因', () => {
  const items = gearChecklist(heavyTrail, { summitMin: -6, maxHikePrecip: 70 });
  const names = items.map((i) => i.item).join('|');
  // 打底盘
  assert.ok(names.includes('身份证'));
  assert.ok(names.includes('头灯'));
  assert.ok(names.includes('离线轨迹'));
  // 重装(类型+无补给)/技术地形/海拔/天气全部命中
  assert.ok(names.includes('帐篷/睡袋/炉灶全套重装'));
  assert.ok(names.includes('登山杖与护膝'));
  assert.ok(names.includes('高反预防'));
  assert.ok(names.includes('防晒霜与墨镜'));
  assert.ok(names.includes('雨具与防水袋'));
  assert.ok(names.includes('保暖层'));
  // 每条都有原因,原因里引用真实数字
  for (const i of items) {
    assert.ok(i.reason && i.reason.length > 2, `${i.item} 缺原因`);
  }
  const alt = items.find((i) => i.item.includes('高反'));
  assert.ok(alt.reason.includes('4500'));
});

test('gearChecklist:轻装休闲短线只出打底,不灌水', () => {
  const easy = { name: '景区栈道', days: 1, type: '景区步道', maxAltM: 800, techLevel: 0 };
  const items = gearChecklist(easy, {});
  const names = items.map((i) => i.item);
  assert.equal(items.length, 1);
  assert.ok(names[0].includes('身份证'));
});

test('gearChecklist:严寒触发四件套,涉水触发防水,没有天气依据不推', () => {
  const icy = gearChecklist(heavyTrail, { summitMin: -15, maxHikePrecip: null });
  assert.ok(icy.some((i) => i.item.includes('冰爪')));
  const wet = gearChecklist({ ...heavyTrail, summary: '全程多次涉水横渡' }, {});
  assert.ok(wet.some((i) => i.item.includes('防水袋与备用鞋袜')));
  // 没有天气上下文,天气相关条目一律不出现
  const noWx = gearChecklist(heavyTrail, {});
  assert.ok(!noWx.some((i) => /雨具|保暖|冰爪/.test(i.item)));
});

test('gearChecklist:空输入返回空数组', () => {
  assert.deepEqual(gearChecklist(null, {}), []);
});

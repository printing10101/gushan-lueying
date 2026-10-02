import { createRequire } from 'module';
const require = createRequire(new URL('../package.json', import.meta.url));
const { planDays, pickTrail, addDays } = require('./lib/planner.js');
const test = require('node:test');
const assert = require('node:assert');

const loop = [
  { name: '成都' }, { name: '映秀' }, { name: '四姑娘山镇' }, { name: '丹巴' }, { name: '成都' },
];
const legs = [
  { from: '成都', to: '映秀', km: 100 },
  { from: '映秀', to: '四姑娘山镇', km: 150 },
  { from: '四姑娘山镇', to: '丹巴', km: 110 },
  { from: '丹巴', to: '成都', km: 340 },
];

test('planDays:环线 + 2 日徒步插在徒步节点', () => {
  const trail = { name: '党岭', node: '丹巴', days: 2 };
  const days = planDays(loop, legs, trail, 4, 400);
  assert.deepEqual(days.filter((d) => d.type === 'hike').length, 2);
  // 徒步日之前的驾车日应恰好结束在丹巴
  const firstDrive = days[0];
  assert.equal(firstDrive.type, 'drive');
  assert.deepEqual(firstDrive.nodes, ['成都', '映秀', '四姑娘山镇', '丹巴']);
  assert.equal(firstDrive.km, 360);
  // 徒步后继续走完闭环
  const after = days.slice(3);
  assert.equal(after[0].type, 'drive');
  assert.deepEqual(after[0].nodes, ['丹巴', '成都']);
  assert.equal(after[0].km, 340);
});

test('planDays:超过单日上限时切分并打 overKm 标记', () => {
  const days = planDays(loop, legs, null, 5, 300);
  // 100+150=250 继续累积;+110=360>300 → 该日 overKm 并在下一段后切分
  const flagged = days.filter((d) => d.overKm);
  assert.ok(flagged.length >= 1);
  const totalKm = days.filter((d) => d.type === 'drive').reduce((s, d) => s + d.km, 0);
  assert.equal(totalKm, 700); // 全程守恒
});

test('planDays:天数不足时给出提示日', () => {
  const days = planDays(loop, legs, null, 1, 200);
  const notes = days.filter((d) => d.type === 'note');
  assert.equal(notes.length, 1);
  assert.ok(notes[0].text.includes('超出'));
});

test('pickTrail:自动选放得下的最短线路', () => {
  const trails = {
    a: { regionId: 'cx', days: 2, name: '两天线' },
    b: { regionId: 'cx', days: 1, name: '一天线' },
    c: { regionId: 'other', days: 1, name: '别区域' },
  };
  assert.equal(pickTrail(trails, 'cx', null, 7).id, 'b');
  assert.equal(pickTrail(trails, 'cx', null, 4).id, 'b');
  assert.equal(pickTrail(trails, 'cx', 'a', 7).id, 'a');
  assert.throws(() => pickTrail(trails, 'cx', 'c', 7));
});

test('addDays:跨月', () => {
  assert.equal(addDays('2026-10-30', 3), '2026-11-02');
});

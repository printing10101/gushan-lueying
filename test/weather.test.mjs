import { createRequire } from 'module';
const require = createRequire(new URL('../package.json', import.meta.url));
const { hikeVerdict } = require('./lib/weather.js');
const test = require('node:test');
const assert = require('node:assert');

test('hikeVerdict:晴天舒适', () => {
  assert.equal(hikeVerdict(10, 22, 8, 15), '宜');
});

test('hikeVerdict:降雨概率高判不宜', () => {
  assert.equal(hikeVerdict(80, 22, 8, 15), '不宜');
});

test('hikeVerdict:边界条件判观察', () => {
  assert.equal(hikeVerdict(50, 22, 8, 15), '观察');
  assert.equal(hikeVerdict(10, 32, 8, 15), '观察');
});

test('hikeVerdict:高温/严寒/大风判不宜', () => {
  assert.equal(hikeVerdict(10, 36, 8, 15), '不宜');
  assert.equal(hikeVerdict(10, 22, -12, 15), '不宜');
  assert.equal(hikeVerdict(10, 22, 8, 65), '不宜');
});

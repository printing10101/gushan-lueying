import { createRequire } from 'module';
const require = createRequire(new URL('../package.json', import.meta.url));
const amap = require('./lib/amap.js');
const test = require('node:test');
const assert = require('node:assert');

const fuel = { consumptionLPer100km: 8, pricePerL: 8.2 };

test('calcCosts:油费 = 里程×油耗×油价,过路费缺失时按里程估', () => {
  const c = amap.calcCosts(300, null, fuel);
  assert.equal(c.fuel, 197); // 300/100 × 8L × 8.2 = 196.8
  assert.equal(c.tolls, 135); // 300 × 0.45
  assert.equal(c.tollsEstimated, true);
  assert.equal(c.driveTotal, 332);
});

test('calcCosts:优先用高德返回的过路费', () => {
  const c = amap.calcCosts(300, 120.4, fuel);
  assert.equal(c.tolls, 120);
  assert.equal(c.tollsEstimated, false);
  assert.equal(c.driveTotal, 317);
});

// data/seasonality.json 的形状与诚实性检查。
//
// 为什么要单独一个测试文件:这份表里的数字全是"估的"(季节系数)与"抄的"(节假日安排),
// 两类错误都不报错、只会安静地把预算算歪。所以这里既管结构(键名、区间、月份范围),
// 也管来源(每条节假日必须写 source,没二次核对的必须自己承认)。
//
// 与设计稿第 7 节一致;违规一律当场红,不做"下游会兜住"的假设。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'module';
const require = createRequire(new URL('../package.json', import.meta.url));
const test = require('node:test');
const assert = require('node:assert');

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const seasonality = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'seasonality.json'), 'utf8'));
const regions = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'regions.json'), 'utf8'));

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isFactor = (v) => Number.isFinite(v) && v > 0.5 && v <= 2.5;

test('regions 键必须是 regions.json 里真实存在的区域(写错了永远不会命中,也不报错)', () => {
  const bad = Object.keys(seasonality.regions || {})
    .filter((k) => !k.startsWith('_') && !regions[k]);
  assert.deepEqual(bad, [], `不存在的 regionId: ${bad.join(', ')}`);
});

test('节假日区间:from<=to、日期格式合法、label 不重复', () => {
  const labels = new Set();
  for (const h of seasonality.holidays || []) {
    assert.match(String(h.from), DATE_RE, `${h.label} from 不是 ISO 日期`);
    assert.match(String(h.to), DATE_RE, `${h.label} to 不是 ISO 日期`);
    assert.ok(h.from <= h.to, `${h.label}: from(${h.from}) 晚于 to(${h.to})`);
    assert.ok(!labels.has(h.label), `label 重复:${h.label}`);
    labels.add(h.label);
    assert.ok(isFactor(h.lodging), `${h.label} 住宿系数缺失或离谱:${h.lodging}`);
    if (h.food !== undefined) assert.ok(isFactor(h.food), `${h.label} 餐饮系数离谱:${h.food}`);
  }
});

test('每条节假日都必须注明来源;没二次核对的要自己写明白', () => {
  const noSource = (seasonality.holidays || []).filter((h) => typeof h.source !== 'string' || !h.source.trim());
  assert.deepEqual(noSource.map((h) => h.label), [], '缺 source 的条目:' + noSource.map((h) => h.label).join(','));
  // 本项目实测:中秋/国庆引到了国办通知原文,元旦/春节/劳动节只到设计稿或口径不一致
  const 未核 = (seasonality.holidays || []).filter((h) => /未二次核对|待核/.test(h.source));
  assert.ok(未核.length > 0, '一条都没标"待核"反而可疑——抓取失败是事实,要留在数据里');
});

test('月份键只能是 1-12,下划线键是注释(读错会凭空多一个旺季)', () => {
  for (const map of [seasonality.months, ...Object.values(seasonality.regions || {}).map((r) => r.months || {})]) {
    for (const k of Object.keys(map)) {
      if (k.startsWith('_')) continue;
      const m = Number(k);
      assert.ok(Number.isInteger(m) && m >= 1 && m <= 12, `非法月份键:${k}`);
      assert.ok(isFactor(map[k]), `月份 ${k} 系数离谱:${map[k]}`);
    }
  }
});

test('区域旺季块必须有 label(系数要能报出"用了哪一路",没 label 就是一串无源数字)', () => {
  for (const [id, r] of Object.entries(seasonality.regions || {})) {
    if (id.startsWith('_')) continue;
    assert.ok(typeof r.label === 'string' && r.label.trim(), `${id} 缺 label`);
    assert.ok(r.months && Object.keys(r.months).length, `${id} 没有任何月份系数,该删掉而不是留空壳`);
  }
});

test('全国性月份系数只给淡季(<1)与暑期(>1),不给"哪个月都贵"的表', () => {
  const vals = Object.entries(seasonality.months).filter(([k]) => !k.startsWith('_')).map(([, v]) => v);
  assert.ok(vals.every((v) => isFactor(v)));
  const over = vals.filter((v) => v > 1);
  assert.ok(over.length <= 3, `全国旺季月份不该铺得太开(${over.length} 个)`);
});

// regions.json 手工维护,节点行是内联风格(JSON.stringify 会重排成多行,污染 diff)。
// 任何脚本化改写 regions.json 后跑一遍本脚本,恢复项目原格式并校验合法性。
import { createRequire } from 'module';
import fs from 'fs';
const require = createRequire(new URL('../package.json', import.meta.url));
const file = new URL('../data/regions.json', import.meta.url);
const rawText = fs.readFileSync(file, 'utf8');
const d = JSON.parse(rawText);

// JSON.parse 会吃掉数字字面量格式(如 30.030 的尾零):先从原文本摘出「节点名+原始字面量」,
// 输出时数值相同就回填原文,保证脚本幂等、diff 不出数字噪音
const rawNums = [...rawText.matchAll(/"name": "([^"]+)", "lng": (-?[\d.]+), "lat": (-?[\d.]+)/g)]
  .map((m) => ({ name: m[1], lng: m[2], lat: m[3], used: false }));
function rawLiteral(node) {
  const hit = rawNums.find((r) => !r.used && r.name === node.name
    && Number(r.lng) === node.lng && Number(r.lat) === node.lat);
  if (!hit) return null;
  hit.used = true;
  return { lng: hit.lng, lat: hit.lat };
}

const out = ['{'];
const ids = Object.keys(d);
ids.forEach((id, ri) => {
  const r = d[id];
  out.push(`  ${JSON.stringify(id)}: {`);
  for (const key of ['name', 'province']) {
    if (r[key] != null) out.push(`    ${JSON.stringify(key)}: ${JSON.stringify(r[key])},`);
  }
  out.push('    "hub": {');
  for (const key of ['city', 'railStation', 'airport', 'flightCity']) {
    if (r.hub[key] != null) {
      out.push(`      ${JSON.stringify(key)}: ${JSON.stringify(r.hub[key])}${key === 'flightCity' || !r.hub.airport ? '' : ','}`);
    }
  }
  out.push('    },');
  out.push('    "loop": [');
  r.loop.forEach((n, i) => {
    const raw = rawLiteral(n);
    const item = raw
      ? `{ "name": ${JSON.stringify(n.name)}, "lng": ${raw.lng}, "lat": ${raw.lat} }`
      : '{ ' + ['name', 'lng', 'lat'].map((k) => `${JSON.stringify(k)}: ${JSON.stringify(n[k])}`).join(', ') + ' }';
    out.push(`      ${item}${i < r.loop.length - 1 ? ',' : ''}`);
  });
  const hasStay = r.stay != null;
  out.push(`    ]${hasStay || r.bestSeason != null || r.notes != null ? ',' : ''}`);
  if (hasStay) {
    out.push('    "stay": {');
    const stayKeys = Object.keys(r.stay);
    stayKeys.forEach((k, i) => {
      out.push(`      ${JSON.stringify(k)}: ${JSON.stringify(r.stay[k])}${i < stayKeys.length - 1 ? ',' : ''}`);
    });
    out.push(`    }${r.bestSeason != null || r.notes != null ? ',' : ''}`);
  }
  if (r.bestSeason != null) {
    out.push(`    "bestSeason": ${JSON.stringify(r.bestSeason)}${r.notes != null ? ',' : ''}`);
  }
  if (r.notes != null) {
    out.push('    "notes": [');
    r.notes.forEach((n, i) => out.push(`      ${JSON.stringify(n)}${i < r.notes.length - 1 ? ',' : ''}`));
    out.push('    ]');
  }
  out.push(`  }${ri < ids.length - 1 ? ',' : ''}`);
});
out.push('}');
const text = out.join('\n') + '\n';
JSON.parse(text); // 写前校验,坏了响亮失败
fs.writeFileSync(file, text);
console.log(`regions.json 已按项目格式重排(${ids.length} 个区域)`);

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

// name 允许 "regions" 或 "trips/2026-10-02-xxx" 形式,拒绝路径穿越
function resolvePath(name) {
  if (!/^[A-Za-z0-9_-]+(\/[A-Za-z0-9_.-]+)*$/.test(name)) {
    throw new Error(`非法的数据名: ${name}`);
  }
  return path.join(DATA_DIR, `${name}.json`);
}

function read(name) {
  const file = resolvePath(name);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function write(name, content) {
  const file = resolvePath(name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(content, null, 2), 'utf8');
  return { ok: true, file };
}

// 首次运行时把 example 配置落成真实配置,避免应用因缺配置起不来
function ensureConfig() {
  const file = path.join(DATA_DIR, 'config.json');
  if (!fs.existsSync(file)) {
    const example = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'config.example.json'), 'utf8'));
    fs.writeFileSync(file, JSON.stringify(example, null, 2), 'utf8');
  }
}

module.exports = { read, write, ensureConfig, resolvePath, DATA_DIR };

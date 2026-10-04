const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

// name 允许 "regions" 或 "trips/2026-10-02-xxx" 形式,拒绝路径穿越
function resolvePath(name) {
  if (!/^[A-Za-z0-9_-]+(\/[A-Za-z0-9_.-]+)*$/.test(name)
    // 字符集合法还不够:"." / ".." 段能穿透 data/,必须显式拒绝
    || name.split('/').some((s) => s === '.' || s === '..')) {
    throw new Error(`非法的数据名: ${name}`);
  }
  return path.join(DATA_DIR, `${name}.json`);
}

function read(name) {
  const file = resolvePath(name);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    // 损坏文件改名留档而不是原地反复炸:调用方拿到 null 走空态/自举,原始内容不丢
    try { fs.renameSync(file, `${file}.broken`); } catch { /* 改不动也别挡返回 */ }
    console.error(`数据文件损坏: ${file} (${e.message}),已改名留档`);
    return null;
  }
}

function write(name, content) {
  const file = resolvePath(name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(content, null, 2), 'utf8');
  return { ok: true, file };
}

// 列出 data/<subdir>/ 下的数据名(去 .json 扩展名),供行程档案列表用
function listDir(subdir) {
  const dir = path.join(DATA_DIR, subdir);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -'.json'.length));
}

function remove(name) {
  const file = resolvePath(name);
  if (!fs.existsSync(file)) return { ok: false, file };
  fs.unlinkSync(file);
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

module.exports = { read, write, remove, listDir, ensureConfig, resolvePath, DATA_DIR };

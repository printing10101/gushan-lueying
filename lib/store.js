const fs = require('fs');
const path = require('path');

// 数据目录:开发时是仓库里的 data/(保持既有工作流:直接编辑 JSON);
// **打包(portable)运行时**,exe 每次都被解到临时目录再运行,那里的 data/ 是只读的种子快照——
// 用户填的 Key、生成的行程、走过的标记全会在退出时随临时目录消失。所以打包时改用一个持久目录,
// 由 electron/main.js 通过 GUSHAN_DATA_DIR 注入(PORTABLE_EXECUTABLE_DIR 是打包器给的环境变量)。
// 这里只认环境变量,不 require electron:本模块同时被单测与普通 node 脚本加载。
const BUNDLED_DATA_DIR = path.join(__dirname, '..', 'data');
const DATA_DIR = process.env.GUSHAN_DATA_DIR
  ? path.resolve(process.env.GUSHAN_DATA_DIR)
  : BUNDLED_DATA_DIR;

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
  // 结尾补一个换行:data/trails.json 与 data/regions.json 都是行尾带 \n 的,
  // 应用内重写(如「导入 GPX」)若丢掉它,会在 git 上留一条与数据无关的单行 diff。
  const text = `${JSON.stringify(content, null, 2)}\n`;
  // 原子写:先写同目录临时文件,成功后再 rename 覆盖。
  // 直接 writeFileSync 遇到崩溃/磁盘满会把旧存档截断,而 store.read 只能把它改名留档。
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 临时文件清不掉也别掩盖原错误 */ }
    throw e;
  }
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

// 存档是否已存在(行程 id 去重用)
function has(name) {
  return fs.existsSync(resolvePath(name));
}

// 打包首次运行:持久数据目录是空的,把"随包带的种子文件"复制过去,数据目录才有 regions/trails/...。
// config/marks/trips 不在随包种子文件的默认分发范围内(build.files 排除);
// 若调用方/自定义包确实把 USER_FILES 放进来了,也只补缺、绝不覆盖已有文件。
// 所以重复调用是安全的。
const SEED_FILES = ['regions.json', 'trails.json', 'seasonality.json', 'config.example.json'];
const USER_FILES = ['config.json', 'marks.json'];

// targetDir 可注入(默认用 DATA_DIR):单测据此直接验真实实现,而不是在测试里重写一遍规则
function bootstrapDataDir(targetDir = DATA_DIR) {
  if (targetDir === BUNDLED_DATA_DIR) return { copied: [] }; // 开发环境:本来就是同一份
  fs.mkdirSync(targetDir, { recursive: true });
  const copied = [];
  const copyIfMissing = (name) => {
    const dst = path.join(targetDir, name);
    const src = path.join(BUNDLED_DATA_DIR, name);
    if (fs.existsSync(dst) || !fs.existsSync(src)) return;
    fs.copyFileSync(src, dst);
    copied.push(name);
  };
  for (const f of [...SEED_FILES, ...USER_FILES]) copyIfMissing(f);
  // 足迹(trips/)整目录搬过来,行程档案才在打包版里可见
  const tripsSrc = path.join(BUNDLED_DATA_DIR, 'trips');
  const tripsDst = path.join(targetDir, 'trips');
  if (fs.existsSync(tripsSrc) && !fs.existsSync(tripsDst)) {
    fs.mkdirSync(tripsDst, { recursive: true });
    for (const f of fs.readdirSync(tripsSrc)) {
      const from = path.join(tripsSrc, f);
      if (!fs.statSync(from).isFile()) continue;
      fs.copyFileSync(from, path.join(tripsDst, f));
    }
    copied.push('trips/');
  }
  return { copied };
}

// 首次运行时把 example 配置落成真实配置,避免应用因缺配置起不来。
// 注意:只在文件不存在时拷。之后 example 新增的键**不会**自动补进已有 config——
// 所以配套 configGaps() 把缺口报出来(见下),但不代改用户配置。
function ensureConfig() {
  const file = path.join(DATA_DIR, 'config.json');
  if (!fs.existsSync(file)) {
    const example = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'config.example.json'), 'utf8'));
    fs.writeFileSync(file, `${JSON.stringify(example, null, 2)}\n`, 'utf8');
  }
}

// 缺键分档:
// blocking = 代码里没有默认值,缺了那个功能**一点就报错**(实测过机票跳转就是这种);
// defaulted = 代码里有兜底值,缺了不报错,只是不能按你的口径调(住宿/餐标/油种/RunOS 地址)。
const GAP_SEVERITY = {
  flightCityPinyin: 'blocking',
  lodging: 'defaulted',
  food: 'defaulted',
  runos: 'defaulted',
  'fuel.gasType': 'defaulted',
};

// 把 {a:{b:1}} 摊成 ['a','a.b'];以 _ 开头的说明键不计
function leafPaths(obj, prefix = '', out = []) {
  for (const [k, v] of Object.entries(obj || {})) {
    if (k.startsWith('_')) continue;
    const p = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      out.push(p); // 分组本身也算一项(整块缺了就报一块,别只报叶子)
      leafPaths(v, p, out);
    } else out.push(p);
  }
  return out;
}

function hasPath(obj, dotted) {
  let cur = obj;
  for (const seg of dotted.split('.')) {
    if (!cur || typeof cur !== 'object' || !(seg in cur)) return false;
    cur = cur[seg];
  }
  return true;
}

// 纯函数:example 有、config 没有的键。单测直接喂对象,不碰文件系统。
// 整块缺失只报父键一次(`runos` 缺了就不重复报 `runos.baseUrl`),免得清单里全是同一件事。
function diffConfig(example, cfg) {
  const missing = [];
  for (const p of leafPaths(example)) {
    if (hasPath(cfg, p)) continue;
    if (missing.some((m) => p.startsWith(`${m.path}.`))) continue;
    missing.push({ path: p, severity: GAP_SEVERITY[p] || 'defaulted' });
  }
  return missing;
}

// 读盘版:给主进程在返回 config 时附带缺口,界面据此提示。
// example 读不到(被删/损坏)就当没缺口,不拿一个猜的清单去吓用户。
function configGaps() {
  const cfg = read('config');
  if (!cfg) return [];
  const examplePath = path.join(DATA_DIR, 'config.example.json');
  if (!fs.existsSync(examplePath)) return [];
  let example;
  try { example = JSON.parse(fs.readFileSync(examplePath, 'utf8')); } catch { return []; }
  return diffConfig(example, cfg);
}

module.exports = {
  read, write, remove, has, listDir, ensureConfig, bootstrapDataDir, resolvePath,
  DATA_DIR, BUNDLED_DATA_DIR, SEED_FILES, diffConfig, configGaps, leafPaths, GAP_SEVERITY,
};

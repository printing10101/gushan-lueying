// 本地静态服务的路径守卫(纯函数,可单测;main.js 的 http 服务用它)。
//
// 为什么单独一个模块:这条防线**没法从渲染层测**——浏览器会把 `/../x` 与 `/%2e%2e/x` 在发请求前
// 就规范化掉(WHATWG URL 把 `.%2e`/`%2e%2e` 都当双点段),所以页面里怎么 fetch 都绕不到它。
// 真正会撞上它的是手写的原始 HTTP 请求(同机任何进程)。抽成纯函数后就能在普通单测里钉住。
//
// 语义:给出仓库根与请求路径,返回可读的绝对文件路径;任何越界/异常输入返回 null。
const path = require('path');

function resolveStaticPath(root, urlPath) {
  if (typeof root !== 'string' || !root) return null;
  // 只接受字符串;先按 URL 语义去掉查询串与解码
  let rel = String(urlPath == null ? '/' : urlPath).split('?')[0];
  try {
    rel = decodeURIComponent(rel);
  } catch {
    return null; // 非法百分号编码
  }
  if (rel.includes('\0')) return null; // 空字节截断
  // 反斜杠在 Windows 上也是分隔符,统一成正斜杠后再拆段
  rel = rel.replace(/\\/g, '/');
  const segs = [];
  for (const seg of rel.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      // 双点段:能弹出就打平一个,弹不出来(已在根上)就直接判非法
      if (!segs.length) return null;
      segs.pop();
      continue;
    }
    segs.push(seg);
  }
  // 盘符/绝对路径混进来(如 C:/Windows/win.ini)在 Windows 上会被 path.join 视作绝对路径,
  // 必须自己先挡:段里带冒号一律拒
  if (segs.some((s) => s.includes(':'))) return null;
  const file = path.join(root, ...segs);
  const rootAbs = path.resolve(root);
  const fileAbs = path.resolve(file);
  if (fileAbs !== rootAbs && !fileAbs.startsWith(rootAbs + path.sep)) return null;
  return fileAbs;
}

module.exports = { resolveStaticPath };

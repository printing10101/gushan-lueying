// 生成桌面快捷方式 孤山掠影.lnk —— 走 shell 自己的 IShellLink(WScript.Shell COM)
//
// 为什么不再手工拼二进制:
//   早期版本按 MS-SHLLINK 规范"直接拼 392 字节 .lnk"。那个文件其实是坏的——
//   ShellLinkHeader 里少了 LinkCLSID(16 字节),LinkFlags 被写在 CLSID 的位置,
//   其后所有字段整体错位;LinkTargetIDList 也没有 ItemID 的长度前缀,LinkInfo 的
//   字段顺序同样不对。后果是资源管理器认不出它,桌面图标退化成一张白纸
//   (实测 SHGetFileInfo 取到的就是通用空白图标:白 549 / 透明 355 / 彩 120 像素),
//   且 WScript.Shell 与 Shell.Application 都读不出 TargetPath。
//
// 关键结论:
//   一个能被系统解析的 .lnk 必须带完整的 LinkTargetIDList(逐级 shell item 序列化,
//   含 GUID / 时间戳 / 文件大小 / 0xBE-EF 扩展名块),手工可靠复现不现实。
//   只有让 shell 自己写才能保证正确,所以本脚本委托 scripts/make-shortcut.ps1。
//   (该 .ps1 必须带 UTF-8 BOM:否则 PowerShell 5.1 会把其中文路径按 ANSI 读坏。)
//
// 与旧版的行为差异:
//   旧版在任何环境都会写文件,COM 被拦时只是产出一个打不开的 .lnk;
//   本版在 COM 不可用时明确报错退出,不会留下坏文件。
//   若报 COM 被拦截,请在有权限的普通桌面会话里再跑一次 `npm run shortcut`。
import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PS1 = join(HERE, 'make-shortcut.ps1');

// 与 make-shortcut.ps1 中的常量保持一致,用于预检(缺 dist 时先提醒,再谈图标)
const TARGET = 'E:\\孤山掠影\\dist\\Gushan-portable.exe';
const ICON = 'E:\\孤山掠影\\build\\icon.ico';

if (!existsSync(PS1)) {
  console.error('[fail] 找不到 ' + PS1);
  process.exit(1);
}
if (!existsSync(TARGET)) {
  console.warn('[warn] 目标不存在:' + TARGET + ' —— 先 npm run dist,再建快捷方式');
}
if (!existsSync(ICON)) {
  console.warn('[warn] 图标不存在:' + ICON);
}

const r = spawnSync('powershell.exe',
  ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS1],
  { stdio: 'inherit' });

if (r.error) {
  console.error('[fail] 无法调用 powershell:' + r.error.message);
  process.exit(1);
}
if (r.status !== 0) {
  console.error('[fail] 生成快捷方式失败(退出码 ' + r.status + ')。');
  console.error('       若提示 COM 被安全策略拦截,说明当前环境禁止实例化 WScript.Shell;');
  console.error('       请换到有权限的普通桌面会话重跑 npm run shortcut。');
  process.exit(r.status || 1);
}
console.log('shortcut ok —— 桌面 孤山掠影.lnk 已重建');

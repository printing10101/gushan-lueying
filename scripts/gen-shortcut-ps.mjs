// 生成带 UTF-8 BOM 的 make-shortcut.ps1(PowerShell 5.1 无 BOM 会把中文当 ANSI 读坏)
// 注意:模板字符串里 ${ 会插值,所以 PowerShell 变量 $x 写作 $ squiggle 无需双写;${x} 才要转义。
import { writeFileSync } from 'fs';
const lines = [
  '$ws = New-Object -ComObject WScript.Shell',
  "$desktop = [Environment]::GetFolderPath('Desktop')",
  '$lnk = $ws.CreateShortcut("$desktop\\孤山掠影.lnk")',
  "$lnk.TargetPath = 'E:\\孤山掠影\\dist\\Gushan-portable.exe'",
  "$lnk.WorkingDirectory = 'E:\\孤山掠影'",
  "$lnk.IconLocation = 'E:\\孤山掠影\\build\\icon.ico'",
  '$lnk.Save()',
  "Write-Output 'shortcut created'",
];
writeFileSync(new URL('./make-shortcut.ps1', import.meta.url), '\ufeff' + lines.join('\n') + '\n', 'utf8');
console.log('make-shortcut.ps1 written with BOM');

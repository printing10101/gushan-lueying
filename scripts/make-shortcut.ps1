$ws = New-Object -ComObject WScript.Shell
$desktop = [Environment]::GetFolderPath('Desktop')
$lnk = $ws.CreateShortcut("$desktop\孤山掠影.lnk")
$lnk.TargetPath = 'E:\孤山掠影\dist\Gushan-portable.exe'
$lnk.WorkingDirectory = 'E:\孤山掠影'
$lnk.IconLocation = 'E:\孤山掠影\build\icon.ico'
$lnk.Save()
Write-Output 'shortcut created'

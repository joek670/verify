# Creates a Windows Startup folder shortcut that launches dsh on login.
# Run once per user profile. No admin required.

$startupDir = [Environment]::GetFolderPath("Startup")
$shortcutPath = Join-Path $startupDir "dsh.lnk"

$wsh = New-Object -ComObject WScript.Shell
$sc = $wsh.CreateShortcut($shortcutPath)
$sc.TargetPath = "powershell.exe"
$sc.Arguments = '-WindowStyle Hidden -NonInteractive -Command "dsh web --no-open"'
$sc.WorkingDirectory = $env:USERPROFILE
$sc.WindowStyle = 7
$sc.Save()

Write-Host "Installed: $shortcutPath"
Write-Host "dsh will start automatically at next login on port 3080."

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

. (Join-Path $repo "llama-swap\windows\rotating-log.ps1")
Stop-ManagedPortOwner -Port 8190 -CommandPattern "node\.exe.*imagegen\\server\.js"

$node = "C:\Program Files\nodejs\node.exe"
$exitCode = Invoke-RotatingNativeCommand `
   -FilePath $node `
   -ArgumentList @(".\imagegen\server.js", "--port", "8190") `
   -LogPath (Join-Path $repo "llama-swap\logs\imagegen.log")
exit $exitCode

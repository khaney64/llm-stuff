$ErrorActionPreference = "Stop"

$taskPath = "\LocalAI\"
$powerShell = "C:\Program Files\PowerShell\7\pwsh.exe"
$repo = "C:\development\ai\llm-stuff"
$principal = New-ScheduledTaskPrincipal `
    -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) `
    -LogonType S4U `
    -RunLevel Highest
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit ([TimeSpan]::Zero)

$proxyAction = New-ScheduledTaskAction `
    -Execute $powerShell `
    -Argument '-NoProfile -ExecutionPolicy Bypass -File "C:\development\ai\llm-stuff\proxy.ps1"' `
    -WorkingDirectory $repo
$swapAction = New-ScheduledTaskAction `
    -Execute $powerShell `
    -Argument '-NoProfile -ExecutionPolicy Bypass -File "C:\development\ai\llm-stuff\llama-swap\windows\start-swap.ps1"' `
    -WorkingDirectory $repo

Register-ScheduledTask -TaskPath $taskPath -TaskName "LlamaProxy" `
    -Action $proxyAction -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Register-ScheduledTask -TaskPath $taskPath -TaskName "LlamaSwap" `
    -Action $swapAction -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null

Write-Host "Registered ${taskPath}LlamaProxy and ${taskPath}LlamaSwap."

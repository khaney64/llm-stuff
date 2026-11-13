# install-windows.ps1
# Registers sysmetrics.py as a Windows Scheduled Task (runs at startup, restarts on failure).
# Run in an elevated PowerShell prompt.

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$InstallDir = "C:\sysmetrics"
$Python = "C:\Python312\python.exe"

if (-not (Test-Path $Python)) {
    Write-Error "Python not found at $Python. Update the `$Python variable and re-run."
    exit 1
}

Write-Host "==> Installing sysmetrics to $InstallDir"
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Copy-Item "$ScriptDir\sysmetrics.py" "$InstallDir\" -Force

if (-not (Test-Path "$InstallDir\config.yaml")) {
    Copy-Item "$ScriptDir\config.yaml" "$InstallDir\" -Force
    Write-Host ""
    Write-Host "  --> Edit $InstallDir\config.yaml before starting:"
    Write-Host "      - Set mqtt.host to your broker address"
    Write-Host ""
}

Write-Host "==> Installing Python dependencies"
& $Python -m pip install -r "$ScriptDir\requirements.txt"

Write-Host "==> Registering Scheduled Task"

$Action = New-ScheduledTaskAction `
    -Execute $Python `
    -Argument "`"$InstallDir\sysmetrics.py`" --config `"$InstallDir\config.yaml`"" `
    -WorkingDirectory $InstallDir

$Trigger = New-ScheduledTaskTrigger -AtStartup

$Settings = New-ScheduledTaskSettingsSet `
    -RestartCount 99 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -StartWhenAvailable

$Principal = New-ScheduledTaskPrincipal `
    -UserId "SYSTEM" `
    -LogonType ServiceAccount `
    -RunLevel Highest

Register-ScheduledTask `
    -TaskName "SysMetrics" `
    -TaskPath "\LocalServices\" `
    -Action $Action `
    -Trigger $Trigger `
    -Settings $Settings `
    -Principal $Principal `
    -Description "System metrics collector — publishes to MQTT for InfluxDB/Grafana" `
    -Force | Out-Null

Write-Host ""
Write-Host "==> CPU temperature (optional)"
Write-Host "    Install LibreHardwareMonitor and enable its WMI service:"
Write-Host "    https://github.com/LibreHardwareMonitor/LibreHardwareMonitor"
Write-Host "    Once running, sysmetrics will automatically report cpu temp_c."
Write-Host ""
Write-Host "==> Done. Commands:"
Write-Host "    Start-ScheduledTask  -TaskPath '\LocalServices\' -TaskName 'SysMetrics'"
Write-Host "    Stop-ScheduledTask   -TaskPath '\LocalServices\' -TaskName 'SysMetrics'"
Write-Host "    Get-ScheduledTask    -TaskPath '\LocalServices\' -TaskName 'SysMetrics' | Get-ScheduledTaskInfo"
Write-Host ""
Write-Host "    Logs: check Event Viewer, Task Scheduler, Microsoft, Windows, TaskScheduler"

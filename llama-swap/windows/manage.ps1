param(
    [ValidateSet("start", "stop", "restart", "status")]
    [string]$Action = "status"
)

$ErrorActionPreference = "Stop"
$taskPath = "\LocalAI\"
$tasks = @("LlamaProxy", "LlamaSwap")
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $scriptRoot "rotating-log.ps1")

function Start-Stack {
    Start-ScheduledTask -TaskPath $taskPath -TaskName "LlamaProxy"
    Start-Sleep -Seconds 2
    Start-ScheduledTask -TaskPath $taskPath -TaskName "LlamaSwap"
}

function Stop-Stack {
    Stop-ScheduledTask -TaskPath $taskPath -TaskName "LlamaSwap" -ErrorAction SilentlyContinue
    Stop-ScheduledTask -TaskPath $taskPath -TaskName "LlamaProxy" -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
    Stop-ManagedPortOwner -Port 8080 -CommandPattern "llama-swap\.exe.*configs\\devbox\.yaml"
    Stop-ManagedPortOwner -Port 8082 -CommandPattern "llama-server\.exe.*--port 8082"
    Stop-ManagedPortOwner -Port 8081 -CommandPattern "node\.exe.*proxy\.js.*--proxy-port 8081"
}

switch ($Action) {
    "start" { Start-Stack }
    "stop" { Stop-Stack }
    "restart" {
        Stop-Stack
        Start-Sleep -Seconds 2
        Start-Stack
    }
    "status" {
        Get-ScheduledTask -TaskPath $taskPath |
            Where-Object TaskName -In $tasks |
            Select-Object TaskName, State
        Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
            Where-Object LocalPort -In 8080, 8081, 8082 |
            Select-Object LocalAddress, LocalPort, OwningProcess
        try {
            Invoke-RestMethod -Uri "http://127.0.0.1:8080/health" -TimeoutSec 5
        } catch {
            Write-Warning "llama-swap health check failed: $($_.Exception.Message)"
        }
    }
}

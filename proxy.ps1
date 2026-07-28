$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$logHelper = Join-Path $PSScriptRoot "llama-swap\windows\rotating-log.ps1"
. $logHelper
Stop-ManagedPortOwner -Port 8081 -CommandPattern "node\.exe.*proxy\.js.*--proxy-port 8081"

$influxEnv = Join-Path $PSScriptRoot "influxdb-env.ps1"
if (Test-Path -LiteralPath $influxEnv) {
   . $influxEnv
}

$node = (Get-Command node -ErrorAction Stop).Source
$proxyArgs = @(
   ".\proxy.js",
   "--proxy-host", "127.0.0.1",
   "--proxy-port", "8081",
   "--backend-port", "8082",
   "--buffer-thinking",
   "--dump-messages",
   "--message-size", "10000",
   "--default-ctx", "65535",
   "--model-config", ".\\proxy-models.json",
   "--log-mode", "influxdb",
   "--backend", "llamacpp",
   "--power",
   "--gpu-idle", "15",
   "--power-interval", "250",
   "--debug-labels",
   "--dump-request",
   "--cron-parse-patch"
)
$exitCode = Invoke-RotatingNativeCommand `
   -FilePath $node `
   -ArgumentList $proxyArgs `
   -LogPath (Join-Path $PSScriptRoot "llama-swap\logs\proxy.log")
exit $exitCode

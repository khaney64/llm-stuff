$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$influxEnv = Join-Path $PSScriptRoot "influxdb-env.ps1"
if (Test-Path -LiteralPath $influxEnv) {
   . $influxEnv
}

node .\proxy.js `
   --proxy-host 127.0.0.1 `
   --proxy-port 8081 `
   --backend-port 8082 `
   --buffer-thinking `
   --dump-messages `
   --message-size 10000 `
   --default-ctx 65535 `
   --thinking `
   --log-mode influxdb `
   --backend llamacpp `
   --power `
   --gpu-idle 15 `
   --power-interval 250 `
   --debug-labels `
   --dump-request `
   --cron-parse-patch

$ErrorActionPreference = "Stop"
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $scriptRoot "rotating-log.ps1")
Stop-ManagedPortOwner -Port 8080 -CommandPattern "llama-swap\.exe.*configs\\devbox\.yaml"
Stop-ManagedPortOwner -Port 8082 -CommandPattern "llama-server\.exe.*--port 8082"

$deadline = [DateTime]::UtcNow.AddSeconds(60)
do {
    try {
        $client = [System.Net.Sockets.TcpClient]::new()
        $client.Connect("127.0.0.1", 8081)
        $client.Dispose()
        break
    } catch {
        if ([DateTime]::UtcNow -ge $deadline) {
            throw "Proxy did not begin listening on 127.0.0.1:8081 within 60 seconds."
        }
        Start-Sleep -Seconds 2
    }
} while ($true)

$swapArgs = @(
    "--config", "C:\development\ai\llm-stuff\llama-swap\configs\devbox.yaml",
    "--listen", "0.0.0.0:8080"
)
$exitCode = Invoke-RotatingNativeCommand `
    -FilePath "C:\development\ai\llama-swap\llama-swap.exe" `
    -ArgumentList $swapArgs `
    -LogPath "C:\development\ai\llm-stuff\llama-swap\logs\llama-swap.log"
exit $exitCode

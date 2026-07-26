$ErrorActionPreference = "Stop"

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

& "C:\development\ai\llama-swap\llama-swap.exe" `
    --config "C:\development\ai\llm-stuff\llama-swap\configs\devbox.yaml" `
    --listen "0.0.0.0:8080"

exit $LASTEXITCODE

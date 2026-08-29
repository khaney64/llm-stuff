function Invoke-RotatingNativeCommand {
    param(
        [Parameter(Mandatory)]
        [string]$FilePath,
        [Parameter(Mandatory)]
        [string[]]$ArgumentList,
        [Parameter(Mandatory)]
        [string]$LogPath,
        [long]$MaxBytes = 50MB,
        [int]$KeepArchives = 5
    )

    $logDirectory = Split-Path -Parent $LogPath
    New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
    $encoding = [System.Text.UTF8Encoding]::new($false)

    function Open-LogWriter {
        $stream = [System.IO.FileStream]::new(
            $LogPath,
            [System.IO.FileMode]::Append,
            [System.IO.FileAccess]::Write,
            [System.IO.FileShare]::ReadWrite
        )
        $writer = [System.IO.StreamWriter]::new($stream, $encoding)
        $writer.AutoFlush = $true
        return $writer
    }

    function Rotate-Logs {
        for ($index = $KeepArchives - 1; $index -ge 1; $index--) {
            $source = "$LogPath.$index"
            $target = "$LogPath.$($index + 1)"
            if (Test-Path -LiteralPath $source) {
                Move-Item -LiteralPath $source -Destination $target -Force
            }
        }
        if (Test-Path -LiteralPath $LogPath) {
            Move-Item -LiteralPath $LogPath -Destination "$LogPath.1" -Force
        }
    }

    $writer = Open-LogWriter
    try {
        & $FilePath @ArgumentList 2>&1 | ForEach-Object {
            $line = "{0:o} {1}" -f [DateTimeOffset]::Now, $_.ToString()
            $lineBytes = $encoding.GetByteCount($line + [Environment]::NewLine)
            if (($writer.BaseStream.Length + $lineBytes) -gt $MaxBytes) {
                $writer.Dispose()
                Rotate-Logs
                $writer = Open-LogWriter
            }
            $writer.WriteLine($line)
        }
        $nativeExitCode = $LASTEXITCODE
    } finally {
        if ($writer) {
            $writer.Dispose()
        }
    }

    return $nativeExitCode
}

function Stop-ManagedPortOwner {
    param(
        [Parameter(Mandatory)]
        [int]$Port,
        [Parameter(Mandatory)]
        [string]$CommandPattern
    )

    $listeners = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
    foreach ($listener in $listeners) {
        $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)" `
            -ErrorAction SilentlyContinue
        if (-not $process) {
            continue
        }
        if ($process.CommandLine -notmatch $CommandPattern) {
            throw "Port $Port is owned by unexpected process $($process.ProcessId): $($process.CommandLine)"
        }

        & "$env:SystemRoot\System32\taskkill.exe" /PID $process.ProcessId /T /F | Out-Null
        $deadline = [DateTime]::UtcNow.AddSeconds(15)
        do {
            $remaining = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
            if (-not $remaining) {
                break
            }
            if ([DateTime]::UtcNow -ge $deadline) {
                throw "Managed process $($process.ProcessId) did not release port $Port."
            }
            Start-Sleep -Milliseconds 250
        } while ($true)
    }
}

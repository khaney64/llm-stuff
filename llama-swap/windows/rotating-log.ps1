function Invoke-RotatingNativeCommand {
    param(
        [Parameter(Mandatory)]
        [string]$FilePath,
        [Parameter(Mandatory)]
        [string[]]$ArgumentList,
        [Parameter(Mandatory)]
        [string]$LogPath,
        [long]$MaxBytes = 50MB,
        [int]$KeepArchives = 5,
        [int]$RotateRetryCount = 5,
        [int]$RotateCooldownSeconds = 60
    )

    $logDirectory = Split-Path -Parent $LogPath
    New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
    $encoding = [System.Text.UTF8Encoding]::new($false)

    function Open-LogWriter {
        # FileShare::Delete lets the file be renamed while this handle is open,
        # so a reader or a tail cannot block the next rotation.
        $share = [System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete
        $stream = [System.IO.FileStream]::new(
            $LogPath,
            [System.IO.FileMode]::Append,
            [System.IO.FileAccess]::Write,
            $share
        )
        $writer = [System.IO.StreamWriter]::new($stream, $encoding)
        $writer.AutoFlush = $true
        return $writer
    }

    function Move-LogFile {
        param(
            [Parameter(Mandatory)]
            [string]$Source,
            [Parameter(Mandatory)]
            [string]$Destination
        )

        for ($attempt = 1; $attempt -le $RotateRetryCount; $attempt++) {
            try {
                Move-Item -LiteralPath $Source -Destination $Destination -Force -ErrorAction Stop
                return $true
            } catch {
                if ($attempt -eq $RotateRetryCount) {
                    return $false
                }
                Start-Sleep -Milliseconds (200 * $attempt)
            }
        }
        return $false
    }

    function Rotate-Logs {
        # Shifts the archives, then archives the active log. Returns $true when
        # the active log was archived, $false when it has to be reused in place.
        # Never throws: a rotation failure must not terminate the pipeline, which
        # would take the piped child process down with it.
        for ($index = $KeepArchives - 1; $index -ge 1; $index--) {
            $source = "$LogPath.$index"
            $target = "$LogPath.$($index + 1)"
            if (Test-Path -LiteralPath $source) {
                Move-LogFile -Source $source -Destination $target | Out-Null
            }
        }
        if (Test-Path -LiteralPath $LogPath) {
            return (Move-LogFile -Source $LogPath -Destination "$LogPath.1")
        }
        return $true
    }

    $writer = Open-LogWriter
    $rotateBlockedUntil = [DateTime]::MinValue
    try {
        & $FilePath @ArgumentList 2>&1 | ForEach-Object {
            $line = "{0:o} {1}" -f [DateTimeOffset]::Now, $_.ToString()
            $lineBytes = $encoding.GetByteCount($line + [Environment]::NewLine)
            if (($writer.BaseStream.Length + $lineBytes) -gt $MaxBytes -and
                [DateTime]::UtcNow -ge $rotateBlockedUntil) {
                $writer.Dispose()
                $rotated = Rotate-Logs
                $writer = Open-LogWriter
                if ($rotated) {
                    if ($rotateBlockedUntil -ne [DateTime]::MinValue) {
                        $writer.WriteLine(("{0:o} [rotating-log] rotation recovered" -f [DateTimeOffset]::Now))
                        $rotateBlockedUntil = [DateTime]::MinValue
                    }
                } else {
                    # Could not archive the active log, almost always because another
                    # process holds an open handle on it. Keep writing past MaxBytes
                    # and retry later; an oversized log beats a dead child process.
                    $rotateBlockedUntil = [DateTime]::UtcNow.AddSeconds($RotateCooldownSeconds)
                    $writer.WriteLine((
                        "{0:o} [rotating-log] could not archive {1}; writing past {2} bytes, retrying in {3}s" -f
                        [DateTimeOffset]::Now, $LogPath, $MaxBytes, $RotateCooldownSeconds))
                }
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

<#
.SYNOPSIS
    Same-day A/B of Strata engines with tools/strata_bench.py, run forward then in reverse order.

.DESCRIPTION
    Method and results log: strata-bench.md (next to this script). Run in an elevated PowerShell.

    For each run it writes a copy of the bench config whose "exe" points at that engine's folder, so the
    installed engine is never swapped. Each engine (and variant) runs once in the given order, then once
    in reverse. A first warm-up run is discarded. Only differences that hold in both orders count.

.EXAMPLE
    # After an update: the new engine (terminal\engine) against the one it replaced (engine\.previous)
    .\strata-bench-ab.ps1

.EXAMPLE
    # Add an engine downloaded by hand, and a variant of the new engine with an environment switch
    .\strata-bench-ab.ps1 -Engines ([ordered]@{
            "0.1.62" = "C:\temp\eng-0.1.62"
            "0.1.64" = "C:\development\ai\Strata\terminal\engine\.previous"
            "0.1.65" = "C:\development\ai\Strata\terminal\engine" }) `
        -Variants @(@{ name = "0.1.65-vdh0"; engine = "0.1.65"; env = @{ STRATA_VERIFY_DEVICE_HITS = "0" } })
#>
param(
    # name -> engine folder (holding strata.exe, strata-vision.exe and BUILD.json). Default: the
    # installed engine and engine\.previous, named by their BUILD.json versions.
    [System.Collections.Specialized.OrderedDictionary]$Engines,
    # Extra runs of an engine with environment variables: @{ name; engine (a key of -Engines); env = @{} }
    [hashtable[]]$Variants = @(),
    [string]$Strata = "C:\development\ai\Strata",
    [string]$BaseConfig = "C:\development\ai\Strata\terminal\strata-iq3_s.json",
    [string]$OutDir = "C:\development\ai\llm-stuff\bench\results\strata-ab-$(Get-Date -Format yyyy-MM-dd)",
    # Minutes to wait after stopping the stack before the first run (see "Slow start" in strata-bench.md)
    [int]$SettleMinutes = 0,
    # Discarded runs of the first engine before the measured ones
    [int]$WarmupRuns = 1,
    # Leave llama-swap alone (it must already be stopped: the bench starts its own server on 8080)
    [switch]$NoStackControl
)

$ErrorActionPreference = "Stop"
$T      = "$Strata\terminal"
$Py     = "$T\.venv\Scripts\python.exe"
$Manage = Join-Path $PSScriptRoot "manage.ps1"
$env:PYTHONUTF8 = 1

if (-not $Engines) {
    $Engines = [ordered]@{}
    foreach ($dir in "$T\engine\.previous", "$T\engine") {
        $v = (Get-Content "$dir\BUILD.json" -Raw | ConvertFrom-Json).version
        $Engines[$v] = $dir
    }
}
foreach ($k in $Engines.Keys) {
    if (-not (Test-Path "$($Engines[$k])\strata.exe")) { throw "no strata.exe in $($Engines[$k]) ($k)" }
}

New-Item -ItemType Directory -Force "$OutDir\cfg", "$OutDir\runs" | Out-Null

# One config per engine, identical apart from the engine paths and the log file.
foreach ($k in $Engines.Keys) {
    $c = Get-Content $BaseConfig -Raw | ConvertFrom-Json
    $c.exe = "$($Engines[$k])\strata.exe"
    if ($c.vision) { $c.vision.exe = "$($Engines[$k])\strata-vision.exe" }
    $c.log = "$OutDir\cfg\engine-$k.log"
    $c | ConvertTo-Json -Depth 10 | Set-Content -Encoding utf8NoBOM "$OutDir\cfg\strata-$k.json"
}

$set = @($Engines.Keys | ForEach-Object { @{ name = $_; engine = $_; env = @{} } }) + $Variants
$plan = @()
for ($i = 0; $i -lt $WarmupRuns; $i++) { $plan += @{ run = $set[0]; label = "warmup$($i + 1)"; order = "warmup" } }
$plan += $set | ForEach-Object { @{ run = $_; label = "fwd-$($_.name)"; order = "forward" } }
[array]::Reverse($set)
$plan += $set | ForEach-Object { @{ run = $_; label = "rev-$($_.name)"; order = "reverse" } }

if (-not $NoStackControl) {
    try { & $Manage stop } catch { Write-Host "stop: $($_.Exception.Message); retrying"; & $Manage stop }
}
$busy = Get-NetTCPConnection -State Listen -LocalPort 8080 -ErrorAction SilentlyContinue |
    Where-Object LocalAddress -In "127.0.0.1", "0.0.0.0", "::1", "::"
if ($busy) { throw "port 8080 is in use (pid $($busy[0].OwningProcess)): stop llama-swap first" }
if ($SettleMinutes -gt 0) { Write-Host "settling $SettleMinutes min"; Start-Sleep -Seconds ($SettleMinutes * 60) }

$variantVars = @($Variants | ForEach-Object { $_.env.Keys } | Select-Object -Unique)
function Clear-VariantVars { foreach ($k in $variantVars) { Remove-Item "Env:$k" -ErrorAction SilentlyContinue } }

$meta = @()
try {
    foreach ($p in $plan) {
        $r = $p.run
        Clear-VariantVars
        foreach ($k in $r.env.Keys) { Set-Item "Env:$k" $r.env[$k] }
        $os = Get-CimInstance Win32_OperatingSystem
        $m = [ordered]@{
            label = $p.label; order = $p.order; engine = $r.engine
            env = (($r.env.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join " ")
            start = (Get-Date -Format "HH:mm:ss")
            free_ram_gib = [math]::Round($os.FreePhysicalMemory / 1MB, 1)
            free_commit_gib = [math]::Round($os.FreeVirtualMemory / 1MB, 1)
        }
        Write-Host ("=== {0} start {1} freeRAM={2}GiB freeCommit={3}GiB" -f $p.label, $m.start, $m.free_ram_gib, $m.free_commit_gib)
        Push-Location $T
        & $Py tools\strata_bench.py --config "$OutDir\cfg\strata-$($r.engine).json" --out "$OutDir\runs\$($p.label)" 2>&1 |
            Out-File -Encoding utf8 "$OutDir\runs\$($p.label).log"
        $m.exit = $LASTEXITCODE
        Pop-Location
        $m.end = (Get-Date -Format "HH:mm:ss")
        Write-Host "=== $($p.label) exit $($m.exit) $($m.end)"
        $meta += [pscustomobject]$m
    }
}
finally {
    Clear-VariantVars
    $meta | ConvertTo-Json -Depth 4 | Set-Content -Encoding utf8NoBOM "$OutDir\runs.json"
    if (-not $NoStackControl) { & $Manage start }
}

# Summary: the medians strata_bench prints, one column per run, in run order.
$keys = "chat decode tok/s", "chat first token (s)", "4K prompt tok/s", "4K first token (s)", "16K prompt tok/s",
        "16K first token (s)", "agent turn first token (s)", "agent decode tok/s"
$cols = foreach ($m in $meta) {
    $text = Get-Content "$OutDir\runs\$($m.label).log" -Raw
    $sec = ($text -split "Results \(median")[1]
    $vals = @{}
    foreach ($k in $keys) {
        $vals[$k] = if ($sec -and $sec -match ([regex]::Escape($k) + '\s+([\d.]+)\s+\(([\d.]+) - ([\d.]+)')) { "$($Matches[1]) ($($Matches[2])-$($Matches[3]))" } else { "-" }
    }
    @{ m = $m; v = $vals }
}
$header = "| Metric | " + (($cols | ForEach-Object { "$($_.m.label)" }) -join " | ") + " |"
$rule   = "| --- | " + (($cols | ForEach-Object { "---:" }) -join " | ") + " |"
$md = @("# Strata engine A/B $(Get-Date -Format yyyy-MM-dd)", "",
        "Config: ``$BaseConfig`` (engine paths swapped per run). Medians over 3 runs per test, range in brackets.", "",
        $header, $rule)
foreach ($k in $keys) { $md += "| $k | " + (($cols | ForEach-Object { $_.v[$k] }) -join " | ") + " |" }
$md += "| start / free RAM GiB / free commit GiB | " + (($cols | ForEach-Object { "$($_.m.start) / $($_.m.free_ram_gib) / $($_.m.free_commit_gib)" }) -join " | ") + " |"
$md += "", "Engines:", ""
foreach ($k in $Engines.Keys) { $md += "- ``$k``: ``$($Engines[$k])``" }
foreach ($v in $Variants) { $md += "- ``$($v.name)``: ``$($v.engine)`` with " + (($v.env.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join " ") }
$md | Set-Content -Encoding utf8NoBOM "$OutDir\summary.md"
Write-Host ""
$md | ForEach-Object { Write-Host $_ }
Write-Host "`nResults: $OutDir"

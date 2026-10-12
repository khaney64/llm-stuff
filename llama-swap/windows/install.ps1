param(
    [Parameter(Mandatory)]
    [string]$ArchivePath,
    [string]$InstallDirectory = "C:\development\ai\llama-swap"
)

$ErrorActionPreference = "Stop"
$expectedHash = "5D2ABD9ECDE7F42355CD17FE6C9252D49F065F8CDD1756F5A81CB11EB1B58C65"
$resolvedArchive = (Resolve-Path -LiteralPath $ArchivePath).Path
$actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $resolvedArchive).Hash

if ($actualHash -ne $expectedHash) {
    throw "Checksum mismatch for $resolvedArchive. Expected $expectedHash, got $actualHash."
}

$staging = Join-Path $env:TEMP ("llama-swap-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $staging | Out-Null

try {
    Expand-Archive -LiteralPath $resolvedArchive -DestinationPath $staging
    $binary = Get-ChildItem -LiteralPath $staging -Recurse -Filter "llama-swap.exe" |
        Select-Object -First 1
    if (-not $binary) {
        throw "llama-swap.exe was not found in $resolvedArchive."
    }

    New-Item -ItemType Directory -Force -Path $InstallDirectory | Out-Null
    Copy-Item -LiteralPath $binary.FullName -Destination (Join-Path $InstallDirectory "llama-swap.exe") -Force
} finally {
    Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
}

& (Join-Path $InstallDirectory "llama-swap.exe") --version

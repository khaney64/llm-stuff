param(
    [Parameter(Mandatory)]
    [string]$ArchivePath,
    [string]$InstallDirectory = "C:\development\ai\llama-swap"
)

$ErrorActionPreference = "Stop"
$expectedHash = "F6C8F46A9E7641962DCE731BF12898E77175539B476EB4E64D6B2597DD9925AC"
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

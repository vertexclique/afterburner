# PowerShell installer for the `burn` CLI.
#
#   iwr -useb https://afterburner.sh | iex
#
# (Served by the afterburner.sh Cloudflare Worker, which dispatches
# by user agent — PowerShell gets this; curl/wget get install.sh.)
#
# Honors:
#   $env:BURN_VERSION   pinned tag (e.g. v0.1.0). Defaults to "latest".
#   $env:BURN_INSTALL   install dir. Defaults to $env:USERPROFILE\.local\bin.

$ErrorActionPreference = 'Stop'

$repo = 'vertexclique/afterburner'
$installDir = if ($env:BURN_INSTALL) { $env:BURN_INSTALL } else { Join-Path $env:USERPROFILE '.local\bin' }
$version = if ($env:BURN_VERSION) { $env:BURN_VERSION } else { 'latest' }

# ----- arch detection ---------------------------------------------------
# Use PROCESSOR_ARCHITECTURE for 64-bit Windows. ARM64 boxes report
# "ARM64"; everything else (Surface, dev workstations, CI runners) is
# AMD64.
$archEnv = $env:PROCESSOR_ARCHITECTURE
if (-not $archEnv -and $env:PROCESSOR_ARCHITEW6432) {
    $archEnv = $env:PROCESSOR_ARCHITEW6432
}
$arch = switch -Regex ($archEnv) {
    'AMD64|x86_64'  { 'x86_64' }
    'ARM64|aarch64' { 'aarch64' }
    default { throw "burn install: unsupported architecture '$archEnv'" }
}
$target = "$arch-pc-windows-msvc"

# ----- resolve tag -------------------------------------------------------
if ($version -eq 'latest') {
    $api = "https://api.github.com/repos/$repo/releases/latest"
    $tag = (Invoke-RestMethod -UseBasicParsing -Headers @{ 'User-Agent' = 'burn-installer' } -Uri $api).tag_name
    if (-not $tag) { throw 'burn install: could not resolve latest release tag' }
} else {
    $tag = $version
}
$ver = $tag.TrimStart('v')
$stem = "burn-$ver-$target"
$asset = "$stem.zip"
$url = "https://github.com/$repo/releases/download/$tag/$asset"

Write-Host "burn install: $tag -> $target"
Write-Host "  fetching $url"

# ----- download + verify -------------------------------------------------
$tmp = Join-Path $env:TEMP "burn-install-$([guid]::NewGuid())"
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

try {
    $zipPath = Join-Path $tmp $asset
    Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $zipPath

    $shaPath = "$zipPath.sha256"
    try {
        Invoke-WebRequest -UseBasicParsing -Uri "$url.sha256" -OutFile $shaPath
        $expected = (Get-Content $shaPath | Select-Object -First 1).Split()[0].ToLower()
        $actual = (Get-FileHash -Algorithm SHA256 $zipPath).Hash.ToLower()
        if ($expected -ne $actual) {
            throw "burn install: SHA-256 mismatch (expected $expected, got $actual)"
        }
        Write-Host '  sha256 ok'
    } catch [System.Net.WebException] {
        Write-Host '  (no checksum available, skipping)'
    }

    # ----- extract --------------------------------------------------------
    # The Windows zip is flat (burn.exe at root + README + LICENSE + docs/).
    # release.yml builds it via `Compress-Archive -Path "$stem/*"`.
    Expand-Archive -Path $zipPath -DestinationPath $tmp -Force
    $binSrc = Join-Path $tmp 'burn.exe'
    if (-not (Test-Path $binSrc)) {
        throw "burn install: expected $binSrc inside $asset"
    }

    # ----- install --------------------------------------------------------
    New-Item -ItemType Directory -Force -Path $installDir | Out-Null
    $binDst = Join-Path $installDir 'burn.exe'
    Copy-Item -Force $binSrc $binDst

    Write-Host "`n  installed: $binDst"

    # PATH advisory
    $pathDirs = $env:Path -split ';' | ForEach-Object { $_.TrimEnd('\') }
    if ($pathDirs -notcontains $installDir.TrimEnd('\')) {
        Write-Host "  note: $installDir is not on `$env:Path -- add it via System Properties > Environment Variables, or for the current session:"
        Write-Host "    `$env:Path += ';$installDir'"
    }
    Write-Host '  run: burn --version'
} finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

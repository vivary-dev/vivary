param(
    [string]$Python = "3.11",
    [switch]$Editable,
    [switch]$SkipChecks
)

$ErrorActionPreference = "Stop"

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = (Resolve-Path (Join-Path $scriptRoot "..")).Path

$packages = @(
    @{ Name = "vivary-tropo"; Path = "packages\tropo"; Command = "tropo" },
    @{ Name = "vivary-ozone"; Path = "packages\ozone"; Command = "ozone" },
    @{ Name = "vivary-exo"; Path = "packages\exo"; Command = "exo" },
    @{ Name = "create-vivary"; Path = "packages\create-vivary"; Command = "create-vivary" }
)

foreach ($pkg in $packages) {
    $pkgPath = Join-Path $repoRoot $pkg.Path
    $pyproject = Join-Path $pkgPath "pyproject.toml"
    if (-not (Test-Path -LiteralPath $pyproject)) {
        throw "missing package pyproject: $pyproject"
    }

    $args = @("tool", "install", "--python", $Python, "--force")
    if ($Editable) {
        $args += "--editable"
    }
    $args += $pkgPath

    Write-Host "Installing $($pkg.Name) from $pkgPath"
    & uv @args
    if ($LASTEXITCODE -ne 0) {
        throw "uv failed installing $($pkg.Name)"
    }
}

if (-not $SkipChecks) {
    Write-Host ""
    Write-Host "Installed CLI smoke checks"
    & tropo --version
    & ozone --version
    & exo --version
    & create-vivary --help | Select-Object -First 8
    & tropo find --help | Out-Null
    & ozone packs --json
    & create-vivary capabilities --preset coding --json | Out-Null
}

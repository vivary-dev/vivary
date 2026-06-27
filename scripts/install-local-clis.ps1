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
}

foreach ($pkg in $packages) {
    $pkgPath = Join-Path $repoRoot $pkg.Path

    Write-Host "Uninstalling existing $($pkg.Name), if present"
    $oldErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $uninstallOutput = & uv tool uninstall $pkg.Name 2>&1
        $uninstallCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $oldErrorActionPreference
    }
    $uninstallText = $uninstallOutput | Out-String
    if ($uninstallCode -ne 0 -and $uninstallText -notmatch "is not installed") {
        Write-Host $uninstallText.Trim()
        throw "uv failed uninstalling $($pkg.Name)"
    }

    $args = @("tool", "install", "--python", $Python)
    if ($Editable) {
        $args += "--editable"
    }
    $args += $pkgPath

    Write-Host "Installing $($pkg.Name) from current checkout: $pkgPath"
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

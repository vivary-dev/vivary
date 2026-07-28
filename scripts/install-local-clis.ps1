param(
    [string]$Python = "3.11",
    [switch]$Editable,
    [switch]$SkipChecks,
    [switch]$SkipLegacyPipCleanup
)

$ErrorActionPreference = "Stop"

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = (Resolve-Path (Join-Path $scriptRoot "..")).Path
$tropoPath = Join-Path $repoRoot "packages\tropo"
$corePath = Join-Path $repoRoot "packages\core"

$packages = @(
    @{ Name = "vivary-tropo"; Path = "packages\tropo"; Command = "tropo" },
    @{ Name = "vivary-strato"; Path = "packages\strato"; Command = "strato" },
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

if (-not $SkipLegacyPipCleanup) {
    $legacyPipPackages = @("create-vivary", "vivary-ozone", "vivary-exo", "vivary-strato", "vivary-tropo")
    $installedLegacy = @()
    foreach ($legacyPackage in $legacyPipPackages) {
        $oldErrorActionPreference = $ErrorActionPreference
        $ErrorActionPreference = "Continue"
        try {
            & python -m pip show $legacyPackage > $null 2> $null
            $showCode = $LASTEXITCODE
        }
        finally {
            $ErrorActionPreference = $oldErrorActionPreference
        }
        if ($showCode -eq 0) {
            $installedLegacy += $legacyPackage
        }
    }

    if ($installedLegacy.Count -gt 0) {
        Write-Host "Cleaning legacy default-Python pip installs: $($installedLegacy -join ', ')"
        $pipOutput = & python -m pip uninstall -y @installedLegacy 2>&1
        if ($pipOutput) {
            Write-Host (($pipOutput | Out-String).Trim())
        }
        if ($LASTEXITCODE -ne 0) {
            throw "pip failed cleaning legacy Vivary installs"
        }
    }
    else {
        Write-Host "No legacy default-Python pip installs found"
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
    if ($Editable) {
        $args += @("--with-editable", $corePath)
    }
    else {
        $args += @("--with", $corePath)
    }
    if ($pkg.Name -notin @("vivary-tropo", "vivary-strato")) {
        if ($Editable) {
            $args += @("--with-editable", $tropoPath)
        }
        else {
            $args += @("--with", $tropoPath)
        }
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
    & strato --version
    & ozone --version
    & exo --version
    & create-vivary --version
    & tropo find --help | Out-Null
    & strato decide --help | Out-Null
    & ozone packs --json
    & create-vivary capabilities --preset coding --json | Out-Null

    foreach ($pkg in $packages) {
        $expectedOutput = @(& $pkg.Command --version 2>&1)
        $expectedCode = $LASTEXITCODE
        if ($expectedCode -ne 0) {
            throw "$($pkg.Command) did not report an active version: $(($expectedOutput | Out-String).Trim())"
        }
        $expected = ($expectedOutput | Select-Object -First 1).Trim()
        $resolved = @(Get-Command $pkg.Command -All)
        foreach ($entry in $resolved) {
            $actualOutput = @(& $entry.Source --version 2>&1)
            $actualCode = $LASTEXITCODE
            if ($actualCode -ne 0) {
                throw "$($entry.Source) did not report a version for $($pkg.Command): $(($actualOutput | Out-String).Trim())"
            }
            $actual = $actualOutput | Select-Object -First 1
            if ($actual.Trim() -ne $expected) {
                throw "stale $($pkg.Command) at $($entry.Source): expected '$expected', got '$($actual.Trim())'"
            }
        }
    }
}

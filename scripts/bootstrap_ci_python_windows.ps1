# Bootstrap only the existing authenticated Python provisioner. Never run the
# image's pip, an installer, or the unpatched retained ensurepip seed.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ArchiveUrl = 'https://github.com/astral-sh/python-build-standalone/releases/download/20261021/cpython-3.12.15%2B20261021-x86_64-pc-windows-msvc-install_only_stripped.tar.gz'
$ArchiveSize = 21990627
$ArchiveSha256 = 'aac5d331fc3307343f95928fdbea4583f0d53973d08c7e1d081884fbd229a0e1'
$PythonSize = 91648
$PythonSha256 = '651e2230e6f02b233b46c0f829f08df95864d8155e41802c4609fc4aab45c843'
$failure = 'host-admission-unavailable'
$root = $null
$archiveStream = $null
$gzip = $null
$process = $null
$started = $false
$status = 1

function Refuse([string] $Reason) {
    $script:failure = $Reason
    throw [InvalidOperationException]::new('Windows Python bootstrap refused')
}

function AssertPlain([string] $Path, [bool] $Directory) {
    $attributes = [IO.File]::GetAttributes($Path)
    if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
        (($attributes -band [IO.FileAttributes]::Directory) -ne 0) -ne $Directory) {
        Refuse 'plain-private-path-required'
    }
}

try {
    if ($args.Count -ne 0 -or $env:RUNNER_OS -ne 'Windows' -or $env:RUNNER_ARCH -ne 'X64' -or
        -not [OperatingSystem]::IsWindows() -or
        [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString() -ne 'X64' -or
        [Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture.ToString() -ne 'X64') {
        Refuse 'native-Windows-x64-without-arguments-required'
    }
    $failure = 'native-tar-api-unavailable'
    Add-Type -AssemblyName System.Formats.Tar
    $null = [System.Formats.Tar.TarFile]
    $failure = 'private-temporary-parent-unavailable'
    if ([string]::IsNullOrEmpty($env:RUNNER_TEMP)) { Refuse 'runner-temporary-parent-required' }
    $temporary = (Resolve-Path -LiteralPath $env:RUNNER_TEMP).ProviderPath
    AssertPlain $temporary $true
    $candidate = Join-Path $temporary ('vivary-python-bootstrap-' + [Guid]::NewGuid().ToString('N'))
    if (Test-Path -LiteralPath $candidate) { Refuse 'fresh-private-directory-required' }
    $failure = 'fresh-private-directory-unavailable'
    $created = New-Item -Path $candidate -ItemType Directory
    $root = $created.FullName
    AssertPlain $root $true
    $archive = Join-Path $root 'python.tar.gz'
    $runtime = Join-Path $root 'runtime'
    $null = New-Item -Path $runtime -ItemType Directory
    AssertPlain $runtime $true
    $failure = 'native-curl-unavailable'
    $curl = Join-Path ([Environment]::SystemDirectory) 'curl.exe'
    AssertPlain $curl $false
    $failure = 'exclusive-artifact-creation-failed'
    $empty = [IO.File]::Open($archive, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    $empty.Dispose()
    AssertPlain $archive $false
    $arguments = @('--disable', '--fail', '--silent', '--show-error', '--proto', '=https',
        '--proto-redir', '=https', '--location', '--max-redirs', '3', '--connect-timeout', '10',
        '--max-time', '120', '--max-filesize', [string]$ArchiveSize, '--output', $archive, $ArchiveUrl)
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $curl
    $start.UseShellExecute = $false
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    foreach ($argument in $arguments) { $start.ArgumentList.Add($argument) }
    $start.Environment.Clear()
    $inherited = [Environment]::GetEnvironmentVariables()
    foreach ($name in @('SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY',
                        'CURL_CA_BUNDLE', 'SSL_CERT_FILE', 'SSL_CERT_DIR')) {
        if ($inherited.Contains($name)) { $start.Environment[$name] = [string]$inherited[$name] }
    }
    $failure = 'native-download-failed'
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $start
    if (-not $process.Start()) { Refuse 'native-download-start-failed' }
    $started = $true
    # Drain to a sink without retaining or printing proxy/TLS diagnostics.
    $stdout = $process.StandardOutput.BaseStream.CopyToAsync([IO.Stream]::Null)
    $stderr = $process.StandardError.BaseStream.CopyToAsync([IO.Stream]::Null)
    if (-not $process.WaitForExit(125000)) {
        $process.Kill($true)
        Refuse 'native-download-deadline-exceeded'
    }
    if ($process.ExitCode -ne 0) { Refuse ('native-download-curlReturnCode=' + $process.ExitCode) }
    if (-not [Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]@($stdout, $stderr), 1000)) {
        Refuse 'native-download-output-deadline-exceeded'
    }
    $failure = 'archive-authentication-failed'
    AssertPlain $archive $false
    # Deny writers/deletion until the same authenticated stream is extracted.
    $archiveStream = [IO.File]::Open($archive, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    if ($archiveStream.Length -ne $ArchiveSize) { Refuse 'archive-size-mismatch' }
    $digest = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($archiveStream)).ToLowerInvariant()
    if ($digest -ne $ArchiveSha256) { Refuse 'archive-SHA256-mismatch' }
    $archiveStream.Position = 0
    $failure = 'authenticated-runtime-extraction-failed'
    $gzip = [IO.Compression.GZipStream]::new($archiveStream, [IO.Compression.CompressionMode]::Decompress, $true)
    [System.Formats.Tar.TarFile]::ExtractToDirectory($gzip, $runtime, $false)
    $gzip.Dispose()
    $gzip = $null
    $archiveStream.Dispose()
    $archiveStream = $null
    $failure = 'extracted-interpreter-authentication-failed'
    $python = Join-Path $runtime 'python/python.exe'
    AssertPlain (Join-Path $runtime 'python') $true
    AssertPlain $python $false
    if ((Get-Item -LiteralPath $python).Length -ne $PythonSize -or
        (Get-FileHash -LiteralPath $python -Algorithm SHA256).Hash.ToLowerInvariant() -ne $PythonSha256) {
        Refuse 'extracted-interpreter-size-or-SHA256-mismatch'
    }
    $failure = 'authenticated-Python-provisioner-failed'
    $helper = Join-Path $PSScriptRoot 'bootstrap_ci_python.py'
    AssertPlain $helper $false
    # Absolute, authenticated bootstrap interpreter; no bootstrap PATH export.
    & $python -I -B $helper
    if ($LASTEXITCODE -ne 0) { Refuse 'authenticated-Python-provisioner-refused' }
    $status = 0
} catch {
    [Console]::Error.WriteLine('Windows Python bootstrap: ' + $failure)
} finally {
    try {
        if ($started -and -not $process.HasExited) {
            $process.Kill($true)
            if (-not $process.WaitForExit(5000)) { Refuse 'native-download-cleanup-deadline-exceeded' }
        }
    } catch {
        [Console]::Error.WriteLine('Windows Python bootstrap: native-download-cleanup-failed')
        $status = 1
    }
    foreach ($resource in @($gzip, $archiveStream, $process)) {
        if ($null -ne $resource) {
            try { $resource.Dispose() }
            catch {
                [Console]::Error.WriteLine('Windows Python bootstrap: native-resource-cleanup-failed')
                $status = 1
            }
        }
    }
    if ($null -ne $root) {
        try { Remove-Item -LiteralPath $root -Recurse -Force }
        catch {
            [Console]::Error.WriteLine('Windows Python bootstrap: private-directory-cleanup-failed')
            $status = 1
        }
    }
}
exit $status

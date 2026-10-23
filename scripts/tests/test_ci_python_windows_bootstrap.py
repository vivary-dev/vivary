"""Portable source-contract controls; these do not claim native Windows execution."""

import ast
from pathlib import Path
import re
import shutil
import subprocess
import unittest


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts/bootstrap_ci_python_windows.ps1"


def require_contract(source):
    """Keep the small native bootstrap's critical barriers fail closed."""
    def required(token):
        if token not in source:
            raise ValueError("missing bootstrap barrier: " + token)
    for token in ("$args.Count -ne 0", "[OperatingSystem]::IsWindows()", "::OSArchitecture.ToString() -ne 'X64'",
                  "::ProcessArchitecture.ToString() -ne 'X64'", "$null = [System.Formats.Tar.TarFile]",
                  "Add-Type -AssemblyName System.Formats.Tar",
                  "[IO.FileAttributes]::ReparsePoint", "[Guid]::NewGuid()", "Test-Path -LiteralPath $candidate",
                  "New-Item -Path $candidate -ItemType Directory", "AssertPlain $root $true",
                  "[IO.FileMode]::CreateNew", "AssertPlain $archive $false", "[Environment]::SystemDirectory",
                  "$start.UseShellExecute = $false", "$start.Environment.Clear()", "$start.ArgumentList.Add($argument)",
                  "@('--disable', '--fail', '--silent', '--show-error', '--proto', '=https'",
                  "'--proto-redir', '=https'", "'--max-redirs', '3'", "'--max-time', '120'",
                  "'--max-filesize', [string]$ArchiveSize", "$process.WaitForExit(125000)", "$process.Kill($true)",
                  "CopyToAsync([IO.Stream]::Null)", "$process.ExitCode -ne 0", "[IO.FileShare]::Read",
                  "$archiveStream.Length -ne $ArchiveSize", "$digest -ne $ArchiveSha256",
                  "$archiveStream.Position = 0", "::ExtractToDirectory($gzip, $runtime, $false)",
                  "AssertPlain $python $false", ".Length -ne $PythonSize", "$PythonSha256",
                  "AssertPlain $helper $false", "& $python -I -B $helper", "$LASTEXITCODE -ne 0",
                  "Remove-Item -LiteralPath $root -Recurse -Force", "exit $status"):
        required(token)
    order = ("$args.Count -ne 0", "$null = [System.Formats.Tar.TarFile]", "$created = New-Item",
             "$process.Start()", "$archiveStream = [IO.File]::Open", "$digest -ne $ArchiveSha256",
             "$gzip = [IO.Compression.GZipStream]::new", "::ExtractToDirectory($gzip, $runtime, $false)",
             "AssertPlain $python $false", "(Get-FileHash -LiteralPath $python -Algorithm SHA256)",
             "& $python -I -B $helper")
    positions = [source.index(token) for token in order]
    if positions != sorted(positions):
        raise ValueError("bootstrap barrier order changed")
    if (re.search(r"(?i)\$env:PATH|GITHUB_PATH|--insecure|--ssl-no-revoke|\bInvoke-Expression\b", source)
            or re.search(r"(?im)^\s*&\s+.*(?:\bpip\b|ensurepip|setup\.ps1|installer)", source)
            or source.count("& $python -I -B $helper") != 1):
        raise ValueError("unqualified execution, trust weakening or bootstrap PATH export")


class NativeBootstrapContract(unittest.TestCase):
    def setUp(self):
        self.source = SCRIPT.read_text(encoding="utf-8")

    def test_native_bootstrap_contract(self):
        require_contract(self.source)

    def test_pins_match_the_existing_qualified_windows_runtime(self):
        tree = ast.parse((ROOT / "scripts/bootstrap_ci_python.py").read_text())
        assets = next(ast.literal_eval(node.value) for node in tree.body
                      if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == "ASSETS" for target in node.targets))
        windows = assets["win32"]
        values = dict(re.findall(r"(?m)^\$(\w+) = '([^']+)'$", self.source))
        numbers = dict(re.findall(r"(?m)^\$(\w+) = (\d+)$", self.source))
        self.assertEqual(values["ArchiveSha256"], windows["sha256"])
        self.assertEqual(int(numbers["ArchiveSize"]), windows["size"])
        self.assertEqual(values["PythonSha256"], windows["executable_sha256"])
        self.assertEqual(int(numbers["PythonSize"]), 91648)
        self.assertEqual(values["ArchiveUrl"], "https://github.com/astral-sh/python-build-standalone/releases/download/20261021/" + windows["file"].replace("+", "%2B"))

    def test_modified_download_custody_or_tls_barriers_are_refused(self):
        for token in ("[IO.FileAttributes]::ReparsePoint", "Test-Path -LiteralPath $candidate", "[IO.FileMode]::CreateNew",
                      "$start.Environment.Clear()", "'--proto-redir', '=https'", "'--max-filesize', [string]$ArchiveSize",
                      "$process.WaitForExit(125000)", "[IO.FileShare]::Read", "$archiveStream.Length -ne $ArchiveSize",
                      "$digest -ne $ArchiveSha256", "AssertPlain $python $false", "$LASTEXITCODE -ne 0"):
            with self.subTest(token=token), self.assertRaises(ValueError):
                require_contract(self.source.replace(token, "REMOVED", 1))

    def test_parser_cannot_run_before_full_archive_authentication(self):
        parser = "$gzip = [IO.Compression.GZipStream]::new"
        altered = self.source.replace(parser, "UNUSED", 1).replace("$digest -ne $ArchiveSha256", parser + "\n$digest -ne $ArchiveSha256", 1)
        with self.assertRaisesRegex(ValueError, "order"):
            require_contract(altered)

    def test_bootstrap_cannot_publish_path_execute_installers_or_disable_tls(self):
        for command in ("$env:PATH = $root", "'anything' >> $env:GITHUB_PATH", "& $python -m pip install anything",
                        "& $root/setup.ps1", "Invoke-Expression $root", "$arguments += '--insecure'"):
            with self.subTest(command=command), self.assertRaises(ValueError):
                require_contract(self.source + "\n" + command)

    @unittest.skipUnless(shutil.which("pwsh"), "PowerShell is unavailable; portable source checks are not native qualification")
    def test_available_powershell_parser_accepts_the_script_without_executing_it(self):
        program = "$errors=$null;$tokens=$null;[void][Management.Automation.Language.Parser]::ParseInput([Console]::In.ReadToEnd(),[ref]$tokens,[ref]$errors);if($errors.Count){exit 1}"
        result = subprocess.run([shutil.which("pwsh"), "-NoProfile", "-NonInteractive", "-Command", program],
                                input=self.source.encode(), capture_output=True, timeout=15)
        self.assertEqual(result.returncode, 0, "PowerShell parser rejected the bootstrap source")


if __name__ == "__main__":
    unittest.main()

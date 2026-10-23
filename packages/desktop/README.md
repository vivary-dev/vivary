# Vivary desktop

This package opens Vivary in a native desktop window and starts the existing
Workbench runtime on the user's computer. It has no dependency on Zo or a cloud
control plane. Opening Vivary requires no login or signup.

The desktop package includes ordinary Node alongside Electron. Native SQLite
modules stay on the Node ABI used to build Workbench. The renderer has no Node
access, uses Electron's sandbox, and can navigate only to its own loopback server.
See [Electron's security guidance](https://www.electronjs.org/docs/latest/tutorial/security).

## Current acceptance

Published checkpoint: 2026-09-22. The publicly downloadable
[Windows prerelease](https://github.com/vivary-dev/Vivary-New/releases/tag/desktop-preview-2026-09-22) pins source `98846706227432e26f519d1b546889261eb08ff1`.
This is the merged PR #78 source. Follow the
[installation guide](../../docs/desktop-preview.md) for extraction, launch,
runtime setup, profile preservation, upgrades, rollback limits, and troubleshooting.

The unsigned portable ZIP is 236,072,825 bytes with SHA-256 `e9c0abf09e9e5a66c1dbea9ec3e05d479829138d35372b10c90a34124d1b81a0`.
It retains development metadata version `0.0.0`, channel `private-preview`, and
prebuilt Workbench `sourceCommitVerified: false`. These labels describe the tested
artifact. They do not prevent its authorized publication as a development prerelease.

Direct Windows checks verified the native browser confirmation, Cancel without
a new tab, confirmed Chrome launch at the exact path/query/fragment, and page
interaction. Project switching cleared the old preview. Graceful close stopped
observed processes and released the listener. Restart retained the selected
project and an empty Preview. Profile backups were hash-verified before launch.

The package retains Codex integration and adoption-request replay. Earlier setup,
chooser, narrow-layout, and real model journeys remain evidence for their named
candidates. Six applicable GitHub CI jobs passed on the reviewed PR #78 fix head.
The site job skipped. Historical Entire trail-approval failures remain recorded.

A later unpublished `df4aedc` Windows package completed a fresh application-profile
journey under the existing Windows account. It showed missing-CLI and sign-in
guidance, used bundled runtimes, selected a Unicode folder, completed reviewed
existing-folder setup after an injected HTTP response loss, ran real Codex/Astra
file tools, displayed and stopped an npm project preview, reused the first
instance, and cleaned up on idle and active shutdown. Its
[Windows receipt](../../docs/product/multi-project/receipts/23b-windows-desktop-acceptance.md)
records the artifact hash, checks, and limits. Independent review accepted
this candidate's Windows journey. This does not replace the published prerelease.

The [acceptance register](../../docs/product/multi-project/desktop-acceptance-status.md)
owns evidence boundaries. Full existing-folder and managed-creation acceptance
under issues #14 and #15, upgrade/removal,
Native-provider turns, automations, and the remaining desktop/web journey stay
open. macOS remains later work.

### Earlier packaged proofs

Earlier Linux and Windows candidates established portions of runtime packaging,
the original command surface, and managed creation. They remain historical evidence.
The current register supersedes their current-status claims. Credentials are never
bundled, and a cross-build alone never establishes Windows behavior.

## Open preview links in your browser

The preview panel's **Open preview in a new tab** action opens HTTP and HTTPS
addresses in the default browser after a native confirmation. The dialog shows
the destination and defaults to Cancel. File URLs, custom protocols, URLs with
credentials, and POST requests are refused. Provider setup links retain their
existing direct browser behavior. A failed browser launch shows a copy-address
fallback. Embedded previews retain their sandbox and cannot create popups.

The September 22 prerelease includes this behavior. Its packaged Windows check
verified both Cancel and confirmed browser launch.

## Development

Build Workbench first, then install this package's locked development tools:

```console
pnpm --dir packages/workbench build
npm --prefix packages/desktop ci
```

Packaging the original runtime also requires host Python 3.12 with `venv` and
`ensurepip`. It does not require global setuptools. The first package build
needs outbound HTTPS for the hash-pinned runtime and build-tool wheels; verified
downloads are reused from the desktop package's `.tmp` cache.

Packaging captures the recorded Git commit and tracked working-tree changes
before downloads and wheel construction. Stage new source files with `git add`
first; untracked files are excluded. Later checkout edits cannot change the
captured inputs. `build.json` records whether that snapshot matches the commit.
The existing Workbench `.output` is copied once and labeled `prebuilt`; its
compilation from the recorded commit is not asserted.

Set `VIVARY_DESKTOP_NODE` to the absolute path of ordinary Node, then run:

```console
npm --prefix packages/desktop start
```

The desktop uses `~/.vivary/workbench` for its database, run history, and workspace.
Electron stores its window/browser state in the operating system's normal Vivary
application-data directory. The user installs and signs into their model CLI
separately. Native Settings shows provider configuration and installed CLI
status. Open folder uses the system directory chooser to connect a project;
Vivary keeps the selected folder and its conversations separate from other
projects.

## Package

```console
npm --prefix packages/desktop run package
```

The packager writes a dated directory under `dist/`. It stages the desktop
entry, compiled Workbench output, startup scripts, ordinary Node, the original
Vivary runtime, licenses, and build metadata. It does not copy a source
checkout, runtime data, credentials, or the development preview service.

### Bundled original runtime

The desktop pins CPython 3.12.15 from the
[python-build-standalone `20261021` release](https://github.com/astral-sh/python-build-standalone/releases/tag/20261021).
The runtime archives are fixed inputs:

| Target | Archive | SHA-256 |
| --- | --- | --- |
| Linux x64 | `cpython-3.12.15+20261021-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz` | `6d7521138fd33afddc1ccd08abb007d9a2829e38117c2576f9efdc0ec73ce772` |
| Windows x64 | `cpython-3.12.15+20261021-x86_64-pc-windows-msvc-install_only_stripped.tar.gz` | `aac5d331fc3307343f95928fdbea4583f0d53973d08c7e1d081884fbd229a0e1` |

These target pins do not establish native acceptance. The Linux artifact contains
Expat 2.9.0 and OpenSSL 3.5.9; static inspection of the Windows artifact still
finds Expat 2.8.5. No affected XML call path was found in the seven bundled Vivary
Python packages, but Windows library applicability, certificate paths and native
acceptance remain open. Neither target is admitted here for arbitrary Python
database workloads. Artifact digests were matched to the official release;
independent provenance verification is not claimed. Electron publication remains held.

Package-time downloads stay under `packages/desktop/.tmp/original-runtime` and
are reused only after their hashes match. This includes the following build-only
Python tools:

| Tool | Version | SHA-256 |
| --- | --- | --- |
| [pip](https://pypi.org/project/pip/26.2.2/) | 26.2.2 | `fd7f4dfa8190e014013b9f08f3e973f4e4c26ffd179a204895533a7254813a70` |
| [setuptools](https://pypi.org/project/setuptools/84.1.0/) | 84.1.0 | `5231689c6ac8156cd155cfb98c3fd6fb252c3e7e9bd3d78b64d3c55f132624c9` |

Each build then:

1. Creates a temporary isolated build environment under the same `.tmp`
   directory without running the host's ensurepip seed. It authenticates the local
   pip and setuptools wheel bytes again, bootstraps from that pip wheel with isolated
   imports and package-client configuration, and
   checks that pip vendors distlib 0.4.2.
2. Builds fresh pure-Python wheels from the owned `vivary`, `create-vivary`,
   `core`, `tropo`, `strato`, `ozone`, and `exo` sources without an
   index or build isolation.
3. Installs those wheels into the staged interpreter without an index or
   dependency download.
4. Writes relocatable component launchers and correct installed-wheel `RECORD`
   entries.
5. Removes the temporary build environment.
6. Copies and hashes the reviewed managed-project bridge.
7. Writes the runtime manifest and license inventory.

The build tools remain package-time inputs. The pip wheel is
`pip-26.2.2-py3-none-any.whl`, with 1,819,850 authenticated bytes and the digest
above. Setuptools moves to 84.1.0, which fixes the Windows legacy wheel-to-egg traversal advisory. These inputs do not add a first-launch
installer or a new runtime dependency.

The distributed application needs no global Python, source checkout, or
first-launch install. The existing `vivary_cli` router continues to own create,
adopt, doctor, capabilities, check, find, decide, review, impact, and control.
Its logs and email-draft helpers remain available through the bundled CLI.

Linux component commands resolve the bundled sibling `python3`. Windows uses
pip's vendored distlib 0.4.2 console launcher and its supported
`<launcher_dir>` interpreter path. Every standalone and component launcher
passes `-I -X utf8 -B` so redirected Unicode output has the same encoding
contract as the application adapter. See the first-party
[distlib launcher source](https://github.com/pypa/distlib/blob/0.4.2/PC/launcher.c).
The packaged runtime omits pip and Python bytecode caches. It retains distlib's
license at `licenses/LICENSE.distlib` for the copied Windows launcher stubs.
The builder requires the authenticated 108,032-byte `t64.exe` with SHA-256
`81a618f21cb87db9076134e70388b6e9cb7c2106739011b6a51772d22cae06b7`.
Before creating the license destination, it requires the 14,531-byte LICENSE
with SHA-256 `808e10c8a6ab8deb149ff9b3fb19f447a808094606d712a9ca57fead3552599d`.
Both boundaries retain the authenticated bytes for the subsequent write.
An unknown vendor, missing input, wrong size or wrong digest is refused.
Electron Packager copies the staged Python tree with verbatim relative symlinks.

The manifest records the target, source revision, interpreter and component
versions, wheel hashes, launchers, bridge hash, and license paths. The package
includes each component's MIT license, the repository MIT license for the
bridge, CPython and distlib licenses, and the release-pinned
[python-build-standalone aggregate licenses](https://github.com/astral-sh/python-build-standalone/blob/20261021/python-licenses.rst).
That aggregate is 105,875 bytes with SHA-256
`e43fb936c6655d7996dba480d7ebdea492d6040ec388eb8ed9d1000f72de8cab`.

Workbench reaches this runtime through a deterministic server adapter. It:

- accepts one of ten typed verbs;
- keeps Create and Adopt in preview mode because a local-stat folder grant does
  not authorize mutation through an ordinary pathname;
- resolves and revalidates the selected project grant;
- checks governed scope and capsule paths against the canonical project, rejecting
  links and raw dot segments while allowing planned files under verified parents;
- invokes `python -I -X utf8 <bytecode flag> -m vivary_cli` without a shell;
- bounds time, input, and output;
- exposes bounded text search for Find and the structure pack for Review; and
- derives app receipts from `VIVARY_DATA_DIR`, without accepting a caller path.

The bytecode flag is `-Xpycache_prefix=` with this build's folder under
`python-cache` in the data folder, so each module compiles once and later
commands read the cache. It is `-B` when no cache can be used. The standalone
launchers keep `-B`, and the bundle neither ships nor receives a `.pyc` file.

The standalone bundled CLI keeps the complete original command flags and the
original `.vivary/receipts.jsonl` default. The adapter is neither a model tool
nor another daemon. Existing-folder application through the GUI remains under
issues #14 and #15, with an identity-preserving apply path. The managed New
Project flow uses its separate reviewed creator. See the
[runtime verification](../../docs/product/multi-project/receipts/23a-bundled-original-runtime.md).
The corrected Linux artifact passed its relocated ten-command checks and
packaged-Electron journey. The hosted preview passed create, Doctor, control,
and foreign-identity rejection. The current Windows candidate passed bundled
Python creation and the native journeys listed in the acceptance register.
Complete original-operation GUI acceptance remains part of the final release journey.

The default command builds the supported target for its host: Linux x64 or
Windows x64. Other architectures and macOS remain later release work. The build
uses that host's Node executable and Workbench native modules. Linux requires
the usual Electron desktop libraries, including GTK 3 and its GSettings schemas.

There is one application instance per user. The window starts its own local
server, waits for the actual app route, and uses parent-child IPC for graceful
shutdown. The server exits normally after local-work cleanup settles and Nitro
closes. Windows desktop shutdown keeps IPC open during cleanup. If a stop or
Nitro close fails, or cleanup stays pending, the server PID remains available for
the desktop's existing 15-second process-tree kill. If Electron disconnects,
including during an existing shutdown, the server gives cleanup 15 seconds before
attempting to stop its own tree. That command is bounded to five seconds, and the
server exits nonzero if it returns. Successful cleanup exits before the fallback.
Direct CLI and
non-Windows cleanup failures still exit with failure after all stops settle.
POSIX also cleans the owned process group if the server exits. An unexpected
Windows server crash left a shell-launched preview and its ordinary child alive
on the historical d8cb7665 package. Each Windows preview now has a bundled Python
owner that retains Core's kill-on-close job around the manager and descendants.
The fresh 4f7a0394 package passes server-first cleanup while Electron remains alive,
active-preview normal close and parent loss, and idle, scheduled and webhook quit.
Process observations precede manual cleanup. The original registered fixture and
grants are preserved.
The shutdown regression exercises controlled Windows cleanup failures with a
real descendant and `taskkill /T /F` when run on Windows. Packaged acceptance
and its limits belong to the [issue receipt](../../docs/product/multi-project/receipts/138-desktop-quit-exit.md).

## Windows x64 portable preview

The Windows x64 packaging entry is:

```console
npm --prefix packages/desktop run package -- --windows-x64
```

This mode requires Workbench output built with Node 24.22.1 (ABI 137) and
`better-sqlite3` 13.0.3. It verifies the pinned official Windows Node asset and
the bundled `prebuilds/win32-x64.node` in the staged copy. That N-API binding must
match SHA-256 `e21e5efd71fba66578e95b62554d9028064a80dafd7221bf8a8ef155de8d240a`.
It remains at the path selected by the 13.x loader; staging does not download or
extract a separate ABI-specific SQLite archive. The source Workbench output is unchanged.
The source checkout and its installed native modules stay intact.

This mode also writes `package-file-manifest.json` beside the `Vivary-win32-x64`
folder in the dated `dist/` directory. It maps each file's path relative to that
folder, with forward slashes, to its lowercase SHA-256. The
[Windows installer](#windows-installer) build takes it as `--manifest`.

[Node checksums](https://nodejs.org/dist/v24.22.1/SHASUMS256.txt) and the
[SQLite release](https://github.com/WiseLibs/better-sqlite3/releases/tag/v13.0.3)
are the asset authorities. [Electron Packager](https://github.com/electron/packager/blob/v20.3.0/README.md)
supports cross-platform assembly, but Vivary's mandatory native runtime
collector requires matching Windows x64 evidence and refuses that collection
on Linux. Electron publication remains held because standalone Node admission
does not resolve its incomplete advisory backport evidence.

The approved Node 24.22.1 inputs are:

| Input | SHA-256 |
| --- | --- |
| Linux x64 archive | `6c172a9ab6718f7b801fb5a7bd486af2ee5e32758086a04b84fcce2aa77095e6` |
| Windows x64 ZIP | `d2046d28c2c3dcd211ac5145c0bf30e2047ef9dfb306693c8c6e2eccd8b95fa5` |
| `node-v24.22.1-win-x64.exe` | `d702daa815eabbff763c7d3808e235cf031cf2ca70211b56847bc72f51e240e5` |

The signed-checksum exception covers only those approved Linux and Windows
archives. Their OIDC build attestations are missing, and fresh online key
revocation was not checked. The separate verified Windows executable receipt
exited 0 and reported Node 24.22.1, OpenSSL 3.5.9 and ABI 137. It did not verify
installed Vivary. Linux packaging still binds the actual native process and
copied executable bytes.

The pip/distlib source port preserves the verified transfer's pinned inputs and
exact-byte checks. Source reconciliation and Linux tests do not establish native
Windows execution or acceptance of installed Vivary. Final-head hosted CI,
independent server review and packaged Windows acceptance remain separate gates.
Electron and PyPI or raw registry publication remain held. No publication is
authorized by these source or artifact checks.

`vivary.exe` carries the Vivary name and icon. The icon is
`assets/vivary.ico`, made from the site mark `site/src/assets/vivary-mark.png`
(256 x 256) with PNG entries at 16, 20, 24, 32, 40, 48, 64, 96, 128 and 256
pixels. Replace both together if the mark changes. Its file properties show
"Copyright (C) 2026 Jeff Kazzee", set through the packager's `appCopyright`.

The folder must stay together: `vivary.exe` uses its sibling `resources` files.
For this portable preview, extract the archive to a short path such as
`C:\Vivary` or `%USERPROFILE%\Vivary`. Windows Explorer can reject a deeply
nested destination before the application starts.

Windows users need their own installed and signed-in coding CLI. The package does
not include credentials. The published `9884670` package verified confirmed
browser opening, project-preview clearing, restart, and graceful shutdown.
The unpublished `df4aedc` package verified missing-runtime guidance and a real
Codex/Astra file turn in a fresh application profile. Its reviewed npm preview
started, rendered, and stopped. Upgrade/removal behavior and the complete
release journey remain outside this candidate's acceptance.

The bundled runtime can be checked without opening Electron or calling a provider:

```console
<selected-node-executable> --test packages/desktop/tests/node-shutdown.test.mjs
```

This control uses only a loopback redirect server and child processes. It checks
normal exit and exit after a failed fetch, including the Windows shutdown failure
fixed by [Node #61999](https://github.com/nodejs/node/pull/61999). Each child has a
cleared environment and a bounded timeout. Passing does not establish native
desktop acceptance.

## Windows installer

`build-installer.mjs` wraps a packaged `Vivary-win32-x64` folder in a per-user
Windows installer. It uses [NSIS 3](https://nsis.sourceforge.io/Docs/) through
`makensis`, which it takes from the `MAKENSIS` environment variable or from `PATH`.
It stops when neither has it. When `makensis` was extracted rather than installed,
set `NSISDIR` to its data folder (the one holding `Include`, `Plugins`, and `Stubs`).

```console
npm --prefix packages/desktop run package -- --windows-x64
npm --prefix packages/desktop run installer -- --payload <dist>/<time>/Vivary-win32-x64 --output Vivary-Setup-<commit>.exe --manifest <dist>/<time>/package-file-manifest.json
```

The first command writes the dated `<dist>/<time>/` folder, which holds both the
`Vivary-win32-x64` payload and its `package-file-manifest.json`.

The script reads the version and payload commit from the payload's
`resources/workbench/build.json`. It refuses a payload built from a modified
checkout and a payload with links. It refuses a path the installer cannot list or
Windows cannot hold: non-ASCII, a wildcard or drive character, a part ending in a dot
or space, a reserved device name such as `CON` or `nul.txt`, two paths that differ
only in case, or a file or folder at the payload root named like a file setup
writes there (`install-files.txt`, `install-files.tmp`, `vivary-setup.txt`,
`Uninstall Vivary.exe`, in any case). It refuses a file path longer than 179 characters and a folder path
longer than 167 (168 with the list line's trailing backslash). Windows file paths
stop at 259 characters and `CreateDirectory` stops at 247, and the install root for
a 40-character profile folder name takes 80 of them. The receipt records the
longest file and folder paths, and the script passes their lengths to setup as
`LONGEST_FILE` and `LONGEST_FOLDER`.
`--manifest` is required. The script checks every payload
file's relative path and SHA-256 against the package's file manifest and refuses
missing, extra, or changed files. It refuses uncommitted changes to `installer/`,
`build-installer.mjs`, `assets/vivary.ico`, and the repository `LICENSE`, so the
installer commit it records holds every source file the build used. It also refuses
an existing installer, `.sha256`, or `.receipt.json` at the output path.

The script writes `install-files.txt`: every payload file, then every payload folder
deepest first, with a trailing backslash on folder lines. After `makensis` finishes,
it counts the files `makensis` reported adding and fails when that count differs
from the payload plus the list. It writes `<output>.sha256` in the same format as
the ZIP companion, and `<output>.receipt.json` with the installer's size and
SHA-256, the payload and installer commits, the `makensis` version, the payload file
count, and the manifest's SHA-256. Once `makensis` starts, any failure removes the
files this build wrote, so the installer, checksum, and receipt exist together or
not at all. The installer's file properties carry the same two commits as
`PayloadCommit` and `InstallerCommit`.

The installer script is `installer/vivary.nsi`. Its rules:

- It runs as the current user, with no administrator prompt.
- It refuses 32-bit Windows before any other check and exits with an error.
- Setup and the uninstaller hold the per-user mutex `Local\VivarySetup`. A second
  setup or uninstaller exits with an error instead of running alongside.
- It installs to `%LOCALAPPDATA%\Programs\Vivary`. There is no folder choice,
  and it ignores the `/D=` option, so the uninstaller always knows its folder.
- It adds a Start menu shortcut, and a desktop shortcut when the finish page
  checkbox is selected (off by default).
- It registers Vivary under `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\Vivary`
  with version `<version>+<short commit>`, for example `0.0.0+2aaf04f`.
- When Vivary or its bundled Node or Python is running, it asks the user to close
  Vivary and offers Retry or Cancel. It never stops a process.
- A file that cannot be written stops setup (`AllowSkipFiles off`), and setup exits
  with an error. Setup writes the new `install-files.txt` after it removes the
  previous version's files and before it extracts any payload file, so the list on
  disk always names every Vivary file there. An uninstall after an interrupted
  extraction therefore removes all of them, and a listed file that never arrived
  counts as removed. Setup writes the list as `install-files.tmp` and then moves it
  over the old list in one step (`MoveFileExW` with replace and write-through), so an
  interrupted write leaves the old list or the new one, never part of one.
- Before it moves the new list into place or extracts anything, setup checks each
  file path in `install-files.tmp`. Every file the previous list named is gone by
  then, so a file found at a payload path is not Vivary's, for example one the user
  added. Setup then deletes only `install-files.tmp`, names the file, and stops with
  exit code 2, leaving the old list, entry, uninstaller, and marker as they were. On
  an upgrade or repair, where `RemoveInstalledFiles` read a list (`$R8` = 0), the
  previous version's files are already removed by then, so Vivary does not start
  until setup finishes, and the message says so. On a new folder (`$R8` starts at
  -1) or a kept-files folder with the marker and no list, nothing was removed, and
  the message says nothing was changed. A rerun after the user moves the file
  succeeds. Folder paths are not checked: a file
  at a payload folder path makes extraction fail, which stops setup without
  replacing anything. A damaged list with the marker skips this check and copies
  over the folder, because setup cannot tell its files from others there, so it can
  replace a user file at a payload path.
- Nothing is deleted recursively. Upgrade and uninstall read the previous
  `install-files.txt`, check every line before deleting anything, delete the listed
  files, then remove each listed folder only when it is empty. A line with a drive,
  a leading backslash, a `.` or `..` part, a part ending in a dot or space, a
  wildcard, or more than 179 characters stops the removal, and so does a listed
  folder that became a link. Files a user added stay.
- Before it removes or extracts anything, setup adds the payload's longest file and
  folder lengths to the length of its real install root. It stops with exit code 2
  and changes nothing when the file path would pass 259 characters or the folder
  path 247, as can happen under a long or relocated profile folder.
- When the folder does not exist or is empty, setup writes its marker
  `vivary-setup.txt` there before copying any payload file. Setup never writes the
  marker into a folder that already held files. When files the user added keep the
  folder after an uninstall, the uninstaller writes the marker again, so the next
  setup recognizes the folder and installs beside those files without deleting any.
- Both first confirm that the folder is exactly `%LOCALAPPDATA%\Programs\Vivary`
  and is not a link. An upgrade changes an existing folder only when its uninstall
  entry points there or it holds `install-files.txt`, the marker, `vivary.exe`, or
  the uninstaller, so setup can repair a partly removed install. A folder with the
  marker but no list is a first install that did not finish, and setup copies over
  it. The uninstaller asks for that setup rerun instead. A damaged list with the
  marker present is handled the same way: setup copies over it, which rewrites the
  list, and the uninstaller asks for the rerun. A folder with neither a list nor the
  marker makes setup and the uninstaller change nothing and ask the user to remove
  it by hand.
- When listed files remain, setup stops before copying, and the uninstaller keeps
  its entry, list, and itself so it can run again. Otherwise the uninstaller removes
  the shortcuts (the desktop one only when setup made it), then itself, the
  uninstall entry, the marker, any leftover `install-files.tmp`, and the list last.
  It stops, keeping the entry, marker, and list, when its own file is still there
  after the delete or when the uninstall entry still opens after `DeleteRegKey`.
  Stopped at any point, the folder still holds the list, which setup recognizes and
  repairs, or nothing setup made.
- A damaged list without the marker stops setup and the uninstaller with the reason:
  a cut-off line, a path outside the Vivary folder, or an empty or too long line.
- Neither program reads, writes, or deletes `%USERPROFILE%\.vivary`,
  `%APPDATA%\Vivary`, or any project folder.
- `/S` runs the installer or the uninstaller silently. A running Vivary then
  cancels the change instead of waiting.

`tests/installer-script.test.mjs` checks these rules in the script source.
`tests/installer-build.test.mjs` checks the argument validation, the path rules,
the manifest check, the installer commit check, the list order, and the cleanup
after a failed build, which uses a stand-in `makensis`. It builds a small fixture
installer when the real `makensis` is available and skips that build otherwise.
The installer is not code signed.

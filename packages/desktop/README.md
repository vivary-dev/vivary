# Vivary desktop

This package opens Vivary in a native desktop window and starts the existing
Workbench runtime on the user's computer. It has no dependency on Zo or a cloud
control plane. Opening Vivary requires no login or signup.

The desktop package includes ordinary Node alongside Electron. Native SQLite
modules stay on the Node ABI used to build Workbench. The renderer has no Node
access, uses Electron's sandbox, and can navigate only to its own loopback server.
See [Electron's security guidance](https://www.electronjs.org/docs/latest/tutorial/security).

## Runtime security prerequisite

Current source admits ordinary Node 22.23.4, 24.22.1 or 26.12.1 and later patches
on those supported branches; CI selects Node 24.22.1. Build and Workbench startup
inspect the actual executable before running affected code. Use the
[isolated build tools](../../docs/BUILD-TOOLS.md), locked dependencies with scripts
disabled, and the rebuilt Go compilers before build commands below.

Electron 44.3.0 remains locked as historical metadata but is affected. The package
entry refuses before loading Electron Packager, and no replacement Electron
release is admitted by the current policy. Do not run the Electron development
start or package commands until a candidate is separately qualified. These source
changes do not repair existing archives, installed applications, or establish new
Windows acceptance. The source candidate and its platform checks remain separate
from the historical acceptance records below.

## Current acceptance

Checkpoint: 2026-09-16. The current private Windows x64 candidate is built from
`26798df3b1b4e4f6dd6c3e9eb798a9817ccaab1a`. The unsigned portable archive is
available as a [private Windows development preview](https://github.com/vivary-dev/Vivary-New/releases/tag/desktop-preview-2026-09-16)
to people with repository access. It is incomplete and is not ready for public
release. The [desktop acceptance register](../../docs/product/multi-project/desktop-acceptance-status.md)
is the concise authority for verified capabilities and remaining gaps.

The broad `31d9afc` Windows pass exercised managed five-file creation, project
files, the preserved-profile Usage surface, restart persistence, a real approved
Claude Code follow-up, Stop, second-instance reuse, and idle and active cleanup. The
focused final `26798df` retest extracted and hash-matched all 3,110 files, verified the
read-only runtime identity with no provider fallback, ran one approved Claude Code
file read, retained its conversation through a second launch, and removed every
observed process on close. See the register for the exact evidence split.

Windows acceptance fixed five concrete defects: long cache paths in the Python stage,
generic invalid-rename errors, hidden project-name rules, first-run Usage table setup,
and a Code model control that routed CLI aliases into Native provider setup. The Code
composer now displays the effective CLI identity as read-only text and leaves runtime
setup in Settings.

This does not establish public release readiness. Codex can report Ready but cannot
be selected for a new Code conversation. Real Native-provider turns, automation
execution, clean-profile setup, full populated-folder adoption, search, memory,
responsive self-hosted access, integrated preview/debugging, upgrade/removal behavior,
and release approval remain unaccepted. A portable archive satisfies the current
distribution shape. Signing and an installer are future choices. macOS is later work.

### Earlier packaged proofs

Earlier Linux and Windows candidates established portions of runtime packaging,
the original command surface, and managed creation. They remain historical evidence.
The current register supersedes their current-status claims. Credentials are never
bundled, and a cross-build alone never establishes Windows behavior.

## Development

Build Workbench first, then install this package's locked development tools:

```console
pnpm --dir packages/workbench build
npm --prefix packages/desktop ci
```

Packaging the original runtime also requires qualified host Python 3.12.15 with `venv`.
It creates its build environment with `--without-pip`, authenticates its wheel inputs,
and never executes the host ensurepip seed or requires global setuptools. The first package build
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
   pip, setuptools and certifi wheel bytes again. Before executing pip, the shared
   certificate helper derives a local pip 26.2.2 wheel with certifi 2026.10.23.
   It changes only certifi's version and CA data, its vendoring declaration and
   wheel RECORD; the vendored import rewrites and distlib stay unchanged. Bootstrap
   uses that derived wheel with isolated imports and package-client configuration,
   then checks the actual vendored certifi bundle and distlib 0.4.2.
   The same derived wheel replaces the staged interpreter's authenticated
   ensurepip seed, so a later fresh venv cannot restore the older bundle. An
   unknown or additional seed, or a mismatched ensurepip version, refuses packaging.
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

The authenticated upstream pip input is
`pip-26.2.2-py3-none-any.whl`, with 1,819,850 authenticated bytes and the digest
above. The overlay input is the official certifi 2026.10.23 wheel, 135,082 bytes,
SHA256 `e9b54de76e530bb6cf0ccd036787103acb58fd42ba930ea8bf948ddbaa2f61d1`.
Its CA bundle removes emSign C1/C3 and preserves the other 118 roots. The derived
pip wheel is a Vivary modification, not an upstream pip release; `manifest.json`
records both upstream inputs and the derived seed's path and SHA256. Installed
pip remains excluded from the shipped site-packages. Its standard ensurepip
seed remains available with the same corrected vendored certifi bytes; standalone
certifi is not added to the seven owned packages. No first-launch installation
or TLS verification bypass is introduced. Setuptools remains 84.1.0, including
the Windows legacy wheel-to-egg traversal fix.

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
The packaged runtime omits installed pip and Python bytecode caches. Its retained
ensurepip seed contains the authenticated derived pip/certifi wheel. It retains distlib's
license at `licenses/LICENSE.distlib` for the copied Windows launcher stubs.
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
- invokes `python -I -X utf8 -B -m vivary_cli` without a shell;
- bounds time, input, and output;
- exposes bounded text search for Find and the structure pack for Review; and
- derives app receipts from `VIVARY_DATA_DIR`, without accepting a caller path.

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
shutdown. POSIX also cleans the owned process group if the server exits.
Windows has a live-process tree fallback; crash cleanup on Windows still needs
an actual platform test.

## Windows x64 portable preview

A Linux build host can also assemble the unsigned Windows x64 folder:

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

[Node checksums](https://nodejs.org/dist/v24.22.1/SHASUMS256.txt) and the
[SQLite release](https://github.com/WiseLibs/better-sqlite3/releases/tag/v13.0.3)
are the asset authorities. [Electron Packager](https://github.com/electron/packager/blob/v20.3.0/README.md)
supports cross-platform assembly, but Vivary's mandatory native runtime
collector requires matching Windows x64 evidence and refuses that collection
on Linux. Electron publication remains held because standalone Node admission
does not resolve its incomplete advisory backport evidence.

The folder must stay together: `vivary.exe` uses its sibling `resources` files.
For this private preview, extract the archive to a short path such as
`C:\Vivary` or `%USERPROFILE%\Vivary`. Windows Explorer can reject a deeply
nested destination before the application starts.

Windows users need their own installed and signed-in coding CLI. The package does
not include credentials. Explorer launch, Claude Code discovery, a bounded real file
turn, restart persistence, and active cleanup passed on the tested candidate. Codex
selection/execution, clean-profile setup, upgrade/removal behavior, and the complete
release journey remain open before this becomes a supported release.

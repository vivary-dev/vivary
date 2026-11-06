# Packaged Windows runtime follow-up checks

Verified 2026-10-02 on the Windows x64 candidate built from clean source
`c0b0bbc0e07b70a70cd65952eceeb79064316cd3`. This is the same candidate used for
the #156 packaged creator check. Its archive is 222,613,107 bytes with SHA-256
`788087d3f887cb9624cc6be815651e9b48850d9f0216faede91f572e8e4e4b71`.

## #155: Bundled Python bytecode cache

The candidate bundles Python 3.12.14. The cache build identifier is `afa9f119`,
the first eight hexadecimal characters of the SHA-256 of the raw runtime
manifest bytes. It is not the source commit prefix.

A bounded benchmark invoked the candidate's interpreter directly, using
`-I -X utf8 -B` for the baseline and
`-I -X utf8 -Xpycache_prefix=<extended-length-absolute-prefix>` for cached runs.
The cache option was one argument with the Windows `\\?\` prefix. Each command
used seven baseline runs, one fresh-cache run, and seven warm runs in its own
disposable directory. Each process had a 120-second timeout and an explicit
minimal environment. The CLI command was `-m vivary_cli capabilities --json`.
The bridge received `{"operation":"catalog"}` on standard input.

| Command | Baseline median | Fresh-cache run | Warm median |
| --- | ---: | ---: | ---: |
| CLI capabilities | 936.837 ms | 1,030.618 ms | 246.854 ms |
| Bridge catalog | 771.420 ms | 1,027.485 ms | 204.739 ms |

The warm runs reused 104 and 103 bytecode files respectively, with no changed
timestamps, sizes, or cache inventory. Actual cache paths reached 318 and
316 characters. This machine had `LongPathsEnabled=1`, so those lengths do not
prove behavior with the Windows long-path policy disabled.

The installed runtime contained no `.pyc` files or `__pycache__` directories
before or after measurement. The manifest stayed unchanged, and the benchmark
removed its scratch directory. These are direct interpreter timings, not GUI
or application-dispatch latency. The separate [creator receipt](156-creator-shutdown-windows.md) records
application creation through the bundled runtime. Its application data held
151 bytecode files under `python-cache/afa9f119` before the upgrade check.

Private evidence includes `bytecode-timings.json`, with all individual timings,
cache arguments, inventory checks, and cleanup status.

### Same-profile package upgrade

The second private package was built from clean documentation-only source
`d6241f03a8703ccf0291ef75dc62d27a26bdbad3`. Its ZIP is 222,613,877 bytes
with SHA-256
`0b5704a431957c88fea40bd3d8613ab06e4bddd7cc376bf8e1858bc2d9f3ebed`.
Packaging and archive integrity passed. The raw runtime manifest has SHA-256
`a75c292cad91b83ed7c165cb1b5a9c02ace557bc8fe71914cf0d7dc81ac75f63`,
so its cache identifier is `a75c292c`.

The upgraded package opened the same isolated application profile and retained
`acceptance-positive` in the UI. At 18:33:06 UTC, the new cache held 109 bytecode
files totaling 3,146,581 bytes. The previous `afa9f119` cache, which had held
151 files, was absent. An unrelated sentinel kept its SHA-256. The installed
runtime still contained zero `.pyc` files and zero `__pycache__` directories.

The actual New project UI loaded its catalog. **Preview files** for
`acceptance-upgrade` showed five guidance files. At 18:33:15 UTC, the packaged
runner recorded `creator-plan` with `ok: true`, exit code 0, Python 3.12.14,
and duration 329 ms. This was a preview only, without applying or registering
the proposed project. After normal Alt+F4 close, all eight observed application,
server, Electron, and console-host processes were gone by 18:34:21 UTC, and no
Vivary window remained.
A final filesystem check at 18:35:07 UTC again found 109 cache files totaling
3,146,581 bytes, the old cache absent, the sentinel unchanged, and no installed
bytecode or `__pycache__` directory. The superseded local candidate folder and
ZIP were removed after the replacement passed. The current package, isolated
profile, and evidence were preserved. Unrelated processes and services were
left untouched.

This same-profile upgrade establishes a changed manifest-derived cache identity,
removal of the previous build's cache, preservation of the unrelated sentinel,
and a working creator preview after upgrade. It is one observed upgrade, not a
claim about arbitrary cache contents or every filesystem failure. Private
`upgrade-after.json`, `upgrade-preview.png`, the packaged runtime receipt, and
`upgrade-closed-final.json`, and `upgrade-after-final.json` retain the observations.

## #130: Codex discovery completion and timeout

The real packaged Settings UI used an external Codex CLI fixture with an npm
package layout. In normal mode, Settings showed Ready, two models, and the
fixture connection `synthetic-offline-connection`.

In lingering mode, the fixture answered discovery requests but remained alive
after standard input closed. Both observed processes were gone at the bounded
follow-up check, before their 45-second fallback exit. The latest process had
started about 17 seconds before that check, and neither recorded a fallback
exit. This supports application-driven cleanup of discovery processes that
answered but did not exit on their own.

In stalled mode, Settings displayed "Codex took too long..." and the fixture
recorded standard input closing after about 12 seconds. The follow-up process
check found neither observed process still running. Switching the fixture back
to normal and selecting Refresh recovered Ready and two models in the same
application and server session.

This check used no real Codex service or model provider. It did not deliberately
force an unconfirmed `taskkill` failure. The lower-level test covers that branch,
and the separate orphan-process limitation tracked by #133 remains. Private
evidence includes the normal, timeout, and recovered screenshots, fixture event
records, and the two process-check JSON files.

## #144: Accepted instructions during review

An external fixture called the candidate's actual packaged store exports from
its shipped `_libs` files. It supplied a synthetic `automationRun` context to
write one personal instruction file for the disposable local owner. It used
no raw SQL or scheduler.

The packaged Automation files UI displayed the green proposal while
`resourceForAgent` returned the accepted blue baseline. Discard restored the
blue file. The fixture then wrote another green proposal, which the UI displayed,
and replaced it externally with purple text before the owner clicked Accept.
The stale Accept returned the 409 changed-file notice. Purple remained pending
and blue remained accepted. Accepting the refreshed purple version promoted it
and removed the waiting row.

The pending, discarded, stale-refused, and accepted JSON snapshots agree with
the packaged UI screenshots. This Windows check covered the packaged store,
review action, and UI. It did not run an owner chat, unattended tool wrapper,
or scheduler. The earlier [Zo receipt](144-automation-instruction-preservation.md)
separately records owner-chat dispatch, the unattended wrapper, and deletion
refusals. It did not start the scheduler either.

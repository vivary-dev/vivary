# Creator shutdown on packaged Windows

Date: 2026-10-02
Issue: [#156](https://github.com/vivary-dev/vivary/issues/156)
Candidate source: `c0b0bbc0e07b70a70cd65952eceeb79064316cd3`

## Candidate

The private Windows x64 ZIP is 222,613,107 bytes with SHA-256
`788087d3f887cb9624cc6be815651e9b48850d9f0216faede91f572e8e4e4b71`.
Zo built Workbench and packaged it from the same clean source using pnpm.
The archive integrity check passed. Build metadata records `sourceDirty: false`,
a Git archive with zero tracked overlays, and `commitMatchesPackagedSource: true`.
The package includes Node 24.19.0, Electron 44.3.0, and Python 3.12.14.

Workbench metadata remains `prebuilt` with `sourceCommitVerified: false`.
The separate successful build record on the same clean commit supplies the
source relationship. No application code changed for this acceptance run.
The candidate remains private and unpublished.

## Successful creation

The packaged UI created `acceptance-positive` in an isolated application profile.
The runner recorded a successful creator plan in 297 ms, a successful creator
apply in 1,018 ms, and a successful adoption. This positive control shows that
the bundled creator can complete through the normal application path.

## Quit during creation

A second UI project, `acceptance-interrupted`, completed its preview in 286 ms.
A reviewed external helper then suspended the actual bundled Python creator
child of the candidate server at 17:55:26.613 UTC. The helper matched the parent,
executable, bridge argument, and creation time, retained a process handle, and
had a 60-second resume deadline. The application showed **Creating**.

At 17:55:46.722 UTC, Alt+F4 requested normal desktop quit. The helper observed
the creator exit after 20,595 ms of its hold. The runner recorded
`creator-apply` with `ok: false`, reason `stopped`, and elapsed time 20,661 ms.
The creator therefore ended before either the runner's 30-second command limit
or the helper's 60-second resume deadline could explain its exit.

By 17:56:12 UTC, the observed desktop, server, creator, and helper processes
were all gone. Reopening the same isolated profile at 17:56:45 UTC retained
`acceptance-positive`. The interrupted project was not registered in the UI.

## Evidence boundary

This is an actual packaged Windows desktop quit with a synthetic external
pause to keep the real creator in flight. It does not claim an unmodified
creator naturally ran for that duration. The observed creator did not spawn
a grandchild. The separate Windows CI `creator-shutdown.test.mjs` proof covers
a real Python child and grandchild through the shared shutdown owner.

The check establishes normal creator completion, shutdown of the in-flight
packaged creator, a stopped receipt, and registration state after reopening.
It does not establish that an interrupted apply made no filesystem changes.
It adds no acceptance claim for bytecode caching (#155), Codex model-check
cleanup (#130), or automation instruction preservation (#144). Screenshots,
helper output, and process observations remain in private evidence.

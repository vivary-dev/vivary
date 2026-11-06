# Windows desktop first-launch verification

Evidence-record: 23b
Date: 2026-09-23
Issue: [#8](https://github.com/vivary-dev/Vivary-New/issues/8)
Candidate source: `df4aedc998580a5040ffb670dfdba821541bff9a`
Review status: Owner-selected GPT-6 Luna independently accepted this candidate's
Windows journey. The owner requested Sol for implementation work and Luna for
bounded independent review on this run, overriding the default Astra reviewer
choice.

## Candidate and build

The Windows x64 ZIP contains 3,108 files and is 221,884,442 bytes. Its SHA-256
is `85263c5dab59977e5c4a5b556e2742624abad01f98d33d135b63e9e30ecd2184`. Archive
integrity passed. The package contains Electron, Node 24.15.0, Python 3.12.14,
the Workbench server, and the Windows SQLite binding. The build metadata records
the exact source commit, `sourceDirty: false`, and a Git archive snapshot
without a tracked overlay. Workbench remains labeled `prebuilt` and
`sourceCommitVerified: false`.

Zo built Workbench and the Windows package from the assigned checkout.
Twenty-seven focused desktop, runtime, snapshot, and startup tests passed. Five
coding-runtime status tests passed. Workbench typecheck passed. The production
build logged a missing `BETTER_AUTH_SECRET` configuration warning but exited
successfully. These host checks are separate from the Windows run.

## Packaged Windows journey

The executable opened with fresh application and Electron browser data under the
existing Windows account. The test process used redirected profile and
agent-home variables and a restricted `PATH` containing Windows system
directories. Vivary opened without signup. The original profile's 2,011 recorded
file hashes matched before and after the run. This is same-account
application-profile isolation, not a newly created Windows OS account.

The packaged runtime handled setup without a global Node or Python executable on
that restricted path and without a source checkout. Missing coding CLIs appeared
as not installed with setup guidance. A separate empty Codex login appeared as
needing sign-in. The real Windows folder chooser selected a path with Unicode
characters, and Vivary displayed the file from that selected project. A second
launch reused the existing app instance. Closing an idle instance released its
owned listener and processes.

Existing-folder setup first previewed its proposed changes without writing.
Cancel preserved the folder. A stale `.gitignore` review was refused. A separate
privacy confirmation changed only the reviewed `.gitignore`. A new setup review
proposed four files. After the reviewed Apply was approved, a test dropped the HTTP
response to the renderer and its automatic status response. The visible Retry
reused the same operation. The result reported replay, all four file bytes
matched the review, and their hashes and modification times stayed unchanged on
Retry. This proves renderer response-loss recovery. The creator-to-service
lost-result path has separate focused tests.

An authorized Codex turn using GPT-6 Astra read the project's guidance, context,
and note, then wrote the requested 18-byte result. The normal packaged
conversation showed real tool output. Stop ended a later active shell turn and
its observed worker, Codex, MCP, and shell descendants while Vivary stayed open.

Vivary reviewed and started the project's npm `dev` script through bundled Node.
The resulting page returned HTTP 200 for health probes and displayed its marker
in the embedded preview. Preview Stop removed the owned process, cleared the
frame, and released its listener. Closing the application during active work
removed all 20 observed application and child processes and released the
observed listeners. Reopening retained the project and conversation history,
showed the stopped run as stopped, and opened with an empty preview.

The owner directed valid completed checks to carry forward. Explorer extraction
and launch passed on candidate `26798df3b1b4e4f6dd6c3e9eb798a9817ccaab1a`.
A source comparison with `df4aedc998580a5040ffb670dfdba821541bff9a` confirms
that the packager and startup paths are unchanged. The intervening desktop
behavior change adds confirmation for opening external browser links.

This run used a controlled launch to isolate application data. The earlier
Explorer check carries forward for the unchanged packaging and startup paths.
It was not rerun on this candidate.

## Acceptance boundary

Independent review accepted the Windows journey for this candidate. This receipt
does not accept full existing-folder adoption and creation
under issues [#14](https://github.com/vivary-dev/Vivary-New/issues/14) and
[#15](https://github.com/vivary-dev/Vivary-New/issues/15), or the full desktop
and self-hosted release under
[#23](https://github.com/vivary-dev/Vivary-New/issues/23). Native provider
access, automations, phone routing, upgrade and removal, signing, and
publication retain their own gates. Private screenshots, process snapshots,
profile comparisons, and request records stay outside tracked source.

# GUI workspace creation and reconnection acceptance

Evidence-record: 07d
Date: 2026-09-23
Issue: [#15](https://github.com/vivary-dev/Vivary-New/issues/15)
Hosted candidate and exact Workbench build: `27499cf249631d090f8c1311834227baba913744`
Hosted result: passed
Packaged Windows result: passed

## Result

The GUI creates a managed workspace from a reviewed five-file plan. It also
registers an authorized folder on the connected host, reviews setup changes,
preserves existing files, and reconnects that project's saved folder after its
filesystem identity changes. Reconnection requires an explicit review of the
saved path. It retains the project identity, selection, files, and scoped
conversation history.

The implementation extends the existing Native reconnection owner to registered
external folders. It accepts no caller-supplied replacement path. Confirmation
rechecks the saved grant, path, parent, folder identity, and project revisions.
A Code request cannot start during the root transition. Review fixes also give
filesystem roots a nonempty folder name. Reconnection refuses missing, linked,
or moved folders and folders that change after review.

## Carried acceptance

The [Windows first-launch receipt](23b-windows-desktop-acceptance.md) accepts the
earlier packaged candidate's account-free opening, native folder chooser,
isolated application profile, guidance read by a real Codex turn, Stop, preview,
and restart. Its Workbench package metadata remains `prebuilt` with
`sourceCommitVerified: false`. That receipt does not prove the new candidate's
Windows reconnection behavior.

The [shared plan and apply receipt](07b-shared-workspace-plan-apply.md) accepts
exact creator plans, separate privacy approval, refusal of changed inputs,
same-request replay, and reviewed recovery. Its Windows first Apply HTTP response
and post-restart Native HTTP response were not captured. Visible app state, exact
disk bytes, and the creator receipt support those Windows results. This issue
uses that accepted operation. It did not repeat the prior fault injection or
claim a new model turn.

## Hosted GUI journey

The normal Workbench app and browser ran against disposable managed and
registered host folders. Managed Create previewed five guidance files, wrote
the reviewed bytes, and opened the project. The registered folder review
showed proposed and retained files. Cancel changed nothing. An edit to retained
`STATE.md` made old Apply refuse without a write. Fresh review applied only
approved changes, and Files and a Native chat route opened.

A same-path replacement gave the registered folder a new filesystem identity
while preserving its original in a private backup. At 390 pixels, the GUI
showed the full saved path, identity warning, and confirmation control without
horizontal overflow. Cancel wrote nothing. Confirm restored the same project
and Files access. Six fixture files kept their bytes and modification times.
The first app restart retained selection and Files. An empty chat route alone
created no persisted history.

One project-scoped user message was then fixture-seeded through the installed
Native thread store API. It was neither UI-authored nor model-produced.
The marker was visible in the GUI before a second same-process folder swap.
**Refresh projects** showed the selected unavailable row and **Review
connection**. The later reconnect and one subsequent app restart retained the
marker, selection, Files access, and six unchanged fixture files.

Earlier driver runs stopped on stale selectors, a hidden phone sidebar, or a
loading page. One early-loading attempt lacked the recovery control without
captured client state. The settled refresh and restart paths passed.

## Verification

From the repository root on Zo:

```console
node --test packages/workbench/tests/managed-project-reconnection.test.mjs
pnpm --dir packages/workbench exec tsx --test tests/local-code-agent.test.ts
pnpm --dir packages/workbench typecheck
pnpm --dir packages/workbench build
pnpm --dir packages/workbench test:maintained
git diff --check
```

The reconnection suite passed 10 of 10, including a read-only filesystem-root
preview. The Code host suite passed 12 of 12. Typecheck exited successfully
while reporting the existing missing production auth-secret diagnostic. The
normal Workbench build passed with an ephemeral build secret. The full
local maintained suite and Native doctor passed on the preceding
`316653c354097c5827e72a9df47eab7d7cc3332e` commit. That local full gate was
not rerun on `27499cf`, whose source change only fixes the filesystem-root
display name and adds its regression test. GitHub's applicable CI jobs passed
on the exact `27499cf` candidate. The site job was skipped. Entire's separate
trail had no formal approval vote. The private continuation handoff records the
hosted runner, commands, logs, screenshots, and disposable inputs. Those
records are not shipped in this repository.

## Packaged Windows journey

The unpublished Windows package came from the exact clean `27499cf` source.
Its ZIP SHA-256 is
`d041f0aca7fe2edcb170259eea282476b80ee083f5d6d471f439605cbcbad6c6`.
Workbench metadata still reports `sourceCommitVerified: false`.

The actual EXE previewed and created a managed project through the GUI. Native
HTTP preview and create responses used the same reviewed plan, and all five
written file hashes matched. The system folder chooser then registered and
selected a separate long Unicode path. Files opened its existing guidance
marker. No model ran during this Windows check.

After normal close, the owner preserved the external four-file folder and
restored byte-identical files with matching modification times at its saved
path. Restart retained that external project as unavailable and offered
**Review connection**. The GUI showed the full saved path and identity
warning. Cancel left all four files unchanged. A new review and explicit
confirmation returned Native HTTP 200 for the same project ID and advanced its
binding revision to 2. Another normal close and restart reopened that project
as available, with its Files marker readable. The managed project remained
listed and selectable after both restarts.

The original account profile's 2,011 recorded files kept their hashes and
counts, including 48 application and 1,963 browser-profile files. This run
did not claim Windows model execution or conversation-history persistence.
Those behaviors retain their separate [issue #8](23b-windows-desktop-acceptance.md)
evidence. Issue #23 still owns full desktop and self-hosted release acceptance.

## Picker-selected folders beside managed projects

Review found that a folder selected through the picker could be eligible for
reconnection but fail preview if it sat under the managed Projects directory
with a name such as `My Project`. Commit
`8fb3ed0b83563e358b3fefd0c8f3305a98dd2b8c` reuses the provider's existing
location classification. These picker folders receive the external saved-path
review. Creator-made managed folders keep their existing rules.

The expanded reconnection suite passed 11 of 11. Typecheck and the exact
Workbench build passed. All applicable GitHub CI jobs passed on `8fb3ed0`,
with the site job skipped. Independent review approved the correction.

The updated unpublished Windows package has ZIP SHA-256
`cc8dc4232c379a8c93189f62e570785fd067392b704afb73c0869a128eb2e85b`.
Its source snapshot is clean at `8fb3ed0`. Workbench metadata continues to
report `sourceCommitVerified: false`.

The actual Windows folder picker registered `My Project` directly under the
isolated profile's Projects parent. After the test preserved and copied that
folder at its saved path, **Refresh projects** exposed **Review connection**.
The review showed the full path and external-folder wording. Confirmation used
the reviewed plan and returned HTTP 200 with `reconnected` for the same project
ID. Files opened the original guidance marker. All four fixture files retained
their hashes and modification times. All 2,011 original-profile files and their
counts stayed unchanged, and the candidate processes stopped.

This focused Windows check carries the earlier cancellation and restart results.
It did not repeat those steps or run a model. An indexed click during sidebar
scrolling opened Settings. No setting changed. The visible reconnection control
completed the action, and the tester returned to the workspace to read Files.

The hosted check registered the same kind of picker-selected folder, preserved
its original tree, and replaced it at the saved path. Both reviews identified an
external folder. Cancel preserved all four files. Native confirmation returned
HTTP 200 with `reconnected` for the same project ID. A retained-profile resume
then opened the normal app, showed the project as available, and read its
guidance marker through Files. The file URL retained the confirmed project ID,
and file bytes, lengths, and modification times remained unchanged.

The first hosted driver attempts had incorrect classification or success-text
expectations. A first resume also waited for a read-only query as though it were
an action event. Those attempts remain diagnostic failures. The captured
confirmation and completed retained-profile resume support the final result.
No model call ran, and the app and test port stopped afterward.

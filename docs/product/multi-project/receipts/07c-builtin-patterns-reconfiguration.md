# Built-in guidance and reconfiguration acceptance

Evidence-record: 07c
Date: 2026-09-23
Issue: [#16](https://github.com/vivary-dev/Vivary-New/issues/16)
Full journey source: `7784b8d9f55df1146b18e7aa032e05f4eea7d084`
Compatibility source: `1ae195658c56e41ca205f4c0c2bcfc212e6e169d`
Hosted result: both journeys passed as described below
Packaged Windows result: reserved for final artifact acceptance under #23

## Result

The installed creator supplies Capture, Sources, Navigation, and Project brief.
Each choice has an editable name and relative Markdown path. Choices compose
independently with the four existing workspace aliases. Omitting patterns
preserves the legacy five-file output.

The GUI previews exact content before creation or a guidance change. The creator
owns rendering and validation. Native owns the selected project and saved
approval. Changing choices requires a fresh preview. An old approval cannot
apply the replacement plan. The selected project's existing instruction path
finds the active guidance.

Reconfiguration preserves authored guidance, state, unknown configuration, project
identity, and conversations. Retiring a pattern keeps its file and removes its
active links and ownership. Rewriting edited or unowned content reports a
conflict. Role paths grant no access. Selecting guidance starts no model,
provider, hook, schedule, or external template download.

## Hosted acceptance

A fresh bundled runtime and Workbench built from clean `7784b8d9` passed the
normal application journey at desktop width and 390 pixels. The installed
creator loaded from runtime `site-packages`, matched source, exposed all four
patterns, wrote the exact seven-file plan, and passed Doctor.

Creation composed Capture and Sources with custom paths. Preview refused
`projects/capture.md` with E101 before creating the target because the project
schema requires a status field. A corrected path passed. Changing the Capture
name after preview invalidated the preview. A name containing an emoji survived
creation and restart. Cancel made no project writes. Desktop and narrow previews
showed the same final plan, and Create wrote its seven files exactly.

The Files view saved authored additions to Capture and `STATE.md`.
Reconfiguration retired Sources and added Navigation. Changing the Navigation
name invalidated preview A. Preview B showed the changed choice and a different
plan hash. Cancel preserved the entire project tree. The 390-pixel review showed
the same plan and usable confirmation controls without horizontal overflow.

Apply completed while the browser lost its response. The immediate status
request also failed. Retrying the same input and operation returned the saved
result with `replayed: true` and made no second workspace write. After server
and browser restart, the same project retained Capture and Navigation. Capture,
`STATE.md`, and retired Sources kept their hashes, sizes, and modification times.
The new Navigation file and updated configuration matched the approved bytes.
No model call was requested.

## Legacy and Unicode compatibility

A fresh installed runtime and Workbench built from clean `1ae19565` passed a
second hosted journey. Registration opened an existing thin-v0.3 workspace with
a UTF-8 BOM, authored configuration comments, and a custom memory role.
The pattern controls read its legacy metadata and offered a reviewed change.
A Capture name containing 41 emoji passed through Native's request and state
schemas, which count Unicode code points consistently with the creator.

Preview changed no files. Apply wrote exactly the reviewed Capture, context,
and configuration content. The configuration retained its BOM and original
text, then appended versioned guidance metadata with the effective legacy roles.
The existing instructions, state, memory note, and ignore file stayed unchanged.
After server and browser restart, the same project retained its guidance name
and opened the new file. No model call was requested.

The creator regressions also covered interrupted legacy migration and recovery,
empty legacy pattern selections, and a custom law role. The later compatibility
changes leave the earlier composition and replay journey in place. That full
journey's source remains recorded separately above.

## Verification and limits

All 13 applicable source workflow steps passed on clean `7784b8d9`. They cover
Tropo, creator and adoption behavior, CLI characterization and route parity,
installed routing, package assets, and the npm launcher. Focused Native service
tests passed 22 cases, including preview replacement and stale approval refusal.
Independent review approved the creator changes and audited the retained
installed-runtime and hosted evidence.

Regression checks cover Windows line endings, Unicode names, invalid destinations,
missing parent directories, and configuration reads without following symlinks.
Historical renderer tests retain fixed version-one content and hash checks.
They preserve old output ownership when adding newer patterns and recover an
interrupted older journal without accepting arbitrary journal content.
Windows governed verification and both platform orientation jobs passed on
`7784b8d9`. An unrelated Codex child-request timing test failed in that commit's
Linux CI job and passed its isolated 24-case rerun. All seven GitHub jobs then passed on documentation checkpoint `d4b1892`.
The focused compatibility checks, maintained Workbench suite, and all seven
GitHub jobs passed on `1ae19565`. Final PR checks record the merge candidate separately.

The private continuation handoff holds commands, logs, GUI captures, and
synthetic fixture evidence. The retained evidence also has an off-host backup.
This receipt establishes hosted desktop-width and narrow-layout acceptance.
It does not claim an EXE journey for this source or a published release.
Parent outcome 07 and the complete desktop and web journey under #23 remain open.

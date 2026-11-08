---
name: verify
description: Drive Vivary's real web workbench to verify navigation, projects, Settings and documentation on an exact candidate head before merging a code change.
---

# Verify Vivary

## Launch

Run code in a fresh Daytona sandbox created for this one job, at the agreed
resource ceiling. Do not reuse or resize another owner's sandbox. Before
deleting it, export the evidence folder to a durable destination outside the
sandbox and verify the copy; see Cleanup. Delete the sandbox when this run
ends, whether it passed or failed.

Read AGENTS.md, ENGINEERING.md, CONTRIBUTING.md and docs/ENTIRE.md. Use an owned
checkout at the candidate full SHA. Never change Entire hook trust. Report
capture as unverified when the actual runtime has no captured session.

Before any install, build or test, check the Daytona sandbox directly: confirm
the installed Node version satisfies packages/workbench/package.json's
engines.node, confirm `pnpm --version` matches the pin in
.github/workflows/ci.yml, confirm python3's version and OpenSSL build are the
qualified pair the repo's own scripts require, and confirm enough free disk for
the install. Report FAIL with the exact mismatch and stop. This replaces
tools/vivary-preflight, a Linveo-workspace tool not present in a Daytona
sandbox; do not substitute a Linveo pass for a Daytona pass.

From the repository root, choose a new private evidence directory under the
system temp directory and outside the checkout (for example
/tmp/vivary-proof-UNIQUE). Do not reuse one from an earlier run. Then read the
answer key:

```sh
python3 .claude/skills/verify/key.py /tmp/vivary-proof-UNIQUE
```

Replace UNIQUE with the run's unique name. The helper fetches origin/dev, pins
its full SHA, requires acceptance.md there and rejects a candidate whose key
differs. It writes the trusted key and candidate SHA into the evidence folder.
A missing key is FAIL. Never copy a key into origin/dev or forge its ref.

Use the installed Node and pnpm versions required by package.json and CI.
After passing the relevant preflight, install and build with the repo commands:

```sh
pnpm --dir packages/workbench install --frozen-lockfile
pnpm --dir packages/workbench build
```

Create a fresh private scratch directory and empty data, home and workspace
subdirectories. Set HOME to that scratch home only for the child server. Launch
the normal application from packages/workbench with the installed Node:

```sh
node bin/start.mjs --port 55173 --data-dir "$RUN_DATA" --workspace "$RUN_WORKSPACE"
```

Choose an unused loopback port if 55173 is occupied. Record the child PID and
owned paths. Do not reuse the beta.1 sandbox checkout, profile or workspace.
Keep the browser in the same sandbox and use loopback rather than changing the
proxy access boundary. The saved owner-sign-in.txt is a credential. Read it only
inside the browser driver, never print it or put it in argv or evidence.
Use the normal sign-in page. Start evidence capture after sign-in.

Ready means the authenticated workspace displays Projects and Personal workspace,
and its controls respond. A ping or HTTP 200 alone is insufficient. From the UI,
create disposable Alpha and Beta projects using New project, Project name,
Preview files and Create project. Inspect each file plan before accepting it.
Keep all created folders under the isolated home. Confirm both project choices
appear. Missing registration or any error fails setup rather than skipping it.

## Doctor

Before driving, verify the server PID is alive, owns the chosen port and started
from this checkout. Record git rev-parse HEAD and compare it to key-receipt.json.
Confirm the browser's origin is the owned loopback URL and its authenticated
workspace is usable. Fail if a foreign process owns the port, the build predates
the candidate, a source file changed after building or sign-in failed.

## Drive

Read the pinned acceptance.md in the evidence folder and every mapped feature.
Drive all five journeys, in order, with real browser clicks, keyboard input and
viewport changes. Use the existing browser harness where available. A Playwright
driver may use getByRole and getByLabel for the handles in the feature map.
Use the actual application and production services. Never set React state,
write localStorage, mock the project catalog or call an internal action endpoint
to manufacture a result. Read-only DOM inspection can observe state.

For each row, capture the initial state, each action and the resulting state.
Assert every clause in the answer key. A detached or hidden sidebar is not
visible. Check geometry as well as accessibility for the sidebar and resize
handle. Scope navigation controls to the visible sidebar or sheet so hidden
copies cannot satisfy a check. Check focus after Escape and route choice.

## Evidence

Keep action logs, viewport sizes, screenshots before and after transitions,
observed URLs, selection labels and assertion results in the evidence folder.
Record all five results in report.md, linked to their captures. Include full
candidate SHA, pinned origin/dev SHA, build command, launch command, environment,
start and end times and any failure. Use FAIL for missing browser, server,
credentials, key, project preconditions or evidence. Never report SKIP as PASS.

For project creation also inspect the previewed folder and resulting files in
scratch. Reload must retain Beta through the real persistence path. A screenshot
or source inspection cannot establish persistence by itself.

Every report.md must state that Files, Search, Preview, draft preservation
and conversation preservation are outside this five-feature seed. Project
selection proves selection and reload only. Keep these coverage limits
visible even when all five mapped journeys pass.

Overall PASS requires all five rows passing on the unchanged candidate, followed
by a final git status and HEAD check. A run against an earlier head cannot pass
the merge gate. Keep private sign-in URLs, cookies and tokens out of logs and
screenshots. Do not capture network traces containing authentication headers.

## Cleanup

Close the browser context and stop only the server process group this run
created. Confirm its PID exited and the port no longer answers. Remove only the
run-owned scratch profile, home, projects and data after successful backup and
restoration checks. If a copy or restoration fails, stop and preserve the saved
state. Evidence is outside scratch, but it is still inside this sandbox and
does not survive sandbox deletion.

Before stopping the sandbox, export the evidence folder to a durable
destination outside the sandbox (for example the laptop, or a shared folder
such as Shared/projects/vivary-team/qa/<pr>-<sha>/), using the Daytona SDK's
own download, never a GitHub token. Verify the export before deleting
anything: list the exported files and confirm each one's sha256 matches its
in-sandbox original. Treat a failed or unverified export the same as a failed
restoration: stop and preserve the sandbox rather than deleting unexported
evidence. Only after a verified export, stop the sandbox and record elapsed
active minutes.

## Helpers

key.py is invoked above. It never produces a verification PASS on its own.
fixtures.json defines source mutations for the independent review. For each
fixture, stop the app, make a byte-for-byte backup outside the checkout, apply
the exact replacement once, rebuild and run the affected journey. Require the
clean baseline to pass first. A build failure or absent precondition does not
prove the planted UI bug was detected.

Restore each source file immediately after its case and run cmp against the
backup. Stop if cmp fails. Rebuild and rerun the affected journey to confirm the
clean behaviour returns. Record the observed failing assertion and both restore
and clean-rerun results. Never commit a mutation or its backup.

Use /verification after application changes to keep this map true.

# Entire for contributors

Keep both the source commit and its supported agent-session checkpoint. GitHub
owns source, issues and PR review. The active Entire mirror keeps source trails.
Future approved project checkpoints use the private
`vivary-dev/vivary-workbench-handoff` repository. Its old source snapshot stays
intact. The [private recording index](https://github.com/vivary-dev/vivary-workbench-handoff/tree/docs/project-recordings)
groups Vivary and website work by source repository and PR.

This setup was checked with Entire 0.10.6. Read the installed `entire agent-help`
and command help before using another version. The [separate checkpoint store
guide](https://docs.entire.io/guides/checkpoints/store-checkpoints-in-another-repo)
explains routing. The [privacy guide](https://github.com/entireio/cli/blob/v0.10.6/docs/security-and-privacy.md)
explains what a checkpoint can contain.

## Destination and upload hold

The committed `.entire/settings.json` gives Entire's web service the dedicated
checkpoint destination. Keep it committed so source trails can locate external
checkpoints. Local settings alone do not provide that web link. Source remotes
still point to the active source repository and its existing mirror.

The dedicated `strategy_options.checkpoint_remote` overrides a named
`checkpoint_push_remote`. Do not replace the private route with the public source
mirror. Native checkpoints use `refs/entire/checkpoints/<shard>/<id>`, separate
from source branch refs. Keep the supported format. The index organizes records
by project without renaming checkpoint refs.

`push_sessions:false` holds automatic uploads. Keep this hold until the existing
shared queue has completed its separate privacy review and upload authorization.
Approval for future project recording does not release older queued records.
Linked worktrees share one Git directory and checkpoint push queue. Disabling
uploads in one worktree does not isolate its records from another worktree's push.
Do not remove queue markers or manually push checkpoint refs around the hold.

## Start a fresh project session

Use the assigned checkout. Preserve existing workers, branches and dirty work.
Before starting a supported agent, run:

```sh
entire status --detailed
entire status --json
entire agent list
```

Confirm enabled capture, the dedicated private destination, the refs backend and
approved hooks for the agent being used. For a fresh checkout, or at the owner's
next fresh session in a disabled checkout, use:

```sh
entire enable --local --agent codex --checkpoint-backend refs \
  --checkpoint-remote github:vivary-dev/vivary-workbench-handoff \
  --skip-push-sessions --telemetry=false --absolute-git-hook-path \
  --agent-help-skill --search-skill --no-init-repo
```

Use `claude-code` instead of `codex` for Claude Code, or add its integration with
`entire agent add claude-code`. Select only agents actually used. Do not import
old history or turn capture on in the middle of an existing conversation. An
established checkout with a different backend needs a reviewed migration first.
Keep `.entire/settings.local.json`, logs and transcripts untracked. The shared
routing file is the only file allowed from `.entire/` in source history.

Codex can discover hooks in the root worktree instead of the assigned worktree.
Read the discovered path in `entire status --json`. If hooks are missing, use
`entire agent add codex` and check that the discovered file contains the reviewed
Entire hooks. Preserve unrelated hooks. If status reports `trust_review_needed`,
review the seven hooks through `/hooks` in the actual Codex client. Entire does
not approve Codex trust. Do not bypass that review or edit approval hashes.
Installed hooks alone do not prove they executed.

The installed 0.10.6 integrations include Codex and Claude Code. Cline is not in
the installed integration list. Do not claim Cline capture without verifying a
supported installed integration and a real session.

## Verify and deliver both records

After the real session starts, use `entire session current` or
`entire session list` to confirm tracking. Keep ordinary reviewed source commits
and push source to its configured remotes. Before claiming capture, inspect:

```sh
entire checkpoint list --json
entire checkpoint explain <checkpoint-id> --json
```

Record the source repository, PR, tested source commit, execution location,
native agent/session, checkpoint ID and trail URL in the private project index.
Report capture and upload separately. Local capture can be verified while remote
delivery remains held. A source-only trail or an empty checkpoint result does not
prove conversation capture. Record unknown evidence as unknown.

After the shared settings are accepted and an authorized real future checkpoint
is delivered, verify that its active source trail resolves the private checkpoint.
Do not mark that web link complete from configuration alone. Existing trails and
checkpoints stay in their original locations. Do not relocate or fabricate them.

For earlier decisions, read `entire agent-help search` and search narrowly before
loading a transcript. Checkpoint content can include private prompts and tool
results. Preserve the approved project scope and destination access boundary.

A controller on another computer that edits Zo through MCP is not a local agent
session. Zo hooks cannot capture that controller's conversation. Use a supported
agent running in the project checkout for future capture, or a separately verified
supported export from the actual controller. Never copy hidden session files as
a substitute. No dummy coding session is needed to prove setup.

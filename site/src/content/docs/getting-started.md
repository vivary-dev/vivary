---
title: "Getting started"
description: "Install published Vivary 0.3.1 and run your first agent workspace."
editUrl: "https://github.com/vivary-dev/vivary/edit/dev/docs/GETTING-STARTED.md"
---

Vivary is a local-first governed-context layer for agent work. It gives a project a
typed knowledge graph, a visible state surface, verification hooks, and human gates.
It does not require a particular editor, agent runtime, database, memory provider, or
MCP client.

> **Release truth:** this page describes **published 0.3.1**. Pin that version.
> Registry `@latest` is 0.3.1 today, but do not rely on an unpinned command. The
> unpublished 0.4.2 five-file contract lives in development source only. The
> [README release table](https://github.com/vivary-dev/vivary/blob/dev/README.md#release-status) is the publication authority.

## Set up with an agent

Paste this into Claude Code, Codex, Cursor, or another coding agent:

```text
Set up published Vivary 0.3.1 in this project.

1. Confirm Python 3.11+ is available. Do not install anything without approval.
2. Pin the scaffolder. Use `uvx --from create-vivary==0.3.1 create-vivary` or `npx --yes @vivary/create@0.3.1`. Do not use unpinned latest. Do not use a checkout command unless I say so.
3. If this folder already has content, run `uvx --from create-vivary==0.3.1 create-vivary adopt . --json`. Show me every file it would add. Existing files must stay byte-identical. Stop on collisions. Apply only after I approve, with `--yes`.
4. If this folder is empty, ask which preset fits (coding, second-brain, knowledge-work, or writing), then run `uvx --from create-vivary==0.3.1 create-vivary init . --preset <choice> --no-wizard`.
5. Verify with `uvx --from create-vivary==0.3.1 create-vivary doctor .` and `uvx --from vivary-tropo==0.4.1 tropo check --root .`. Both must pass.
6. Read AGENTS.md, then follow it.
```

## 1. Install

You need Python 3.11 or newer.

Pin the published scaffolder:

```bash
uvx --from create-vivary==0.3.1 create-vivary --help
npx --yes @vivary/create@0.3.1 --help
```

Pin Tropo the same way:

```bash
uvx --from vivary-tropo==0.4.1 tropo --help
```

Optional published tools:

```bash
uvx --from vivary-ozone==0.2.0 ozone --help
uvx --from vivary-exo==0.2.2 exo --help
```

Do not use `uvx create-vivary` or `npx @vivary/create@latest` without a version pin.
Those commands follow whatever the registry calls latest.

## 2. Create a new workspace

```bash
uvx --from create-vivary==0.3.1 create-vivary init my-workspace --preset coding --no-wizard
cd my-workspace
```

Or from npm:

```bash
npx --yes @vivary/create@0.3.1 my-workspace -- --preset coding --no-wizard
cd my-workspace
```

The preset selects `coding`, `second-brain`, `knowledge-work`, or `writing`.

Published 0.3.1 writes the full-layout scaffold: agent operating files, a starter
typed graph, and skill surfaces. A coding proof run wrote 38 files. Those files are
plain Markdown, TOML, and agent skill files. See the
[published 0.3.1 proof](/walkthrough/).

This is not the unpublished five-file 0.4.2 seed. Do not expect five files from a
registry install.

## 3. Adopt an existing repo or vault

Published adopt is dry-run first. It only adds files. Existing content stays
byte-identical.

```bash
uvx --from create-vivary==0.3.1 create-vivary adopt . --json
```

Read the planned creates and any collisions. Stop on a collision. Apply only after
you approve the add list:

```bash
uvx --from create-vivary==0.3.1 create-vivary adopt . --yes
```

An adopted workspace must pass Doctor and Tropo check. Adopt does not rewrite
existing files.

The unpublished 0.4.2 `--plan <hash>` apply path is not on the registry. Do not use
it with 0.3.1.

## 4. Verify

```bash
uvx --from create-vivary==0.3.1 create-vivary doctor .
uvx --from vivary-tropo==0.4.1 tropo check --root .
```

Both commands must exit `0`.

Optional review and coordination:

```bash
uvx --from vivary-ozone==0.2.0 ozone review --root .
uvx --from vivary-ozone==0.2.0 ozone impact <node-id> --root .
uvx --from vivary-exo==0.2.2 exo board --root .
```

Tropo can inventory a tree without a workspace config:

```bash
uvx --from vivary-tropo==0.4.1 tropo map --root .
```

## 5. Operate the loop

The compact operating loop is:

> Ask → retrieve → act → verify → learn → gate.

Start with `AGENTS.md`. Load `STATE.md` when the current focus or next action
matters. Stop at authority, privacy, destructive, publishing, credential, or
deliberate human-approval gates.

## Unpublished 0.4.2 source

The five-file thin contract, `create-vivary record`, exact-hash adopt apply, and
optional `vivary-mcp` are development source. They are not on the registry.

To inspect that candidate from a checkout:

```bash
python packages/create-vivary/create_vivary.py --help
python packages/tropo/tropo.py --help
```

Do not substitute those commands for a stranger install. Do not describe them as
published.

## Next

- [Published 0.3.1 proof](/walkthrough/): scaffold, doctor, review, blast radius.
- [Guide library](/learn-by-doing/): one task at a time. Published guides pin 0.3.1.
- [Command reference](/commands/): flags, outputs, and exit codes. Unreleased
  commands are marked.
- [Architecture](/architecture/): ownership and package boundaries.

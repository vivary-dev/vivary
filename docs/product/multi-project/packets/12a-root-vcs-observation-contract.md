# 12a: Define the trusted root and VCS observation boundary

Type: packet
Parent: 12
Status: done
Depends-on: [03c]
Owner: Coordinating Codex, sole writer, with an independent Codex reader
Scope: Storage-neutral observation contract and deterministic expected filesystem/VCS oracles only. No production registry schema, write-back, live project mutation, or production adapter activation.
Verification-kind: inspection
Evidence: [Observation contract receipt](../receipts/12a-root-vcs-observation-contract.md)
Verification-result: passed
Timebox: One context window. Stop when every required observation and refusal has a traceable fixture and a second reader finds no caller-controlled authority field.

## Goal

Define the trusted observation needed to distinguish a path alias from a
recreated directory and author expected oracles for common mutation keys across
no-VCS, Git, linked worktree, monorepo, Jujutsu, and colocated Jujutsu layouts.

## Context

Read the portable registry contract, the reviewed 03c transaction map, outcome
12, the filesystem model in `design.md`, and the Jujutsu evidence it cites. The
03c inspection found no callable existing adapter that supplies the whole trusted
observation. A normalized path, connection config, VCS remote, content digest,
or in-process lock is not physical-root identity or mutation authority.

This packet defines the observation contract and expected oracles before
implementation. It must not invent registry action names, select a database, or
make unsupported layouts writable.

## Owned files

- Create
  `docs/product/multi-project/contracts/root-vcs-observation.md`.
- Create
  `docs/product/multi-project/fixtures/root-vcs-observation.json`.
- Create
  `docs/product/multi-project/receipts/12a-root-vcs-observation-contract.md`.
- PR #333 review correction: amend the private VCS field in
  `docs/product/multi-project/contracts/project-registry.md`, its synthetic
  `fixtures/project-registry.json` oracle, `scripts/registry_contract_model.mjs`,
  and `scripts/tests/test_registry_contract_model.mjs` together. This keeps the
  observation contract and its reference consumer consistent; it adds no
  production storage or adapter.
- Update this packet and graph only after independent review.

## Required cases

1. The same directory through path aliases resolves to one `rootId`; a directory
   recreated at the same locator resolves to a different `rootId`.
2. Missing, non-directory, inaccessible, and identity-unverified roots remain
   distinct refusals. Probe failure never downgrades VCS kind to `none`.
3. No-VCS, ordinary Git, linked worktree, nested project in one checkout,
   monorepo siblings, Jujutsu workspace, colocated Jujutsu, submodule, dirty,
   detached, and unsupported/ambiguous layouts have exact observations.
4. Git and colocated Jujutsu expose stable common repository and checkout IDs;
   two worktrees share the repository key and differ on checkout key. No-VCS
   exposes only its root key.
5. Exactly one mutation owner is reported. Unresolved colocated or unsupported
   layouts are read-only.
6. Overlapping writable roots are accepted only when a verified common
   reservation domain makes the overlap safe. Nested no-VCS roots and mixed
   no-VCS/repository containment remain ambiguous.
7. A fresh observation includes root access and `contentRevision` evidence, and
   states which facts can be rechecked at the external effect boundary.
8. Fixture inputs model platform observations; product callers cannot submit
   `rootId`, identity verification, overlap, repository/checkout IDs, mutation
   owner, content revision, or root access as authority.

## Done condition

- Every root/VCS field consumed by registration, rebind, mutation admission, and
  write-back in `vivary.project-registry-contract.v1` has one adapter-produced
  source or an explicit unsupported result.
- Expected resource keys follow the contract's structured
  `(deviceId, resourceKind, resourceId)` domain and model shared-repository
  contention without using paths, project IDs, actors, collections, URLs, or
  GUI tabs as the common key.
- The expected fixture oracles cover alias convergence, recreated-directory
  separation, common Git repository contention, distinct checkout identity,
  no-VCS root ownership, colocated Jujutsu single ownership, and safe refusal
  for ambiguity.
- A second reader checks the fixtures against R3, R4, R8, and R10-R13 and reports
  any unowned or caller-controlled fact.
- The receipt says which platform-specific implementation and Habitat runtime
  checks remain. Structurally valid expected oracles do not claim live
  filesystem or cross-process fencing behavior.

## Verify

Read the exact owning rules and inspect existing source before writing. Validate
the JSON structure and documentation consistency. These commands do not execute
a physical root adapter or prove the expected oracle behavior.

Run the package/Workbench search from the preserved `Jeff-Kazzee/littleagent`
checkout, as in 03c. Run the other commands from the canonical Vivary worktree.
No source import is required. If the preserved checkout is unavailable, use the
03c receipt's explicit source findings and record that inspection limit; the
storage-neutral contract work can still proceed.

```console
rg -n "R3|R4|R8|R10|R11|R12|R13|rootId|locationRef|repositoryId|checkoutId|mutationOwner|contentRevision" docs/product/multi-project/contracts/project-registry.md docs/product/multi-project/contracts/project-registry-transaction-map.md docs/product/multi-project/design.md
rg -n "rootId|locationRef|repositoryId|checkoutId|realpath|gitDir|commondir|canonicalCwd" apps/workbench node_modules/@agent-native/core/dist -g '*.ts' -g '*.d.ts'
python -m json.tool docs/product/multi-project/fixtures/root-vcs-observation.json
python -c "import json,pathlib; d=json.loads(pathlib.Path('docs/product/multi-project/fixtures/root-vcs-observation.json').read_text(encoding='utf-8')); c=d['cases']; assert d['fixtureVersion']==1 and isinstance(c,list) and c and len({x['id'] for x in c})==len(c)"
node --test scripts/tests/test_registry_contract_model.mjs
python scripts/check_multi_project_plan.py --check
python scripts/check_line_endings.py
git diff --check
```

## Stop conditions

Do not write a production root resolver, registry action, schema, migration,
file adapter, lock, runner, or write-back path. Do not probe a personal or live
project root. Do not initialize, mutate, adopt, repair, or publish a Git or
Jujutsu repository. Do not treat expected fixture oracles as proof of Habitat
filesystem identity or an enforceable external-process fence.

## Next packet

Prepare 12b for implementation and physical fixture execution only after a
second reader accepts the 12a contract and expected oracles in a later session.
Do not create 12b in this packet.

## Log

- 2026-09-05: Prepared from packet 03c's source inspection. The inspected Core
  and Workbench surfaces had no callable adapter providing the complete trusted
  root/VCS observation required by the registry contract.

## Verification log

- 2026-09-06: The sole writer inspected both repositories, the owning rules,
  installed Core 0.176.5, preserved host/readiness source, and primary Git/Jujutsu
  references before drafting. No physical adapter or live project was exercised.
- 2026-09-06: Accepted 61 observation cases, 21 identity/key relations, and 15
  boundary assertions after independent review. Corrected three unsupported
  layouts whose content revisions still referenced no-VCS state.
- 2026-09-06: JSON structure, exact expected relations, planning checks, line
  endings, diff checks, and technical-writing lint passed. The separate Windows
  planning suite ran 67 tests with two failing newline subcases in one unchanged
  test helper. The receipt preserves that result and the prior temporary-storage
  failures. No universal suite pass is claimed.
- 2026-09-06: Stopped at the accepted contract checkpoint. The receipt describes
  the later implementation session and prerequisites. No 12b, adapter, database,
  runtime start, write-back, or production lock was created. Outcome 12 stays open.
- 2026-09-06: PR #333 review found five contract/oracle gaps. Corrected
  scoped read-only grants, private Jujutsu administration binding, Git
  replacement and R13 root-conflict oracles, and the frontier receipt.
  The observation fixture now has 68 cases, 28 relations, and 19 boundary
  assertions. The shared synthetic registry contract/model stayed in
  sync; 39 tests and 59 fixture decisions pass after the two new cases
  first failed under the old validator. See the receipt for review evidence.

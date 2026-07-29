---
title: "Changelog"
description: "Release history for the Vivary packages."
editUrl: "https://github.com/vivary-dev/vivary/edit/dev/CHANGELOG.md"
---

Notable changes to Vivary. The project ships several **independently versioned**
packages, so each entry names the package(s) it affects. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the initial suite release is
the `v0.1.0` line.

**Current release line:** `create-vivary` / `@vivary/create` **0.3.1** · optional
`vivary-memory-cognee` **0.1.0** · `vivary-tropo` **0.4.1** · `vivary-ozone`
**0.2.0** · `vivary-exo` **0.2.2**. Versions are independent; there is no single
"Vivary 0.4.1" release.

## [Unreleased: governed Tropo, Strato, and Ozone adapters] — 2026-07-26

Affects the source checkout's unreleased `vivary-core` **0.2.2**, `vivary-tropo`
**0.5.0**, `vivary-strato` **0.1.1**, `vivary-ozone` **0.3.0**, and `vivary`
meta-package **0.1.2**, the first three role-to-core dependency edges, package
documentation, and CI packaging proof. The published releases remain Tropo **0.4.1**,
Ozone **0.2.0**, and `vivary` **0.1.0**; Strato and core remain unpublished during
development. No package was published, deployed, or enabled by default; publication
remains part of the final coordinated release train and requires a separate human gate.

### Added

- `tropo find <task> --governed [--max-claims N]` — an explicit experimental adapter
  from one normalized, allowlisted, read-only Tropo root through `vivary-core`
  observation, content search, evidence-graph projection, and bounded Task Capsule
  compilation. JSON and human output expose evidence-backed claims, conflicts,
  unknowns, omissions, observed required checks, stable selection reasons, and the
  capsule fingerprint. Unicode question terms preserve order and deduplicate; one-letter
  ASCII contraction fragments are discarded before the first **16** meaningful terms
  enter the bounded core content search.
- Top-level `vivary_core` exports for the four deep-module entry points used by the
  adapter: `observe_checkouts`, `observe_content`, `project_workspace_graph`, and
  `compile_task_capsule`.
- Direct regressions for the real Git-backed pipeline, equivalent Windows root casing,
  symlink aliases of the worktree root, Unicode workspace paths and question terms,
  observed check derivation, non-negative capsule budgets, missing-core installation
  errors, and rejection of incompatible
  plain-find/query flags including `--budget 0`.
- The packaged integration smoke now installs core beside Tropo, proves the wheel's
  declared dependency metadata, and exercises the installed governed command.
- The cross-platform orientation matrix now runs the full Tropo suite on
  `windows-latest`, including the governed root-casing contract.
- Session-scoped test harnesses isolate the core and Tropo suites from host user Git
  policy by pinning `HOME`, `USERPROFILE`, and `XDG_CONFIG_HOME` to throwaway Git
  homes. Tropo's direct `__main__` runner uses the same boundary, keeping observation
  fixtures, dirty facts, and fingerprints reproducible under both supported test
  entry points.
- `vivary-strato` **0.1.1** — the first independently versioned Strato runtime package.
  `strato decide --governed` validates a pinned request/policy schema, core-owned actor
  and authority class, workspace fingerprint, absolute path scope bound to its Task
  Capsule, a non-empty project audit label, and caller-supplied timestamps before
  delegating to core's pure budget, capsule/receipt-gate, and next-loop policy. The
  capsule body fingerprint and deterministic identifier are recomputed before
  delegation, so changing either the capsule contents or its identity after compilation
  is refused before policy. Receipt integrity is checked separately against the capsule
  and workspace fingerprints. The compiler and verifier
  share the JavaScript-lossless `max_claims` bound; malformed task scopes, missing
  compiler-owned fields, and non-canonical values that would be lossy in JavaScript are
  refused before policy. Requests, capsule observations, and receipts have a
  deterministic 300-second
  freshness window; a verdict without its receipt is rejected. Unknown fields and
  non-string Python mapping keys fail closed, so free-form status text cannot
  impersonate a human gate. Incomplete capsule envelopes and inputs whose JSON or
  evidence graphs are too deeply nested fail closed with typed refusal
  reasons instead of reaching core as successful policy evaluations. `--json` separates
  validated `vivary.strato-decision/v0` documents from
  `vivary.strato-decision-refusal/v0` envelopes with stable reason codes; advisory mode
  exits `0`, while `--strict` exits `1` for a valid `blocked` or `request_gate` result.
- Strato's package and CLI contract have direct tests for core delegation, budget
  exhaustion, intact/insufficient/tampered/stale/malformed/recursive evidence,
  deterministic results, identity boundaries, malformed and deeply nested documents,
  advisory/strict exit semantics,
  and default text output. Isolated package smokes exercise the installed console
  script on Windows and WSL Linux.
- `vivary-ozone` **0.3.0** adds `ozone verify REQUEST --governed`, an explicit
  experimental facade over core's receipt-integrity, gate-sufficiency, and dry-run
  repair contracts. It recomputes Task Capsule identity, binds the workspace and
  caller-supplied clock, applies a deterministic 300-second evidence window, and
  rejects malformed gate constraints, invalid typed graph relationships, and malformed
  or deeply nested repair inputs before calling core. It refuses unknown
  capsule/receipt fields even when the artifact is re-fingerprinted, enforces core's
  16-entry omission-list/count contract and a 128-byte JSON-encoded ceiling on repair
  identifiers, caps total checkout-pair scans across all repositories, bounds
  route-proposal evidence to core's checkout cap, and bounds derived repair estimates
  to JavaScript's lossless integer range before delegation.
  It returns typed verification or refusal envelopes. Core's fingerprinted receipt/gate
  verdicts and repair proposal pass through unchanged; Strato consumes the raw
  `gate_verdict` without a second verification implementation. Plain-text refusal
  output JSON-escapes reason fragments before writing them, including unpaired Unicode
  surrogates. Advisory mode exits `0`, `--strict` exits `1` for a valid insufficient
  result, and malformed/refused requests exit `2`.
- Ozone regressions cover sufficient, wrong-claim-ID, duplicate-claim-ID, missing,
  tampered, stale, workspace-mismatched, budget-limited, unknown-artifact,
  bounded-repair, pair-scan-bound, route-evidence-bound, identifier-bound,
  omission-bound, estimate-bound, gate-shape, graph-relationship, output-escaping,
  malformed, recursive, repair, CLI, and real Ozone-to-Strato cases.
  The installed-package CI smoke proves Ozone's core floor, runs the packaged Ozone
  verdict path, and hands its unchanged verdict to Strato.

### Changed

- `vivary-core` advances from 0.2.0 to 0.2.2. Version 0.2.1 introduced the governed
  adapter API; 0.2.2 hardens the compiler/verifier integrity boundary.
  `vivary-tropo` advances from 0.4.1 to 0.5.0 because the governed flags are a
  user-visible minor feature and keeps `vivary-core>=0.2.1`, the first source version
  exposing the adapter API. This is the first real package-to-core dependency promised
  by [#207](https://github.com/vivary-dev/vivary/issues/207). The `vivary` meta-package
  advances from 0.1.0 to 0.1.2: 0.1.1 raised its floor to `vivary-tropo>=0.5.0`, and
  0.1.2 raises its floor to `vivary-ozone>=0.3.0`, so a fresh suite install cannot
  resolve the pre-verification Ozone CLI. All development versions remain unpublished
  until the coordinated release.
- `vivary-strato` advances from 0.1.0 to 0.1.1 for the capsule-integrity hardening and
  declares `vivary-core>=0.2.2`. The `vivary` meta-package does not add Strato yet;
  completing the one-install role surface remains owned by #207. Both Strato and core
  stay explicitly allowlisted as unpublished until the final coordinated release gate.
- `vivary-ozone` advances from 0.2.0 to 0.3.0 because `verify --governed` is a
  user-visible command and declares `vivary-core>=0.2.2` with its first real core
  import. Plain `review`, `impact`, and `packs` behavior remains unchanged. Ozone
  0.3.0 stays unpublished until the final coordinated release gate.
- Plain `tropo find` keeps its existing typed-context packet and default token budget.
  Governed-only flags, malformed core inputs, and broken core installs fail with the
  documented usage exit code `2`; the command reference owns the exact flag contract.
- Core's shared bounded subprocess runner drains stdout and stderr concurrently, so a
  Git child that fills stderr first cannot deadlock observation. Cleanup kills stalled
  children, closes completed pipes, and returns a structured timeout rather than
  blocking on an inherited stderr handle.
- Derived required checks now carry checkout-scoped names, the normalized checkout
  `cwd`, and the observation that actually proves each command. This prevents one
  checkout's receipt from clearing another checkout's check. An observed npm test
  script also no longer suppresses an undetermined Python test-system warning in a
  polyglot checkout.
- Governed content now uses NUL-framed Git output, literalizes every path before
  `git check-ignore`, and excludes tracked files covered by repository ignore policy
  without naming them in evidence. Unexpected ignore output and incomplete
  injected-runner failures fail closed. Unicode workspace paths
  use a deterministic graph-ordering fallback; unrankable non-content capsule facts
  become explicit omissions instead of aborting Unicode queries.
- Governed mode refuses a Tropo root nested inside a larger Git worktree rather than
  labeling repository-wide checkout facts as scoped to the nested directory.
- Standalone Tropo graphs now derive only `tropo check`; `create-vivary doctor` requires
  the observed `tropo.toml` + `AGENTS.md` + `STRATO.md` scaffold identity. Governed
  query fallback no longer restores filtered stopwords or one-letter ASCII fragments,
  and checkout observation sorts non-Latin remote names with the deterministic Unicode
  fallback instead of aborting.
- Governed content is bracketed by checkout observations and retried once when the
  worktree changes. Dirty or privacy-filtered checkouts also require two identical
  content scans inside a stable fact bracket; persistent mutation produces an explicit
  content-unavailable unknown instead of a mixed-state capsule. A checkout whose dirty
  state cannot be established reports `dirty_state_unknown`, not a false mutation race.
  Every default Git command used for observation or content retrieval disables
  repository-configured filesystem monitors. Workspace markers and package scripts
  pass through the same fail-closed ignore-policy filter as content and dirty paths;
  reparse-point and multiply linked markers are rejected, and package manifests are
  read through a bounded descriptor whose file identity is verified before and after
  opening. An ignored or externally linked manifest cannot leak facts or derive an
  executable check.
  The hardened boundary preserves Git-parsed `core.autocrlf`/`core.eol` and an
  explicit readable global or system `core.excludesFile` without honoring ambient
  `GIT_*` injection or overriding repository-scoped ignore policy. Host ignore
  policy can therefore legitimately change dirty facts, workspace fingerprints, and
  capsule IDs between machines, matching the host's own `git status`.
- Derived checks execute from the observed Git worktree root even when the requested
  checkout path is nested. Excessively nested `package.json` input now degrades to no
  npm check instead of escaping the structured observation contract.
- Semantic-memory configuration now returns structured misconfiguration results for
  unreadable or invalid-UTF-8 TOML. Optional-provider failures identify the provider
  boundary and name a workspace-disabled `memory.cognee.allow_network` gate without
  returning exception text that can disclose filesystem paths.
- Generated `llms.txt` package surfaces read published versions from the root release
  table rather than unreleased source manifests. On-demand examples use
  `uvx --from <distribution> <command>`, matching each package's console entry point.
  The Strato integrity gate now locks core's full-scaffold marker set to
  create-vivary's repair contract.
- The Tropo package quickstart copies the example vault into a guarded temporary Git
  fixture, commits it with local throwaway identity, demonstrates content-backed
  governed claims, and removes the fixture on exit.
- Command, package, architecture, root overview, and generated-site truth now describe
  the opt-in boundary, dependency direction, and no-fetch/no-write/no-provider
  constraints.

### Verification

- `python packages/tropo/tests/test_tropo.py` — **169/169** passed on Windows.
- `wsl.exe -e bash -lc "python3 packages/tropo/tests/test_tropo.py"` — **169/169**
  passed on WSL Linux.
- `python -m pytest packages/core/tests/ -q` — **626 passed** on Windows;
  `UV_CACHE_DIR=/tmp/vivary-uv-cache TMPDIR=/tmp uv run --no-cache --with pytest
  python3 -m pytest packages/core/tests/ -q -p no:cacheprovider` — **624 passed,
  2 platform-specific skips** on WSL Linux.
- `python -m pytest packages/strato/tests -q` — **48 passed** on Windows and
  **48 passed** on WSL Linux.
- `python -m pytest packages/core/tests/test_policy.py -q` — **91 passed**;
  `python -m pytest packages/core/tests/test_control.py -q` — **101 passed**.
- Isolated Windows and WSL `uv run --no-cache --with ./packages/core --with
  ./packages/strato` smokes built core **0.2.2** and Strato **0.1.1**; installed
  metadata matched Strato's runtime version and `strato decide --help` exposed the
  governed JSON/strict command surface.
- `python -m pytest packages/tropo/tests/test_tropo.py -q -k "governed or
  cmd_find_returns_context_packet"` — **17 passed**.
- Isolated `uv run --no-cache --with ./packages/core --with ./packages/tropo`
  metadata smoke reported core **0.2.2** and Tropo **0.5.0**.
- Coordinated local `uv run --no-cache --with` smoke across core, Tropo,
  create-vivary, Ozone, Exo, and the meta package reported `vivary` **0.1.2**,
  Tropo **0.5.0**, and core **0.2.2**.
  The packaged smoke also verified that the installed core version satisfies Tropo's
  declared requirement specifier, not merely that the metadata names it.
- `python -m pytest packages/vivary/tests/ -q` — **9 passed**; the manifest/runtime
  version and `vivary-tropo>=0.5.0` floor matched.
- `python packages/create-vivary/tests/test_privacy_differential.py` — **2/2
  passed** with global Git config, excludes, templates, and fsmonitor isolated from
  the real-Git oracle.
- `python scripts/tests/test_package_docs_parity.py` — **10/10 passed**;
  `python scripts/check_package_docs_parity.py` — **6** published manifests and
  **2** unpublished allowlist entries matched the architecture page.
- `python scripts/check_line_endings.py --verbose` — **265** tracked text files
  checked; **8** legacy files remain explicitly allowlisted.
- `python packages/tropo/tropo.py check --root packages/tropo/examples/vault` —
  **4** documents, zero errors or warnings.
- Repository verification also passed: Ozone **42/42**, Exo **17/17**,
  create-vivary **143 tests with 1 platform skip**, asset parity **3/3**, and
  Strato integrity **7/7**.
- `cd site && npm run test:site && npm run build && npm run test:links` — **8/8**
  site tests passed; **23** pages built; **1,686** local references and **1,060**
  anchors checked with zero failures.

## [Unreleased: cross-platform orientation proof] — 2026-07-26

Affects repository proof automation and CI only. No package version, public command,
publication, deployment, or generated workspace behavior changes in this slice.

### Added

- Added one disposable orientation runner, implemented without third-party Python
  imports and using Node, uvx, and Git for the real transport and checkout proof, for
  `tropo map → create-vivary adopt → create-vivary doctor → tropo find` loop across
  current, legacy flat-layout, brownfield, already-adopted, divergent-checkout, and
  corrupt fixtures.
- Exercised the Python and npm entry points together, with strict normalized-JSON
  parity, dry-run-before-apply enforcement, exact mutation allowlists, post-apply
  adopt idempotence, Git branch/HEAD/ref preservation, bounded read-only map/find checks,
  and honest Doctor compatibility results.
- Added a sanitized aggregate JSON receipt with command, version, fixture fingerprint,
  expected/actual mutation, parity, Doctor, retrieval, and Git-preservation evidence.
  CI runs the proof independently on `ubuntu-latest` and `windows-latest` and uploads
  each receipt even when a fixture fails.

### Verification

- `python packages/create-vivary/tests/test_orientation_proof.py` — **7/7** focused
  runner and receipt regressions passed.
- `python packages/create-vivary/tests/orientation_proof.py --receipt
  orientation-proof.json` — all **6/6**
  fixtures passed on Windows with real Python and npm transports.
- `cd site && npm run sync-docs && npm run build` — **23** documentation pages built
  after regenerating the source-doc and changelog mirrors.
- `python scripts/check_line_endings.py --verbose` — tracked text files checked; **8**
  legacy files remain explicitly allowlisted.
- `python scripts/check_package_docs_parity.py` — package documentation matches all
  **6** published manifests and the one explicit unpublished allowlist.
- `git diff --check origin/dev` — clean.

## [Unreleased: create-vivary npm adopt dispatch] — 2026-07-26

Affects `@vivary/create` argv transport, launcher coverage, and package documentation.
No package version, Python command behavior, publication, or deployment changes occur
in this slice.

### Fixed

- Made the npm launcher a shell-free transport that forwards argv unchanged to the
  canonical Python CLI, which solely owns command recognition and bare-name-to-`init`
  normalization.
- Added launcher coverage for raw passthrough of all five documented public command
  names, runner fallback and status propagation, both-runner error reporting, package
  pins, and shell-free stdio inheritance.
- Kept Python-only coverage for bare-name normalization and every canonical public
  subcommand, without requiring Node.

### Verification

- Node launcher coverage exercises raw explicit, bare, and leading-flag passthrough;
  uvx/pipx success and nonzero propagation; both-runner stderr; pinned package args;
  and shell-free stdio-inherited spawning.
- Python launcher coverage exercises bare-target-to-`init` normalization and explicit
  handling for every canonical public subcommand without invoking Node.

## [Unreleased: Bellamente predecessor contract and semantic adapter truth] — 2026-07-26

Affects public documentation, its generated website mirror, future implementation
contracts, and the source checkout's unreleased `vivary-memory-cognee` 0.1.1 privacy
floor. The published release remains 0.1.0; no provider call, memory mutation, MCP,
install, version, publication, or deployment action occurs.

### Changed

- Reconciled [#160](https://github.com/vivary-dev/vivary/pull/160) as the normative
  predecessor to #190: Bellamente remains an independent, workspace-local AgentLTM;
  Tropo-backed semantic adapters and the provider-neutral `vivary-core` candidate
  firewall are separate seams; learned memory never silently becomes authored truth.
- Locked explicit opt-in before any disabled AgentLTM policy is created, the complete
  fail-closed private set, truthful declarative capability and Doctor behavior, and
  separate human gates for install, activation, MCP enablement, every mutation, and
  release dogfood. Ordinary scaffold/adopt runs create no AgentLTM surface; selected
  output is disabled policy and inert instructions only.
- Corrected `docs/SEMANTIC-MEMORY.md` to match the shipped asynchronous Cognee adapter:
  the adapter owns privacy-filtered snapshot construction, indexing refreshes the
  whole dataset, recall accepts only known-node typed hits, forget removes the whole
  approved dataset, and Doctor remains module-level and provider-free.
  Recall documentation now names Cognee's fixed `source = "provider"` label, with the
  package contract test asserting that value.
  Current Doctor ordering is now explicit: `unavailable` short-circuits state-path
  validation, so that status does not attest path safety.
- Routed the nested Bellamente contract from the documentation index and the generated
  semantic-memory page without creating an unsupported site route.
- Made `docs/bellamente-memory/SPEC-bellamente-memory.md` the sole owner of the
  physical-store/persisted-payload, private-set, Doctor-state, normalized-input, and
  firewall-result contracts; the ADR, glossary, and core package README now route
  instead of restating them. It pins accepted
  exact-duplicate preserve and independent-evidence corroboration evaluations, plus
  accepted no-match evaluation with empty `reason_codes`; `review_required` outcomes
  for explicit correction, unresolved identity, and value conflict; and rejected
  stale, provider-degraded, or unfingerprinted inputs.
- The source checkout's unreleased adapter floor includes `.strato/private/**` and now
  matches privacy paths case-insensitively on Windows, with snapshot-level regression
  coverage. Public docs distinguish that behavior from published 0.1.0. The remaining
  escaped/complex Git-ignore limitation stays explicit and tracked by
  [#236](https://github.com/vivary-dev/vivary/issues/236).
- **create-vivary Doctor compatibility (#199)** — Doctor now distinguishes the strict
  15-path v0.1 common contract from legacy flat and v0.2+ indexed module layouts.
  Valid published workspaces receive preset-preserving, read-only upgrade
  recommendations, including actionable warnings for newer privacy-ignore lines they
  predate. Partial modern indexes, common root/runtime-skill gaps, and privacy gaps
  owned by each declared semantic-memory profile remain errors. The versioned
  `compatibility` report is schema version 1.
- **Declared configuration integrity (#199)** — Doctor validates recognized published
  and current embedded/cloud storage and local/Cognee memory profiles, including every
  field in the generated current profile without rejecting the narrower published
  v0.3.1 memory profile. It rejects empty declared storage strings, unknown cloud
  providers, privacy downgrades below the published floor, and enabled
  `memory.provider = "none"`, while preserving graph/trend metrics when a declared
  optional-memory config is malformed.
- **Indexed repair recognition (#237 follow-up)** — `doctor --repair` now recognizes
  either surviving indexed module-contract marker, so losing `modules/index.md` alone
  does not block unrelated conservative repairs.

### Verification

- `python packages/memory-cognee/tests/test_memory_cognee.py` — **50/50** adapter
  tests passed.
- `cd site && npm run test:site` — **8/8** site tests passed.
- `cd site && npm run build && npm run test:links` — **23** pages built; **1,644**
  local references and **1,018** anchors checked with zero failures.
- `python scripts/check_line_endings.py --verbose` — **231** tracked text files
  checked; **8** legacy files remain explicitly allowlisted.
- `git diff --check origin/dev...HEAD` — clean.
- Rendered `/semantic-memory/` browser smoke — all three seams, current/future
  divergence, absolute Bellamente contract link, published-0.1.0 versus unreleased
  privacy behavior, Windows matching, the #236 link, and no horizontal overflow
  verified.

## [Unreleased: vivary-core, the governed-context seam] — 2026-07-26

Introduced `vivary-core`, an in-repo library under `packages/core/`. It was not
published to PyPI or reachable from a shipping CLI in this initial slice; the first
outward adapter is recorded in the later Tropo governed-context entry above. No
existing package changed its published version here. The in-repo `vivary-core`
version is **0.2.0**. Nothing
about installing or running Vivary changed in this slice.
Publishing remains a manual human gate. No package publishes before the comprehensive
coordinated release train is complete and separately approved.

### Added

- `vivary-core` — the shared seam the role packages will speak through, so "what is
  true, and how do we know" has one implementation rather than four that drift.
  Canonical JSON, sha256 fingerprints and deterministic IDs; read-only checkout
  observation over explicit allowlisted roots; projection into a typed evidence graph
  where divergent checkouts stay unresolved conflicts with both sides preserved;
  bounded task capsules where every claim carries its evidence and selection reason;
  and receipts bound to the exact capsule and workspace fingerprint they ran against.
  Documented in [the architecture page](/architecture/). (Site-absolute route, not a
  repo-relative path: `CHANGELOG.md` is mirrored to `/changelog/`, where `docs/…`
  would resolve against that route and 404. Same convention the docs pages use.)
- `scripts/check_package_docs_parity.py` — a CI guard that derives the published-package
  list on [the architecture page](/architecture/) from `packages/*/pyproject.toml` plus
  one explicit `UNPUBLISHED` allowlist, so documented package truth cannot drift behind
  the manifests again. It caught two published packages missing from that list on the
  very commit that introduced it. Covered by `scripts/tests/test_package_docs_parity.py`
  (10 cases), which pins the wrapping behaviour of that prose bullet — reading only its
  first physical line would report wrapped names as missing and redden CI on a correct
  doc.
- Completed the in-core reference surfaces for the four role layers without wiring
  them into shipping CLIs: Strato owns fail-closed budgets, capsule/receipt gates, and
  loop transitions; Ozone owns receipt-integrity verdicts, gate sufficiency, and
  bounded gated repair proposals; Exo owns claims, leases, handoffs, dependencies,
  execution evidence, and task views; Bellamente owns the SPEC-owned
  candidate-recall firewall: accepted evaluations and gated review-only
  corrections preserve authored truth. The canonical architecture page and its
  generated site mirror now describe these surfaces explicitly.

### Changed

- **Recorded the selected dependency direction for `vivary-core`** — the first
  acceptance criterion of [#207](https://github.com/vivary-dev/vivary/issues/207). Role
  packages depend on core; the `vivary` meta package receives it transitively and does
  not declare it, so there is one owner per edge and no version-pinning fight. The edge
  is added to a role's `pyproject.toml` in the *same commit* that makes that role first
  import `vivary_core`, never ahead of it. That is why no role manifest depends on
  `vivary-core` yet: no role imports it, and a dependency nothing uses is a declaration
  the code does not support. Recorded on [the architecture page](/architecture/) and in
  the release workflow's bump table.
- The architecture page's PyPI list named four packages while six are published. It now
  also names `vivary` and `vivary-memory-cognee`, and says plainly that `vivary-core`
  remains unpublished during development and publishes only in the final comprehensive
  coordinated release train. The seam description stopped asserting in the present
  tense that every role package speaks through core — none does yet.
- The architecture opening, root agent contract, root README, and create-vivary
  PyPI/npm package copy now state Vivary's settled standard/scaffolder and
  governed-context descriptions directly instead of using the retired
  `create-t3-app` comparison.
- The release workflow now treats core as the library it is: its manifest is the sole
  in-repo version declaration, it ships in the same final release train as its
  dependent roles while uploading first inside that train, the `vivary` meta package
  uploads after its component floors, and registry smokes prove both direct core and
  meta-package installs expose `vivary_core` with the expected distribution versions.
- The edited root README, release workflow, and generated release-workflow mirror are
  now LF-normalized, and their retired legacy line-ending allowlist entries are gone.
- The lean root verification block now includes the core suite and current observed
  counts for the four fast local package suites; exhaustive jobs remain CI-owned.

### Fixed

Findings from the `vivary-core` review, all pre-release and none user-reachable:

- **Git environment injection.** Observation dropped four `GIT_*` variables, so
  command-scope config (`GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_*` / `GIT_CONFIG_VALUE_*`)
  could make a repository with no remotes observe as having an attacker-supplied
  origin — which then became the repository identity used for grouping, conflicts and
  fingerprints. The environment is now pinned rather than filtered.
- **Credential disclosure.** A remote URL embedding credentials was stored verbatim as
  both a fact and the repository identity, reaching observations, graphs, capsules and
  fingerprints. Userinfo is now stripped before storage.
- **Remote-less repositories are first-class.** Identity fell back to the checkout
  path, so each linked worktree of a repository without a remote became its own
  repository node and their divergence never surfaced. Identity now falls back to
  Git's common directory, which every linked worktree shares.
- **Capsule scope is enforced, not decorative.** `task.scope` was copied into the
  output but never applied, so a capsule could declare one scope and carry claims,
  conflicts and unknowns from outside it.
- **Content evidence is bound to the snapshot it was observed at**, so an excerpt from
  an earlier scan can no longer be presented as evidence about a later state.
- **Failed content searches are visible.** A search that could not run was
  indistinguishable from a search that found nothing.
- **Required checks are derived, not hardcoded.** Every workspace was told to run
  `npm test`, `npx create-vivary doctor` and `entire status`. Checks are now derived
  from observed markers with their evidence attached, an undeterminable test command
  is reported as an unknown rather than guessed, and `task.required_checks` overrides.
- Windows allowlist paths compare case-insensitively; a corrupt symbolic HEAD reports
  `unknown` instead of "detached"; the git output bound is enforced while the process
  runs rather than after; search terms are matched as fixed strings, not regexes; and
  negative claim budgets fail closed instead of silently widening the capsule.
- **Equivalent Win32 device paths share one claim scope.** Extended-length drive
  and UNC spellings can no longer acquire a second claim over a tree already
  covered by its ordinary drive or UNC path.
- **Duplicate Ozone check names preserve the worst evidence.** A later passing
  entry can no longer erase an earlier failed or skipped result for the same
  required check.
- **Malformed configured loop budgets fail closed.** Non-numeric, boolean,
  `NaN`, and infinite limits or counters exhaust the affected dimension with
  deterministic typed details; omission remains the only unbounded form.
- **Capsule compilation, gate validation, and budget validation agree on shape.**
  Capsule IDs, capsule fingerprints, and workspace fingerprints are mandatory;
  non-dict graph nodes or facts are rejected instead of being partially compiled.
- **Ozone keeps optional constraints and binding failures distinct.** An explicit
  null claim-verification constraint remains absent, while a partial capsule cannot
  produce a `sufficient` verdict. A receipt whose own capsule/workspace bindings are
  incomplete reports the new pinned `missing_binding` reason instead of masquerading
  as a mismatch with a supplied capsule.
- **Strato verifies receipts and bound Ozone verdicts before clearing a gate.**
  Receipt fingerprints and deterministic IDs are recomputed. Verdict fingerprints,
  bindings, typed projections, and outcome consistency are checked. Genuine
  non-sufficient early verdicts bound to the same receipt keep their actual Ozone
  reasons; a receiptless non-sufficient verdict supplied later with a receipt yields
  `verdict_binding_mismatch`. A `sufficient` verdict also requires a verified receipt
  outcome and projections matching the bound capsule and receipt. Forged verdicts use
  the pinned `verdict_integrity_mismatch` reason.
- **The Bellamente recall firewall rejects replay and mismatched corrections.**
  Typed evidence requires stable references and self-recomputable fingerprints;
  reordered or duplicated evidence cannot claim independent corroboration. Explicit
  unresolved-identity markers preserve opaque provider references and stop at
  `identity_unresolved`; they never reach comparison or mutation paths. Explicit
  corrections whose predicate or scope differs from the named target use the pinned
  `correction_target_mismatch` review reason.
- **Receipt construction refuses unusable evidence at the source.** Incomplete
  capsule/workspace bindings and missing, empty, or non-string runtime actors raise
  `ValueError` instead of producing a receipt that can never verify.
- **Exo fails closed on malformed caller-owned control state.** Handoffs and
  execution edges recheck receipt integrity; inverted leases are refused, malformed
  persisted leases are quarantined with `unknown_lease_shape`, and malformed claim
  ledgers are refused or quarantined with `unknown_claim_shape`. Duplicate task IDs
  invalidate a dependency graph instead of being resolved last-write-wins. Truthy
  non-dict scope, request, dependency, capsule, or receipt inputs produce typed
  refusals (or `ValueError` for invalid dependency graphs) instead of uncaught errors.

### Verification

- `python -m pytest packages/core/tests/ -q` — **589 passed**.
- `uv run --isolated --no-project --no-cache --with ./packages/core python -c
  "from importlib.metadata import version; import vivary_core; assert
  version('vivary-core') == '0.2.0'"` — local wheel-equivalent import and distribution
  metadata smoke passed.
- `python scripts/tests/test_package_docs_parity.py` — **10/10 passed**.
- `python scripts/check_package_docs_parity.py` — architecture matches **6** published
  manifests with **1** deliberately unpublished distribution allowlisted.
- `python scripts/check_line_endings.py --verbose` — **256** tracked text files checked;
  **8** legacy files remain explicitly allowlisted.
- `git check-attr whitespace --` with `docs/RELEASE-WORKFLOW.md`,
  `site/src/content/docs/release-workflow.md`, `README.md`, and
  `site/src/pages/index.astro` — all four preserve Git's whitespace checks while
  treating CRLF's `\r` as part of the line ending.
- `git diff --check origin/dev` — clean across the complete branch plus local remediation.
- `cd site && npm run test:site && npm run build && npm run test:links` — **8/8** site
  tests; **23** pages built; **1,644** local references and **1,018** anchors checked
  with zero failures.

## [Unreleased: guided doctor repair and truthful map counts] — 2026-07-25

Affects `create-vivary` / `@vivary/create` and `vivary-tropo`. Published versions stay
at **0.3.1** and **0.4.1** in this entry; the bumps are deferred to the unified release
line tracked in #149, where `create-vivary` / `@vivary/create` take a **minor** and
`vivary-tropo` a **patch**. `strato` is versionless and rides the create-vivary train.
Publishing remains a manual human gate.

### Added

- `create-vivary doctor --repair` — a guided, conservative repair plan. Dry-run by
  default; `--yes` applies only deterministic safe repairs, reruns doctor, and keeps a
  nonzero exit if the workspace is still invalid. Safe repairs are limited to
  regenerating missing private/runtime placeholders from the canonical templates,
  appending missing privacy ignore lines, and removing simple single-line W210
  redundant derived metadata.
- `create-vivary doctor --trend` — opt-in drift tracking against a prior recorded run.

### Fixed

- **Privacy probes now match `.gitignore` the way Git does.** The matcher used
  `fnmatchcase`, so `*` crossed `/`, `**/` and `/**` were not honoured, directory rules
  like `.strato/*/` never matched, and an excluded directory did not exclude its
  contents. Doctor could therefore report a leaking workspace as clean — including the
  `!**/USER.md` case, which stayed green even after the first nested-negation fix
  because that fix inherited the same matcher bug.
- **A backslash in a `.gitignore` pattern is treated as Git's escape character, not a
  path separator.** `USER.md\ ` names the file "USER.md " — with the space — so it does
  not protect `USER.md`, but the parser stripped the trailing space unconditionally and
  rewrote the backslash to `/`, crediting the rule and reporting the workspace clean.
- **A bracket expression is no longer credited with protecting a private file.**
  `[U]SER.md` is honoured only where `core.ignorecase` is off, so on the default
  Windows and macOS configuration such a rule silently protects nothing. Positive rules
  that depend on case folding now fail closed; negations spelled that way are still
  honoured, so an unignore is never missed.
- **`doctor --repair --yes` converges.** It previously appended a duplicate privacy
  block on every run without ever fixing the workspace, because the planner predicted
  success using a different rule than doctor used to pass. Patterns an append provably
  cannot fix are now withheld from the safe list and reported as manual instead.
- **Nested `.gitignore` negations are reported, not papered over.** A lower-level rule
  that unignores a private path takes precedence in Git, so no root-level line can
  override it. Both `doctor` and `adopt` now say so and name the exposed paths, rather
  than recommending a root-level fix that cannot work — or, in adopt's case, answering
  a negation with another negation.
- **`doctor --repair` reports the real reason a W210 field was left for a human.**
  Every failure previously said "complex YAML", so a user whose file was non-UTF-8,
  hard-linked or unreadable was told to hand-edit YAML that was not the problem.
- **`doctor --repair` preserves file modes.** Atomic replacement went through
  `mkstemp`, which creates at `0600`, silently making an existing `0644` file
  owner-only on POSIX and breaking shared workspaces and service accounts.
- **Stale-scaffold cleanup no longer crashes.** A raw `OSError` from an unremovable
  path escaped the `init` error handler, producing a traceback and — under `--json` —
  no JSON at all. Directory reparse points are now removed with `rmdir`.
- **Private placeholders no longer crash on an undecodable template.**
  `UnicodeDecodeError` is a `ValueError`, so it slipped past the `OSError` handler and
  the repair apply loop alike.
- **`tropo map` counts hard-linked files.** They were skipped as though they were
  symlinks, which silently removed ordinary public files from totals, largest-file,
  index detection and module candidates. Symlinks and reparse points are still omitted;
  a hard link is an ordinary directory entry, not an alternate route to already-counted
  content. `map` counts paths and sums per-path sizes — it does not report disk usage.
- Documented the full privacy ignore set in `docs/COMMANDS.md`. Three enforced lines
  (`*.vivary-tmp`, `!memory/.gitkeep`, `!heartbeat-reports/.gitkeep`) appeared nowhere
  in the docs, so a user following them could not make the post-adopt check pass. A
  test now derives the expectation from the code so the two cannot drift again.

## [Unreleased: Vivary product identity and proof spine] — 2026-07-18

Affects documentation, site verification, and the website only. No package versions
change.

### Added

- Added a distinct Vivary visual identity with an abstract strata-and-gate mark,
  living-world hero illustration, and architecture-layer asset.
- Added a full-length technical white paper defining the workspace failure mode,
  terminology, requirements, system invariants, architecture, operating protocol,
  threat model, evidence ledger, limitations, governance, and reproducible evaluation
  standard, grounded in primary references.
- Added the white paper to the generated Starlight documentation and
  machine-readable docs surfaces.

### Changed

- Rebuilt the public homepage around the brownfield adoption path, product thesis,
  four-layer architecture, measurable proof, and quiet company endorsement.
- Reframed the canonical repo roadmap around comprehension, adoption, retention, and
  evidence loops, then surfaced it as a first-class website page outside the guides.
- Replaced the long-form docs FAQ with concise homepage answers about adoption,
  privacy, lock-in, optional providers, and the current evidence boundary.
- Replaced the generic blog backlog with a proof-led content system tied to runnable
  commands, canonical docs, and repeat use; the plan remains repo-only.
- Preserved the static support-report flow through the redesigned homepage, aligned
  the blog and docs favicon/mark surfaces, repaired generated-site link rewrites, and
  brought the security policy's supported package lines up to current registry truth.

### Verification

- `cd site && npm audit`
- `cd site && npm run test:site`
- `cd site && npm run sync-docs`
- `cd site && npm run build`
- Desktop and mobile browser checks, primary-link checks, command-copy interaction,
  FAQ disclosure checks, roadmap-page checks, and console review.

## [Unreleased: stored vector query] — 2026-07-06

Affects `vivary-tropo` query behavior and docs. This is not published yet.

### Added

- `tropo query --mode vector` now prefers current stored vectors from embedded
  storage when `.vivary/storage.toml` enables local-hash embeddings and the embedded
  backend has migrated rows.
- Vector JSON now reports whether results came from `source: "stored"`,
  `source: "computed"`, or `source: "text"` fallback, plus embedded index metadata
  when stored rows are used.

### Changed

- The dependency-free local-hash vector shape is now `local-hash-v2`, adding a small
  prefix/character feature signal so local vector search can catch simple wording
  drift such as `verify` matching `verification`.

### Fixed

- Stored vector query refuses stale, partial, deleted, old-version, or
  dimension-mismatched embedded rows and falls back to deterministic typed text
  results with an explicit `detail`.
- Stored vector query now validates compact metadata before fetching bounded vector
  candidates, so huge or corrupt embedded tables do not silently force full-table
  vector materialization.
- Embedded storage config now rejects malformed `[storage.embedded]` values,
  out-of-root paths, and symlink/junction-backed storage paths before backend writes.
- Backend vector-search failures now fall back to typed text results with redacted
  diagnostics instead of being reported as healthy stored-vector search.
- Stored vector query keeps the existing type, path, edge, snippet, `--k`, and
  `--explain` result shape, including Windows-style path globs.

### Verification

- `python packages/tropo/tests/test_tropo.py`
- Real LanceDB dogfood: fresh `create-vivary init ... --preset coding --storage
  embedded --provider lancedb --auto --yes --json`, local-hash embedding enablement,
  file-to-embedded migration, stored vector query with `source: "stored"`, stale
  `source_fingerprint` fallback after editing a source file, re-migration, and
  Windows-style path/edge filter query.
- Wording-drift proof: text query for `verify` returned no results after removing the
  exact word, while stored vector query returned the `verification` node after
  re-migration.
- Timing smoke on the dogfood workspace: 8 in-process loops for text and stored-vector
  query paths to catch obvious regressions. Release-grade benchmark work remains
  tracked separately.
- Adversarial review hardening: added regression coverage for malformed embedded
  storage config, out-of-root storage paths, case-insensitive Windows path redaction,
  all-deleted stale rows, non-finite vectors, backend vector-search failure, and
  candidate limiting for large `--k`.

## [Unreleased: embedded typed-node embeddings] — 2026-07-06

Affects `vivary-tropo` migration behavior and docs. This is not published yet.

### Added

- `tropo migrate --from file --to embedded --json` now reports an `embedding` object.
- When `.vivary/storage.toml` explicitly enables `[storage.embedding]` with
  `provider = "local-hash"`, embedded migration stores graph-shaped vectors on typed
  node rows, plus source and embedding fingerprints for stale-vector detection.

### Fixed

- Nested `tropo.toml` `exclude` rules now filter analysis candidates after overlay
  resolution, so private nested notes are not analyzed or embedded.
- Invalid embedding config fails before backend writes during real migration; dry-run
  migration remains conservative and write-free.
- Real embedded migration now replaces the node snapshot, preventing deleted,
  renamed, newly excluded, or vector-schema-changed nodes from leaving stale rows.

### Verification

- `python packages/tropo/tests/test_tropo.py`
- Fresh scaffold dogfood: `create-vivary init ... --preset coding --storage embedded
  --provider lancedb --auto --yes --json`, followed by plain embedded migration,
  explicit local-hash embedding enablement, rerun migration, and LanceDB row-shape
  inspection.
- Brownfield dogfood: `create-vivary adopt ... --preset coding --yes --json`,
  explicit embedded/local-hash storage config, migration, and LanceDB row-shape
  inspection.
- Real LanceDB idempotence smoke: repeated migration kept row count stable while
  preserving 64-dimension vectors and embedding/source fingerprints.

## [Unreleased: local receipt log viewer] — 2026-07-05

Affects the `vivary` meta package, CLI docs, package docs, and generated website
docs. This is not published yet; the `vivary` version bump and registry publish remain
release-train gates.

### Added

- Added the dependency-free `vivary` helper CLI to the meta package.
- Added `vivary logs [PATH]` to summarize local JSONL run receipts as text or JSON.
- Added `vivary logs email [PATH] --to ...` to create a local `.eml` support draft or
  print a `mailto:` URL from whitelisted receipt fields.
- Added a dependency-free website support modal with copy-email, copy-report, prefilled
  `mailto:`, and GitHub issue fallbacks. The modal opens automatically for browser
  errors noticed by the site and omits local `file://` paths from generated reports.
- Pointed the website support flow at the bug issue form and set the form to assign
  new bug reports to the maintainer account for GitHub notifications.

### Security

- `vivary logs` copies only receipt schema/tool/version/command/flags/count/status/timing
  and runtime envelope fields. Unknown fields, stdout/stderr-like fields, file contents,
  raw query text, target ids, and local paths are not included in summaries or email
  drafts.
- `vivary logs email --out` refuses directory targets, symlink targets,
  symlink/junction ancestor directories, and Windows device names.
- Vivary still never sends telemetry or email itself; users send the local draft with
  their own mail client if they choose.
- The website support modal is static-only and does not call SendGrid, Resend, SMTP, or
  any other email provider.

### Verification

- `python packages/vivary/tests/test_vivary_cli.py`
- `cd site && npm run test:support`
- Real receipt smoke: `tropo check --root packages/tropo/examples/vault --receipt
  sandboxes/observability-proof/receipts.jsonl`, then `vivary logs ... --json` and
  `vivary logs email ... --out ... --json`.

## [Unreleased: repo line-ending standard] — 2026-07-05

Affects contributor docs, PR hygiene, and CI only. No package behavior changed.

### Added

- Added `.gitattributes`, `.editorconfig`, and `scripts/check_line_endings.py` as the
  repo standard for LF-normalized text files across Windows, WSL/Linux, and GitHub
  Actions.
- Added the line-ending check to CI, the PR template, and contributor guidance, with
  an explicit temporary allowlist for legacy mixed/CRLF files that should be reduced
  through deliberate cleanup PRs.

## [Unreleased: retrieval mode docs polish] — 2026-07-05

Affects public docs, generated website docs, and the `vivary-tropo` package README
only. No package behavior changed.

### Changed

- Added a plain-English chooser for `tropo query` retrieval modes so users know when
  to stay with default text search, when local vector ranking is useful, and when
  optional provider-backed semantic recall is required.

## [Unreleased: getting-started proof walkthrough] — 2026-07-05

Affects public docs and generated website docs only. No private dogfood workspace,
package release, or provider runtime call is included.

### Added

- Added `docs/WALKTHROUGH.md`, a public, generic proof of the first Vivary product
  cycle: scaffold, doctor health, `tropo check`, `ozone review`, `exo board`, and
  `ozone impact`.
- Added sanitized SVG terminal captures under `docs/assets/walkthrough/` and copied
  docs assets into the generated site build.
- Added the walkthrough to the website sidebar, docs index, getting-started next links,
  and generated LLM documentation surfaces.

### Verification

- Generic disposable proof workspace: `create-vivary init`, `doctor`, `tropo check`,
  `ozone review`, `exo board`, and `ozone impact human-gates` all completed without
  private paths in the public artifacts.
- `cd site && npm run build`

## [Unreleased: tropo typed vector query mode] — 2026-07-05

Affects `vivary-tropo`, CLI docs, package docs, and generated website docs. This is
not published yet; the `vivary-tropo` version bump and registry publish remain
release-train gates.

### Added

- Added `tropo query --mode vector`, a dependency-free local typed-vector search mode
  over analyzed tropo graph nodes.
- Added explicit `.vivary/storage.toml` opt-in for local vectors via `[storage.embedding]
  enabled = true`, `provider = "local-hash"`, and optional `dimensions`.
- Kept vector results graph-shaped: typed node ids, paths, types, scores, provider
  markers, snippets, and type/path/edge filters are preserved.
- This is a local query-time vector slice only; it does not add stored embeddings,
  ANN search over an embedded backend, or clustering/community graph views.

### Hardened

- `--mode vector` falls back to dependency-free text graph search when no embedding
  config is present instead of failing or installing anything.
- Invalid embedding config is reported as structured `misconfigured` JSON without
  attempting provider calls, network access, or package installation.
- Malformed storage config reports relative `.vivary/storage.toml` details instead of
  absolute local paths, and `tropo migrate --to embedded` refuses to silently use the
  file backend when embedded storage is not configured.

### Verification

- `python packages/tropo/tests/test_tropo.py`

## [Unreleased: tropo semantic query mode] — 2026-07-05

Affects `vivary-tropo`, `vivary-memory-cognee`, CLI docs, package docs, and
generated website docs. This is not published yet; registry publishes remain
release-train gates.

### Added

- Added `tropo query --mode semantic`, a dependency-free bridge to an explicitly
  configured optional semantic-memory provider. The default `text` mode is unchanged.
- Semantic query returns typed Vivary node ids from the provider instead of opaque
  chunks, and reports a structured unavailable state when semantic memory is not
  configured, installed, or indexed.

### Hardened

- Scoped real Cognee runtime state/log/cache directories to the workspace
  `memory.cognee.state_path` before provider import.
- Enforced `memory.cognee.allow_network = true` before Cognee provider runtime calls
  so generated Cognee policy cannot accidentally index or recall through embedding/LLM
  providers.
- Required either `memory.cognee.api_key_env` or explicit
  `memory.cognee.allow_without_api_key = true` before provider runtime calls.
- Forced Cognee third-party telemetry/tracing off by default with
  `memory.cognee.allow_telemetry = false`, even when inherited environment variables
  try to enable tracing, while still allowing an explicit opt-in.
- Rejected invalid semantic-memory TOML schema instead of coercing truthy strings or
  integers into safety gates.
- Refused semantic provider snapshots that resolve Markdown files outside the workspace
  through symlinks or Windows junctions, plus in-root linked or hard-linked Markdown
  files that could smuggle private content through a public path.
- Bound Cognee dataset names to the workspace path hash, even when a label is
  configured, so one workspace cannot accidentally forget another workspace's dataset.
- Made provider recall require a current manifest fingerprint, and made approved index
  replace the prior Cognee dataset before remembering current node packets.
- Made `vivary-cognee forget` request full dataset deletion instead of memory-only
  deletion, and made missing provider datasets idempotent under `--yes`.
- Refused nonexistent `vivary-cognee --root` targets instead of promoting typos to the
  nearest ancestor workspace before a mutating command.
- Refused linked or hard-linked Cognee manifest targets before writing local index
  proof, and preserved manifests when provider dataset deletion fails with permission
  or accessibility errors.
- Hardened `tropo query --mode semantic` against workspace-local `vivary_cognee.py`
  import hijacking while still allowing the repo adapter or installed adapters outside
  the workspace/current working tree.
- Bumped the unreleased `vivary-memory-cognee` adapter metadata to `0.1.1`, added an
  explicit adapter capability marker, and made `tropo query --mode semantic` refuse
  older adapters before calling provider recall.
- Honored nested `.gitignore` files and directory ignore patterns before building
  provider snapshots, so ignored private Markdown is not sent to the optional provider.
- Preflighted the local Cognee manifest path before any provider-side mutation, compared
  full manifest identity instead of fingerprint alone, and sanitized provider exception
  strings to action plus exception class.
- Capped semantic provider over-fetch for filtered queries so large `--k` values cannot
  fan out into unbounded provider requests before local filtering.
- Kept `vivary-cognee doctor` package-presence-only, avoiding Cognee import side
  effects, suppressed Cognee dotenv autoload during runtime import, and kept provider
  import/call chatter off JSON stdout for runtime commands.

### Verification

- `python packages/tropo/tests/test_tropo.py`
- `python packages/memory-cognee/tests/test_memory_cognee.py`
- CI packaged optional semantic bridge smoke installs local `vivary-tropo` plus
  `vivary-memory-cognee` with `--no-deps`, then verifies installed `tropo query
  --mode semantic --json` reaches the explicit `allow_network` gate without provider
  calls.
- Real installed `cognee 1.2.2` smoke: `vivary-cognee doctor --json` reported the
  installed package without importing provider runtime, `vivary-cognee index --dry-run
  --json` reported packet counts, and provider runtime calls were refused while
  `allow_network = false`.

## [Unreleased: local run receipts] — 2026-07-05

Affects `create-vivary`, `vivary-tropo`, `vivary-ozone`, `vivary-exo`, CLI docs,
package docs, and generated website docs. This is not published yet; package version
bumps and registry publishes remain release-train gates.

### Added

- Added dependency-free, opt-in local JSONL run receipts to the core CLIs via
  `--receipt PATH` or `VIVARY_RECEIPT_LOG=PATH`.
- Receipts record a small debug envelope: schema version, tool/version, command,
  flag names, argument count, exit code, duration, Python version, and platform.
- Receipts deliberately avoid stdout, stderr, environment variables, file contents,
  raw query text, target ids, local paths, graph content, preset values, and agent
  handles.

### Security

- Receipt targets must be regular files; symlink targets and directory targets are
  refused so an opt-in debug log cannot silently append through a suspicious path.
- Symlink or Windows junction directory ancestors are refused for receipt paths before
  and after parent directory creation.
- Windows device names such as `NUL`, `CON`, `COM1`, and `LPT1` are refused as
  receipt targets.

### Verification

- `python packages/tropo/tests/test_tropo.py`
- `python packages/ozone/tests/test_ozone.py`
- `python packages/exo/tests/test_exo.py`
- `python packages/create-vivary/tests/test_create_vivary.py`
- `python packages/create-vivary/tests/test_adopt.py`
- `python packages/create-vivary/tests/test_strato_integrity.py`
- `python packages/create-vivary/tests/test_assets_parity.py`
- `python packages/memory-cognee/tests/test_memory_cognee.py`
- `node packages/create-vivary/tests/test_npm_launcher.js`
- `python packages/tropo/tropo.py check --root packages/tropo/examples/vault`
- `cd site && npm run sync-docs && npm run build`
- `cd packages/create-vivary/npm && npm pack --dry-run`
- `git diff --check`

## [Unreleased: vivary-ozone editorial pack] — 2026-07-05

Affects `vivary-ozone`, CLI docs, package docs, and generated website docs. This is
not published yet; the `vivary-ozone` version bump and registry publish remain a
later release-train gate.

### Added

- Added `ozone review --pack editorial`, a deterministic writing-workspace rule pack
  that demonstrates the "code review and editorial review are the same layer with
  different rule packs" thesis.
- The pack flags missing draft/manuscript review coverage, missing edit/revision
  coverage, missing outline/structure coverage, and unlinked reviews or edits while
  staying quiet for non-writing workspaces.

### Verification

- `python packages/ozone/tests/test_ozone.py`

## [Release workflow / @vivary/create trusted publishing] — 2026-07-05

Affects GitHub Actions, release docs, and generated website docs only. No package
release, npm publish, or PyPI publish is implied.

### Added

- Added a manually dispatched, release-tag-gated GitHub Actions workflow for
  tokenless `@vivary/create` publishing through npm Trusted Publishing and the
  protected `npm-publish` environment.
- Added a CI guard that verifies the npm trusted publish workflow keeps OIDC
  permissions, package checks, dry-run behavior, and avoids token-based publishing.

### Changed

- `docs/RELEASE-WORKFLOW.md` now documents the policy-level trusted publisher setup
  for `@vivary/create` instead of public maintainer-specific npm auth steps.

### Verification

- `python scripts/check_npm_trusted_publish_workflow.py`
- `python packages/create-vivary/tests/test_assets_parity.py`
- `node packages/create-vivary/tests/test_npm_launcher.js`
- `python packages/create-vivary/tests/test_create_vivary.py`
- `cd site && npm run sync-docs && npm run build`
- `cd packages/create-vivary/npm && npm pack --dry-run` reported the expected
  three npm package files: `README.md`, `index.js`, and `package.json`.

## [Public stats snapshot] — 2026-07-05

Affects README/site public signals only. No package release, changelog-worthy
runtime change, npm publish, or PyPI publish is implied.

### Changed

- Refreshed the checked-in public signals snapshot: `@vivary/create` npm weekly
  downloads `344`, PyPI package weekly downloads `1467`, all package weekly
  downloads `1811`, GitHub stars `3`, forks `1`, and open issues `8`.
- The usage snapshot chart keeps the same fixed SVG canvas; the npm bar is shorter
  because bars are proportional to the largest package-source count in that
  snapshot, not because a badge or chart container was resized.

### Verification

- `stats/latest.json` reports `status: "ok"` with no stale-source warnings.
- `stats/history.csv` adds the `2026-07-05` row.
- `stats/usage-snapshot.svg` and `site/public/usage-snapshot.svg` match.

## [vivary 0.1.0] — 2026-07-04

Adds the `vivary` meta-package on PyPI: `pip install vivary` installs the full
CLI suite (`create-vivary`, `vivary-tropo`, `vivary-ozone`, `vivary-exo`) with
compatible minimum versions. No code of its own; the four packages stay
independently versioned and installable. Website and docs install commands
collapse to the one-liner; the homepage strip shows a single PyPI card.

### Verification

- Published and verified: `pip index versions vivary` returned `vivary (0.1.0)`
  from the public index after `twine upload`.

## [vivary-tropo 0.4.1 / create-vivary 0.3.1] — 2026-07-04

Affects `vivary-tropo`, `create-vivary` / `@vivary/create`, root docs, package docs,
generated website docs, and the homepage. The adoption-line release: Vivary now works
on existing repos and vaults, not just fresh scaffolds. Published and verified as
`vivary-tropo==0.4.1`, `create-vivary==0.3.1`, and `@vivary/create@0.3.1`:
cache-resistant `uvx --no-cache` installs from the public index self-report
`tropo 0.4.1` / `create-vivary 0.3.1`, and
`npx --yes @vivary/create@0.3.1 capabilities --preset coding --json` returns ok.

> Note: `vivary-tropo==0.4.0` and `create-vivary==0.3.0` exist on PyPI but
> self-report the previous version from a stale `__version__` constant; they are
> superseded by 0.4.1 / 0.3.1 (same content plus the constant fix and a
> version-parity test). `@vivary/create` skips 0.3.0 on npm entirely.

### Added

- **`tropo map`** (tropo 0.4.0) — read-only filesystem inventory of any repo, vault, or
  docs tree: directory table, extension/size summaries, largest files, existing
  index/routing surfaces, and likely-modules-without-an-index. Markdown by default,
  deterministic `--json`; workspace excludes honored (file-level and subtree-rebased),
  junction/symlink cycles pruned, no `tropo.toml` required.
- **`create-vivary adopt <path>`** (create-vivary 0.3.0) — brownfield adoption: dry-run
  by default, `--yes` write gate, only ever adds files (existing content stays
  byte-identical), candidate module routers for markdown-heavy directories, collision
  skip and report, privacy follow-ups for an existing `.gitignore`, and the 0.2.5
  symlink/out-of-root hardening. An adopted workspace passes `doctor` and `tropo check`.
- **`create-vivary doctor --trend`** (create-vivary 0.3.0) — opt-in drift tracking:
  prior-run state in `.vivary/doctor-state.json` (atomic, symlink-refusing writes),
  signed deltas for graph and routing metrics, corrupt state degrades to first-run with
  a visible `trend_warning` in `--json`. Plus a copy-paste GitHub Actions CI-gate
  recipe in `docs/HOWTO.md`.
- **Strato integrity gates** — scaffold smokes for all four presets, markdown
  cross-reference integrity, and Claude/Codex skills structural parity now run in CI.
  strato formally rides the create-vivary release train.

### Fixed

- Homepage mobile overflow (155px horizontal overflow at a 375px viewport) and a
  desktop hero width regression caught in review.
- The loops skill is runtime-honest: the Codex copy no longer claims Claude Code's
  `/loop` and `/goal`; one combined section covers both runtimes in all three copies.

### Changed

- `docs/PRODUCT-ROADMAP.md` restructured around the P1 adoption line;
  `docs/RELEASE-WORKFLOW.md` expanded into a detailed runbook (scope table, publish
  commands, verification smokes, social announcement step); `CONTRIBUTING.md`
  corrects the stale prod-branch claim.

### Verification

- tropo: 83/83 tests on Python 3.11 and 3.14 (68 pre-existing + 15 map).
- create-vivary: full suite green post-merge; init byte-parity vs 0.2.8 verified
  across five flag configurations by adversarial review; only-adds and dry-run purity
  verified against hostile fixtures.
- Adversarial review on every PR in the line (#98–#105) with findings fixed pre-merge.
- Publishing remains a manual human gate.

## [vivary-memory-cognee 0.1.0 / create-vivary 0.2.8] — 2026-06-27

Affects the optional Cognee adapter package, `create-vivary` / `@vivary/create`,
root docs, package docs, and generated website docs. Published and verified as
`vivary-memory-cognee==0.1.0`, `create-vivary==0.2.8`, and `@vivary/create@0.2.8`
after PR #93 merged to `dev`.

### Added

- **Optional Cognee memory adapter** — `packages/memory-cognee/` adds the
  `vivary-memory-cognee` package and `vivary-cognee` CLI with `doctor`, `index`,
  `recall`, and `forget`. It indexes privacy-filtered typed Tropo node packets and
  accepts only recall hits that map back to known Vivary node ids.

### Changed

- `create-vivary capabilities --json` now marks `memory:cognee` with
  `"adapter_status": "optional-package"` while keeping Cognee out of the default
  install path.
- `create-vivary` / `@vivary/create` move to 0.2.8 so the scaffolder and npm launcher
  publish the updated Cognee adapter metadata and docs together.

### Verification

- `python packages/memory-cognee/tests/test_memory_cognee.py` passed locally: 6/6.
- `python -m pip index versions create-vivary` reported `0.2.8`.
- `python -m pip index versions vivary-memory-cognee` reported `0.1.0`.
- `uvx --no-cache --index-url https://pypi.org/simple --from create-vivary==0.2.8 create-vivary --version`
  returned `create-vivary 0.2.8`.
- `uvx --no-cache --index-url https://pypi.org/simple --from vivary-memory-cognee==0.1.0 vivary-cognee --version`
  returned `vivary-cognee 0.1.0`.
- `npm view @vivary/create version` returned `0.2.8`.
- `npx --yes @vivary/create@0.2.8 capabilities --preset coding --json` completed
  through the published npm launcher and reported `memory:cognee` with
  `"adapter_status": "optional-package"`.

## [vivary-tropo 0.3.0 / vivary-ozone 0.2.0 / create-vivary 0.2.7] — 2026-06-27

Affects `vivary-tropo`, `vivary-ozone`, `create-vivary` / `@vivary/create`, root
docs, package docs, and generated website docs. Published and verified as
`vivary-tropo==0.3.0`, `vivary-ozone==0.2.0`, `create-vivary==0.2.7`, and
`@vivary/create@0.2.7` after PR #91 merged to `dev`.

### Added

- **`tropo find` context packets** — a human-friendly command that returns the small
  set of typed nodes/files worth opening first, with reasons, snippets, filters, JSON
  output, and an approximate token budget.
- **Ozone `context-budget` pack** — `ozone review --pack context-budget` flags
  context-bloat risks in public routing surfaces: missing module indexes, legacy
  module files that coexist with directory indexes, oversized always-on files,
  oversized module indexes, bulk-load wording, and duplicated routing blocks.
- **Ozone pack selection** — `ozone review --pack structure|context-budget|all`
  keeps the default `structure` behavior stable while allowing opt-in context-budget
  review. `--strict` still exits non-zero only on `warn` findings.
- **Local checkout CLI refresh** — `scripts/install-local-clis.ps1` uninstalls existing
  Vivary uv tools, then installs the current branch's CLIs without `--force`, preventing
  stale global tools from silently testing older behavior during local review.
- **LLM active-context guide** — `docs/LLM-ACTIVE-CONTEXT.md` and the generated website
  page provide a compact, copyable graph-first CocoIndex-code retrieval prompt.
- **Product roadmap** — `docs/PRODUCT-ROADMAP.md` captures the high-leverage backlog
  for large filesystem maps, module index planning, structured content query, typed
  recall providers, optional integration proof, and context-budget repair workflows.

### Changed

- **`tropo query` is graph-aware** — query now searches analyzed Tropo nodes instead
  of raw Markdown files, returning real graph ids/types/paths and supporting `--type`,
  `--path`, `--edge`, `--snippet`, and `--explain`.
- **Active-context guidance is simpler and stricter about CocoIndex path filters** —
  the generated skill and docs now lead with `tropo find`, use exact
  `ccc search --path` examples, and warn that broad folder globs can miss indexed files
  in current CocoIndex-code releases.
- **LanceDB wording is storage-first** — public docs, wizard copy, and capability
  labels now describe LanceDB as explicit embedded storage, while `tropo find` and
  `tropo query` remain graph-first zero-dependency retrieval commands.
- **Package dependency floor moved with retrieval guidance** — `create-vivary` and
  `vivary-ozone` now depend on `vivary-tropo>=0.3.0` so installed scaffolds and review
  docs reference a tropo version that includes `find` and graph-aware `query`.

### Verification

- `python packages/tropo/tests/test_tropo.py` passed locally: 68/68.
- `python packages/ozone/tests/test_ozone.py` passed locally: 16/16.
- `python packages/create-vivary/tests/test_create_vivary.py` passed locally: 54/54.
- `python packages/create-vivary/tests/test_assets_parity.py` passed locally: 3/3.
- `python packages/exo/tests/test_exo.py` passed locally: 14/14.
- `cd site && npm run sync-docs && npm run build` passed locally.
- Local CLI refresh passed with `scripts/install-local-clis.ps1`, then bare `tropo`,
  `ozone`, `exo`, and `create-vivary` smokes passed.
- Disposable LanceDB, CocoIndex-code, and Cognee-policy smokes passed locally. Cognee
  remains policy-only in Vivary; the actual optional adapter is not shipped in this
  release.
- `uvx --no-cache --index-url https://pypi.org/simple --from vivary-tropo==0.3.0 tropo --version`
  returned `tropo 0.3.0` from public PyPI.
- `uvx --no-cache --index-url https://pypi.org/simple --from vivary-ozone==0.2.0 ozone --version`
  returned `ozone 0.2.0` from public PyPI.
- `uvx --no-cache --index-url https://pypi.org/simple --from create-vivary==0.2.7 create-vivary --version`
  returned `create-vivary 0.2.7` from public PyPI.
- `npm view @vivary/create version` returned `0.2.7`, and
  `npx --yes @vivary/create@0.2.7 capabilities --preset coding --json` completed
  through the published npm launcher.

## [create-vivary 0.2.6] — 2026-06-26

Affects `create-vivary` / `@vivary/create`, generated workspace docs, and public docs.
Published and verified as `create-vivary==0.2.6` on PyPI and `@vivary/create@0.2.6`
on npm after PR #87 merged to `dev`.

### Added

- **`knowledge-work` preset** — a generic workbench for sources, artifacts, decisions,
  and proof, with editable `workbench` and `sources` module routers.
- **Capability discovery** — `create-vivary capabilities [--preset ...] [--json]`
  lists optional storage, semantic-memory, and preset-specific sidecar capabilities for
  human and agent setup flows.
- **Optional semantic-memory setup** — `create-vivary init` / `wizard` now accept
  `--memory none|local|cognee`. `local` writes local-only semantic-memory policy;
  `cognee` writes Cognee policy, graph docs, and verification surfaces without
  installing Cognee, indexing content, enabling network access, or using API keys.
- **Doctor memory reporting** — `create-vivary doctor` reports semantic-memory status
  as disabled, healthy/configured, unavailable, misconfigured, or privacy-failed.

### Changed

- The npm launcher recognizes the new `capabilities` subcommand instead of rewriting it
  to `init`.

### Verification

- `python -m pip index versions create-vivary` reported `LATEST: 0.2.6`.
- A fresh venv installed `create-vivary==0.2.6` from PyPI and ran
  `create-vivary capabilities --preset knowledge-work --json`.
- `npm view @vivary/create version` reported `0.2.6`.
- `npx --yes @vivary/create@0.2.6 capabilities --preset knowledge-work --json`
  ran through the published npm launcher and matching PyPI scaffolder.

## [vivary-tropo 0.2.3 / vivary-exo 0.2.2 / create-vivary 0.2.5] — 2026-06-23

Affects `vivary-tropo`, `vivary-exo`, `create-vivary` / `@vivary/create`,
`strato` workspace assets, and public docs/site release surfaces. This package set
ships the merged security-hardening batch from the June 23 security scan review.

### Security

- **`tropo view --out` output hardening** — rendered HTML writes must stay inside
  the tropo root, refuse symlink output paths, and replace the output path instead
  of truncating existing hard-linked files.
- **Heartbeat reports stay private** — scaffolded workspaces now gitignore
  `heartbeat-reports/*` (while keeping `.gitkeep`), the doctor flags missing report
  ignores, and strato's heartbeat procedure treats reports as PRIV because they may
  summarize private memory.
- **Doctor privacy ignore validation hardening** — `create-vivary doctor` now
  validates active `.gitignore` rules for `USER.md`, `MEMORY.md`, `memory/*`, and
  `heartbeat-reports/*` instead of accepting comments, negations, or unrelated
  substring matches as proof that private context files are ignored.
- **`exo claim` hard-link hardening** — claim writes now replace the workspace work
  item file instead of truncating an existing inode, so a hard-linked file outside
  the workspace is not mutated.
- **create-vivary symlink hardening** — scaffold writes, storage config writes, and
  stale generated cleanup now refuse symlinked destination parents and paths that
  resolve outside the selected workspace, including when `--force` is used.
- **create-vivary dry-run cleanup guard** — `--dry-run --force` previews the scaffold
  without removing stale generated files.
- **create-vivary embedded install fallback** — when `create-vivary` is run through
  `uvx`, embedded storage setup now falls back to `uv pip install --python ...` if
  the temporary Python environment does not include `pip`.

### Documentation

- **Security-hardening release truth** — README, FAQ, command docs, package READMEs,
  `SECURITY.md`, and the website now identify the package versions that carry the
  hardening batch.

### Changed

- `vivary-exo` now depends on `vivary-tropo>=0.2.3` so installed claim workflows use
  the hard-link-safe write behavior.
- `create-vivary` now depends on `vivary-tropo>=0.2.3`, and the npm launcher
  version `@vivary/create@0.2.5` pins the matching `create-vivary==0.2.5` PyPI
  scaffolder.
- `create-vivary init --no-wizard` now honors the documented lean default of file
  storage unless `--auto` or `--storage auto` is explicitly requested.

### Release note

Published through the manual human gate as `vivary-tropo==0.2.3`,
`vivary-exo==0.2.2`, `create-vivary==0.2.5`, and `@vivary/create@0.2.5`.
`create-vivary==0.2.4` was uploaded during release validation, then superseded by
0.2.5 after the public `uvx` smoke exposed the embedded-install fallback bug.
Verified from public PyPI/npm registries plus fresh `uvx` and `npm exec` scaffold
smokes.

## [vivary-tropo 0.2.2 / vivary-exo 0.2.1] — 2026-06-22

Affects `vivary-tropo` and `vivary-exo` only. `create-vivary` / `@vivary/create`
remain at 0.2.3, and `vivary-ozone` remains at 0.1.0.

### Fixed

- **UTF-8 BOM hardening** — tropo now treats a single leading UTF-8 BOM as a
  file-encoding artifact in both `tropo.toml` and Markdown frontmatter, so files
  produced by Windows PowerShell `Set-Content -Encoding UTF8` load normally.
- **`exo claim` no longer duplicates BOM-prefixed frontmatter** — claims update the
  existing frontmatter block, normalize the rewritten file to plain UTF-8, and still
  reject malformed frontmatter instead of guessing.

### Changed

- `vivary-exo` now depends on `vivary-tropo>=0.2.2` so installed claim workflows use
  the BOM-aware parser.

### Release note

Published through the manual human gate as `vivary-tropo==0.2.2` and
`vivary-exo==0.2.1`; no npm publish was needed. Verified from public PyPI pages plus
fresh `pip` and `uvx --no-cache --index-url https://pypi.org/simple` install smokes.

## [vivary-tropo 0.2.1 / vivary-exo 0.2.0] — 2026-06-22

Affects `vivary-tropo` and `vivary-exo` only. `create-vivary` / `@vivary/create`
remain at 0.2.3, and `vivary-ozone` remains at 0.1.0.

### Added

- **Graph-native work claiming** — `exo claim <id> --agent <handle>` writes a
  top-level `assignee` onto a work item under `changes/`, reports JSON with the
  previous assignee and whether the file changed, and leaves same-assignee claims as
  no-op success.
- **Opt-in coordination pack** — `packs = ["coordination"]` declares
  `assignee = "string"` as a base optional field, so exo can write claims without
  bloating every default workspace schema.
- **Embedded starter packs** — built-in tropo packs are embedded in the single-file
  engine so installed wheels can resolve `dev-project`, `repo-graph`, and
  `coordination` without relying on a repo-local `packs/` directory.
- **Pack parity tests** — tracked built-in pack TOML files are checked against the
  embedded values, and workspace-local `.tropo/packs/<name>.toml` files still take
  precedence over bundled packs.

### Changed

- `vivary-exo` now depends on `vivary-tropo>=0.2.1` so installed users get the
  bundled `coordination` pack required by `exo claim`.

### Release note

Released through the manual human gate as `vivary-tropo==0.2.1` and
`vivary-exo==0.2.0`; no npm publish was needed for this release.

## [0.2.3] — 2026-06-22

Affects `create-vivary` (PyPI) and `@vivary/create` (npm) only.

### Fixed

- **npm launcher pins the matching PyPI scaffolder** — `npm create @vivary@latest`
  now invokes `create-vivary@0.2.3` instead of leaving `uvx create-vivary` or
  `pipx run create-vivary` to resolve an unversioned package. This prevents stale
  tool caches from serving an older CLI without the `wizard` subcommand.
- **Launch copy uses the explicit latest npm form** — public install examples now
  prefer `npm create @vivary@latest my-workspace`, with direct Python usage shown as
  `uvx create-vivary@0.2.3 ...` or `pip install create-vivary==0.2.3`.

Use 0.2.3 for new installs. Existing PyPI 0.2.2 installs already include the wizard;
the hotfix is primarily for npm launcher provenance and fresh public onboarding.

## [0.2.2] — 2026-06-21

Affects `create-vivary` (PyPI) and `@vivary/create` (npm) only.

### Fixed

- **Supersedes 0.2.1** — use 0.2.2 for new installs. PyPI 0.2.1 was installable,
  but it was replaced by a clean CI-reviewed release after generated build artifacts
  were removed from the source tree. npm 0.2.1 was not live; 0.2.2 is the npm/PyPI
  lockstep release users should install.
- **Clean release provenance** — the repository source tree no longer includes the
  generated 0.2.1 wheel/sdist artifacts, and the release was re-cut after branch
  protection and CI-gated PR flow were restored.

No runtime API changes are expected for users already on 0.2.1; this is a source
and release-hygiene hotfix.

## [0.2.1] — 2026-06-21

Affects `create-vivary` (PyPI) only; no live `@vivary/create` npm 0.2.1 release was
published.

### Fixed

- **Wizard installs LanceDB inline** — when the interactive wizard's user picks "on this
  computer" (embedded storage), LanceDB now installs immediately as part of the wizard
  conversation. Previously, a second standalone "Install lancedb? [Y/n]" prompt appeared
  after the wizard ended, which was jarring and broke the mental model (the wizard IS the
  consent step).
- **`--auto` implies `--yes` for installs** — `create-vivary init . --auto --size large`
  no longer hangs on the install prompt. `--auto` means fully unattended; it now implies
  `yes=True` for every install step, so agents don't need to pass both `--auto` and `--yes`.
- **`wizard` subcommand** has the same two fixes applied.

## [0.2.0] — 2026-06-21

Affects `vivary-tropo` and `create-vivary`. `vivary-ozone` and `vivary-exo` are unchanged at 0.1.0.

### Added

- **Storage layer in tropo** — tiered storage abstraction: `file` (default, no new deps),
  `embedded` (LanceDB on disk, `pip install vivary-tropo[embedded]`), and `cloud` adapter
  interface (0.3.x). Config lives in `.vivary/storage.toml`. Optional extras:
  `vivary-tropo[embedded]`, `vivary-tropo[cloud]`, `vivary-tropo[astra]`.
- **`tropo migrate`** — move graph nodes between backends
  (`--from file --to embedded [--dry-run] [--json] [--yes]`).
- **`tropo query`** — text search over the workspace knowledge graph
  (`tropo query "auth module" [--k N] [--json]`).
- **Agent-mode flags on `create-vivary init`** — `--json`, `--dry-run`, `--auto`,
  `--yes`, `--no-wizard`, `--storage`, `--provider`, `--size`, `--privacy`.
  Agents can now self-configure a workspace end-to-end without human interaction.
- **`create-vivary wizard` subcommand** — reconfigure storage on an existing workspace.
- **Interactive setup wizard** — `create-vivary init` now prompts interactively when
  run from a TTY (human-friendly, no database jargon). `--no-wizard` or `--auto` skips it.
- **`.vivary/data/` in scaffolded `.gitignore`** — runtime storage data is always ignored.
- **`doctor` reports `backend` field** — JSON output now includes `"backend": "file|embedded|cloud"`.
- **Spec:** `docs/SPEC-data-layer.md` — full architecture rationale and agent CLI contract.

### Changed

- `create-vivary init` with `--storage embedded` self-installs `vivary-tropo[embedded]`
  (with confirmation unless `--yes`).
- `--dry-run` on `init` simulates the full scaffold without writing any files.

## [create-vivary 0.1.1] — 2026-06-14

Affects `create-vivary` (PyPI) and its npm launcher `@vivary/create`, released in
lockstep. The other three packages are unchanged at 0.1.0.

### Fixed

- A bare target now defaults to the `init` subcommand, so the documented
  `npm create @vivary@latest <name>` and `uvx create-vivary@0.2.3 <name>` scaffold a workspace
  without an explicit `init` (previously failed with argparse `invalid choice: …`).
  Explicit `init` / `doctor` and leading flags (`-h` / `--help`) pass through unchanged.
  npm launcher: [#33](https://github.com/vivary-dev/vivary/pull/33). Python CLI parity:
  [#35](https://github.com/vivary-dev/vivary/pull/35).

## [0.1.0] — 2026-06-14

Initial public release — all four layers on PyPI, the scaffolder also on npm.

### Added

- `vivary-tropo` — typed knowledge-graph CLI (`check` / `signal` / `types` / `stats` /
  `graph` / `blast` / `view` / `plan` / `fix` / `init`); `check` is strict by default.
- `vivary-ozone` — review layer (`review` / `impact` / `packs`).
- `vivary-exo` — coordination layer (`conflicts` / `board` / `roles`).
- `create-vivary` (PyPI) / `@vivary/create` (npm) — agent-workspace scaffolder
  (`init` / `doctor`; presets: `coding` · `second-brain` · `writing`).

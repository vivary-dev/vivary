# 03b Registry reference-model verification

Evidence-record: 03b
Date: 2026-09-05. Verification kind: runtime. Result: reference-model packet
complete. Parent outcome 03 remains in progress.

## Artifact and boundary

The dependency-free [model](../../../../scripts/registry_contract_model.mjs)
validates inputs, computes canonical request hashes, evaluates decisions, and
applies immutable in-memory transitions. The [tests](../../../../scripts/tests/test_registry_contract_model.mjs)
exercise the generic [57-case oracle](../fixtures/project-registry.json),
contender schedules, crash intent, and deliberate faulty implementations.
There is no case-ID dispatch in the evaluator.

The authorized [10c Habitat environment](10c-habitat-fallback-proof.md) ran Node
v22.23.2 in one offline, non-root container with no host mounts or credentials.
No model provider, app server, native coding agent, database, or project-root
adapter was started. Host commands authored/copied files and transformed docs;
all registry model and test execution occurred inside the container.

SHA-256 of the tested source files:

| Artifact | Digest |
| --- | --- |
| `scripts/registry_contract_model.mjs` | `2f1a5b45ffdd2e5b244c42e31953520d882dd142ee26dc57c0ebf925ac9fc0a1` |
| `scripts/tests/test_registry_contract_model.mjs` | `56620608eed1c8d9975b5100c04b36cabf9bd51b83c069480d46047033364130` |

## Commands and results

Exact canonical suite invocation inside the container:

```console
PROJECT_REGISTRY_FIXTURE=/tmp/project-registry.json node --test /tmp/scripts/tests/test_registry_contract_model.mjs
node /tmp/scripts/registry_contract_model.mjs --fixture /tmp/project-registry.json --check
```

Results: **25 tests passed, zero failed**; **57/57 exact fixture decisions
passed**. The suite checks output, permitted effects, and exact record changes.
The CLI emits case IDs and aggregate status without raw adapter facts.

Equivalent repository commands, once the same source is staged in a verified
environment:

```console
node --test scripts/tests/test_registry_contract_model.mjs
node scripts/registry_contract_model.mjs --fixture docs/product/multi-project/fixtures/project-registry.json --check
```

CI runs these commands on its existing Node 22 runner for ongoing regression
coverage. CI does not establish the Habitat configuration or BrowserPod support.

## Independent QA and corrections

The original author suite passed 16 tests. An independent reader and the
integration reviewer then found gaps. Seven added regressions failed against
that unchanged candidate in Habitat (16 pass, 7 fail). Corrections covered:

- Missing/mismatched export bindings and scope-dependent lookup order.
- Unknown `__proto__` JSON fields disappearing from the parsed own-key set.
- Unused trusted records affecting unrelated operations.
- Invalid receipt key sets and operation owners.
- Unsafe revision increments and a relocation's occupied destination.

A separate probe then reproduced a registration-replay authorization regression
introduced by the scope correction. The final tests cover actor, collection,
and device changes plus a fresh-registration control. Targeted review also
strengthened receipt consistency and no-change assertions at revision limits.
The original 57 oracle expectations were preserved. The contract now makes the
export, relevant-record, and revision-overflow rules explicit.

Two independently authored probes passed against the final candidate. Their
collision and replay assertions are also retained in the canonical suite.
Candidate hashes identify the source assessed; this file does not claim that a
production runtime enforces frozen-candidate QA permissions.

## Deliberate failures

The suite creates altered temporary copies. An additional CLI check observed
each altered copy exit 1 with these failed cases:

| Fault introduced | Observed failing case IDs |
| --- | --- |
| Deduplicate by location text | `canonical-path-alias-converges` |
| Drop the common repository key | `git-mutation-reserves-common-and-checkout`, `other-worktree-repository-busy`, `colocated-jj-single-owner` |
| Export the trusted object | `portable-export-only`, `export-retains-selected-content-identity` |
| Accept a stale fence | `write-back-stale-fence` |

The original CLI then exited 0 with 57/57 matches. Its source bytes were
unchanged. Mutation detection demonstrates that these checks catch the named
faults; it is not proof that every possible implementation defect is absent.

## Limits and next work

Concurrency and crash evidence here uses deterministic in-memory schedules.
It proves model transitions, not simultaneous processes or durable database
transactions. Adapter observations are synthetic. Root detection, overlap,
filesystem containment, physical isolation, persistent uniqueness, historical
fence allocation, process fencing, native cancellation/resume, real write-back,
and the HoH product cycle remain unproved.

The [generated frontier](../index.md) owns the next executable packet. The
[PR 328 review receipt](pr-328-code-review.md) records later corrections and
38 passing registry tests, 57 fixture decisions, and five independent probes.
The earlier source hashes and 25-test result above remain historical evidence.
Source import, production database selection, real-runtime activation, merges,
and release were not performed by this packet.

Final cleanup: the two source hashes were rechecked inside the container and
matched the receipt above. The task-owned container was stopped and removed; its
identified hidden WSL keepalive was stopped. No existing authentication volume or
other session was removed. BrowserPod proof 10b is inactive under the later owner decision.

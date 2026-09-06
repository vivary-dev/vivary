# 20c deterministic headless-loop preparation receipt

Evidence-record: 20c
Date: 2026-09-06. Verification kind: runtime. Result: needs-info. The
implementation is frozen, and independent source review closed all six findings.
Habitat runtime acceptance remains held after the strict deadline guard observed
the wall clock move backward in three final waves.

## Result and prerequisite

The twelve implementation files are complete and frozen. Packet 20c remains open
because Habitat did not provide a nondecreasing wall clock for one complete
acceptance wave. The Habitat environment maintainer owns this prerequisite.

The strict guard is part of the packet contract. It rejects backward or uncertain
clock observations and keeps the original one-hour deadline across resume. No
accepted change weakens that rule. The final two runs used CPU 0, and the final run
kept the distro active with a bounded helper. Both still observed a backward step.
A keepalive and CPU affinity do not establish clock stability.

Packet [20a](../packets/20a-headless-loop-proof.md) retains its separate need for a
verified pre-admission token bound. This receipt contains no live Claude call,
runtime authentication proof, or factory acceptance.

## Authority and environment

The current integration baseline is commit
`794296f17116179700b27b536099994c78410802`, tree
`33bd861cf331bbc64637b7243ee88355cb61cbd5`. Historical development waves preceded
that fast-forward. The twelve frozen source hashes remained unchanged across the
integration, and the later strict continuous wave used the current baseline.

The retained Habitat daemon reported ID
`3b437172-3fc6-4ee4-aa2b-f70e04c5a74a`, Docker root `/var/lib/docker`, and Docker
`29.7.2`. Every candidate wave used the existing image
`sha256:ffdba5d54dd6f91875fa60fc15103b6b30bb23ecaaf2d8ed65559d3cdff05bee`
with `--pull never`. The preflight reported UID and GID `1000`, Python `3.11.16`,
and Git `2.43.0`.

The final boundary used user `ubuntu`, `--network none`, a read-only root,
`--cap-drop ALL`, `--security-opt no-new-privileges`, two CPU quota units,
`--cpuset-cpus 0`, 1 GiB memory, and 128 processes. The source bundle was a
read-only mount. Only the persistent test root at `/tmp` was writable. The
container had no authentication volume, Docker socket, production checkout,
external network, or provider configuration.

No package installation, clock change, service change, model call, provider API
call, app server, schedule, paid service, commit, push, or cleanup ran.

## Frozen delivery bundle

The delivery manifest contains twelve entries. Its SHA-256 is
`452a434c0c37979747e9dff17ef7f0ca9df7ee13a5fc729a717aa602478f7061`.
The staged diff check found an extra blank line at EOF in three new files.
Delivery removes exactly one final LF byte from `linkcheck.py`, `spec.md`, and
`hoh/__init__.py`; the other nine files are byte-identical to the last tested
strict revision. This delivery revision has not been executed. It preserves
the strict clock policy, and runtime acceptance remains held.

| Source | Bytes | SHA-256 |
| --- | ---: | --- |
| `docs/product/multi-project/fixtures/hoh-loop/linkcheck.py` | 1,122 | `3323e052e3649b9c811c0a685121f0ab73027f1ab87c364b31c8adc0928f96d5` |
| `docs/product/multi-project/fixtures/hoh-loop/spec.md` | 1,058 | `8a9c239f21e9613fb18d7a813ac3a62e53863d9ba4e777bab6b4090c3ad9b26d` |
| `docs/product/multi-project/fixtures/hoh-loop/tests/test_links.py` | 4,050 | `4fb90f88091d486cb034f53e41c46f03508e06aedf4478068c7b4e950801dc2d` |
| `tools/hoh/__init__.py` | 66 | `0b95447b469c56520f69606b3e57114ac5605a4683ec27cfd4eb2866d643e707` |
| `tools/hoh/claude.py` | 4,956 | `4d1703d1e58a55edf1e085bbd654665c9c1f290d37eca39b644af8e601ae85eb` |
| `tools/hoh/prompts/developer.md` | 687 | `405910e2b6ea41f970d5e214237594e28ddb09f72a4beaf5cd98b9ca5fe516ee` |
| `tools/hoh/prompts/planner.md` | 996 | `f06b0026ff7db5fea67bf833617f81f2a9a3dd1c7b02ec6d99416d5dd475ae52` |
| `tools/hoh/prompts/qa.md` | 880 | `0214968ac4322276cd8412bd5cdf991229d7a3b94f7d9c36ec3673fd93e2443f` |
| `tools/hoh/protocol.py` | 33,576 | `fe0add227e2a510657c18a80aab5d6e743260eb791ba98a1ce7478eddd131d73` |
| `tools/hoh_loop.py` | 81,867 | `4f163f10b91d3629818ef204ce80ba8ebb1bb4d024e25f60dd49e30aba756c5a` |
| `tools/tests/hoh_fault_probe.py` | 3,376 | `8ad0a31f120c1978f9a308aa1ba51990550d200f33b000325b820580f6376c1d` |
| `tools/tests/test_hoh_loop.py` | 72,026 | `f6c63f925ac76e856b82d97410ce7c7c3b4a457735bac5c3f97e00fb09f983b6` |

The delivery source archive SHA-256 is
`d79e97433c059f29694d110fcd6d78ff5777dd48262ddd16c79de4752ebb8f15`.
All twelve archive members matched the delivery manifest by size and SHA-256.
The manifest, source archive, and byte-comparison record are retained as the
separate `delivery-whitespace-*` evidence supplement.

The historical strict test manifest is
`f5dce7382cd8c13049069954f1a50baafdc0781bce261db4d09115b0e16060fa`.
Three comparisons after the `dev` fast-forward found zero mismatches before
delivery whitespace normalization. Its preserved source archive SHA-256 is
`426e413510e8e0166a1f563def4de8c2eedb3ea97ae4cee3267ededf831d6ee7`.
The staging helper restored each archive into a fresh Habitat source root,
compared every file with the manifest, and made the source tree read-only before
container creation.

## Implemented controls and source review

The deterministic implementation covers the fixed four-case oracle, expected-red
starter, three role views, prompt assembly, strict records, token reservation and
settlement, iteration order, no-progress handling, resume, regression handling,
frozen QA input, and the native Claude CLI adapter preflight. The tests use only
deterministic role doubles and disposable fixture copies.

The final independent source review closed six findings:

1. A `developer_complete` resume requires exactly one matching developer receipt
   and binds its candidate, checkpoint, development document, and developer report.
2. Reopening `failed` or `regressed` state remains terminal when derived role views
   are absent.
3. An invalid developer response that changed its writable view cannot retry,
   export, or start the next role. A planner or unchanged read-only view retains
   the one schema retry.
4. Every receipt requires the baseline commit and tree Git object IDs. Resume
   validates every receipt against them.
5. A new baseline requires empty Git porcelain and an exact match between tracked
   files and actual non-Git files. Dirty, staged, untracked, and ignored additions
   all refuse.
6. The sequencer hashes each frozen candidate before and immediately after the
   product oracle. A self-mutating candidate writes an incomplete test receipt and
   stops before QA or acceptance.

The reviewer matched the strict hashes above and found no remaining defect in
these six areas. The reviewer made no independent runtime claim because the final
strict waves refused on the environment clock.

## Verification history

All candidate execution happened in retained offline Habitat containers. The
exact command was `python3 -B -m unittest discover -s tools/tests -p
'test_hoh*.py' -v`. Repository CI runs its existing guards but does not execute
this mutable-candidate suite. CI is not acceptance evidence for packet 20c.

| Wave | Boundary and result | Disposition |
| --- | --- | --- |
| `green-hardening6` | 33 of 33 tests passed in 46.395 seconds on an earlier source revision | Useful pre-review evidence. Six later review fixes superseded its source bytes. |
| `green-final-review1` | Strict clock policy, normal affinity. 38 tests passed and one errored in 45.873 seconds. | Refused after the schema-retry fixture's four-test oracle passed but the wall clock moved backward. |
| `green-final-review2` | A temporary two-second clock tolerance produced 39 of 39 passing tests in 51.495 seconds. | Excluded. The tolerance conflicted with the packet rule, was reverted, and is absent from the frozen hashes. |
| `green-strict-affinity1` | Strict policy with CPU 0 affinity. 38 of 39 outer tests passed in 51.843 seconds. | Refused after an intentionally-red four-test oracle finished but the wall clock moved backward. |
| `green-strict-continuous1` | Strict policy with CPU 0 affinity and continuous distro activity. 38 of 39 outer tests passed in 47.932 seconds. | Refused after the no-progress fixture's four-test oracle passed but the wall clock moved backward. |

The outer failures do not show a mismatched fixture result. Each affected inner
oracle executed all four declared test IDs exactly once. The strict clock error
made its evidence incomplete before the later outer assertion.

## Clock evidence

| Observation | Wall result | Monotonic result |
| --- | --- | --- |
| `green-final-review1` | Observed `1788732719446275221` after persisted `1788732720582900513`, a `-1,136,625,292` ns step. Process wall elapsed `-1,139,429,536` ns. | Process monotonic elapsed `625,752,967` ns. |
| `green-strict-affinity1` | Observed `1788733619921956926` after persisted `1788733621152017707`, a `-1,230,060,781` ns step. Process wall elapsed `-1,233,142,657` ns. | Process monotonic elapsed `748,368,178` ns. |
| `green-strict-continuous1` | Observed `1788734197332049984` after persisted `1788734198375883969`, a `-1,043,833,985` ns step. Process wall elapsed `-1,046,968,456` ns. | Process monotonic elapsed `676,831,993` ns. |

The first 20-second diagnostic sampled the original affinity and then pinned the
same process to CPU 0. The original phase recorded a `+2,004,441,775` ns wall
delta at sample 330 and a `-1,775,585,498` ns delta at sample 357. Both samples
began and ended on CPU 0. The phase had five CPU transitions elsewhere. Its
CPU-0 phase recorded no negative delta or one-millisecond clock divergence.
That single result did not prove affinity fixed the clock.

A second 20-second diagnostic during continuous distro activity recorded 1,827
normal-affinity samples and 1,778 CPU-0 samples with no negative delta or
one-millisecond divergence. The later candidate wave still observed the third
rollback above. Before and after that wave, `systemd-timesyncd` remained active
and running with `ActiveEnterTimestampMonotonic=4846921088` and
`ExecMainStartTimestampMonotonic=4846868642`. The keepalive did not satisfy the
prerequisite. The captured journal contained no new service start or sync event
during the wave, so the immediate cause of that last step remains unresolved.

## Excluded and refused attempts

The evidence archive preserves these attempts because none confers acceptance:

- A Windows host source parse and five host unit tests ran before the boundary
  correction. Their output and temporary paths are labeled excluded.
- A Docker Desktop probe reached the `desktop-linux` daemon. It did not contain
  the Habitat image or task containers. Every accepted daemon check used the
  explicit Habitat distro.
- An early helper invocation passed pipe characters through the WSL command
  boundary and refused before creating files or a container.
- The next transfer refused because ignored host bytecode appeared in the
  manifest but not the archive. Later bundles exclude bytecode from both.
- A reviewed diagnostic tried to bind a Windows `/mnt/c` path that the Habitat
  Docker host could not see. Docker refused before container creation. The next
  diagnostic received the same hashed script over standard input.
- `green-final-review2` changed the strict clock policy. Its result is retained
  for audit only. The final source and all resumable instructions use the strict
  rule.
- A journal capture command split its spaced `--since` argument and returned
  exit 1. A separate root read supplied the service history stated above.

## Evidence export and restoration

The final private evidence archive contains its manifest plus 195 evidence files,
including the frozen source archives and manifests, test logs, container
inspections, failure receipt extracts, clock diagnostics, excluded-attempt
records, retained-resource inventories, both earlier exports, and the private
host-time prerequisite note. Its manifest SHA-256 is
`74a0f7f00e1b8aa964402e60b1d2446fa3ec4a0ad13b0128d6b56c5dfcbc1d89`.
The archive SHA-256 is
`423b1468dd09bb0c667380f66a80a93b129607e182ed1e46f95fac132cf94390`.
The host-time note's SHA-256 is
`579670c0c89bf94762225cc6f7e0b9d7aef9625737c70fe1a19656f1c3346831`.

The owner extracted the final archive into a fresh ignored restore directory and
compared every listed byte count and SHA-256. All 195 evidence entries and the
restored manifest matched, with zero missing or changed files. The earlier 76-
and 48-entry archives and their zero-mismatch restores also remain preserved.

Private evidence remains under the authorized Littleagent evidence root and the
Habitat task root. This public receipt uses aliases for those machine-local
paths. It does not publish private filesystem coordinates.

## Resume point

The Habitat environment maintainer must first provide evidence that the selected
clock stays nondecreasing across the complete container and subprocess lifecycle.
A short clean diagnostic, CPU affinity, or keepalive alone is insufficient.

After that prerequisite is met, verify immutable integration commit
`794296f17116179700b27b536099994c78410802`, tree
`33bd861cf331bbc64637b7243ee88355cb61cbd5`, as an ancestor of the runnable
candidate HEAD. Do not check out or reset to that commit: it predates the
implementation. Bind the runnable candidate to all twelve frozen delivery
manifest entries, then recheck the pinned image and daemon identity. Record the
time-service identity and readiness without changing its configuration. Then
run exactly one fresh wave:

```powershell
& '<private-evidence-root>\stage-wave.ps1' -Wave 'green-strict-stable-clock1'
```

The reviewed helper SHA-256 is
`5727f1859a13947451d96f83ea53ff2f810f8f287d427b74c095668de6817d32`.
It includes `--cpuset-cpus 0` and the limits recorded above. Stop on any clock
discontinuity, source mismatch, isolation change, or test failure. A bounded
task-owned keepalive may keep Habitat active during the wave, but it does not
guarantee wall-clock stability.

## Retained cleanup disposition

No cleanup is approved or performed. Review these task-owned resources by
2026-09-13. The deterministic preparation owner must ask Jeff for explicit
approval before removing each container or path. The private inventories bind 41
stopped containers and 74 Habitat task-root paths. Their SHA-256 values are
`2970b3ea1013cdbcf906a9909a3e9dfa7bc68fdb3407ad5d4e18bcddaaed27d6`
and `6eb9294b10a215c0f11e76728b4803e13e92aa3c0eb898053bbee3a8da3936a4`.

### Private inventory records

The logical artifact `20c-retained-containers-final.txt` itemizes all 41
stopped task-owned containers. The logical artifact
`20c-retained-paths-final.json` itemizes all 74 retained Habitat task-root
directories with their file counts and byte totals. Both are included in the
final evidence export and bound by the hashes above. Exact machine-local names
remain in private evidence for the cleanup owner.

The archive preserves captured logs, source bundles, manifests, and the two
inventory records. It does not contain the persistent test-tree contents named
by the 74-path inventory. Those trees remain only in the private Habitat task
root pending itemized cleanup approval.

The delivery supplement, private evidence root, all three restored archive directories, all three
evidence archives, their manifests, and their restoration receipts also remain
retained. The bounded keepalive was a
temporary process with host PID `28620` and scheduled expiry `2026-09-06T22:48:05Z`.
No recurring job or cleanup schedule was created.

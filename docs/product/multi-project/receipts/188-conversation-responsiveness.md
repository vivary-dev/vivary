# Conversation responsiveness — issue #188

## Result and scope

Retain E1: share bounded Intl formatters and observe message geometry without cloning message content. Reject E2: the added Code record/transcript cache did not produce a worthwhile incremental switching gain. No third experiment was started. No new content cache, prefetch, authorization path, or provider call ships.

The retained change substantially reduces long-thread delays, but does not meet the exploratory 12-second long-thread target or 1.5-second large-Code target. Ordinary Native revisit improves by 42.6%, short of the batch’s 50% target. This receipt records the bounded improvement, regressions and remaining limits; it is not owner approval or release acceptance.

## Reproducible comparison

The full built-app harness is retained at source commit `6e8b2d5` and SHA-256 `6ba32494e8961e85b25841a9fb930fe4c30ddbaca0a1448c710468930743e793`. Three fresh servers per size; fifteen switch samples per runtime/pass and fifteen search targets per run; five fresh browser loads per server; 30 seconds idle; 30-switch memory journey. Small histories contain 10 Native threads × 20 messages and 10 Code runs × 50 events. Large contains 200 Native threads × 200 messages (newest three: 2,000) and 1,000 Code runs × 400 events (newest five: 5,000; display window: 400). Synthetic data, seed 188, no model calls.

Both builds used Node 24.21.0, Chrome 154.0.8037.97, 1440 × 1000 viewport, Linux 7.0.0-38-generic, six Xeon Gold 6140 vCPUs and about 15 GiB memory. Sequential builds/measurements used the same host. Per-run load averages and every sample remain in raw results. Lightweight tests ran during the baseline first repeat’s later search/journey period; no concurrent build/browser was launched.

The keep rule was recorded before experiments: median saving ≥250 ms for switching (100 ms search), and relative gain above max(15%, three times the larger full between-repeat range/median). These are medians of per-run medians, not a controlled causal model or statistical confidence interval.

Original `ColdMs` labels are first-pass clicks: startup-selected Code 0000, untimed Native hops and persisted server selections can pre-open targets. They are not guaranteed first visits. The separate CI guard fixes this selection issue and was calibrated separately using explicit untimed startup selection and disjoint timed targets.

## Baseline versus corrected E1

| Size / scenario | Baseline ms | E1 ms | Saving | Clears keep rule |
| --- | ---: | ---: | ---: | --- |
| large / codeColdMs | 3,328 | 2,127 | 36.1% | no |
| large / codeWarmMs | 3,522 | 2,138 | 39.3% | yes |
| large / nativeColdMs | 31,391 | 15,042 | 52.1% | yes |
| large / nativeColdMs.longest | 77,989 | 36,602 | 53.1% | yes |
| large / nativeColdMs.others | 7,941 | 4,315 | 45.7% | no |
| large / nativeWarmMs | 4,903 | 2,552 | 48.0% | no |
| large / nativeWarmMs.longest | 39,945 | 19,248 | 51.8% | yes |
| large / nativeWarmMs.others | 3,889 | 2,232 | 42.6% | yes |
| large / searchFirstMs | 6,415 | 6,224 | 3.0% | no |
| large / startup.pageToComposerMs | 5,461 | 4,105 | 24.8% | no |
| large / startup.pageToListMs | 2,814 | 1,695 | 39.8% | no |
| small / codeColdMs | 756 | 599 | 20.8% | no |
| small / codeWarmMs | 740 | 584 | 21.1% | no |
| small / nativeColdMs | 1,135 | 879 | 22.5% | yes |
| small / nativeWarmMs | 797 | 637 | 20.0% | no |
| small / searchFirstMs | 164 | 158 | 3.7% | no |
| small / startup.pageToComposerMs | 2,702 | 2,178 | 19.4% | no |
| small / startup.pageToListMs | 2,431 | 1,993 | 18.0% | no |

Longest Native strata have 6–7 samples per repeat; ordinary strata 8–9; the full runtime aggregates 15. Different strata and counts are preserved. Every small search target was found; large finds 7/15 targets and misses the same eight Code targets within ten More clicks on every run. Search latencies include successful targets only.

| Idle (30 seconds observed) | Baseline median | E1 median |
| --- | ---: | ---: |
| small / requests | 262 | 263 |
| small / bytes | 1,170,858 | 1,188,430 |
| large / requests | 230 | 230 |
| large / bytes | 6,034,023 | 6,029,826 |

Per-minute rates are twice these 30-second observations, not an independent minute-long measurement. Large event-loop maximum ranges 209–239 ms baseline versus 212–226 ms E1 overlap. No request-count or event-loop win is claimed.

At completed large journey endpoints, renderer RSS 3,826–3,993 MiB becomes 1,508–1,842 MiB. **Server RSS increases 259–314 → 378–422 MiB.** Renderer-plus-server sums 4,084–4,306 → 1,899–2,220 MiB exclude other browser processes and are not unique physical-memory accounting. No controlled GC or retained-memory test establishes a leak or cause. Baseline large repeat 1 crashed during its memory journey; all preceding samples remain. The other two baseline large runs and all three small runs completed. Corrected E1 completed all six runs.

The owner reported Dream Reef competing load on 2026-10-06 from 03:55:18.722 to 03:56:00.713 UTC. Corrected E1 large repeat 1 startup/readiness may be confounded. Individual startup sample wall-clock starts were not recorded. No impact magnitude, causal attribution, exclusion, adjustment or retry was inferred. Startup improvements do not clear the noise rule.

## E2 rejected

Against corrected E1, large Code first-pass 2,127 → 2,055 ms saves 72 ms / 3.4%; revisit 2,138 → 2,269 ms is 131 ms / 6.1% slower. No incremental timing scenario clears the keep rule. Large idle 230 → 240 requests and 6.030 → 6.153 MB per 30 seconds; renderer endpoint median 1,686 → 1,855 MiB, server 391 → 397 MiB. Event-loop maximum 212–226 → 135–147 ms improves, but does not meet the targeted switching threshold. Search correctness is unchanged. Every E2 run completed and is retained.

Independent review found the added cache’s sign-out hook missed supported Better Auth-only logout. Removing E2 also removes that new retention gap. The proposed hosted regression was archived unrun; no red-before-green or passing result is claimed. The pre-experiment legacy draft-ID memo is unchanged.

## Source and raw provenance

| Build | Source | Dirty-source SHA-256 |
| --- | --- | --- |
| Baseline | `8b1d1e4eed9331095343366dbba387525d8209e8` | `5930d5440c9fca232a57aeb9374b7a524b14fce9850b5d7e0f7b981364cfbd69` |
| Corrected E1 | `ef157874c8c4aa76e3d13490fb45cc3bacaac922` | `0b02ebec9ffeeb326ef09a9dae4a6dbe6c880f081f4f9b9183e00c63743d5e40` |

E2 source is `9a6009f2f3a411ff621d87eef233e1c3a5dc00b1` with dirty-source SHA-256 `12cfa444c2eefe9b423df0a89b7ed058b8b08b2b7e4777959d617e8a31917991`.

Corrected E1 measured the E1-only commit plus the corrected formatter patch/lock from `de22edd`, with no E2. Baseline overlay only adds pinned Playwright, harness/plugin and timing helper. Exact source patches, serving builds and stashes are preserved with the private handoff; dependency directories are not archived.

| Raw result | SHA-256 |
| --- | --- |
| `baseline-8b1d1e4-small.json` | `78fbda06d87d45cf47e50d92d5a7878514768d37a38fc923a640c06846681bff` |
| `baseline-8b1d1e4-large.json` | `9b824fb759384d5815b3a8f5a610f75798dfdcd639b08edec6670579535745e1` |
| `e1-corrected-de22edd-small.json` | `662c659f48bcd4475bc7ac86e38717aaa4b1038ecbe702986b083f5abc04c320` |
| `e1-corrected-de22edd-large.json` | `bdb0a4ece586dbd25102a2540a9091fd1670f588d37846d89dcfdf7598db3d32` |
| `e2-9a6009f-small.json` | `47b63a6e38546d30880b40fba63401b36514e478e100f6a7cc904d5f69533b56` |
| `e2-9a6009f-large.json` | `3a675671ca8771d77ec7636026c502f55a7afa1a09874fc2e5b55c25f2e2f2bd` |

Raw JSON, Markdown, traces, logs and checksum manifests remain with the owner’s #188 evidence. Superseded original-E1 measurements and failed build/review attempts are retained; they are not substituted for corrected E1.

## Correctness and UI

Installed formatter tests execute timestamp/formatDate behavior, bounded reuse, eviction, locale/options, invalid inputs and timezone changes; the timezone regression demonstrated an actual failing result before its fix. Rendered message tests exercise Expand/Collapse, shrinking content, Edit/Cancel and retired observers. Earlier coverage is not a retroactive red-before-green claim.

Actual retained-E1 built app at `9b688f9` was inspected using server-side Playwright at 1440 × 1000 and 390 × 844 outside timing windows. Keyboard expansion, collapse, Edit/Cancel persistence, resize, reload, old Native/Code search anchors, empty search and unavailable desktop-access states passed. Narrow navigation closes on selection/Escape; no horizontal document overflow, page errors or external requests. Browser/server were gracefully stopped. Synthetic saved conversations and disabled providers do not establish real provider/tool execution, browser-click sign-out or packaged Windows acceptance.

## Calibrated guard and remaining gates

The ordinary-switch guard uses three fresh servers, fifteen first-visit and revisit
samples per runtime per server, and fixed Code 1–3 and Native 196/195/194 targets.
Each fresh browser context opens untimed Code 5; Native 193 is the other untimed
hop. Server caches persist. This avoids the original full harness’s pre-opened
targets while retaining the same large stored history.

| Revisit scenario | Baseline per-repeat medians, ms | E1 per-repeat medians, ms | Median ratio | Larger relative spread | Fixed ceiling |
| --- | --- | --- | ---: | ---: | ---: |
| Code | 3,280 / 3,134 / 3,174 | 2,204 / 2,237 / 2,241 | 0.7047 | 0.0460 | 0.76 |
| Native | 3,250 / 3,288 / 3,303 | 2,357 / 2,353 / 2,286 | 0.7157 | 0.0300 | 0.75 |

The rule was recorded before candidate calibration: add the larger full
between-repeat range/median to the candidate/baseline median ratio, then round
up to 0.01. Both gains clear the original keep rule and save more than 250 ms.
Keep these ceilings fixed for subsequent verification; ratchet downward when a
new win is proven. First-visit medians were also recorded: Code 3,072 → 2,362 ms,
Native 6,559 → 4,238 ms. They do not replace the earlier full-mode evidence.

Calibration source is clean `9b688f9` against the fixed `8b1d1e4` baseline, using
harness SHA-256 `49293f49b88f55973b082527a2ecbf1635e6e67a3a30f4da4b03e2661c44e2b5`.
Both runs exited zero with all three repeats complete and 45 samples per scenario.
The raw paired checker passed. The shorter mode protects ordinary switching;
the 2,000-message operation bound and rendered controls protect the shared E1
mechanism. It is not a latency budget for the full long-thread target.

Independent review then identified unsafe timeout cleanup in the harness. An
actual setup-interruption probe reproduced the detached server surviving its
driver. The corrected harness preserves failed raw evidence and closes only its
owned handles, including repeated signals and interrupted startup. Its helper’s
stop operation is idempotent. Setup and active-browser probes each sent three
SIGTERM signals and passed with no recorded descendants alive. These probes were
outside all accepted timing windows. A failed probe’s exact orphan was gracefully
released; no broad process kill was used.

CI now selects relevant Workbench/design/workflow changes, checks out the exact
candidate and pinned baseline separately, and applies only the baseline’s
measurement dependency/helper overlay. It builds and measures them sequentially,
requires the paired budget to pass and uploads evidence even after failure.
Thirty-one workflow contract tests pass; the three new contract cases first
failed when the checker accepted missing/weakened performance checks.

**Still pending:** final paired verification with the cleanup-corrected harness,
exact-final-head maintained/applicable CI, independent final review/publisher,
and owner approval. Calibration on this server is not a GitHub runner result.
No merge or release acceptance is claimed.

Raw `guard-baseline.json` SHA-256: `691bc9d8826a32dc4a587b5a4bd6e2e21f73a6aaec6471c8beeebdadda16ec07`.

Raw `guard-e1.json` SHA-256: `33db8501d19adecaf7140f72b18ace3708722756c35df48fc72b4c88c04d6457`.

# strato

**The agent OS** — the stratosphere layer, the stable contract above tropo's churn.
If tropo is *what's true*, strato is *how an agent works over it*: a per-turn loop,
one visible state surface, human gates, and the self-improvement that compounds across
sessions.

strato is **[throughline](https://github.com/Jeff-Kazzee/throughline) and
[flywheel](https://github.com/Jeff-Kazzee/flywheel) fused** — they are one loop at two
speeds:

- **Per turn** (throughline): `Ask → retrieve → act → verify → learn → gate`, the
  FW/WS/PRIV/VS/Gate grammar, the visible State Surface, human gates.
- **Per heartbeat** (flywheel): distill what the loop *learned* into durable memory, a
  bug-risk playbook (self-healing), and skills extracted on a workflow's third
  occurrence; audit workspace hygiene.

**Design law:** strato must be *tiny to load*. The only always-on file is `STRATO.md`;
templates load once at bootstrap, module `index.md` files route progressively, and
the procedures load on demand from the skill. One fact gets one owner; links beat
copies.

## Layout

| Path | What it is |
|---|---|
| [`STRATO.md`](STRATO.md) | The compressed model — the always-on agent OS (read this) |
| [`templates/`](templates/) | A workspace's starters: `AGENTS.md`, `SOUL.md`, `USER`/`MEMORY`/`STATE` templates, `bug-risk-playbook.md` |
| [`.claude/skills/strato/`](.claude/skills/strato/) | The executable: `bootstrap` / `heartbeat` / `self-improve` modes |
| [`strato.py`](strato.py) | The opt-in `strato decide --governed` facade over `vivary-core` policy |
| [`.claude/skills/active-context/`](.claude/skills/active-context/) | Optional CocoIndex-code sidecar decision/retrieval policy |

## How it's used

strato is the **framework**; a workspace is the **instance**. `create-vivary` lays
the templates down, and the strato skill runs `bootstrap`, `heartbeat`, and
`self-improve`. The workspace's own `AGENTS.md` is distinct from Vivary's root
`AGENTS.md`, which governs agents working on Vivary itself.

The runtime facade is deliberately opt-in:

```console
strato decide --governed --json request.json
```

It validates the request schema, pinned policy version, core-owned actor and authority
class, workspace binding, absolute scope roots bound to the Task Capsule, the capsule's
deterministic identifier and body fingerprint, and caller-supplied timestamps before
delegating the budget/gate/next-loop decision to `vivary-core`. The compiler and
verifier share the JavaScript-lossless `max_claims` bound; fabricated capsule IDs,
missing compiler-owned fields, malformed task scopes, and non-canonical or numerically
lossy capsule values fail closed. Requests, capsule observations, and receipts have a
deterministic 300-second freshness window. A verdict is accepted only beside its
receipt. A malformed, invalid, altered, or unsafely nested
envelope returns a `vivary.strato-decision-refusal/v0` document and exit `2`; a valid
envelope returns
`vivary.strato-decision/v0`, is advisory, and exits `0`. Add `--strict` to exit `1`
when core blocks or requests a gate. Unknown fields and non-string Python mapping keys
are rejected, so free-form status text cannot impersonate a human gate. Omit `--json`
for a short text summary. The full contract is in
the [command reference](../../docs/COMMANDS.md#strato--the-policy-layer).

Loop *literacy* — running the loop unattended — is strato's domain too; see the loops
skill (`.claude/skills/loops/`).

## Versioning

The `vivary-strato` Python distribution is at unpublished source version **0.1.2** and
requires `vivary-core>=0.2.4`. Both remain unpublished during development and ship only
through the final coordinated release gate. The templates and skills remain
bundled by `create-vivary`; the runtime package does not duplicate or replace them.

From this checkout, install the unpublished pair without consulting a registry:

```console
python -m pip install --no-deps ./packages/core ./packages/strato
```

> Distilled from throughline + flywheel (Jeff's own repos, used read-only). Not a
> verbatim copy — the overlap (duplicate memory templates, gates, proactivity rules)
> is collapsed into one model.

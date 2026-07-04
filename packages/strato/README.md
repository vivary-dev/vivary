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
| [`.claude/skills/active-context/`](.claude/skills/active-context/) | Optional CocoIndex-code sidecar decision/retrieval policy |

## How it's used

strato is the **framework**; a workspace is the **instance**. You don't edit strato per
project — you lay its `templates/` down into a new workspace (`create-vivary` does
this) and run the strato skill to `bootstrap`, then `heartbeat` on a cadence. The
workspace's own `AGENTS.md` (from `templates/AGENTS.md`) is distinct from Vivary's root
`AGENTS.md`, which governs agents working on Vivary itself.

Loop *literacy* — running the loop unattended — is strato's domain too; see the loops
skill (`.claude/skills/loops/`).

## Versioning

strato is not independently versioned — it has no version number of its own and
ships no separate release. Its templates and skills ride the `create-vivary` release
train: any change here lands in a `create-vivary` release, and the change itself is
recorded in the root [`CHANGELOG.md`](../../CHANGELOG.md) under that package's entries,
not under a `strato` heading.

> Distilled from throughline + flywheel (Jeff's own repos, used read-only). Not a
> verbatim copy — the overlap (duplicate memory templates, gates, proactivity rules)
> is collapsed into one model.

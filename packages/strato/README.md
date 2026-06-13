# @vivary/strato

> Status: **stub.** To be built by fusing [throughline](https://github.com/Jeff-Kazzee/throughline)
> and [flywheel](https://github.com/Jeff-Kazzee/flywheel). See [../../HANDOFF.md](../../HANDOFF.md).

**The agent OS** — the stratosphere layer. The stable layer above tropo's churn:
the operating contract every agent session runs, plus the self-improvement that
compounds it.

`strato` is **throughline and flywheel fused**, because they are one loop at two
speeds:

- **The loop (per turn, from throughline):** `Ask → retrieve → act → verify →
  learn → gate`. Plus the visible **State Surface** (Focus/Status/Next/Blockers/
  Sources/Updated), the FW/WS/PRIV grammar, and **human gates** before durable or
  outward-facing actions.
- **The self-improvement (on a heartbeat, from flywheel):** distill what the loop
  `learn`ed into durable memory, a bug-risk playbook (self-healing), skills
  extracted on the third occurrence of a pattern, and workspace hygiene audits.

Memory, agent state, and agent roles live here.

**Design law:** this must be *tiny to load*. throughline's whole thesis is that
the framework must not steal the context the work needs. Resist turning the agent
OS into ten pages of process.

## To build (see HANDOFF §"Recommended next steps")

Start from throughline's `THROUGHLINE.md` compressed model + `AGENTS.md` runtime
contract, and flywheel's three modes (`bootstrap` / `heartbeat` /
`self-improvement`). Collapse the overlap (both have MEMORY templates, gates,
proactivity rules) into one minimal model.

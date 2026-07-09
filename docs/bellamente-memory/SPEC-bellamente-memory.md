# SPEC: Bellamente memory provider for Vivary

Status: design locked via grill-with-docs session (2026-07-09). Ready for
implementation planning.

## Summary

Add Bellamente as an optional memory provider for Vivary workspaces.
Bellamente enters as agent LTM beside tropo — not a tropo-backed recall
sidecar like Cognee, and not a full product drop-in. Vivary writes config,
MCP wiring, and agent rules; shells out to `bella` CLI for verification and
runtime. No Vivary-owned adapter package.

## Locked decisions

| # | Decision | Lock |
|---|---|---|
| Q2 | Integration shape | Scaffold-time wiring. Vivary sets projects up to use Bellamente. |
| Q3 | Opt-in model | Explicit opt-in. Never default in presets. |
| Q4 | CLI entrypoints | Both: `--memory bellamente` at init + `memory add bellamente` post-setup. Same provider registry as `none\|local\|cognee`. |
| Q5 | "Main option" meaning | Recommended first in docs/help, but still opt-in. Bellamente is the first-class maintained adapter; Cognee is supported secondary. |
| Q6 | Bellamente's job | Agent LTM beside tropo. Tropo = project truth. Bellamente = durable agent facts with provenance. Neither silently rewrites the other. |
| Q8 | Greenfield only | v1 targets workspaces just started, no real coding done, docs may exist. Not brownfield. |
| Q9 | Pass bar | Install + doctor green + one live memory round-trip (write fact → recall → trace exists). Uses real `bella` CLI or MCP, not a test seam. |
| Q10 | Data location | Workspace-local DB at `.bellamente/data/` (gitignored). Dies with project. Global is later/explicit. |
| Q11 | Dual-store rules | Strict split: Bellamente = agent LTM, tropo/STATE = project truth, private files stay private. Single facts allowed; bulk/import/private-source gated. |
| Q12 | MCP targets | Claude Code (first-class), Codex (first-class), generic MCP snippet (for Grok/others). Cursor not in v1. |
| Q13 | Command engine | Same install/verify path behind both entrypoints. Both refuse non-greenfield. |
| Q14 | Package boundary | Thin create-vivary integration + shell out to `bella`. No `vivary-memory-bellamente` adapter package. |
| Q15 | Install method | `bella` must be pre-installed by the user. `memory add` verifies via `bella doctor`. No binary download. |
| Q16 | DB scoping | Separate DB per workspace via `BELLA_DATA_DIR` env var pointing at `.bellamente/data/`. |
| Q17 | MCP config files | Three: `.mcp.json` (Claude Code, committed), `.codex/config.toml` (Codex, gitignored), `.vivary/mcp-servers.json` (harness-neutral reference). |
| Q18 | Agent rules location | `.vivary/memory-rules.md` holds full rules. `AGENTS.md` gets a short memory section + link only when a memory provider is installed. |
| Q19 | Rules content | Dual-store table, write gates, MCP tool list, data location. (See below.) |

## CLI surface

```
create-vivary init . --preset coding --memory bellamente --yes
create-vivary memory add bellamente --yes
```

Both call the same installer/verifier. Both refuse non-greenfield workspaces.

## Install flow (memory add bellamente)

1. **Greenfield check** — refuse if workspace has real code (heuristic: more
   than docs/config files present, or an existing memory provider configured).
2. **Verify bella** — run `bella doctor`. If `bella` not on PATH or doctor
   fails, stop with a clear "install Bellamente first" pointer.
3. **Write config** — `.vivary/memory.toml` with `provider = "bellamente"`,
   privacy settings, and `BELLA_DATA_DIR` pointing at `.bellamente/data/`.
4. **Write MCP configs** — `.mcp.json` (Claude Code), `.codex/config.toml`
   (Codex), `.vivary/mcp-servers.json` (generic reference).
5. **Write agent rules** — `.vivary/memory-rules.md` + short section in
   `AGENTS.md` with link.
6. **Update .gitignore** — add `.bellamente/`, `.codex/config.toml`.
7. **Round-trip proof** — write one test fact via `bella` CLI or MCP, recall
   it, verify a trace exists. Prefer cleanup/forget after proof.
8. **Doctor report** — `create-vivary doctor` reports Bellamente configured +
   healthy.

## Files written by scaffold

| File | Purpose | Committed? |
|---|---|---|
| `.vivary/memory.toml` | Memory provider config | yes (no secrets) |
| `.mcp.json` | Claude Code MCP server entry | yes |
| `.vivary/mcp-servers.json` | Harness-neutral MCP reference | yes |
| `.vivary/memory-rules.md` | Agent rules for dual-store | yes |
| `AGENTS.md` | Short memory section appended | yes |
| `.codex/config.toml` | Codex MCP server entry | no (gitignored) |
| `.bellamente/data/` | Bellamente DB (workspace-local) | no (gitignored) |

## .vivary/memory-rules.md content

```md
# Memory Rules — Bellamente

This workspace uses Bellamente as its agent LTM provider.
Bellamente holds durable agent-usable facts. Tropo holds project truth.
Neither silently rewrites the other.

## What goes where

| Store | Holds |
|---|---|
| Bellamente DB | durable agent facts, preferences, decisions-with-provenance, cross-session lessons |
| tropo / STATE / modules | project truth, architecture, typed entities, current work state |
| USER.md / MEMORY.md / memory/ | private human context — never auto-copied into Bellamente |

## Write gates

- Single durable project-agent facts: allowed once Bellamente is enabled
- Bulk ingest, private-file import, anything leaving the machine: explicit human gate

## MCP tools

Bellamente MCP exposes: memory_search, memory_write, memory_correct,
memory_forget, memory_list, memory_history, document_ingest,
document_list, trace_inspect. Use these for all memory operations.

## Data

Bellamente DB lives at .bellamente/data/ (gitignored).
Memory dies with this workspace unless explicitly promoted to global.
```

## AGENTS.md addition (when memory provider installed)

```md
## Memory

This workspace uses <provider> for agent memory. Read
[.vivary/memory-rules.md](.vivary/memory-rules.md) before writing or
recalling memory. Tropo is project truth; <provider> is agent LTM.
```

## MCP config examples

### .mcp.json (Claude Code)

```json
{
  "mcpServers": {
    "bellamente": {
      "command": "bella",
      "args": ["mcp"],
      "env": { "BELLA_DATA_DIR": "${CLAUDE_PROJECT_DIR}/.bellamente/data" }
    }
  }
}
```

### .codex/config.toml (Codex)

```toml
[mcp_servers.bellamente]
command = "bella"
args = ["mcp"]
env = { BELLA_DATA_DIR = ".bellamente/data" }
```

### .vivary/mcp-servers.json (generic reference)

```json
{
  "bellamente": {
    "transport": "stdio",
    "command": "bella",
    "args": ["mcp"],
    "env": { "BELLA_DATA_DIR": "<workspace-root>/.bellamente/data" }
  }
}
```

## Out of scope (v1)

- Brownfield workspace support
- `memory add` for workspaces that already have a memory provider configured
- Binary download / platform detection
- Global Bellamente data dir (workspace-local only)
- Cursor MCP config
- Bellamente install automation (user installs `bella` themselves)
- Runtime recall integration with tropo/strato (Bellamente is used by agents
  via MCP, not wired into Vivary's retrieval pipeline)

## Test plan

- Greenfield detection: refuse when code files exist; allow docs-only
- `bella doctor` verification: pass when healthy, fail with pointer when
  missing
- Config writing: all files written with correct content + gitignore entries
- MCP config validity: `.mcp.json` valid JSON, `.codex/config.toml` valid TOML
- Round-trip proof: write → recall → trace exists, using real `bella` CLI
- Doctor integration: `create-vivary doctor` reports Bellamente status
- No-install safety: all core Vivary suites pass without `bella` installed
- Preset default: no preset silently selects `bellamente`

## Open implementation questions

- Exact greenfield heuristic (file count thresholds, file type detection)
- Whether `memory add bellamente` writes `.codex/config.toml` with absolute
  `cwd` at scaffold time or uses a relative path + `codex mcp add` instead
- How `create-vivary capabilities --json` reports the bellamente provider
  (adapter_status field, requires_install, etc.)
- Whether the round-trip proof runs `bella` CLI directly or starts `bella mcp`
  and calls tools over stdio

## References

- ADR: [ADR-0001-bellamente-agent-ltm-beside-tropo.md](ADR-0001-bellamente-agent-ltm-beside-tropo.md)
- Domain glossary: [CONTEXT.md](CONTEXT.md)
- Existing semantic memory architecture: [../SEMANTIC-MEMORY.md](../SEMANTIC-MEMORY.md)
- Cognee adapter (the pattern we are NOT following): [../../packages/memory-cognee/](../../packages/memory-cognee/)
- Bellamente MCP implementation: `src/mcp.ts` in the Bellamente repo

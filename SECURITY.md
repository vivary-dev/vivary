# Security Policy

## Supported Versions

Vivary is pre-1.0 and ships several independently versioned packages. Security fixes
target the current public release line:

| Package | Supported line |
|---|---|
| `vivary` | `0.1.x` |
| `create-vivary` / `@vivary/create` | `0.3.x` |
| `vivary-tropo` | `0.4.x` |
| `vivary-ozone` | `0.2.x` |
| `vivary-exo` | `0.2.x` |
| `vivary-memory-cognee` | `0.1.x` |

Older versions may receive a note in the changelog, but fixes are expected to land in
the current line.

## Reporting a Vulnerability

Use GitHub private vulnerability reporting for this repository when available. If that
is not available to you, contact the maintainer through the repository owner profile
and avoid posting exploit details in a public issue.

Please include:

- affected package and version
- operating system and install method
- minimal reproduction steps
- expected impact
- whether any secret, private file, or network boundary is involved

## Scope

Vivary is a local Markdown workspace scaffold and CLI suite. Security-sensitive areas
include package publishing, dependency installation, generated `.gitignore` privacy
boundaries, active-context sidecars, and any workflow that pushes, opens PRs, or
publishes packages.

## Current Hardening Coverage

The current package set contains the June 23 security-hardening batch:

- scaffold writes, storage config writes, and stale generated cleanup refusing
  symlinked or out-of-workspace destination paths
- `create-vivary doctor` validating active `.gitignore` rules instead of accepting
  comments, negations, or substring matches for private files
- generated workspaces keeping `USER.md`, `MEMORY.md`, `memory/*`, and
  `heartbeat-reports/*` private while preserving `.gitkeep` placeholders
- `tropo view --out` and `exo claim` replacing workspace files without mutating
  hard-linked targets outside the workspace

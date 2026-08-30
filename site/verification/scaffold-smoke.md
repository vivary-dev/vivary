---
project: site
status: planned
target: scaffold-init
command: tropo check --root .
related_modules: [agent-workspace]
related_changes: [scaffold-init]
---
# Scaffold Smoke

Validate that the generated workspace has a loadable `tropo.toml`, clean starter
graph documents, and no broken graph references.

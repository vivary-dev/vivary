---
project: site
status: active
module_area: progressive disclosure router
related_modules: [agent-workspace, manuscript-system]
verification: [scaffold-smoke]
gates: [human-gates]
---
# Modules

Use this file to choose what to open next. Do not load every module by default.

- `agent-workspace` -> `modules/agent-workspace/index.md`
- `manuscript-system` -> `modules/manuscript-system/index.md`

## DRY Rule

Each fact gets one owner. Put the short routing summary in the module index, keep
canonical detail in the owning file, and link instead of copying.

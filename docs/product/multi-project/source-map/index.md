---
module_refs: [root-observation, project-registry, native-runtime, project-writeback]
---

# Vivary source map

Use this bounded graph after selecting a live owning GitHub issue. The
[program frontier](../index.md) is a navigation reference, not a second task ledger.
It routes from a product responsibility to its canonical contract, implementation,
tests, and evidence without copying those sources.

- [Root observation](modules/root-observation/index.md) owns bounded checkout discovery.
- [Project registry](modules/project-registry/index.md) owns canonical project identity and transitions.
- [Native runtime](modules/native-runtime/index.md) owns coding-runtime execution boundaries.
- [Project write-back](modules/project-writeback/index.md) owns authorized project effects.

For the full product, use the [visual specification module catalog](../specification/modules.md)
and [contributor operating manual](../specification/operating-manual.md). They
map current Workbench source and planned responsibilities without replacing
the bounded typed graph below.

Read the [original Vivary product map](../research/original-vivary-product-map.md)
when connecting templates, project files, context, or review to the Native GUI.

Run `python -B scripts/check-source-navigation.py --check` from the repository root
to verify the selected identities, edges, and repository-relative locators.

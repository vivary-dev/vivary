---
module_refs: [root-observation, project-registry, native-runtime, project-writeback]
---

# Vivary source map

Use this bounded graph after selecting work from the [program frontier](../index.md).
It routes from a product responsibility to its canonical contract, implementation,
tests, and evidence without copying those sources.

- [Root observation](modules/root-observation/index.md) owns bounded checkout discovery.
- [Project registry](modules/project-registry/index.md) owns canonical project identity and transitions.
- [Native runtime](modules/native-runtime/index.md) owns coding-runtime execution boundaries.
- [Project write-back](modules/project-writeback/index.md) owns authorized project effects.

Run `python -B scripts/check-source-navigation.py --check` from the repository root
to verify the selected identities, edges, and repository-relative locators.

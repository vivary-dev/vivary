---
status: accepted
date: 2026-06-12
deciders: [Jeff, Claude]
---

# Folder-as-type

We make the directory a document lives in *be* its type, instead of a `type:`
field on every file. The path already encodes the type in almost every vault;
declaring it again is pure noise. Type resolution is "nearest registered
ancestor folder" (see SPEC §2), which makes nesting — like this decision living
inside a project — resolve correctly with no extra configuration.

Consequence accepted: moving a file between type roots retypes it. We consider
that a feature, not a hazard — the move *is* the reclassification.

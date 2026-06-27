# Vivary — portfolio entry

Vivary is my open-source baseline for agent-native workspaces. It packages the
stuff every serious AI-agent project eventually invents by hand: typed project
memory, visible state, reusable skills, private memory boundaries, and
verification gates. Four PyPI CLIs are published, plus the npm `@vivary/create`
launcher; a generated workspace can be scaffolded and checked in minutes.

## Links

- **Live site:** https://vivary.vercel.app/
- **GitHub:** https://github.com/vivary-dev/vivary (public · MIT)
- **PyPI:** [`create-vivary`](https://pypi.org/project/create-vivary/) 0.2.8 ·
  [`vivary-tropo`](https://pypi.org/project/vivary-tropo/) 0.3.0 ·
  [`vivary-ozone`](https://pypi.org/project/vivary-ozone/) 0.2.0 ·
  [`vivary-exo`](https://pypi.org/project/vivary-exo/) 0.2.2
- **In-repo release candidate:** `vivary-memory-cognee` 0.1.0
- **npm:** [`@vivary/create`](https://www.npmjs.com/package/@vivary/create) 0.2.8

## Proof

Homepage — desktop:

![Vivary homepage, desktop](proof/homepage-desktop.webp)

One command scaffolds a verified workspace (real `create-vivary` + `doctor` +
`tropo check` output):

![Scaffold and doctor terminal output](proof/scaffold-doctor.webp)

Review by blast radius — the hero graph lights up everything that depends on a
changed node:

![Blast-radius graph](proof/graph-blast.webp)

Mobile:

![Vivary homepage, mobile](proof/homepage-mobile.webp)

## What it demonstrates

- **Product framing:** named the irreducible layer agent projects keep
  rebuilding, and shipped it as a one-command scaffolder.
- **Distribution:** four PyPI CLIs, plus the npm `@vivary/create` launcher,
  composed by `create-vivary`.
- **Restraint:** no third-party dependencies; the framework costs almost nothing
  to load. Plain Markdown, any editor, Claude Code *and* Codex.

> Release candidate line: `create-vivary` 0.2.8 (PyPI), `@vivary/create` 0.2.8 (npm),
> optional `vivary-memory-cognee` 0.1.0, `vivary-tropo` 0.3.0, `vivary-ozone` 0.2.0,
> `vivary-exo` 0.2.2. Versions are independent; there is no single "Vivary 0.3.0".
> This line adds typed context packets, graph-aware query filters, Ozone context-budget
> review, clearer CocoIndex-code active-context guidance, and gated Cognee recall.

> Context-compression release proof, refreshed 2026-06-27: `tropo find` and
> graph-aware `tropo query` passed 68 tropo tests; Ozone context-budget passed 16 ozone
> tests; create-vivary generated active-context workspaces doctor clean. Disposable
> smokes verified LanceDB embedded storage migration, CocoIndex-code exact-path search,
> and Cognee policy scaffolding. The optional `vivary-memory-cognee` adapter lives
> outside Vivary core and only accepts recall hits that map back to typed graph nodes.

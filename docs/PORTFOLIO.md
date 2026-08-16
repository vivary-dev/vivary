# Vivary — portfolio entry

Vivary is my open-source baseline for agent-native workspaces. It packages the
stuff every serious AI-agent project eventually invents by hand: typed project
memory, visible state, reusable skills, private memory boundaries, and
verification gates. Four PyPI CLIs are published, plus the npm `@vivary/create`
launcher; a generated workspace can be scaffolded and checked in minutes.

## Links

- **Live site:** https://vivary.vercel.app/
- **GitHub:** https://github.com/vivary-dev/vivary (public · MIT)
- **PyPI:** [`vivary`](https://pypi.org/project/vivary/) 0.1.10 ·
  [`create-vivary`](https://pypi.org/project/create-vivary/) 0.4.2 ·
  [`vivary-core`](https://pypi.org/project/vivary-core/) 0.2.7 ·
  [`vivary-tropo`](https://pypi.org/project/vivary-tropo/) 0.5.3 ·
  [`vivary-strato`](https://pypi.org/project/vivary-strato/) 0.1.2 ·
  [`vivary-ozone`](https://pypi.org/project/vivary-ozone/) 0.3.1 ·
  [`vivary-exo`](https://pypi.org/project/vivary-exo/) 0.3.0 ·
  [`vivary-memory-cognee`](https://pypi.org/project/vivary-memory-cognee/) 0.1.2 ·
  [`vivary-mcp`](https://pypi.org/project/vivary-mcp/) 0.1.3
- **npm:** [`@vivary/create`](https://www.npmjs.com/package/@vivary/create) 0.4.2

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

> Current release line: `create-vivary` / `@vivary/create` 0.4.2, `vivary-core` 0.2.7,
> `vivary-tropo` 0.5.3, `vivary-strato` 0.1.2, `vivary-ozone` 0.3.1, `vivary-exo`
> 0.3.0, `vivary` 0.1.10, plus optional `vivary-memory-cognee` 0.1.2 and `vivary-mcp`
> 0.1.3. Versions are independent; there is no single "Vivary 0.4.2". This line ships
> the thin five-file init contract, exact-hash brownfield `create-vivary adopt`, the
> `vivary-core` governed-context seam, and the optional read-only MCP adapter.

> Context-compression release proof, refreshed 2026-06-27: `tropo find` and
> graph-aware `tropo query` passed 68 tropo tests; Ozone context-budget passed 16 ozone
> tests; create-vivary generated active-context workspaces doctor clean. Disposable
> smokes verified LanceDB embedded storage migration, CocoIndex-code exact-path search,
> and Cognee policy scaffolding. The optional `vivary-memory-cognee` adapter lives
> outside Vivary core and only accepts recall hits that map back to typed graph nodes.

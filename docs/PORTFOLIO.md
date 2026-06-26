# Vivary — portfolio entry

Vivary is my open-source baseline for agent-native workspaces. It packages the
stuff every serious AI-agent project eventually invents by hand: typed project
memory, visible state, reusable skills, private memory boundaries, and
verification gates. Four PyPI CLIs are published, plus the npm `@vivary/create`
launcher; a generated workspace can be scaffolded and checked in minutes.

## Links

- **Live site:** https://vivary.vercel.app/
- **GitHub:** https://github.com/vivary-dev/vivary (public · MIT)
- **PyPI:** [`create-vivary`](https://pypi.org/project/create-vivary/) 0.2.6 ·
  [`vivary-tropo`](https://pypi.org/project/vivary-tropo/) 0.2.3 ·
  [`vivary-ozone`](https://pypi.org/project/vivary-ozone/) ·
  [`vivary-exo`](https://pypi.org/project/vivary-exo/) 0.2.2
- **npm:** [`@vivary/create`](https://www.npmjs.com/package/@vivary/create) 0.2.6

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

> Prepared release line: `create-vivary` 0.2.6 (PyPI), `@vivary/create`
> 0.2.6 (npm), `vivary-tropo` 0.2.3, `vivary-exo` 0.2.2. This line adds the
> `knowledge-work` preset, optional semantic-memory setup, capability discovery, and
> doctor memory reporting while keeping Cognee optional.
> Prepared 0.2.6 scaffold proof: `knowledge-work` and semantic-memory setups are
> covered by the create-vivary test suite and generated docs/site build.

> Active-context branch proof, refreshed 2026-06-23: plain coding scaffold writes 39 files and
> doctors clean at 9 nodes / 28 edges; `--active-context cocoindex-code` writes 45
> files and doctors clean at 12 nodes / 38 edges. `cocoindex-code==0.2.36` was
> installed with local embeddings, initialized against this repo, indexed 95 files into
> 897 chunks, and `ccc search --refresh` returned the active-context docs plus the
> `create_vivary.py` implementation.

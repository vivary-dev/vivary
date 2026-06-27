---
title: "Release workflow"
description: "End-of-update checklist for Vivary release truth, docs, publishing, and post copy."
---

Use this at the end of every Vivary update that changes behavior, packaging,
public docs, install commands, release status, or package versions.

## End-of-update checklist

1. **Set release truth first.**
   Update the package versions, dependency constraints, `README.md`, `CHANGELOG.md`,
   package READMEs, `docs/FAQ.md`, `docs/PORTFOLIO.md`, and `AGENTS.md` when the
   public agent contract changes.
   If the homepage names versions or package surfaces, update `site/src/pages/index.astro`.

2. **Keep docs and site in sync.**
   Source docs live in `docs/` plus root `CHANGELOG.md`. Run:

   ```bash
   cd site
   npm run sync-docs
   npm run build
   ```

   Commit generated `site/src/content/docs/*` changes with the source docs.

3. **Make local CLI truth explicit before command smokes.**
   If the change adds or changes CLI behavior that is not published yet, refresh the
   local CLIs from the current checkout before testing bare commands:

   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts/install-local-clis.ps1
   ```

   The script uninstalls existing Vivary uv tools, then installs this checkout without
   `uv tool install --force`. This prevents stale global tools from silently testing an
   older package or, worse, treating a new subcommand as a scaffold target.

4. **Record whether the release is planned or live.**
   Before publishing, the changelog may say "Publishing remains a manual human gate."
   After publishing, change that same entry to "Published and verified" with the exact
   package versions and smoke commands.

5. **Verify from the public registries after publish.**
   Check the package pages and run cache-resistant install smokes:

   ```bash
   uvx --no-cache --index-url https://pypi.org/simple --from vivary-tropo==<tropo-version> tropo --version
   uvx --no-cache --index-url https://pypi.org/simple --from vivary-exo==<exo-version> exo --version
   ```

   If npm changed, run npm from the package directory that owns the npm package:

   ```bash
   cd packages/create-vivary/npm
   npm view @vivary/create version
   npm pack --dry-run
   ```

6. **Keep private agent communications outside the repo.**
   Handoffs, agent-to-Jeff continuity notes, launch/social drafts, and private release
   packets stay in ignored local storage, such as `.release/private/`, or in the
   Second Brain. They do not go into the public repo.

7. **Capture the workflow learning.**
   If the update revealed a repeatable release lesson, save it in the repo docs or an
   explicit memory note. Do not rely on chat history as the only copy.

## Gates

These remain explicit human gates, one item at a time:

- `git push`
- opening a PR
- merging a PR
- PyPI publish
- npm publish
- GitHub release creation or update
- posting launch/social copy

Inside the work, be fast. At the edges, leave proof.

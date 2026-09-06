# Vivary workbench delivery and agent readiness

Updated: 2026-09-05. Status: planned release criteria, not released functionality. [Program](design.md), [graph](graph.md), [migration](migration.md).

## Done means the whole user journey

Each feature updates its owning canonical documentation and verification in the same change. After behavior stabilizes, update the product UI, website, screenshots, installation instructions, user guides, and troubleshooting. Publication follows the existing [release workflow](../../RELEASE-WORKFLOW.md).

The GUI is the primary experience. A working backend without discoverable project creation, adoption, runtime selection, files, plans, results, and recovery does not satisfy the product milestone.

## Guide inventory

| Guide | Required proof |
| --- | --- |
| Start with the GUI | A new user opens the workbench, creates a project, and finds its real files |
| Keep using standalone Vivary | Existing init/adopt/doctor paths work with no GUI, login, or project registry |
| Open an existing project | Registration changes no project bytes. Optional adoption has a reviewable diff and rejects conflicts |
| Version control is your choice | None, Git, Jujutsu, existing monorepo, and existing worktree cases show accurate capabilities |
| Connect a repository host | GitHub, Gitea/custom remote, local-only, and skip paths remain separate from project creation |
| Install a workspace template | Pinned content, preview, receipt, interrupted-install recovery, and independent workspace use |
| Select and resume a runtime | Actual installed/configured/runnable distinctions, project binding, cancellation, and supported resume |
| Learn with a Brain | Optional setup, sources, project privacy, review of learning proposals, correction, export, and deletion limits |
| Plan and execute work | Editable plan, selected task source, dependencies, reviewed execution, costs, and evidence |
| Run bounded automation | Factory, email, and heartbeat scope, deterministic no-op checks, stop, and recovery |
| Migrate from Littleagent | Preserved files/history, known prototype limits, saved sessions, and rollback |
| Agent integration | Structured operations, discovery, authority requirements, examples, and actual supported protocols |

Use real UI screenshots and verified outputs. Never describe a pending native runtime as runnable or an unpublished command as installed behavior.

## Website ownership

`docs/`, root README release status, and CHANGELOG are canonical. `site/scripts/sync-docs.mjs` generates doc mirrors and `llms.txt`/`llms-full.txt`. The Astro `site/` is the public website, not the GUI runtime.

Update homepage positioning, getting started, architecture, command reference, feature/maturity matrix, template and Brain guides, runtime support, screenshots, download links, and compatibility notices. Preserve useful existing URLs or redirect them intentionally. Align public claims with the actual package and app versions.

Run the repository's site sync, link, test, and build scripts using its package manager. Confirm generated parity and inspect the built pages in a browser. Existing dirty website work is preserved and reconciled before publication.

## Live scanner baseline

Verified: 2026-09-05. Public target: `https://vivary.vercel.app/`. Scanner: [isitagentready.com](https://isitagentready.com/), public MCP `scan_site`, profile `all`, no custom exclusions. Full response transcript (line endings and trailing blank lines normalized to repository policy; original bytes retained privately): [baseline receipt](agent-readiness-baseline-2026-09-05.txt).

The scanner reported Level 1/5, Basic Web Presence. Its category results total three passes among sixteen scored checks. The response did not provide an overall percentage, so no official percentage is claimed.

The API advertised twenty-two checks. Six were informational or not applicable in this response. The public page and API inventory can differ as the service evolves. Refresh the real API contract at implementation and record the actual enabled check set.

| Category | Baseline | Required work or investigation |
| --- | --- | --- |
| Discoverability | 2/4 | Keep robots and sitemap. Add useful Link headers. Establish DNS-AID records on a controlled domain |
| Content accessibility | 0/1 | Serve useful Markdown when requested with `Accept: text/markdown`. Preserve HTML and correct cache variation |
| Bot access control | 1/2 | Preserve usable crawler access. Declare truthful Content Signals matching the owner's policy |
| API/auth/MCP/A2A discovery | 0/9 | API catalog, OAuth metadata, protected resource metadata, Auth.md, MCP card, A2A card, skills index, WebMCP tools, and ARD manifest |
| Web Bot Auth | Informational | Evaluate the actual need and chosen host implementation |
| Commerce protocols | 0 scored | x402, MPP, UCP, ACP, and AP2 were not applicable to the scanned site. Do not invent a payment product |

The scanner's public page links primary specifications and per-check guidance. Use those sources for implementation, not a copied generic checklist. `llms.txt` is useful but does not replace the failed Markdown-negotiation check.

## Exact 100% acceptance gate

The acceptance target remains 100% from the actual checker. Run the `all` profile against the deployed canonical production URL. Do not disable failed checks or substitute a content-only score to claim completion. If the checker changes applicability, preserve its actual reasons and result.

Record the deployed commit, app/package versions, canonical URL, redirect chain, UTC timestamp, scan profile, returned checks and applicability, raw response, and the UI score or result URL when available. Save a screenshot when the percentage is only shown in the browser. A locally calculated percentage, mock, generated badge, or copied report is insufficient.

After each remediation deployment, rerun the checker and verify the advertised capabilities directly. The gate passes only when the real report shows 100% and the listed services work. Scanner errors, unavailable results, and partial output keep the gate open.

## Capabilities behind the metadata

Publish discovery for actual services. For example, template discovery, public documentation search, and installation-plan generation can be useful agent operations. Select the supported service before publishing OpenAPI, MCP, A2A, WebMCP, skills, or ARD entries for it.

Protected operations require a real authentication flow and correctly scoped authorization. Use the supported Agent-Native auth/connection implementation where it fits. An OAuth JSON file with nonexistent endpoints is not authentication. Public marketing metadata must not expose private local workspaces or remote-control a user's computer.

Keep Vivary's local stdio MCP distinct from a hosted HTTP MCP endpoint. Do not advertise one transport as the other. Browser tools must perform their stated operations and handle unsupported browsers and aborts.

DNS discovery may not be configurable for the existing `vivary.vercel.app` subdomain. Confirm DNS authority and use a chosen custom domain if required. Domain selection, DNS changes, auth-service enablement, bot policy, hosting costs, and any commerce work are explicit decisions at their dependent tickets. Planning does not authorize those account or security changes.

The 100% gate may expose additional requirements. Record those as concrete work or a decision for the repository owner. Do not silently lower the target, fabricate services, or equate the score with general security or product quality.

## Release sequence

1. Close feature acceptance and migration preservation checks. Verify standalone compatibility and each supported runtime mode.
2. Update canonical docs, generated site content, UI copy, screenshots, guide walkthroughs, command/version parity, and changelog.
3. Build and test exact package/app artifacts in the prescribed sandbox. Run installed-artifact checks from isolated paths, not only source imports.
4. Prepare the coordinated release and per-artifact publication actions. Preserve the old registry truth until actual publication.
5. Publish approved artifacts and deploy the corresponding website. Verify registry versions, downloads, redirects, production pages, and agent-facing routes.
6. Run the live all-checks readiness scan, remediate actual failures, and retain the 100% receipt. No announcement calls the site agent-ready before this proof.
7. Complete release notes and approved announcements. Retire old repositories only through [the migration procedure](migration.md) after preservation and the chosen product checkpoint.

## Progress reports

After each work unit, update the owning ticket and graph with changed files, verification evidence, remaining blockers, and the next executable task. Report what changed and what the result means. Continue brief progress updates during active work. Do not create recurring notifications or scheduled jobs from this reporting requirement.

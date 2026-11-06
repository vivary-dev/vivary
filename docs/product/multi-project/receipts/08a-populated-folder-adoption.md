# Populated-folder adoption acceptance

Evidence-record: 08a
Date: 2026-09-23
Issue: [#17](https://github.com/vivary-dev/Vivary-New/issues/17)
Current product source: `2d620afcfabf7912f69819ac66f6a3e4145d33be`
Hosted result: passed on current source
Packaged Windows result: passed on `f024979`, carried forward as qualified below

## Result

The GUI can register a populated folder without changing it, then preview and
approve adoption through the existing creator operation. Preview shows proposed
writes, retained files, conflicts, unsupported file counts, and expected
validation findings. Cancel makes no change. Apply checks the approved inputs
again and writes only the reviewed content.

Ordinary folders such as `projects`, `decisions`, and `modules` stay untyped
unless an existing schema declares their meaning. Frontmatter containing
`type: project` alone does not assign a schema. Ordinary Markdown stays
available to the existing Markdown index. PDFs and other non-Markdown files
remain in the folder but are not added to that index. The preview counts uppercase Markdown
extensions as other files, matching the current index policy. The preview counts files
in scanned folders separately from the heuristic used to suggest a workspace
type. Hidden and dependency directories retain their scan exclusions.

Vivary's internal record schemas apply only under `.vivary/records/`. Their
schema names are separate from the owner's definitions, so a configured
`decision` type retains its meaning. A regression previews and applies an
internal change record in an adopted workspace, then finds it through search.

Preview validates existing and proposed Markdown under the configuration that
Apply will use. Reference checks include the proposed documents, so an existing
link to the proposed context file does not produce a false warning. Invalid
nested configuration names the actual file. Text-mode CLI previews show the
same conflicts and validation findings, including the offending path and code. Nested schemas remain authoritative. Changes to validated
content or effective pack policy invalidate an old approval. Incompatible
legacy root schemas and root-only packs require a reviewed migration. Old
incomplete adoption journals still validate and recover with their originally
approved content. The [shared operation receipt](07b-shared-workspace-plan-apply.md)
covers replay, lost response, and reviewed recovery.

## Hosted acceptance

A fresh Workbench and bundled creator built from clean `2d620af` passed three
journeys through the real hosted application. Browser registration selected an
authorized folder on the connected host.

The representative S2 fixture recreated the documented PARA shape with 400
ordinary Markdown notes and 12 PDFs. The original research fixture was not
available. Registration and Preview/Cancel made no project writes. Separate
privacy and setup approvals wrote the exact reviewed ignore file and four
setup files. All 412 original files kept their bytes, lengths and modification
times. The final tree had 417 files. Files and readable guidance opened after
Apply and after restart with the same selected project. The confirmation
controls remained usable at 390 pixels. No model call was requested.

The mixed-schema folder retained its own decision schema. Preview reported
four Markdown and two other files, displayed E101 for a decision missing its
required date, and disabled approval. An ordinary note with `type: project`
frontmatter and a valid declared decision had no findings. Cancel preserved
all six existing files. The findings remained readable at 390 pixels.

A focused preview used an existing `.gitignore`, lowercase Markdown, uppercase
Markdown extensions and a PDF. It counted one indexed Markdown file and four
other files. The rendered plan showed the ignore-file append with the owner's
existing text, and both preservation statements allowed reviewed changes.
Cancel left all five originals unchanged. The file preview and confirmation
controls remained usable at 390 pixels.

## Packaged Windows acceptance

The unpublished Windows ZIP was built from clean `f024979` source. It contains
3,108 files, is 221,480,193 bytes, and has SHA-256
`2774ca79f70cc2500197fe16abd6b6e072ac225f4e4ffec80107e7598b42e48b`.
Workbench metadata reports `sourceCommitVerified: false`. The source build
and package identity are recorded separately from that metadata limit.

The actual EXE used the native folder picker to register the S2 copy.
Preview counted 400 Markdown and 12 other files. Cancel wrote nothing.
Privacy approval created only the reviewed `.gitignore`. A fresh setup
preview counted 400 Markdown and 13 other files and showed four proposed
setup files. Separate approval applied those four files with the Native
preview hashes. Native Apply returned HTTP 200 for the same project.
Files opened the adopted project and its guidance.

A second populated folder exercised configured validation. Preview counted
four Markdown and two other files, displayed the missing-date E101 finding,
disabled approval, and left all six originals unchanged after Cancel. The
normal application restart retained the S2 project identity and readable
guidance. All 423 visible files across both fixture folders kept their bytes and
modification times across restart. All 418 original fixture files retained
their hashes, lengths, and modification times through the Windows journey.
The 2,011 recorded files in the original installed profiles also remained
unchanged. The candidate closed with no observed processes. No model call
was requested.

The post-restart Native HTTP response was not captured. The selected GUI
route, readable guidance, and unchanged disk state support the restart result
without claiming that response.

The `f024979` EXE journey is retained packaged integration evidence. The later
schema, validation, CLI, inventory and copy fixes passed current-source hosted
checks and automated Windows CI. They have not been exercised inside an EXE
built from `2d620af`. No Native picker, project identity, adoption executor or
packaging code changed in those fixes. Final ticket #23 still requires its
complete journey against the exact release artifact.

## Verification and limits

From the repository root on Zo, the eight applicable creator scripts in
`.github/workflows/ci.yml` passed on clean `2d620af`: 375 tests passed and eight
were skipped. Exact-workflow Workbench state transport and maintained checks,
Native doctor, repository contracts, and `git diff --check` also passed.
The updated Tropo direct runner passed 205 tests during source review.
Independent review approved the product fixes and the text-mode recovery
compatibility correction. The seven reported PR findings were addressed.
The private continuation handoff holds test logs, disposable fixture manifests,
GUI captures, and the Windows evidence manifest. Those records are not shipped
in this repository.

This acceptance does not add PDF extraction, semantic indexing, folder
renaming, model execution, or a release of the desktop app. Parent packet 08
and final desktop and web acceptance remain open.

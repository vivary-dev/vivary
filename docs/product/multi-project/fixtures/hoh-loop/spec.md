# Local Markdown link checker

Implement `check_tree(root)` in `linkcheck.py`. It returns one record for each
invalid local Markdown link under `root`, sorted by source path and target.

- Existing relative file targets are valid.
- A missing relative file target produces `{"code": "missing_target"}`.
- A target that resolves outside `root` produces `{"code": "path_escape"}`.
- An anchor-only target is valid and does not read the filesystem.
- HTTP, HTTPS, and `mailto:` targets are outside this fixture's scope.

The starter must fail these tests and observations exactly:

- `test_links.LinkCheckTests.test_reports_missing_relative_target` with
  `observation=missing-target-was-not-reported`.
- `test_links.LinkCheckTests.test_rejects_parent_escape` with
  `observation=parent-escape-was-accepted`.
- `test_links.LinkCheckTests.test_ignores_anchor_only_target` with
  `observation=anchor-only-target-was-read`.

`test_links.LinkCheckTests.test_accepts_existing_relative_target` must pass.
The oracle is fixed. A developer changes only `linkcheck.py`.

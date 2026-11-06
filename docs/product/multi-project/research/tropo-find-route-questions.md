# Route questions in public find

## Recommendation

Let the privacy-filtered find and query accept a question that names a URL
route, such as "what serves /api/users?", only if one rule can also refuse
every absolute host path in every output field, including the echoed
`query`. `docs/MCP.md` promises that. The rule must refuse a host path
with or without a file extension, such as `/data/private.txt`, `/etc/passwd`,
or `/proc/self/environ`, and give the same answer on Linux, macOS, and
Windows. If no such rule exists, the refusal stays, and the refusal message
explains it.

Today's checks do not meet that yet. Both Tropo's question check and the MCP
result check accept `//etc/passwd`, which Linux and macOS read as
`/etc/passwd`, and `file:///etc/passwd`. The refusal tests for those two checks
list 11 host paths,
and every one ends in `.txt` or `.md`. The MCP cases check only a `path`
field. The change adds tests for a doubled leading slash, `file:` URIs,
paths without an extension, and the `query` field.

The owner requested this change on 2026-09-24, in the working session that
reviewed issue #19. It lands as its
own PR after [PR #89](https://github.com/vivary-dev/Vivary-New/pull/89)
merges, because it changes Tropo's and the MCP adapter's privacy rules and
files that #89 adds.

## What happens today

Public find and public query both check the question with
`_public_query_value(root, value)` in `packages/tropo/tropo.py`. `find_context`
and `query_context` call it. It raises `PathRefusedError` when either check
fails:

- `_public_output_text_is_safe` refuses text that `_public_safe_text`
  rejects, such as empty, overlong, or unprintable text. It also refuses
  credential-like text and any match of `_PUBLIC_MACHINE_PATH_RE` in
  `_public_security_text(value)`, which applies NFKD and drops control,
  format, and mark characters. So a fullwidth slash counts as `/`. A new
  question rule must read the same normalized text, and no test covers
  lookalike slashes yet.
- `_public_contains_workspace_path` refuses text that contains the project's
  own folder path, in either separator.

`_PUBLIC_MACHINE_PATH_RE` matches a drive path (`C:\`), a backslash network
share (`\\host\share`), and a `/`-led token at the start of the text or after
any character that is neither a word character nor `/`. That character can be
a space, `.`, `~`, `(`, a quote, or `:`. In "what serves /api/users?" the
regex matches ` /api/users?`, with the question mark. It also matches
`./src/relay.py` and `~/.ssh/config`. It does not match a bare relative path
such as `src/relay.py`, which find already accepts, or `//server/share`.

The MCP adapter `packages/mcp/vivary_mcp.py` checks questions only for type
and length. It checks results instead. `_assert_result_safe` removes URIs with
`_URI_RE`, then runs its own copy of the pattern, `_MACHINE_PATH_RE`, over every
string in a producer result, including the echoed `query`. A match turns the
result into `producer_unavailable`. Tropo removes no URIs, so the two checks
already disagree. MCP accepts "see https://[::1]/public/docs", and Tropo refuses
it as a question. `test_result_firewall_refuses_machine_paths_and_credentials`
in `packages/mcp/tests/test_vivary_mcp.py` requires refusing seven absolute
paths, including a file in a user's home folder and two host paths that
follow a URL.
`docs/MCP.md` promises that the adapter returns no absolute machine path.
Changing Tropo alone would leave `vivary_find` and `vivary_query` refusing
the same questions over MCP, with a less clear reason.

On output, find drops a snippet whose own text fails
`_public_output_text_is_safe`. Query also replaces a title that fails that
check with the document's ID.

## Where users see it

After PR #89:

- `vivary find --public` returns a `vivary.read-refusal/v0` document with
  reason `path_refused`.
- The Workbench Details panel shows `FIND_PATH_REFUSED` from
  `packages/workbench/server/project-read.ts`.
- The Native agent receives the same result, with `status: "unavailable"`,
  `reason: "path_refused"`, and that message.

The issue #19 acceptance treats this refusal as a pass. The receipt
`docs/product/multi-project/receipts/09b-original-read-tools.md` records it.
The hosted journey script, kept outside the repository with the private
evidence, sends "what serves /api/users" and asserts the refusal. The receipt
describes what the tested candidates did, so it stays as it is. The change
adds its own receipt and a new dated section in the acceptance register,
`docs/product/multi-project/desktop-acceptance-status.md`, and updates the
hosted script.

The refusal message already overstates the rule. `FIND_PATH_REFUSED`,
`docs/ORIGINAL-CLI.md`, and `packages/workbench/README.md` say a question
cannot contain a file or URL path, but `src/relay.py` and
"what serves https://example.test/api/users?" both pass today. The new
message states the rule the change ships.

## Design questions

1. Which rule separates a route from a host path? The pattern cannot tell
   `/api/users` from `/data/private.txt`. A rule that checks which
   directories exist on the host fails on hosts where `/data` or `/usr` does
   not exist. The rule also needs an answer for `~/.ssh/config`, a sibling
   project's folder, and `/etc/passwd`, and for trailing punctuation such as
   the `?` above.
2. What does `query` echo? Echoing the question keeps it readable and relaxes
   the "no machine path in output" promise for that field. Echoing its terms
   keeps the promise and shows text the caller did not type.
3. May snippets keep route text, under the same rule?
4. How should a doubled leading slash be read? `//server/share` names a
   share on Windows, and `//etc/passwd` names `/etc/passwd` on Linux and
   macOS. Both pass today.
5. Should the facade state its accounting outright? After PR #89, the
   Workbench panel reads private and sensitive exclusions and the token
   budget from omission rows, and says only that a report is incomplete. A
   private exclusion count, a sensitive exclusion count, and a flag on each
   omission that made the report incomplete would let every reader show the
   cause without rebuilding Tropo's rules. The same change touches these
   files, so it can share this release.

## Files

- `packages/tropo/tropo.py`: `_public_query_value`, a question rule apart from
  `_PUBLIC_MACHINE_PATH_RE`, and the snippet check.
- `packages/tropo/tests/test_tropo.py`: accepted routes, and still-refused
  host paths, credentials, workspace paths, drive paths, and shares, for both
  find and query.
- `packages/mcp/vivary_mcp.py` and `packages/mcp/tests/test_vivary_mcp.py`:
  how `_assert_result_safe` treats the echoed `query` and snippets.
- `packages/vivary/tests/test_vivary_cli.py`: a public find with a route
  question.
- `packages/workbench/server/project-read.ts` and
  `packages/workbench/tests/project-read.test.ts`: the refusal message.
- `docs/ORIGINAL-CLI.md`, `docs/MCP.md`, `packages/workbench/README.md`, and
  the site mirrors `site/src/content/docs/original-cli.md`,
  `site/src/content/docs/mcp.md`, and `site/public/llms-full.txt`.

## Verify

The MCP tests need the packages CI installs first.

```console
python3 -m pip install pytest "mcp==2.0.0"
python3 packages/tropo/tests/test_tropo.py
python3 -m pytest packages/mcp/tests -q
python3 packages/vivary/tests/test_vivary_cli.py
pnpm --dir packages/workbench exec tsx --test tests/project-read.test.ts
```

Then add `docs/routes.md` to a Git coding project with the line "The gamma
relay serves /api/users for the dashboard." Ask the agent "what serves
/api/users?", and ask MCP `vivary_find` the same question. Confirm both return
`docs/routes.md` and no host path.

## Release

`docs/RELEASE-WORKFLOW.md` governs the release, because the change touches
`packages/tropo/tropo.py` and `packages/mcp/vivary_mcp.py`. Tropo 0.5.5 is
staged and unpublished, so the Tropo change can ship in 0.5.5 without moving
any floor. The MCP change needs a `vivary-mcp` release. Its version is pinned
in `packages/mcp/vivary_mcp.py` (`__version__`), `packages/mcp/pyproject.toml`,
`packages/mcp/README.md`, `packages/mcp/tests/test_vivary_mcp.py`, and the
`vivary-mcp` version assertions in `.github/workflows/ci.yml`. If it needs the
Tropo change, its `vivary-tropo` floor moves too. On 2026-09-24 PyPI listed
vivary-tropo 0.5.4 and vivary-mcp 0.1.3. The owner decides which releases
carry this change.

"""Lab ticket #58/#60, decision 0008 (ticket #84): pytest translation of
tests/digest.test.mjs for the Python port (python/vivary_core/capsule_digest.py).

Adaptation (documented once, applies throughout): the Node suite builds its
capsules via the observe -> project -> compile pipeline, which is NOT part
of this slice. Wherever the Node test builds a capsule that way, this file
loads the equivalent already-captured fixture from python/parity/fixtures/
instead:
  - capsule-basic.json      <-> the Node suite's default fixture capsule
                                 (FIXTURE_DIR "digest"/"digest-table")
  - capsule-tight-budget.json <-> the Node suite's budget-2 "tight" capsule
                                 built inline for the claims_over_budget test

These fixtures are frozen INPUTS captured from the Node reference, not snapshots
of what this port's compiler currently emits, and the two have deliberately
diverged: `compile_task_capsule` no longer hardcodes `required_checks` (it derives
them from the observed workspace and drops `entire status`, which is not a Vivary
command), so the `required_checks` recorded in these fixtures is Node's old shape.
That is intentional and does not weaken them - they exist to pin *digest
serialization* byte-for-byte against Node, and the digest reads
`required_checks` through `.get("name")`, so the divergence never reaches it.

What the fixtures cannot cover, because they are inputs rather than outputs, is
that the digest still serializes what the compiler actually produces today. That
is proved separately by test_compiled_capsule_serializes_through_the_digest below,
which runs the real observe -> project -> compile -> digest path.

The Node suite's "dogfood capsule" describe block (site/data/dogfood.json,
pinned ratio/marginal-byte magic constants measured against the Node
reference) is intentionally NOT translated: that file is not one of this
slice's owned/provided fixtures, and the pinned constants (0.25, 106 bytes)
were calibrated against a Node run this slice has no independent way to
re-derive or justify. Structural assertions this module DOES prove
(tiers dedup, evidence dedup, smaller-than-capsule, determinism) are already
covered against the owned fixtures below.
"""

from __future__ import annotations

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

from vivary_core.capsule_digest import (  # noqa: E402
    CAPSULE_DIGEST_SCHEMA,
    CAPSULE_DIGEST_TABLE_SCHEMA,
    serialize_capsule_digest,
)

FIXTURE_DIR = os.path.join(HERE, "fixtures", "parity")
MODULE_SOURCE_PATH = os.path.join(os.path.dirname(HERE), "vivary_core", "capsule_digest.py")


def load_fixture(name):
    with open(os.path.join(FIXTURE_DIR, f"{name}.json"), encoding="utf-8") as fh:
        return json.load(fh)


def load_expected(name, suffix):
    with open(os.path.join(FIXTURE_DIR, f"{name}.{suffix}.expected.txt"), encoding="utf-8") as fh:
        return fh.read()


def first_diff_index(a, b):
    n = min(len(a), len(b))
    for i in range(n):
        if a[i] != b[i]:
            return i
    return n if len(a) != len(b) else -1


def assert_byte_identical(got, expected, label):
    if got == expected:
        return
    i = first_diff_index(got, expected)
    lo, hi = max(0, i - 40), i + 40
    raise AssertionError(
        f"{label}: byte mismatch at index {i}\n"
        f"  got     : ...{got[lo:hi]!r}...\n"
        f"  expected: ...{expected[lo:hi]!r}..."
    )


# --- Purity: no I/O in the module that must be a pure function of its input ---


def test_no_io_imports_or_clock_or_randomness_in_capsule_digest_source():
    with open(MODULE_SOURCE_PATH, encoding="utf-8") as fh:
        src = fh.read()
    for banned in ("import os", "import subprocess", "import io", "open(", "datetime", "random"):
        assert banned not in src, f"capsule_digest.py must not contain {banned!r}"


# --- serializeCapsuleDigest over the capsule-basic fixture --------------------


def test_digest_binds_capsule_id_fingerprint_and_workspace_fingerprint():
    capsule = load_fixture("capsule-basic")
    digest = json.loads(serialize_capsule_digest(capsule))
    assert digest["schema"] == CAPSULE_DIGEST_SCHEMA
    assert digest["capsule_id"] == capsule["capsule_id"]
    assert digest["capsule_fingerprint"] == capsule["fingerprint"]
    assert digest["workspace"]["fingerprint"] == capsule["workspace"]["fingerprint"]
    assert digest["workspace"]["observed_at"] == capsule["workspace"]["observed_at"]


def test_task_budget_and_required_checks_pass_through():
    capsule = load_fixture("capsule-basic")
    digest = json.loads(serialize_capsule_digest(capsule))
    assert digest["task"] == capsule["task"]
    assert digest["budget"] == capsule["budget"]
    assert digest["required_checks"] == [c["name"] for c in capsule["required_checks"]]


def test_every_claim_row_resolves_back_into_source_capsule():
    capsule = load_fixture("capsule-basic")
    digest = json.loads(serialize_capsule_digest(capsule))
    assert len(digest["claims"]) == len(capsule["claims"])
    for i, claim in enumerate(capsule["claims"]):
        subject_ref, fact, status, claim_text, evidence_ref, tier_ref = digest["claims"][i]
        assert digest["subjects"][subject_ref] == claim["subject_path"], f"claim {i} subject-ref must resolve"
        assert fact == claim["fact"]
        assert status == claim["status"]
        assert claim_text == claim["claim"], f"claim {i} text must be byte-verbatim"
        expected_evidence = (claim.get("evidence") or [{}])[0].get("command") if claim.get("evidence") else None
        if expected_evidence is None:
            assert evidence_ref is None, f"claim {i} has no evidence; evidence-ref must be null"
        else:
            assert digest["evidence"][evidence_ref] == expected_evidence, f"claim {i} evidence-ref must resolve"
        tier_name, reason = digest["tiers"][tier_ref]
        assert tier_name == claim["selection"]["tier"], f"claim {i} tier-code must resolve"
        assert reason == claim["selection_reason"], f"claim {i} tier-code must resolve to its exact reason"


def test_evidence_and_tier_tables_deduplicated():
    capsule = load_fixture("capsule-basic")
    digest = json.loads(serialize_capsule_digest(capsule))
    real_evidence = {
        (c.get("evidence") or [{}])[0].get("command") for c in capsule["claims"] if c.get("evidence")
    }
    real_tiers = {f"{c['selection']['tier']} {c['selection_reason']}" for c in capsule["claims"]}
    assert len(digest["evidence"]) == len(real_evidence)
    assert len(digest["tiers"]) == len(real_tiers)
    for command in digest["evidence"]:
        assert command in real_evidence, "every evidence-table entry must be real capsule evidence"
    for tier_name, reason in digest["tiers"]:
        assert f"{tier_name} {reason}" in real_tiers, "every tier-table entry must be a real (tier, reason) pair"


def test_conflicts_and_unknowns_are_byte_verbatim():
    capsule = load_fixture("capsule-basic")
    digest = json.loads(serialize_capsule_digest(capsule))
    assert digest["conflicts"] == capsule["conflicts"]
    assert digest["unknowns"] == capsule["unknowns"]
    assert len(capsule["unknowns"]) > 0, "fixture must actually exercise unknowns"
    assert len(capsule["conflicts"]) > 0, "fixture must actually exercise conflicts"


def test_ignored_paths_excluded_collapses_to_kind_and_count():
    capsule = load_fixture("capsule-basic")
    digest = json.loads(serialize_capsule_digest(capsule))
    assert any(o["kind"] == "ignored_paths_excluded" for o in capsule["omissions"])
    assert digest["omissions"]["ignored_paths_excluded"] == {"count": 1}


def test_refused_root_preserved_conservatively_not_silently_dropped():
    capsule = load_fixture("capsule-basic")
    digest = json.loads(serialize_capsule_digest(capsule))
    real_refusals = [o for o in capsule["omissions"] if o["kind"] == "refused_root"]
    assert len(real_refusals) > 0, "fixture must exercise a refused root"
    assert len(digest["omissions"]["refused_root"]) == len(real_refusals)
    for entry in digest["omissions"]["refused_root"]:
        assert any(r["reason"] == entry["reason"] and r["path"] == entry["path"] for r in real_refusals)


def test_claims_over_budget_collapses_cut_list_to_subject_and_count():
    tight = load_fixture("capsule-tight-budget")
    overflow = next(o for o in tight["omissions"] if o["kind"] == "claims_over_budget")
    assert overflow["omitted_count"] > 0, "the tight-budget fixture must force an over-budget omission"
    digest = json.loads(serialize_capsule_digest(tight))
    entry = digest["omissions"]["claims_over_budget"]
    assert entry["omitted_count"] == overflow["omitted_count"], "true total must survive"
    total = sum(count for _, count in entry["by_subject"])
    assert total <= overflow["omitted_count"]
    if overflow.get("truncated"):
        assert entry.get("by_subject_partial") is True
    for subject_ref, _ in entry["by_subject"]:
        assert digest["subjects"][subject_ref], "each claims_over_budget subject-ref must resolve"


def test_deterministic_across_repeated_calls_and_json_round_trip():
    capsule = load_fixture("capsule-basic")
    a = serialize_capsule_digest(capsule)
    b = serialize_capsule_digest(capsule)
    assert a == b
    clone = json.loads(json.dumps(capsule))
    c = serialize_capsule_digest(clone)
    assert a == c


def test_digest_smaller_than_source_capsule():
    capsule = load_fixture("capsule-basic")
    digest_text = serialize_capsule_digest(capsule)
    capsule_text = json.dumps(capsule)
    assert len(digest_text.encode("utf-8")) < len(capsule_text.encode("utf-8"))


# --- Byte-parity against the captured Node-reference fixtures -----------------


def test_byte_parity_capsule_basic_default_profile():
    capsule = load_fixture("capsule-basic")
    got = serialize_capsule_digest(capsule)
    expected = load_expected("capsule-basic", "digest-default")
    assert_byte_identical(got, expected, "capsule-basic default profile")


def test_byte_parity_capsule_basic_table_profile():
    capsule = load_fixture("capsule-basic")
    got = serialize_capsule_digest(capsule, {"profile": "table"})
    expected = load_expected("capsule-basic", "digest-table")
    assert_byte_identical(got, expected, "capsule-basic table profile")


def test_byte_parity_capsule_tight_budget_default_profile():
    capsule = load_fixture("capsule-tight-budget")
    got = serialize_capsule_digest(capsule)
    expected = load_expected("capsule-tight-budget", "digest-default")
    assert_byte_identical(got, expected, "capsule-tight-budget default profile")


def test_byte_parity_capsule_tight_budget_table_profile():
    capsule = load_fixture("capsule-tight-budget")
    got = serialize_capsule_digest(capsule, {"profile": "table"})
    expected = load_expected("capsule-tight-budget", "digest-table")
    assert_byte_identical(got, expected, "capsule-tight-budget table profile")


# --- Table profile: independent reconstruction proof (lab ticket #60) ---------
# A decoder written from the documented encoding alone (digest.mjs's own
# comments / this module's docstrings), NOT by importing/reusing this
# module's internal encoder functions - a real reconstruction proof.


def unescape_table_field(text):
    out = []
    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        if ch == "\\" and i + 1 < n:
            nxt = text[i + 1]
            if nxt == "\\":
                out.append("\\")
                i += 2
                continue
            if nxt == "t":
                out.append("\t")
                i += 2
                continue
            if nxt == "n":
                out.append("\n")
                i += 2
                continue
            if nxt == "r":
                out.append("\r")
                i += 2
                continue
        out.append(ch)
        i += 1
    return "".join(out)


def decode_claims_table(claims_table):
    lines = claims_table.split("\n")
    assert lines[0] == "subject\tfact\tstatus\tclaim\tevidence\ttier", "table header must match the documented order"
    rows = []
    for line in lines[1:]:
        fields = line.split("\t")
        assert len(fields) == 6, f"claim row must have exactly 6 tab-separated fields, got: {line!r}"
        subject, fact, status, claim, evidence, tier = fields
        rows.append(
            {
                "subjectRef": None if subject == "" else int(subject),
                "fact": unescape_table_field(fact),
                "status": unescape_table_field(status),
                "claim": unescape_table_field(claim),
                "evidenceRef": None if evidence == "" else int(evidence),
                "tierRef": int(tier),
            }
        )
    return rows


def decode_evidence_entry(entry, evidence_prefix, evidence_commands, subjects):
    subject_ref, command_ref = entry
    remainder = evidence_commands[command_ref]
    if subject_ref is None:
        return remainder
    path = subjects[subject_ref]
    return f"{evidence_prefix}{path}" if remainder == "" else f"{evidence_prefix}{path} {remainder}"


def test_table_profile_schema_identifies_distinctly_from_default():
    capsule = load_fixture("capsule-basic")
    digest = json.loads(serialize_capsule_digest(capsule, {"profile": "table"}))
    assert digest["schema"] == CAPSULE_DIGEST_TABLE_SCHEMA
    assert digest["schema"] != CAPSULE_DIGEST_SCHEMA


def test_table_profile_every_claim_reconstructs_exactly():
    capsule = load_fixture("capsule-basic")
    digest = json.loads(serialize_capsule_digest(capsule, {"profile": "table"}))
    rows = decode_claims_table(digest["claims_table"])
    assert len(rows) == len(capsule["claims"])
    for i, claim in enumerate(capsule["claims"]):
        row = rows[i]
        decoded_subject_path = None if row["subjectRef"] is None else digest["subjects"][row["subjectRef"]]
        assert decoded_subject_path == claim.get("subject_path"), f"claim {i} subject_path must reconstruct"
        assert row["fact"] == claim["fact"]
        assert row["status"] == claim["status"]
        assert row["claim"] == claim["claim"], f"claim {i} claim text must reconstruct byte-verbatim"

        expected_evidence = (claim.get("evidence") or [{}])[0].get("command") if claim.get("evidence") else None
        if expected_evidence is None:
            assert row["evidenceRef"] is None, f"claim {i} has no evidence; evidenceRef must be null"
        else:
            decoded_command = decode_evidence_entry(
                digest["evidence"][row["evidenceRef"]],
                digest["evidence_prefix"],
                digest["evidence_commands"],
                digest["subjects"],
            )
            assert decoded_command == expected_evidence, f"claim {i} evidence command must reconstruct exactly"

        tier_name, reason = digest["tiers"][row["tierRef"]]
        assert tier_name == claim["selection"]["tier"], f"claim {i} tier must reconstruct exactly"
        assert reason == claim["selection_reason"], f"claim {i} selection_reason must reconstruct exactly"


def test_table_profile_conflicts_and_unknowns_byte_verbatim():
    capsule = load_fixture("capsule-basic")
    digest = json.loads(serialize_capsule_digest(capsule, {"profile": "table"}))
    assert digest["conflicts"] == capsule["conflicts"]
    assert digest["unknowns"] == capsule["unknowns"]


def test_table_profile_omissions_normalize_identically_to_default():
    capsule = load_fixture("capsule-basic")
    table_digest = json.loads(serialize_capsule_digest(capsule, {"profile": "table"}))
    default_digest = json.loads(serialize_capsule_digest(capsule))
    assert table_digest["omissions"] == default_digest["omissions"]


def test_table_profile_task_budget_required_checks_pass_through_like_default():
    capsule = load_fixture("capsule-basic")
    table_digest = json.loads(serialize_capsule_digest(capsule, {"profile": "table"}))
    default_digest = json.loads(serialize_capsule_digest(capsule))
    assert table_digest["task"] == default_digest["task"]
    assert table_digest["budget"] == default_digest["budget"]
    assert table_digest["required_checks"] == default_digest["required_checks"]
    assert table_digest["capsule_id"] == default_digest["capsule_id"]
    assert table_digest["capsule_fingerprint"] == default_digest["capsule_fingerprint"]
    assert table_digest["workspace"] == default_digest["workspace"]


def test_table_profile_smaller_than_capsule():
    capsule = load_fixture("capsule-basic")
    default_text = serialize_capsule_digest(capsule)
    table_text = serialize_capsule_digest(capsule, {"profile": "table"})
    assert len(table_text.encode("utf-8")) < len(json.dumps(capsule).encode("utf-8"))
    # Not asserted <= default on every fixture (see digest.mjs's comment: a
    # tiny fixture could see the table header/extra fields cost more than
    # they save) - just confirm the default text is itself a real string.
    assert isinstance(default_text, str) and len(default_text) > 0


def test_table_profile_deterministic_across_calls_and_json_round_trip():
    capsule = load_fixture("capsule-basic")
    a = serialize_capsule_digest(capsule, {"profile": "table"})
    b = serialize_capsule_digest(capsule, {"profile": "table"})
    assert a == b
    clone = json.loads(json.dumps(capsule))
    c = serialize_capsule_digest(clone, {"profile": "table"})
    assert a == c


def test_options_are_optional_default_profile_equals_no_options():
    capsule = load_fixture("capsule-basic")
    assert serialize_capsule_digest(capsule) == serialize_capsule_digest(capsule, {"profile": "default"})


# --- Table profile: path-boundary safety on adversarially prefix-sharing ------
# subject paths. Hand-built synthetic capsules, no fixture needed.


def make_claim(subject, fact, claim, command=None, status="known", tier="allowlisted", reason="test"):
    return {
        "subject": subject,
        "subject_path": subject,
        "fact": fact,
        "status": status,
        "claim": claim,
        "evidence": [{"command": command}] if command else [],
        "selection": {"tier": tier},
        "selection_reason": reason,
    }


def test_prefix_sharing_subject_path_never_misattributed():
    # "workspace://side" is a literal prefix of "workspace://side-two" - the
    # encoder must not let the shorter path's boundary-less match steal the
    # longer path's evidence.
    capsule = {
        "capsule_id": "cap_test",
        "fingerprint": "fp_test",
        "workspace": {"fingerprint": "wsfp_test", "observed_at": "2026-01-01T00:00:00.000Z"},
        "task": {"question": "test"},
        "claims": [
            make_claim(
                "s1",
                "head_revision",
                "HEAD revision is aaa",
                command="git --no-optional-locks -C workspace://side rev-parse HEAD",
            ),
            make_claim(
                "s2",
                "head_revision",
                "HEAD revision is bbb",
                command="git --no-optional-locks -C workspace://side-two rev-parse HEAD",
            ),
        ],
        "conflicts": [],
        "unknowns": [],
        "omissions": [],
        "required_checks": [],
        "budget": {"max_claims": 24},
    }

    digest = json.loads(serialize_capsule_digest(capsule, {"profile": "table"}))
    rows = decode_claims_table(digest["claims_table"])
    for i, claim in enumerate(capsule["claims"]):
        expected = claim["evidence"][0]["command"]
        decoded = decode_evidence_entry(
            digest["evidence"][rows[i]["evidenceRef"]],
            digest["evidence_prefix"],
            digest["evidence_commands"],
            digest["subjects"],
        )
        assert decoded == expected, f"claim {i}'s evidence must reconstruct to its own checkout's command"


def test_non_git_evidence_command_preserved_verbatim():
    capsule = {
        "capsule_id": "cap_test2",
        "fingerprint": "fp_test2",
        "workspace": {"fingerprint": "wsfp_test2", "observed_at": "2026-01-01T00:00:00.000Z"},
        "task": {"question": "test"},
        "claims": [
            make_claim("s1", "last_fetch", "last recorded fetch at X", command="fs.stat FETCH_HEAD"),
        ],
        "conflicts": [],
        "unknowns": [],
        "omissions": [],
        "required_checks": [],
        "budget": {"max_claims": 24},
    }
    digest = json.loads(serialize_capsule_digest(capsule, {"profile": "table"}))
    rows = decode_claims_table(digest["claims_table"])
    decoded = decode_evidence_entry(
        digest["evidence"][rows[0]["evidenceRef"]],
        digest["evidence_prefix"],
        digest["evidence_commands"],
        digest["subjects"],
    )
    assert decoded == "fs.stat FETCH_HEAD"


def test_claim_text_with_tabs_newlines_backslashes_round_trips_exactly():
    tricky = "line one\tcol\nline two\\ backslash \"quoted\" text"
    capsule = {
        "capsule_id": "cap_test3",
        "fingerprint": "fp_test3",
        "workspace": {"fingerprint": "wsfp_test3", "observed_at": "2026-01-01T00:00:00.000Z"},
        "task": {"question": "test"},
        "claims": [make_claim("s1", "content_match", tricky, command=None)],
        "conflicts": [],
        "unknowns": [],
        "omissions": [],
        "required_checks": [],
        "budget": {"max_claims": 24},
    }
    digest = json.loads(serialize_capsule_digest(capsule, {"profile": "table"}))
    rows = decode_claims_table(digest["claims_table"])
    assert rows[0]["claim"] == tricky, "claim text with tabs/newlines/backslashes must round-trip exactly"
    assert rows[0]["evidenceRef"] is None


def test_compiled_capsule_serializes_through_the_digest(tmp_path):
    """The digest must handle what the compiler emits today, not only frozen inputs.

    Every other test in this file loads a captured Node fixture, so nothing proved
    that a capsule built by *this* port's `compile_task_capsule` still serializes.
    That gap mattered the moment `required_checks` stopped being a hardcoded list of
    `{name, command}` and became derived entries carrying `evidence`: the fixtures
    could not have caught a digest that choked on the new shape, because they still
    hold the old one.
    """
    import subprocess

    from vivary_core.workspace_model import project_workspace_graph
    from vivary_core.workspace_observe import observe_checkouts
    from vivary_core.capsule_compile import compile_task_capsule

    repo = tmp_path / "repo"
    repo.mkdir()
    env = {**os.environ, "GIT_AUTHOR_NAME": "F", "GIT_AUTHOR_EMAIL": "f@x",
           "GIT_COMMITTER_NAME": "F", "GIT_COMMITTER_EMAIL": "f@x"}
    def git(*args):
        subprocess.run(["git", *args], cwd=repo, env=env, capture_output=True, check=True)
    git("init", "-q", "-b", "main", ".")
    (repo / "tropo.toml").write_text("[base]\nallow_untyped = true\n", encoding="utf-8")
    (repo / "package.json").write_text('{"scripts": {"test": "vitest run"}}\n', encoding="utf-8")
    (repo / "a.md").write_text("# A\n", encoding="utf-8")
    git("add", "-A")
    git("commit", "-q", "-m", "seed")

    graph = project_workspace_graph(
        observe_checkouts([str(repo)], allowlist=[str(repo)], now=lambda: "2026-07-26T00:00:00.000Z")
    )
    capsule = compile_task_capsule(task={"question": "what is here?"}, graph=graph)

    # The derived checks are the new shape, evidence and all.
    assert capsule["required_checks"], "expected derived checks for a governed workspace"
    assert any(c.get("evidence") for c in capsule["required_checks"])

    digest = json.loads(serialize_capsule_digest(capsule))

    assert digest["required_checks"] == [c["name"] for c in capsule["required_checks"]]
    assert digest["capsule_fingerprint"] == capsule["fingerprint"]
    assert json.loads(serialize_capsule_digest(capsule)) == digest, "digest must be deterministic"

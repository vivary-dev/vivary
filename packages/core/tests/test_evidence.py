"""Pytest translation of tests/evidence.test.mjs (slice 1, ticket #84,
decision 0008).

Builds real temp git repositories and bare "remotes" under a disposable
per-test fixture directory (never origin, never the network), with pinned
git identity/dates and isolated global/system config, mirroring
tests/helpers/fixtures.mjs's initEvidenceWorkspace/initBareRemote/
cloneRepo/fetchRef and tests/evidence.test.mjs's own pinned-identity git
helpers exactly - just re-expressed as pytest fixtures/helpers local to this
one owned file.

Node's evidence.test.mjs shares one FIXTURE_DIR for the whole suite and
scopes each test to a differently-named subdirectory; this translation gives
every test its own fresh temporary directory instead (removed at teardown)
for stronger isolation - the subdirectory names below are kept identical to
Node's only for readability/traceability, not because isolation depends on
them.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

from vivary_core.canonical import is_within  # noqa: E402

try:
    from vivary_core.evidence_store import evidence_paths, open_evidence_store
    from vivary_core.evidence_sync import (
        DEFAULT_REF,
        EvidenceSyncError,
        read_evidence_snapshot,
        sync_evidence,
    )
    from vivary_core.event_contract import create_context_integrity_event
    from vivary_core.receipt import RECEIPT_SCHEMA, create_integrity_receipt
except ImportError as exc:  # pragma: no cover - only until the parallel port lands
    pytest.skip(
        "blocked on vivary_core.event_contract / vivary_core.receipt (parallel port "
        f"not landed yet): {exc}",
        allow_module_level=True,
    )

# Empty-tree SHA is a universal git constant (the hash of an empty tree
# object), not something this suite computes - used to pin the "empty
# evidence dir syncs to the empty tree" edge case unambiguously.
GIT_EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"

SINK = {"project": "vivary-lattice-lab", "visibility": "local", "policy_version": "policy/v0"}
IDENTITY = {"name": "Lattice Evidence Sync", "email": "evidence-sync@lattice.local"}
DATE_A = "2026-07-21T00:00:00Z"
DATE_B = "2026-07-21T01:00:00Z"


# --- fixture plumbing --------------------------------------------------------


@pytest.fixture
def fixture_dir():
    d = tempfile.mkdtemp(prefix="vivary-evidence-fixtures-")
    try:
        with open(os.path.join(d, "empty-gitconfig"), "w", encoding="utf-8") as handle:
            handle.write("")
        yield d
    finally:
        _rmtree_force(d)


def _rmtree_force(path):
    # On Windows, git object files are read-only and a plain rmtree fails on
    # them (ignore_errors=True would silently LEAK the temp repo instead) -
    # clear the read-only bit and retry, then fail loudly if still stuck.
    def _on_error(func, target, exc_info):
        os.chmod(target, stat.S_IWRITE)
        func(target)

    if os.path.isdir(path):
        shutil.rmtree(path, onerror=_on_error)


def fixture_path(fixture_dir_, *segments):
    # Guard (ticket requirement): every remote/workspace path this suite
    # touches must resolve under the disposable fixture dir - never origin,
    # never the network. A stray absolute path anywhere in this file fails
    # loudly instead of silently reaching out.
    p = os.path.join(fixture_dir_, *segments)
    assert is_within(fixture_dir_, p), f"refusing a non-local fixture path: {p}"
    return p


def _git_env(fixture_dir_):
    env = dict(os.environ)
    env.update(
        {
            "GIT_AUTHOR_NAME": "Lattice Fixture",
            "GIT_AUTHOR_EMAIL": "fixture@lattice.local",
            "GIT_COMMITTER_NAME": "Lattice Fixture",
            "GIT_COMMITTER_EMAIL": "fixture@lattice.local",
            "GIT_AUTHOR_DATE": "2026-07-21T00:00:00Z",
            "GIT_COMMITTER_DATE": "2026-07-21T00:00:00Z",
            "GIT_CONFIG_GLOBAL": os.path.join(fixture_dir_, "empty-gitconfig"),
            "GIT_CONFIG_SYSTEM": os.path.join(fixture_dir_, "empty-gitconfig"),
        }
    )
    return env


def _git(fixture_dir_, cwd, args):
    proc = subprocess.run(
        ["git", *args], cwd=cwd, env=_git_env(fixture_dir_), capture_output=True, text=True, check=True
    )
    return proc.stdout.strip()


def init_evidence_workspace(fixture_dir_, dir_):
    _git(fixture_dir_, fixture_dir_, ["init", "-q", "-b", "main", dir_])
    return dir_


def init_bare_remote(fixture_dir_, dir_):
    _git(fixture_dir_, fixture_dir_, ["init", "-q", "--bare", "-b", "main", dir_])
    return dir_


def clone_repo(fixture_dir_, source_dir, dest_dir):
    _git(fixture_dir_, fixture_dir_, ["clone", "-q", source_dir, dest_dir])
    return dest_dir


def fetch_ref(fixture_dir_, repo_dir, remote_dir, ref):
    _git(fixture_dir_, repo_dir, ["fetch", "-q", remote_dir, f"{ref}:{ref}"])


def git_rev_parse(cwd, ref):
    proc = subprocess.run(
        ["git", "-C", cwd, "rev-parse", "--verify", "--quiet", ref], capture_output=True, text=True
    )
    if proc.returncode != 0:
        return None
    return proc.stdout.strip() or None


def base_event_input(**overrides):
    base = dict(
        event_type="memory.assertion.proposed",
        occurred_at="2026-07-21T00:00:00.000Z",
        producer={"module": "evidence-fixture", "version": "0.0.0"},
        actor={"kind": "agent", "id": "claude-code:vivary-lattice"},
        workspace={"id": "ws_evidence_fixture", "revision": "lab://fixtures"},
        subject={"kind": "repository", "id": "repo_evidence_fixture"},
        scope={"project": "vivary-lattice-lab", "visibility": "local"},
        payload={"note": "evidence store fixture event"},
        now=lambda: "2026-07-21T00:00:01.000Z",
    )
    base.update(overrides)
    return base


def capsule_stub(suffix="1"):
    return {
        "capsule_id": f"capsule_fixture_{suffix}",
        "fingerprint": f"sha256:fixture-capsule-{suffix}",
        "workspace": {"fingerprint": f"sha256:fixture-workspace-{suffix}", "observed_at": "2026-07-21T00:00:00.000Z"},
        "claims": [{"id": f"claim_{suffix}"}],
        "conflicts": [],
        "unknowns": [],
    }


def build_receipt(suffix="1"):
    return create_integrity_receipt(
        capsule=capsule_stub(suffix),
        runtime={"harness": "pytest", "actor": "evidence-suite"},
        checks=[{"name": "fixture-check", "command": "true", "outcome": "passed"}],
        now=lambda: "2026-07-21T00:00:02.000Z",
    )


def seed_workspace(fixture_dir_, name, events=(), receipts=()):
    workspace_root = fixture_path(fixture_dir_, name)
    init_evidence_workspace(fixture_dir_, workspace_root)
    store = open_evidence_store(workspace_root=workspace_root, **SINK)
    for event in events:
        store.append_event(event)
    for receipt in receipts:
        store.append_receipt(receipt)
    return workspace_root


def _read_text(path):
    with open(path, "r", encoding="utf-8") as handle:
        return handle.read()


def _read_lines(path):
    return [line for line in _read_text(path).split("\n") if line]


# --- append validation --------------------------------------------------------


def test_valid_event_is_accepted_and_appended_as_one_canonical_json_line(fixture_dir):
    workspace_root = fixture_path(fixture_dir, "append-valid")
    store = open_evidence_store(workspace_root=workspace_root, **SINK)
    event = create_context_integrity_event(**base_event_input())

    outcome = store.append_event(event)
    assert outcome == {"decision": "accepted", "reason_codes": []}

    lines = _read_lines(evidence_paths(workspace_root)["events"])
    assert len(lines) == 1
    # JSON round-trip both sides: canonicalize() (like JSON.stringify) drops
    # undefined-valued keys such as the unset `policy` field.
    assert json.loads(lines[0]) == json.loads(json.dumps(event))


def test_event_the_frozen_contract_rejects_is_never_written(fixture_dir):
    workspace_root = fixture_path(fixture_dir, "append-invalid")
    store = open_evidence_store(workspace_root=workspace_root, **SINK)
    bad_event = dict(create_context_integrity_event(**base_event_input()))
    bad_event.pop("actor", None)

    outcome = store.append_event(bad_event)
    assert outcome["decision"] == "rejected"
    assert "missing_actor_identity" in outcome["reason_codes"]

    assert not os.path.exists(evidence_paths(workspace_root)["events"])


def test_duplicate_event_id_is_idempotent_line_never_duplicated(fixture_dir):
    workspace_root = fixture_path(fixture_dir, "append-idempotent")
    store = open_evidence_store(workspace_root=workspace_root, **SINK)
    event = create_context_integrity_event(**base_event_input())

    assert store.append_event(event) == {"decision": "accepted", "reason_codes": []}
    assert store.append_event(event) == {"decision": "duplicate", "reason_codes": []}

    lines = _read_lines(evidence_paths(workspace_root)["events"])
    assert len(lines) == 1


def test_reusing_event_id_for_different_body_fails_closed(fixture_dir):
    workspace_root = fixture_path(fixture_dir, "append-reuse")
    store = open_evidence_store(workspace_root=workspace_root, **SINK)
    original = create_context_integrity_event(**base_event_input())
    store.append_event(original)

    imposter = dict(create_context_integrity_event(**base_event_input(event_type="capsule.compiled")))
    imposter["event_id"] = original["event_id"]
    outcome = store.append_event(imposter)
    assert outcome == {"decision": "rejected", "reason_codes": ["event_id_reuse"]}

    lines = _read_lines(evidence_paths(workspace_root)["events"])
    assert len(lines) == 1
    assert json.loads(lines[0]) == json.loads(json.dumps(original))


def test_idempotency_survives_fresh_store_reopen(fixture_dir):
    workspace_root = fixture_path(fixture_dir, "append-restart")
    first = create_context_integrity_event(**base_event_input())
    store_a = open_evidence_store(workspace_root=workspace_root, **SINK)
    store_a.append_event(first)

    store_b = open_evidence_store(workspace_root=workspace_root, **SINK)
    assert store_b.append_event(first) == {"decision": "duplicate", "reason_codes": []}

    second = create_context_integrity_event(**base_event_input(event_type="capsule.compiled"))
    assert store_b.append_event(second) == {"decision": "accepted", "reason_codes": []}

    lines = _read_lines(evidence_paths(workspace_root)["events"])
    assert len(lines) == 2
    assert [json.loads(line)["event_id"] for line in lines] == [first["event_id"], second["event_id"]]


def test_appends_are_append_only_bytes(fixture_dir):
    workspace_root = fixture_path(fixture_dir, "append-only-bytes")
    store = open_evidence_store(workspace_root=workspace_root, **SINK)
    a = create_context_integrity_event(**base_event_input(occurred_at="2026-07-21T02:00:00.000Z"))
    b = create_context_integrity_event(**base_event_input(event_type="capsule.compiled"))

    store.append_event(a)
    after_first = _read_text(evidence_paths(workspace_root)["events"])
    store.append_event(b)
    after_second = _read_text(evidence_paths(workspace_root)["events"])

    assert after_second.startswith(after_first)
    lines = [line for line in after_second.split("\n") if line]
    assert [json.loads(line)["event_id"] for line in lines] == [a["event_id"], b["event_id"]]


# --- receipts -----------------------------------------------------------------


def test_valid_receipt_is_accepted_and_appended(fixture_dir):
    workspace_root = fixture_path(fixture_dir, "receipt-valid")
    store = open_evidence_store(workspace_root=workspace_root, **SINK)
    receipt = build_receipt()

    assert store.append_receipt(receipt) == {"decision": "accepted", "reason_codes": []}
    lines = _read_lines(evidence_paths(workspace_root)["receipts"])
    assert len(lines) == 1
    assert json.loads(lines[0]) == receipt


def test_malformed_receipt_is_rejected_and_never_written(fixture_dir):
    workspace_root = fixture_path(fixture_dir, "receipt-invalid")
    store = open_evidence_store(workspace_root=workspace_root, **SINK)

    wrong_schema = dict(build_receipt())
    wrong_schema["schema"] = "vivary.execution-receipt/v9"
    missing_id = dict(build_receipt())
    del missing_id["receipt_id"]

    assert store.append_receipt(wrong_schema) == {"decision": "rejected", "reason_codes": ["unsupported_schema"]}
    assert store.append_receipt(missing_id) == {"decision": "rejected", "reason_codes": ["missing_receipt_id"]}
    assert not os.path.exists(evidence_paths(workspace_root)["receipts"])


def test_duplicate_receipt_id_is_idempotent_reuse_fails_closed(fixture_dir):
    workspace_root = fixture_path(fixture_dir, "receipt-idempotent")
    store = open_evidence_store(workspace_root=workspace_root, **SINK)
    receipt = build_receipt()

    assert store.append_receipt(receipt) == {"decision": "accepted", "reason_codes": []}
    assert store.append_receipt(receipt) == {"decision": "duplicate", "reason_codes": []}

    imposter = dict(receipt)
    imposter["checks"] = []
    assert store.append_receipt(imposter) == {"decision": "rejected", "reason_codes": ["receipt_id_reuse"]}

    lines = _read_lines(evidence_paths(workspace_root)["receipts"])
    assert len(lines) == 1
    assert RECEIPT_SCHEMA == "vivary.execution-receipt/v0"


# --- sync: determinism and chaining -------------------------------------------


def test_identical_evidence_content_identity_date_sync_to_identical_shas(fixture_dir):
    event = create_context_integrity_event(**base_event_input())
    receipt = build_receipt()

    ws_a = seed_workspace(fixture_dir, "determinism-a", events=[event], receipts=[receipt])
    ws_b = seed_workspace(fixture_dir, "determinism-b", events=[event], receipts=[receipt])
    remote_a = fixture_path(fixture_dir, "determinism-a-remote.git")
    remote_b = fixture_path(fixture_dir, "determinism-b-remote.git")
    init_bare_remote(fixture_dir, remote_a)
    init_bare_remote(fixture_dir, remote_b)

    result_a = sync_evidence(workspace_root=ws_a, remote=remote_a, identity=IDENTITY, date=DATE_A)
    result_b = sync_evidence(workspace_root=ws_b, remote=remote_b, identity=IDENTITY, date=DATE_A)

    assert result_a["tree"] == result_b["tree"]
    assert result_a["commit"] == result_b["commit"]
    assert result_a["parent"] is None
    assert result_b["parent"] is None


def test_second_sync_is_parented_on_first(fixture_dir):
    first = create_context_integrity_event(**base_event_input())
    ws_root = seed_workspace(fixture_dir, "chain", events=[first])
    remote = fixture_path(fixture_dir, "chain-remote.git")
    init_bare_remote(fixture_dir, remote)

    first_sync = sync_evidence(workspace_root=ws_root, remote=remote, identity=IDENTITY, date=DATE_A)
    assert first_sync["parent"] is None

    store = open_evidence_store(workspace_root=ws_root, **SINK)
    store.append_event(create_context_integrity_event(**base_event_input(event_type="capsule.compiled")))

    second_sync = sync_evidence(workspace_root=ws_root, remote=remote, identity=IDENTITY, date=DATE_B)
    assert second_sync["parent"] == first_sync["commit"]
    assert second_sync["commit"] != first_sync["commit"]
    assert second_sync["tree"] != first_sync["tree"]


def test_diverged_remote_ref_fails_closed_non_fast_forward(fixture_dir):
    event_a = create_context_integrity_event(**base_event_input())
    event_b = create_context_integrity_event(**base_event_input(event_type="capsule.compiled"))
    ws_a = seed_workspace(fixture_dir, "nff-a", events=[event_a])
    ws_b = seed_workspace(fixture_dir, "nff-b", events=[event_b])
    remote = fixture_path(fixture_dir, "nff-remote.git")
    init_bare_remote(fixture_dir, remote)

    sync_evidence(workspace_root=ws_a, remote=remote, identity=IDENTITY, date=DATE_A)

    with pytest.raises(EvidenceSyncError) as exc_info:
        sync_evidence(workspace_root=ws_b, remote=remote, identity=IDENTITY, date=DATE_A)
    assert exc_info.value.code == "non_fast_forward"


def test_rejected_push_is_inert_locally(fixture_dir):
    event_a = create_context_integrity_event(**base_event_input())
    event_b = create_context_integrity_event(**base_event_input(event_type="capsule.compiled"))
    ws_a = seed_workspace(fixture_dir, "inert-a", events=[event_a])
    ws_b = seed_workspace(fixture_dir, "inert-b", events=[event_b])
    remote = fixture_path(fixture_dir, "inert-remote.git")
    init_bare_remote(fixture_dir, remote)

    # A syncs first; B's push must then be rejected non-fast-forward.
    sync_evidence(workspace_root=ws_a, remote=remote, identity=IDENTITY, date=DATE_A)
    assert git_rev_parse(ws_b, DEFAULT_REF) is None, "precondition: B has no local evidence ref"

    for attempt in (1, 2):
        with pytest.raises(EvidenceSyncError) as exc_info:
            sync_evidence(workspace_root=ws_b, remote=remote, identity=IDENTITY, date=DATE_A)
        assert exc_info.value.code == "non_fast_forward", f"attempt {attempt} must fail closed"
        # The whole point of #50: rejection leaves the LOCAL ref untouched
        # too - no advance before the push lands, no orphan snapshot chain
        # on retries.
        assert git_rev_parse(ws_b, DEFAULT_REF) is None, f"attempt {attempt} must leave B's local ref unset"

    # And a successful sync still advances the local ref (the happy path
    # keeps its local bookkeeping - inertness applies to failure only).
    fresh_remote = fixture_path(fixture_dir, "inert-fresh-remote.git")
    init_bare_remote(fixture_dir, fresh_remote)
    ok = sync_evidence(workspace_root=ws_b, remote=fresh_remote, identity=IDENTITY, date=DATE_A)
    assert git_rev_parse(ws_b, DEFAULT_REF) == ok["commit"]


# --- sync: divergence, failure modes, edge cases (#64) ------------------------


def test_second_local_writer_races_ref_local_ref_diverged(fixture_dir):
    event = create_context_integrity_event(**base_event_input())
    ws_root = seed_workspace(fixture_dir, "local-diverged", events=[event])
    remote = fixture_path(fixture_dir, "local-diverged-remote.git")
    init_bare_remote(fixture_dir, remote)

    # sync_evidence has no public API to observe its own in-flight commit, so
    # this drives the exact race window (read parent -> push -> update-ref)
    # through the bounded test hook rather than racing real process timing:
    # right after the push lands, a "second writer" moves the local ref to
    # an unrelated commit it minted itself, exactly as a genuine concurrent
    # sync_evidence call would have.
    state = {"second_writer_sha": None}

    def simulate_second_writer(info):
        env = dict(os.environ)
        env.update(
            {
                "GIT_AUTHOR_NAME": "Second Writer",
                "GIT_AUTHOR_EMAIL": "second-writer@lattice.local",
                "GIT_COMMITTER_NAME": "Second Writer",
                "GIT_COMMITTER_EMAIL": "second-writer@lattice.local",
                "GIT_AUTHOR_DATE": DATE_B,
                "GIT_COMMITTER_DATE": DATE_B,
            }
        )
        proc = subprocess.run(
            ["git", "commit-tree", GIT_EMPTY_TREE_SHA, "-m", "second writer snapshot"],
            cwd=info["workspace_root"],
            env=env,
            capture_output=True,
            text=True,
            check=True,
        )
        sha = proc.stdout.strip()
        state["second_writer_sha"] = sha
        subprocess.run(
            ["git", "update-ref", info["ref"], sha], cwd=info["workspace_root"], capture_output=True, check=True
        )

    with pytest.raises(EvidenceSyncError) as exc_info:
        sync_evidence(
            workspace_root=ws_root,
            remote=remote,
            identity=IDENTITY,
            date=DATE_A,
            _on_before_push_advances_local_ref=simulate_second_writer,
        )

    assert exc_info.value.code == "local_ref_diverged"
    assert state["second_writer_sha"], "fixture precondition: the second writer must have actually moved the ref"

    # The push landed on the remote even though the local bookkeeping failed
    # - that ordering (#50) is the entire point of pinning this branch.
    remote_sha = git_rev_parse(remote, DEFAULT_REF)
    assert remote_sha, "the push must have landed on the remote"
    assert remote_sha != state["second_writer_sha"], "the remote must carry OUR commit, not the second writer's"

    # Locally, the ref honestly shows the divergence: our own update-ref
    # lost its compare-and-swap, so the ref is left exactly where the second
    # writer put it - never silently overwritten, never advanced to our
    # commit.
    local_sha = git_rev_parse(ws_root, DEFAULT_REF)
    assert local_sha == state["second_writer_sha"], (
        "the local ref must honestly show the second writer's value, untouched by our failed update-ref"
    )


def test_push_failure_not_non_fast_forward_is_push_failed(fixture_dir):
    event = create_context_integrity_event(**base_event_input())
    ws_root = seed_workspace(fixture_dir, "push-failed", events=[event])
    # Deliberately never initialized: pushing to a path that is not a git
    # repository at all fails with "does not appear to be a git repository"
    # - a real push failure that is neither non-fast-forward, rejected, nor
    # stale info, so it must fall through to the generic push_failed code.
    remote = fixture_path(fixture_dir, "push-failed-remote-does-not-exist.git")

    with pytest.raises(EvidenceSyncError) as exc_info:
        sync_evidence(workspace_root=ws_root, remote=remote, identity=IDENTITY, date=DATE_A)

    assert exc_info.value.code == "push_failed"
    stderr = getattr(exc_info.value, "stderr", "") or ""
    assert not re.search(r"non-fast-forward|rejected|stale info", stderr, re.IGNORECASE)

    # Push failure is inert locally too: the ref must never have advanced.
    assert git_rev_parse(ws_root, DEFAULT_REF) is None


def test_no_filters_autocrlf_true_vs_false_yields_identical_sha(fixture_dir):
    ws_on = seed_workspace(fixture_dir, "autocrlf-on")
    ws_off = seed_workspace(fixture_dir, "autocrlf-off")
    subprocess.run(["git", "config", "core.autocrlf", "true"], cwd=ws_on, capture_output=True, check=True)
    subprocess.run(["git", "config", "core.autocrlf", "false"], cwd=ws_off, capture_output=True, check=True)

    # A file containing CRLF line endings, written identically into both
    # workspaces' evidence dirs (bypassing open_evidence_store, which only
    # ever writes LF - this must exercise a file whose bytes autocrlf
    # actually has an opinion about).
    dir_on = evidence_paths(ws_on)["dir"]
    dir_off = evidence_paths(ws_off)["dir"]
    os.makedirs(dir_on, exist_ok=True)
    os.makedirs(dir_off, exist_ok=True)
    crlf_content = "line one\r\nline two\r\n"
    with open(os.path.join(dir_on, "note.txt"), "w", encoding="utf-8", newline="") as handle:
        handle.write(crlf_content)
    with open(os.path.join(dir_off, "note.txt"), "w", encoding="utf-8", newline="") as handle:
        handle.write(crlf_content)

    # Fixture precondition: prove autocrlf actually diverges filtered
    # hashing for this exact content under these two configs - otherwise
    # this test would pass vacuously regardless of --no-filters doing
    # anything at all.
    filtered_on = subprocess.run(
        ["git", "hash-object", "--", os.path.join(dir_on, "note.txt")],
        cwd=ws_on,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
    filtered_off = subprocess.run(
        ["git", "hash-object", "--", os.path.join(dir_off, "note.txt")],
        cwd=ws_off,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
    # The whole test is only meaningful where autocrlf's clean filter
    # actually diverges the hash for this content. On some platforms/git
    # builds it does not, so the anti-vacuity precondition can't be
    # established there - skip rather than fail, since there is nothing for
    # --no-filters to prove it is neutralizing on that platform.
    if filtered_on == filtered_off:
        pytest.skip(
            "autocrlf clean filter does not diverge this content's hash on this platform; "
            "--no-filters neutrality is unobservable here"
        )

    remote_on = fixture_path(fixture_dir, "autocrlf-on-remote.git")
    remote_off = fixture_path(fixture_dir, "autocrlf-off-remote.git")
    init_bare_remote(fixture_dir, remote_on)
    init_bare_remote(fixture_dir, remote_off)

    result_on = sync_evidence(workspace_root=ws_on, remote=remote_on, identity=IDENTITY, date=DATE_A)
    result_off = sync_evidence(workspace_root=ws_off, remote=remote_off, identity=IDENTITY, date=DATE_A)

    assert result_on["tree"] == result_off["tree"]
    assert result_on["commit"] == result_off["commit"]


def test_empty_evidence_dir_syncs_to_well_known_empty_tree(fixture_dir):
    ws_root = fixture_path(fixture_dir, "empty-evidence-dir")
    init_evidence_workspace(fixture_dir, ws_root)
    # Deliberately never call open_evidence_store/append_event/append_receipt
    # - .vivary/evidence/ is never created at all, so _list_evidence_files
    # must treat "directory does not exist" the same as "directory is empty".
    remote = fixture_path(fixture_dir, "empty-evidence-dir-remote.git")
    init_bare_remote(fixture_dir, remote)

    result = sync_evidence(workspace_root=ws_root, remote=remote, identity=IDENTITY, date=DATE_A)
    assert result["tree"] == GIT_EMPTY_TREE_SHA
    assert result["parent"] is None

    materialized = read_evidence_snapshot(repo_dir=ws_root, ref=DEFAULT_REF)
    assert materialized == {}


# --- full round-trip byte identity proof --------------------------------------


def test_round_trip_write_sync_clone_fetch_materialize_byte_identical(fixture_dir):
    event = create_context_integrity_event(**base_event_input())
    receipt = build_receipt("roundtrip")
    workspace_root = fixture_path(fixture_dir, "roundtrip-workspace")
    init_evidence_workspace(fixture_dir, workspace_root)
    store = open_evidence_store(workspace_root=workspace_root, **SINK)
    store.append_event(event)
    store.append_receipt(receipt)

    remote = fixture_path(fixture_dir, "roundtrip-remote.git")
    init_bare_remote(fixture_dir, remote)
    sync_evidence(workspace_root=workspace_root, remote=remote, identity=IDENTITY, date=DATE_A)

    clone = fixture_path(fixture_dir, "roundtrip-clone")
    clone_repo(fixture_dir, remote, clone)
    fetch_ref(fixture_dir, clone, remote, DEFAULT_REF)

    materialized = read_evidence_snapshot(repo_dir=clone, ref=DEFAULT_REF)
    paths = evidence_paths(workspace_root)
    with open(paths["events"], "rb") as handle:
        original_events = handle.read()
    with open(paths["receipts"], "rb") as handle:
        original_receipts = handle.read()

    assert sorted(materialized.keys()) == ["events.jsonl", "receipts.jsonl"]
    assert materialized["events.jsonl"] == original_events
    assert materialized["receipts.jsonl"] == original_receipts

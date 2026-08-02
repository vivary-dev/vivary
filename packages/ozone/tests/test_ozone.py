"""Tests for the ozone review layer. Run: python tests/test_ozone.py (or pytest)."""
import contextlib
import io
import json
import os
import shutil
import subprocess
import sys
import uuid
from contextlib import contextmanager
from pathlib import Path

OZONE_ROOT = Path(__file__).resolve().parents[1]
CORE_ROOT = OZONE_ROOT.parent / "core"
STRATO_ROOT = OZONE_ROOT.parent / "strato"
for package_root in (OZONE_ROOT, CORE_ROOT, STRATO_ROOT):
    sys.path.insert(0, str(package_root))

import ozone  # noqa: E402
import strato  # noqa: E402
from vivary_core.canonical import deterministic_id, fingerprint, normalize_path  # noqa: E402
from vivary_core.capsule_compile import (  # noqa: E402
    CAPSULE_SCHEMA,
    compile_task_capsule,
    repair_topology_fingerprint,
)
from vivary_core.capsule_select import OMITTED_LIST_CAP  # noqa: E402
from vivary_core.receipt import create_integrity_receipt  # noqa: E402
from vivary_core.verify_repair import MAX_DEDUPE_CHECKOUTS  # noqa: E402
from vivary_core.workspace_content import CONTENT_SCHEMA  # noqa: E402
from vivary_core.workspace_model import (  # noqa: E402
    project_workspace_graph,
    workspace_fingerprint_from_graph,
)

ROOT = str(OZONE_ROOT)
REPO_TMP = os.path.abspath(os.path.join(ROOT, "..", "..", "sandboxes"))


def make_tmp_path():
    base = REPO_TMP if os.path.isdir(REPO_TMP) else os.getcwd()
    path = Path(base) / f"test-ozone-{uuid.uuid4().hex}"
    path.mkdir(parents=True)
    return path


@contextmanager
def temp_workspace():
    path = make_tmp_path()
    try:
        yield path
    finally:
        shutil.rmtree(path)


def _vault(td, complete=False):
    """A minimal vivary-vocab vault. `c1` is a complete change (verified + gated);
    unless `complete`, `c2` is a change with nothing linked. `m1` is an unverified
    module. v1/g1 are the verification/gate targets."""
    Path(td, "tropo.toml").write_text(
        '[base]\nallow_untyped = true\n'
        '[types.module]\nfolder = "modules"\n'
        '[types.module.optional]\nverification = "ref-list"\n'
        '[types.change]\nfolder = "changes"\n'
        '[types.change.optional]\nverification = "ref-list"\ngates = "ref-list"\n'
        '[types.verification]\nfolder = "verification"\n'
        '[types.gate]\nfolder = "gates"\n')
    for d in ("modules", "changes", "verification", "gates"):
        Path(td, d).mkdir()
    Path(td, "modules", "m1.md").write_text("# Module One\n")
    Path(td, "verification", "v1.md").write_text("# Verify One\n")
    Path(td, "gates", "g1.md").write_text("# Gate One\n")
    Path(td, "changes", "c1.md").write_text(
        "---\nverification: [v1]\ngates: [g1]\n---\n# Change One\n")
    if not complete:
        Path(td, "changes", "c2.md").write_text("# Change Two\n")


def _writing_vault(td):
    Path(td, "tropo.toml").write_text(
        '[base]\nallow_untyped = true\n'
        '[types.draft]\nfolder = ["drafts", "manuscripts"]\n'
        '[types.draft.optional]\nreviews = "ref-list"\nedits = "ref-list"\noutline = "ref"\n'
        '[types.review]\nfolder = ["reviews", "editorial-reviews"]\n'
        '[types.review.optional]\ndraft = "ref"\nedits = "ref-list"\n'
        '[types.edit]\nfolder = ["edits", "revisions"]\n'
        '[types.edit.optional]\ndraft = "ref"\nreview = "ref"\n'
        '[types.outline]\nfolder = ["outlines", "structures", "beats"]\n'
        '[types.outline.optional]\ndraft = "ref"\n')
    for d in ("drafts", "reviews", "edits", "outlines"):
        Path(td, d).mkdir()
    Path(td, "drafts", "complete.md").write_text(
        "---\nreviews: [review-complete]\nedits: [edit-complete]\noutline: outline-complete\n---\n"
        "# Complete Draft\n")
    Path(td, "reviews", "review-complete.md").write_text(
        "---\ndraft: complete\n---\n# Review Complete\n")
    Path(td, "edits", "edit-complete.md").write_text(
        "---\ndraft: complete\nreview: review-complete\n---\n# Edit Complete\n")
    Path(td, "outlines", "outline-complete.md").write_text(
        "---\ndraft: complete\n---\n# Outline Complete\n")
    Path(td, "drafts", "raw.md").write_text("# Raw Draft\n")
    Path(td, "reviews", "orphan-review.md").write_text("# Orphan Review\n")
    Path(td, "edits", "orphan-edit.md").write_text("# Orphan Edit\n")


def _run(argv):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        rc = ozone.main(argv)
    return rc, buf.getvalue()


def _run_json(argv):
    rc, out = _run(argv)
    return rc, json.loads(out)


def test_runtime_version_matches_package_manifest():
    import tomllib

    project = tomllib.loads(
        (OZONE_ROOT / "pyproject.toml").read_text(encoding="utf-8")
    )["project"]
    assert ozone.__version__ == project["version"]
    assert "vivary-core>=0.2.4" in project["dependencies"]


def test_run_receipt_appends_jsonl_without_polluting_stdout():
    with temp_workspace() as td:
        receipt = td / "receipts" / "runs.jsonl"
        rc, data = _run_json(["packs", "--json", "--receipt", str(receipt)])

        assert rc == 0
        assert "packs" in data
        record = json.loads(receipt.read_text(encoding="utf-8").strip())
        assert record["schema"] == "vivary.run_receipt.v1"
        assert record["tool"] == "ozone"
        assert record["command"] == "packs"
        assert record["exit_code"] == 0
        assert record["ok"] is True
        assert "--json" in record["flags"]
        assert "--receipt" not in record["flags"]
        assert str(td) not in json.dumps(record, sort_keys=True)

        for early_exit in ("--help", "--version"):
            exit_result = None
            try:
                with (
                    contextlib.redirect_stdout(io.StringIO()),
                    contextlib.redirect_stderr(io.StringIO()),
                ):
                    ozone.main([early_exit, "--receipt", str(receipt)])
            except SystemExit as exc:
                exit_result = exc
            assert exit_result is not None
            assert exit_result.code == 0

        records = [
            json.loads(line)
            for line in receipt.read_text(encoding="utf-8").splitlines()
        ]
        assert [record["command"] for record in records] == [
            "packs",
            "help",
            "version",
        ]


def test_impact_receipt_does_not_record_target_id():
    with temp_workspace() as td:
        _vault(td)
        receipt = td / "runs.jsonl"
        secret_target = "c1"

        rc, data = _run_json([
            "impact",
            secret_target,
            "--root",
            str(td),
            "--json",
            "--receipt",
            str(receipt),
        ])

        assert rc == 0
        assert data["target"] == secret_target
        record = json.loads(receipt.read_text(encoding="utf-8").strip())
        serialized = json.dumps(record, sort_keys=True)
        assert record["command"] == "impact"
        assert secret_target not in serialized
        assert str(td) not in serialized


def test_packs_lists_structure_and_context_budget():
    rc, data = _run_json(["packs", "--json"])
    assert rc == 0
    names = {p["name"] for p in data["packs"]}
    assert {"structure", "context-budget", "editorial"} <= names


def test_governed_flag_is_verify_only():
    for argv in (
        ["review", "--governed"],
        ["impact", "node:test", "--governed"],
        ["packs", "--governed"],
    ):
        stderr = io.StringIO()
        exit_code = None
        try:
            with contextlib.redirect_stderr(stderr):
                ozone._main(argv)
        except SystemExit as exc:
            exit_code = exc.code
        assert exit_code == 2
        assert "--governed is only valid with verify" in stderr.getvalue()


def test_review_flags_unverified_change():
    with temp_workspace() as td:
        _vault(td)
        rc, data = _run_json(["review", "--root", str(td), "--json"])
        rules = {(f["rule"], f["id"]) for f in data["findings"]}
        assert ("change-unverified", "c2") in rules     # c2 has nothing linked
        assert ("change-unverified", "c1") not in rules  # c1 is verified
        assert rc == 0                                   # advisory by default


def test_review_default_remains_structure_only():
    with temp_workspace() as td:
        _vault(td, complete=True)
        Path(td, "modules", "m2").mkdir()
        rc, data = _run_json(["review", "--root", str(td), "--json"])
        assert data["packs"] == ["structure"]
        assert not any(f["rule"] == "module-index-missing" for f in data["findings"])
        assert rc == 0


def test_context_budget_flags_missing_module_index():
    with temp_workspace() as td:
        _vault(td, complete=True)
        Path(td, "modules", "m2").mkdir()
        rc, data = _run_json(["review", "--root", str(td),
                              "--pack", "context-budget", "--json"])
        findings = {(f["rule"], f["path"]) for f in data["findings"]}
        assert data["packs"] == ["context-budget"]
        assert ("module-index-missing", "modules/m2/index.md") in findings
        assert data["warnings"] == 1
        assert rc == 0


def test_context_budget_flags_legacy_module_file_with_index():
    with temp_workspace() as td:
        _vault(td, complete=True)
        Path(td, "modules", "m1").mkdir()
        Path(td, "modules", "m1", "index.md").write_text("# Module One Index\n")
        rc, data = _run_json(["review", "--root", str(td),
                              "--pack", "context-budget", "--json"])
        findings = {(f["rule"], f["path"]) for f in data["findings"]}
        assert ("legacy-module-file", "modules/m1.md") in findings
        assert data["warnings"] == 1
        assert rc == 0


def test_context_budget_flags_large_public_routing_surfaces_as_info():
    with temp_workspace() as td:
        _vault(td, complete=True)
        Path(td, "AGENTS.md").write_text("\n".join(f"root line {i}" for i in range(161)))
        Path(td, "modules", "big").mkdir()
        Path(td, "modules", "big", "index.md").write_text(
            "\n".join(f"module line {i}" for i in range(121)))
        rc, data = _run_json(["review", "--root", str(td),
                              "--pack", "context-budget", "--json"])
        by_rule = {(f["rule"], f["path"]): f for f in data["findings"]}
        assert by_rule[("always-on-large", "AGENTS.md")]["severity"] == "info"
        assert by_rule[("module-index-large", "modules/big/index.md")]["severity"] == "info"
        assert data["warnings"] == 0
        assert data["notes"] == 2
        assert rc == 0


def test_context_budget_flags_positive_bulk_load_cues_only():
    with temp_workspace() as td:
        _vault(td, complete=True)
        Path(td, "AGENTS.md").write_text(
            "Before every task, read the entire docs folder for context.\n")
        Path(td, "modules", "index.md").write_text(
            "Do not read the whole repo by default; use targeted pointers.\n")
        rc, data = _run_json(["review", "--root", str(td),
                              "--pack", "context-budget", "--json"])
        matches = [f for f in data["findings"] if f["rule"] == "bulk-load-cue"]
        assert [(f["severity"], f["path"]) for f in matches] == [("info", "AGENTS.md")]
        assert data["warnings"] == 0
        assert rc == 0


def test_context_budget_ignores_private_memory_surfaces():
    with temp_workspace() as td:
        _vault(td, complete=True)
        Path(td, "USER.md").write_text("\n".join("private user line" for _ in range(1000)))
        Path(td, "MEMORY.md").write_text(
            "Before every task, read the entire docs folder for context.\n")
        Path(td, "memory").mkdir()
        Path(td, "memory", "notes.md").write_text("\n".join("private memory line" for _ in range(1000)))
        rc, data = _run_json(["review", "--root", str(td),
                              "--pack", "context-budget", "--json"])
        assert data["findings"] == []
        assert rc == 0


def test_context_budget_flags_duplicate_long_routing_blocks():
    block = (
        "This routing surface owns a short stable summary for agents and points them "
        "toward the one canonical detail file for each durable fact in the workspace."
    )
    with temp_workspace() as td:
        _vault(td, complete=True)
        Path(td, "AGENTS.md").write_text(f"# Agent Contract\n\n{block}\n")
        Path(td, "modules", "index.md").write_text(f"# Modules\n\n{block}\n")
        rc, data = _run_json(["review", "--root", str(td),
                              "--pack", "context-budget", "--json"])
        matches = [f for f in data["findings"] if f["rule"] == "duplicate-routing-block"]
        assert len(matches) == 1
        assert matches[0]["severity"] == "info"
        assert matches[0]["path"] == "AGENTS.md"
        assert "modules/index.md" in matches[0]["message"]
        assert data["warnings"] == 0
        assert rc == 0


def test_editorial_flags_missing_review_edit_and_structure():
    with temp_workspace() as td:
        _writing_vault(td)
        rc, data = _run_json(["review", "--root", str(td),
                              "--pack", "editorial", "--json"])
        by_rule = {(f["rule"], f["id"]): f for f in data["findings"]}
        assert data["packs"] == ["editorial"]
        assert by_rule[("draft-unreviewed", "raw")]["severity"] == "warn"
        assert by_rule[("draft-unedited", "raw")]["severity"] == "info"
        assert by_rule[("draft-structure-missing", "raw")]["severity"] == "info"
        assert ("draft-unreviewed", "complete") not in by_rule
        assert ("draft-unedited", "complete") not in by_rule
        assert ("draft-structure-missing", "complete") not in by_rule
        assert data["warnings"] == 3
        assert rc == 0


def test_editorial_flags_unlinked_reviews_and_edits():
    with temp_workspace() as td:
        _writing_vault(td)
        rc, data = _run_json(["review", "--root", str(td),
                              "--pack", "editorial", "--json"])
        by_rule = {(f["rule"], f["id"]): f for f in data["findings"]}
        assert by_rule[("review-unlinked", "orphan-review")]["severity"] == "warn"
        assert by_rule[("edit-unlinked", "orphan-edit")]["severity"] == "warn"
        assert ("review-unlinked", "review-complete") not in by_rule
        assert ("edit-unlinked", "edit-complete") not in by_rule
        assert rc == 0


def test_editorial_pack_stays_quiet_for_non_writing_workspace():
    with temp_workspace() as td:
        _vault(td)
        rc, data = _run_json(["review", "--root", str(td),
                              "--pack", "editorial", "--json"])
        assert data["findings"] == []
        assert data["warnings"] == 0
        assert rc == 0


def test_strict_gates_on_warnings():
    with temp_workspace() as td:
        _vault(td)
        rc, _ = _run(["review", "--root", str(td), "--strict"])
        assert rc == 1  # c2 is unverified -> warn -> strict fails


def test_strict_gates_on_context_budget_warnings_with_pack_all():
    with temp_workspace() as td:
        _vault(td, complete=True)
        Path(td, "modules", "m2").mkdir()
        rc, data = _run_json(["review", "--root", str(td),
                              "--pack", "all", "--strict", "--json"])
        assert data["packs"] == ["structure", "context-budget", "editorial"]
        assert any(f["rule"] == "module-index-missing" for f in data["findings"])
        assert rc == 1


def test_strict_allows_info_only_context_budget_findings():
    with temp_workspace() as td:
        _vault(td, complete=True)
        Path(td, "AGENTS.md").write_text("\n".join(f"root line {i}" for i in range(161)))
        rc, data = _run_json(["review", "--root", str(td),
                              "--pack", "all", "--strict", "--json"])
        assert any(f["rule"] == "always-on-large" for f in data["findings"])
        assert data["warnings"] == 0
        assert rc == 0


def test_clean_vault_has_no_warnings():
    with temp_workspace() as td:
        _vault(td, complete=True)
        rc, data = _run_json(["review", "--root", str(td), "--json"])
        assert data["warnings"] == 0
        rc2, _ = _run(["review", "--root", str(td), "--strict"])
        assert rc2 == 0


def test_module_unverified_is_a_note_not_a_warning():
    with temp_workspace() as td:
        _vault(td, complete=True)
        _, data = _run_json(["review", "--root", str(td), "--json"])
        mod = [f for f in data["findings"] if f["rule"] == "module-unverified"]
        assert mod and all(f["severity"] == "info" for f in mod)


def test_impact_returns_dependents():
    with temp_workspace() as td:
        _vault(td)
        rc, data = _run_json(["impact", "v1", "--root", str(td), "--json"])
        assert rc == 0
        ids = {n["id"] for n in data["nodes"]}
        assert "c1" in ids  # c1 depends on v1 via its verification edge


def test_review_json_shape():
    with temp_workspace() as td:
        _vault(td)
        _, data = _run_json(["review", "--root", str(td), "--json"])
        assert set(data) >= {"reviewed", "warnings", "notes", "findings"}
        for f in data["findings"]:
            assert set(f) >= {"severity", "rule", "id", "type", "path", "message"}


NOW = "2026-07-28T12:00:00+00:00"


def _content_artifact(*, checkouts, terms):
    return {
        "schema": CONTENT_SCHEMA,
        "observed_at": NOW,
        "terms": terms,
        "allowlist": [checkout["path"] for checkout in checkouts],
        "checkouts": checkouts,
        "refusals": [],
    }


def _observed_content_checkout(
    path, *, head_revision, matches, privacy_fingerprint=None
):
    return {
        "raw_path": path,
        "path": path,
        "status": "observed",
        "head_revision": head_revision,
        "privacy_fingerprint": privacy_fingerprint
        or fingerprint(
            {
                "revision": head_revision,
                "ignored_tracked_paths": [],
            }
        ),
        "matches": matches,
        "omissions": [],
    }

def _governed_capsule(
    *,
    claims=None,
    conflicts=None,
    unknowns=None,
    omissions=None,
    workspace_fingerprint=None,
    topology_fingerprint=None,
    preserve_claim_ids=False,
):
    if workspace_fingerprint is None:
        workspace_fingerprint = workspace_fingerprint_from_graph({"nodes": []})
    complete_claims = []
    for claim in [] if claims is None else claims:
        complete_claim = {
            "subject": "checkout:test",
            "subject_path": "/repo/packages/ozone",
            "fact": "test_fact",
            "claim": "test claim",
            "status": "known",
            "evidence": [],
            "selection_reason": "test fixture",
            "selection": {
                "tier": "allowlisted",
                "signals": [{"signal": "allowlisted"}],
            },
        }
        complete_claim.update(claim)
        selection = {
            "tier": "allowlisted",
            "signals": [{"signal": "allowlisted"}],
        }
        selection.update(complete_claim.get("selection", {}))
        complete_claim["selection"] = selection
        if not preserve_claim_ids:
            complete_claim["id"] = deterministic_id(
                "claim",
                {
                    "subject": complete_claim["subject"],
                    "fact": complete_claim["fact"],
                    "claim": complete_claim["claim"],
                },
            )
        complete_claims.append(complete_claim)
    value = {
        "schema": CAPSULE_SCHEMA,
        "capsule_id": None,
        "task": {
            "question": "Can this task pass the release gate?",
            "scope": ["/repo/packages/ozone"],
            "required_checks": [
                {
                    "name": "unit",
                    "command": "python packages/ozone/tests/test_ozone.py",
                    "cwd": "/repo/packages/ozone",
                }
            ],
        },
        "workspace": {
            "fingerprint": workspace_fingerprint,
            "repair_topology_fingerprint": (
                topology_fingerprint
                if topology_fingerprint is not None
                else repair_topology_fingerprint({"nodes": [], "edges": []})
            ),
            "observed_at": NOW,
        },
        "claims": complete_claims,
        "conflicts": [] if conflicts is None else conflicts,
        "unknowns": [] if unknowns is None else unknowns,
        "omissions": [] if omissions is None else omissions,
        "required_checks": [
            {
                "name": "unit",
                "command": "python packages/ozone/tests/test_ozone.py",
                "cwd": "/repo/packages/ozone",
            }
        ],
        "budget": {"max_claims": 24},
    }
    value["capsule_id"] = deterministic_id(
        "capsule",
        {
            "task": value["task"]["question"],
            "filters": None,
            "workspace": value["workspace"]["fingerprint"],
        },
    )
    value["fingerprint"] = fingerprint(
        {
            key: item
            for key, item in value.items()
            if key not in {"capsule_id", "fingerprint"}
        }
    )
    return value


def _governed_receipt(capsule, *, outcome="passed", created_at=NOW):
    return create_integrity_receipt(
        capsule=capsule,
        runtime={"harness": "test", "actor": "agent:test"},
        checks=[
            {
                "name": required_check["name"],
                "command": required_check["command"],
                "outcome": outcome,
            }
            for required_check in capsule["required_checks"]
        ],
        now=lambda: created_at,
    )


def _governed_request(*, capsule=None, receipt=True, gate=None, graph=False, **overrides):
    governed_capsule = _governed_capsule() if capsule is None else capsule
    value = {
        "schema": ozone.REQUEST_SCHEMA,
        "workspace": {"fingerprint": governed_capsule["workspace"]["fingerprint"]},
        "verified_at": NOW,
        "capsule": governed_capsule,
        "gate": {
            "name": "release",
            "required_checks": [
                required_check["name"]
                for required_check in governed_capsule["required_checks"]
            ],
            "require_claims_verified": True,
        }
        if gate is None
        else gate,
    }
    if receipt is not False:
        value["receipt"] = (
            _governed_receipt(governed_capsule) if receipt is True else receipt
        )
    if graph is not False:
        value["graph"] = (
            {
                "schema": "vivary.workspace-graph/v0",
                "workspace_fingerprint": governed_capsule["workspace"]["fingerprint"],
                "observed_at": NOW,
                "nodes": [],
                "edges": [],
                "conflicts": [],
                "unknowns": [],
            }
            if graph is True
            else graph
        )
        if graph is True:
            _bind_request_graph_workspace(value)
    value.update(overrides)
    return value

def _bind_request_graph_workspace(request):
    graph = request["graph"]
    capsule = request["capsule"]
    graph["observed_at"] = capsule["workspace"]["observed_at"]
    graph["workspace_fingerprint"] = workspace_fingerprint_from_graph(graph)
    request["workspace"]["fingerprint"] = graph["workspace_fingerprint"]
    capsule["workspace"]["fingerprint"] = graph["workspace_fingerprint"]
    capsule["capsule_id"] = deterministic_id(
        "capsule",
        {
            "task": capsule["task"]["question"],
            "filters": capsule["task"].get("filters"),
            "workspace": capsule["workspace"]["fingerprint"],
        },
    )
    capsule["fingerprint"] = fingerprint(
        {
            key: item
            for key, item in capsule.items()
            if key not in {"capsule_id", "fingerprint"}
        }
    )
    if isinstance(request.get("receipt"), dict):
        request["receipt"] = _governed_receipt(capsule)
    return request



def _checkout_graph_nodes(edges):
    nodes = {}
    for edge in edges:
        if not isinstance(edge, dict) or edge.get("kind") != "checkout_of":
            continue
        nodes[edge["from"]] = {
            "id": edge["from"],
            "kind": "checkout",
            "path": f"/repo/{edge['from']}",
            "facts": {
                "is_git_repository": {
                    "status": "known",
                    "value": True,
                    "evidence": [],
                },
                "head_revision": {
                    "status": "known",
                    "value": "a" * 40,
                    "evidence": [],
                },
                "head_ref": {
                    "status": "known",
                    "value": {"kind": "branch", "name": "main"},
                    "evidence": [],
                },
                "is_dirty": {
                    "status": "known",
                    "value": False,
                    "evidence": [],
                },
                "dirty_entries": {
                    "status": "known",
                    "value": [],
                    "evidence": [],
                },
                "remotes": {
                    "status": "known",
                    "value": [],
                    "evidence": [],
                },
                "last_fetch": {
                    "status": "known",
                    "value": NOW,
                    "evidence": [],
                },
            },
        }
        nodes[edge["to"]] = {"id": edge["to"], "kind": "repository"}
    return list(nodes.values())


def _projected_graph(checkouts, *, allowlist=None, observed_at=NOW):
    return project_workspace_graph(
        {
            "schema": "vivary.workspace-observation/v0",
            "root": "/repo",
            "observed_at": observed_at,
            "allowlist": [] if allowlist is None else allowlist,
            "checkouts": checkouts,
            "refusals": [],
        }
    )


def _projected_remote_graph(
    remote_urls,
    heads,
    common_dirs=None,
    paths=None,
    fact_overrides=None,
):
    checkouts = []
    for index, (remote_url, head) in enumerate(zip(remote_urls, heads)):
        path = paths[index] if paths is not None else f"/repo/checkout-{index}"
        facts = {
            "is_git_repository": {
                "status": "known",
                "value": True,
                "evidence": [],
            },
            "git_common_dir": {
                "status": "known",
                "value": (
                    common_dirs[index]
                    if common_dirs is not None
                    else f"{path}/.git"
                ),
                "evidence": [],
            },
            "head_revision": {
                "status": "known",
                "value": head,
                "evidence": [],
            },
            "content_privacy_fingerprint": {
                "status": "known",
                "value": fingerprint(
                    {
                        "revision": head,
                        "ignored_tracked_paths": [],
                    }
                ),
                "evidence": [],
            },
            "head_ref": {
                "status": "known",
                "value": {"kind": "branch", "name": "main"},
                "evidence": [],
            },
            "is_dirty": {
                "status": "known",
                "value": False,
                "evidence": [],
            },
            "dirty_entries": {
                "status": "known",
                "value": [],
                "evidence": [],
            },
            "remotes": {
                "status": "known",
                "value": (
                    []
                    if remote_url is None
                    else [{"name": "origin", "fetch_url": remote_url}]
                ),
                "evidence": [],
            },
        }
        if fact_overrides is not None:
            facts.update(fact_overrides[index])
        checkouts.append({"path": path, "facts": facts})
    return _projected_graph(checkouts)


def _projected_local_groups(
    group_sizes,
    *,
    divergent=False,
    include_claim_facts=False,
):
    checkouts = []
    for group_index, group_size in enumerate(group_sizes):
        for checkout_index in range(group_size):
            facts = {
                "is_git_repository": {
                    "status": "known",
                    "value": True,
                    "evidence": [],
                },
                "git_common_dir": {
                    "status": "known",
                    "value": f"/repo/group-{group_index}/.git",
                    "evidence": [],
                },
            }
            if divergent or include_claim_facts:
                head = (
                    f"{group_index:038d}{checkout_index:02d}"
                    if divergent
                    else "a" * 40
                )
                facts["head_revision"] = {
                    "status": "known",
                    "value": head,
                    "evidence": [],
                }
            if include_claim_facts:
                facts["is_dirty"] = {
                    "status": "known",
                    "value": False,
                    "evidence": [],
                }
            checkouts.append(
                {
                    "path": (
                        f"/repo/group-{group_index}/"
                        f"checkout-{checkout_index}"
                    ),
                    "facts": facts,
                }
            )
    return _projected_graph(checkouts)


def _replace_graph_node_id(graph, kind):
    forged = json.loads(json.dumps(graph))
    node = next(node for node in forged["nodes"] if node["kind"] == kind)
    old_id = node["id"]
    new_id = f"{kind}:forged"
    node["id"] = new_id
    for related in forged["nodes"]:
        if related.get("checkout") == old_id:
            related["checkout"] = new_id
    for unknown in forged["unknowns"]:
        if unknown.get("checkout") == old_id:
            unknown["checkout"] = new_id
    for edge in forged["edges"]:
        if edge.get("from") == old_id:
            edge["from"] = new_id
        if edge.get("to") == old_id:
            edge["to"] = new_id
        edge["id"] = deterministic_id(
            "edge",
            {
                "kind": edge["kind"],
                "from": edge["from"],
                "to": edge["to"],
            },
        )
    for conflict in forged["conflicts"]:
        if conflict.get("repository") == old_id:
            conflict["repository"] = new_id
        for side in conflict.get("sides", []):
            if side.get("checkout") == old_id:
                side["checkout"] = new_id
        conflict["id"] = deterministic_id(
            "conflict",
            {
                "repository": conflict["repository"],
                "sides": [side["checkout"] for side in conflict["sides"]],
            },
        )
    return forged


def test_governed_verification_returns_raw_bound_core_verdicts():
    graph = _projected_remote_graph([None], ["a" * 40])
    capsule = compile_task_capsule(
        task={
            "question": "Can this task pass the release gate?",
            "scope": ["/repo"],
            "required_checks": [
                {
                    "name": "unit",
                    "command": "python packages/ozone/tests/test_ozone.py",
                    "cwd": "/repo/checkout-0",
                }
            ],
        },
        graph=graph,
    )
    result = ozone.verify_governed(
        _governed_request(capsule=capsule, graph=graph)
    )




    assert result["schema"] == ozone.VERIFICATION_SCHEMA
    assert result["outcome"] == "sufficient"
    assert result["reason_codes"] == []
    assert result["receipt_verdict"]["schema"] == "vivary.receipt-verdict/v0"
    assert result["receipt_verdict"]["outcome"] == "verified"
    assert result["gate_verdict"]["schema"] == "vivary.gate-verdict/v0"
    assert result["gate_verdict"]["outcome"] == "sufficient"
    assert result["repair_proposal"]["schema"] == "vivary.context-repair-proposal/v0"
    assert result["repair_proposal"]["writes_performed"] == 0


def test_governed_verification_allows_graph_backed_enclosing_checkout_cwd():
    graph = _projected_remote_graph(
        [None],
        ["a" * 40],
        paths=["/repo"],
    )
    capsule = compile_task_capsule(
        task={
            "question": "Can this task pass the release gate?",
            "scope": ["/repo/pkg"],
            "required_checks": [
                {
                    "name": "package-unit",
                    "command": "python -m pytest",
                    "cwd": "/repo",
                }
            ],
        },
        graph=graph,
    )

    result = ozone.verify_governed(
        _governed_request(capsule=capsule, graph=graph)
    )

    assert result["schema"] == ozone.VERIFICATION_SCHEMA
    assert result["outcome"] == "sufficient"
    assert result["reason_codes"] == []




def test_governed_verification_refuses_unknown_artifact_fields():
    unknown_capsule = _governed_capsule()
    unknown_capsule["unexpected"] = "accepted"
    unknown_capsule["fingerprint"] = fingerprint(
        {
            key: item
            for key, item in unknown_capsule.items()
            if key not in {"capsule_id", "fingerprint"}
        }
    )
    capsule_result = ozone.verify_governed(
        _governed_request(
            capsule=unknown_capsule,
            receipt=_governed_receipt(unknown_capsule),
        )
    )

    receipt_capsule = _governed_capsule()
    unknown_receipt = _governed_receipt(receipt_capsule)
    unknown_receipt["unexpected"] = "accepted"
    unknown_receipt["fingerprint"] = fingerprint(
        {
            key: item
            for key, item in unknown_receipt.items()
            if key not in {"receipt_id", "fingerprint"}
        }
    )
    receipt_result = ozone.verify_governed(
        _governed_request(capsule=receipt_capsule, receipt=unknown_receipt)
    )

    assert capsule_result["schema"] == ozone.REFUSAL_SCHEMA
    assert capsule_result["reason_codes"] == [
        "unknown_capsule_field:unexpected"
    ]
    assert receipt_result["schema"] == ozone.REFUSAL_SCHEMA
    assert receipt_result["reason_codes"] == [
        "unknown_receipt_field:unexpected"
    ]


def test_governed_verdict_is_consumed_unchanged_by_strato():
    governed = _governed_request()
    ozone_result = ozone.verify_governed(governed)
    strato_result = strato.decide_governed(
        {
            "schema": strato.REQUEST_SCHEMA,
            "policy_version": strato.POLICY_VERSION,
            "actor": {"kind": "agent", "id": "agent:test"},
            "authority_class": "contributor",
            "workspace": governed["workspace"],
            "scope": {"project": "vivary", "paths": ["/repo/packages/ozone"]},
            "requested_at": NOW,
            "decision_at": NOW,
            "capsule": governed["capsule"],
            "receipt": governed["receipt"],
            "verdict": ozone_result["gate_verdict"],
            "state": {"turns_used": 0, "actions_used": 0},
            "limits": {"max_turns": 3, "max_actions": 3},
        }
    )

    assert strato_result["decision"] == "stop"
    assert strato_result["reason_codes"] == ["all_checks_clear"]
    assert "verdict_integrity_mismatch" not in strato_result["gate"]["reason_codes"]


def test_governed_verification_refuses_receipt_claim_ids_outside_capsule():
    governed_capsule = _governed_capsule(
        claims=[
            {"id": "claim:first", "subject": "checkout:a", "claim": "first"},
            {"id": "claim:second", "subject": "checkout:a", "claim": "second"},
        ]
    )
    governed_receipt = _governed_receipt(governed_capsule)
    governed_receipt["claims_verified"] = ["claim:unrelated-a", "claim:unrelated-b"]
    governed_receipt["fingerprint"] = fingerprint(
        {
            key: item
            for key, item in governed_receipt.items()
            if key not in {"receipt_id", "fingerprint"}
        }
    )

    result = ozone.verify_governed(
        _governed_request(capsule=governed_capsule, receipt=governed_receipt)
    )

    assert result["schema"] == ozone.REFUSAL_SCHEMA
    assert result["reason_codes"] == ["invalid_receipt"]


def test_governed_verification_refuses_duplicate_claim_ids():
    governed_capsule = _governed_capsule(
        claims=[
            {"subject": "checkout:a", "claim": "first"},
            {"subject": "checkout:a", "claim": "first"},
        ]
    )
    governed_receipt = _governed_receipt(governed_capsule)
    duplicate_id = governed_capsule["claims"][0]["id"]
    governed_receipt["claims_verified"] = [duplicate_id]
    governed_receipt["fingerprint"] = fingerprint(
        {
            key: item
            for key, item in governed_receipt.items()
            if key not in {"receipt_id", "fingerprint"}
        }
    )

    result = ozone.verify_governed(
        _governed_request(capsule=governed_capsule, receipt=governed_receipt)
    )

    assert result["schema"] == ozone.REFUSAL_SCHEMA
    assert result["reason_codes"] == [
        "invalid_repair_capsule",
        "duplicate_claim_id",
    ]
    over_budget_capsule = _governed_capsule(
        claims=[{"id": "claim:one", "subject": "checkout:a", "claim": "one"}]
    )
    over_budget_capsule["budget"] = {"max_claims": 0}
    over_budget_capsule["fingerprint"] = fingerprint(
        {
            key: item
            for key, item in over_budget_capsule.items()
            if key not in {"capsule_id", "fingerprint"}
        }
    )
    over_budget = ozone.verify_governed(
        _governed_request(capsule=over_budget_capsule)
    )

    assert over_budget["schema"] == ozone.REFUSAL_SCHEMA
    assert over_budget["reason_codes"] == ["capsule_claim_budget_exceeded"]


def test_governed_verification_refuses_duplicate_repair_claim_semantics():
    graph = _projected_remote_graph(
        ["https://example.test/shared.git"] * 2,
        ["a" * 40, "a" * 40],
    )
    checkout_ids = [
        edge["from"] for edge in graph["edges"]
        if edge["kind"] == "checkout_of"
    ]
    repeated_claim = {
        "fact": "head_revision",
        "subject": checkout_ids[0],
        "claim": f"HEAD revision is {'a' * 40}",
        "selection": {"tier": "allowlisted"},
        "evidence": [],
    }
    capsule = _governed_capsule(
        claims=[
            {"id": "claim:duplicate-semantics:a", **repeated_claim},
            {"id": "claim:duplicate-semantics:b", **repeated_claim},
            {
                "id": "claim:other-checkout",
                **repeated_claim,
                "subject": checkout_ids[1],
            },
        ],
        workspace_fingerprint=graph["workspace_fingerprint"],
        topology_fingerprint=repair_topology_fingerprint(graph),
    )

    result = ozone.verify_governed(
        _governed_request(capsule=capsule, receipt=False, graph=graph)
    )

    assert result["schema"] == ozone.REFUSAL_SCHEMA
    assert result["reason_codes"] == [
        "invalid_repair_capsule",
        "duplicate_claim_id",
    ]


def test_governed_verification_fails_closed_for_missing_and_tampered_receipts():
    missing = ozone.verify_governed(_governed_request(receipt=False))
    tampered_request = _governed_request()
    tampered_request["receipt"]["checks"][0]["outcome"] = "failed"
    tampered = ozone.verify_governed(tampered_request)

    assert missing["outcome"] == "insufficient"
    assert missing["receipt_verdict"]["outcome"] == "refused"
    assert "receipt_missing_for_required_checks" in missing["gate_verdict"]["reason_codes"]
    assert tampered["outcome"] == "insufficient"
    assert tampered["receipt_verdict"]["outcome"] == "insufficient"
    assert "fingerprint_mismatch" in tampered["receipt_verdict"]["reason_codes"]


def test_governed_verification_refuses_malformed_or_mismatched_receipt_fields():
    governed_capsule = _governed_capsule(
        claims=[{"id": "claim:first", "subject": "checkout:a", "claim": "first"}]
    )
    malformed_receipts = []
    for field, value in (
        ("claims_unverified", "not-a-list"),
        ("checks", [{"name": "unit", "outcome": []}]),
        (
            "checks",
            [{"name": "unit", "command": "false", "outcome": "passed"}],
        ),
        ("checks", [{"name": "security", "outcome": "passed"}]),
    ):
        governed_receipt = _governed_receipt(governed_capsule)
        governed_receipt[field] = value
        governed_receipt["fingerprint"] = fingerprint(
            {
                key: item
                for key, item in governed_receipt.items()
                if key not in {"receipt_id", "fingerprint"}
            }
        )
        malformed_receipts.append(governed_receipt)
    for field, value in (
        ("schema", 123),
        ("receipt_id", 123),
        ("fingerprint", 123),
    ):
        governed_receipt = _governed_receipt(governed_capsule)
        governed_receipt[field] = value
        if field != "fingerprint":
            governed_receipt["fingerprint"] = fingerprint(
                {
                    key: item
                    for key, item in governed_receipt.items()
                    if key not in {"receipt_id", "fingerprint"}
                }
            )
        malformed_receipts.append(governed_receipt)

    for governed_receipt in malformed_receipts:
        result = ozone.verify_governed(
            _governed_request(capsule=governed_capsule, receipt=governed_receipt)
        )
        assert result["schema"] == ozone.REFUSAL_SCHEMA
        assert result["reason_codes"] == ["invalid_receipt"]

    non_mapping = ozone.verify_governed(
        _governed_request(capsule=governed_capsule, receipt=[])
    )
    assert non_mapping["schema"] == ozone.REFUSAL_SCHEMA
    assert non_mapping["reason_codes"] == ["invalid_receipt"]


def test_governed_verification_refuses_verified_claims_after_failed_checks():
    governed_capsule = _governed_capsule(
        claims=[{"id": "claim:failed-check"}]
    )
    governed_receipt = _governed_receipt(governed_capsule, outcome="failed")
    governed_receipt["claims_verified"] = list(
        governed_receipt["claims_in_scope"]
    )
    governed_receipt["claims_unverified"] = []
    governed_receipt["fingerprint"] = fingerprint(
        {
            key: item
            for key, item in governed_receipt.items()
            if key not in {"receipt_id", "fingerprint"}
        }
    )

    result = ozone.verify_governed(
        _governed_request(
            capsule=governed_capsule,
            receipt=governed_receipt,
            gate={"name": "release", "require_claims_verified": True},
        )
    )

    assert result["schema"] == ozone.REFUSAL_SCHEMA
    assert result["reason_codes"] == ["invalid_receipt"]


def test_governed_verification_refuses_incomplete_capsule_records():
    for field, malformed_records in (
        ("claims", [{"id": "claim:empty"}]),
        ("unknowns", [{}]),
        (
            "unknowns",
            [
                {
                    "kind": "content_snapshot_stale",
                    "subject": "checkout:a",
                    "subject_path": "/repo",
                    "reason": "stale",
                    "observed_revision": None,
                    "searched_revision": None,
                }
            ],
        ),
    ):
        governed_capsule = _governed_capsule()
        governed_capsule[field] = malformed_records
        governed_capsule["fingerprint"] = fingerprint(
            {
                key: item
                for key, item in governed_capsule.items()
                if key not in {"capsule_id", "fingerprint"}
            }
        )
        result = ozone.verify_governed(
            _governed_request(
                capsule=governed_capsule,
                receipt=_governed_receipt(governed_capsule),
            )
        )

        assert result["schema"] == ozone.REFUSAL_SCHEMA
        assert result["reason_codes"] == ["invalid_capsule"]



def test_governed_verification_refuses_non_compiler_claim_status():
    capsule = _governed_capsule(claims=[{}])
    capsule["claims"][0]["status"] = "bogus"
    capsule["fingerprint"] = fingerprint(
        {
            key: value
            for key, value in capsule.items()
            if key not in {"capsule_id", "fingerprint"}
        }
    )

    result = ozone.verify_governed(
        _governed_request(capsule=capsule, receipt=_governed_receipt(capsule))
    )

    assert result["schema"] == ozone.REFUSAL_SCHEMA
    assert result["reason_codes"] == ["invalid_capsule"]
    assert result["receipt_verdict"] is None
    assert result["gate_verdict"] is None
    assert result["repair_proposal"] is None

def test_governed_verification_refuses_incomplete_capsule_conflicts():
    governed_capsule = _governed_capsule()
    governed_capsule["conflicts"] = [
        {"id": "conflict:fake", "decision": "review_required"}
    ]
    governed_capsule["fingerprint"] = fingerprint(
        {
            key: item
            for key, item in governed_capsule.items()
            if key not in {"capsule_id", "fingerprint"}
        }
    )
    request = _governed_request(
        capsule=governed_capsule,
        receipt=_governed_receipt(governed_capsule),
    )
    request["gate"]["max_unresolved_conflicts"] = 1

    result = ozone.verify_governed(request)

    assert result["schema"] == ozone.REFUSAL_SCHEMA
    assert result["reason_codes"] == ["invalid_capsule"]



def test_governed_verification_refuses_incomplete_capsule_conflict_sides():
    graph = _projected_remote_graph(
        ["https://example.test/shared.git"] * 2,
        ["a" * 40, "b" * 40],
    )
    capsule = compile_task_capsule(
        task={
            "question": "Review the shared repository.",
            "scope": ["/repo"],
            "required_checks": [
                {
                    "name": "unit",
                    "command": "python packages/ozone/tests/test_ozone.py",
                    "cwd": "/repo/checkout-0",
                }
            ],
        },
        graph=graph,
    )
    assert capsule["conflicts"]

    for missing_field in (
        "head_revision",
        "head_ref",
        "last_fetch",
        "evidence",
    ):
        malformed_capsule = json.loads(json.dumps(capsule))
        del malformed_capsule["conflicts"][0]["sides"][0][missing_field]
        malformed_capsule["fingerprint"] = fingerprint(
            {
                key: item
                for key, item in malformed_capsule.items()
                if key not in {"capsule_id", "fingerprint"}
            }
        )

        result = ozone.verify_governed(
            _governed_request(
                capsule=malformed_capsule,
                receipt=_governed_receipt(malformed_capsule),
            )
        )

        assert result["schema"] == ozone.REFUSAL_SCHEMA
        assert result["reason_codes"] == ["invalid_capsule"]

    duplicate_side_capsule = json.loads(json.dumps(capsule))
    duplicate_side_capsule["conflicts"][0]["sides"][1] = json.loads(
        json.dumps(duplicate_side_capsule["conflicts"][0]["sides"][0])
    )
    duplicate_side_capsule["fingerprint"] = fingerprint(
        {
            key: item
            for key, item in duplicate_side_capsule.items()
            if key not in {"capsule_id", "fingerprint"}
        }
    )
    duplicate_side = ozone.verify_governed(
        _governed_request(
            capsule=duplicate_side_capsule,
            receipt=_governed_receipt(duplicate_side_capsule),
        )
    )
    assert duplicate_side["schema"] == ozone.REFUSAL_SCHEMA
    assert duplicate_side["reason_codes"] == ["invalid_capsule"]


def test_governed_verification_refuses_malformed_task_without_repair_graph():
    for malformed_task in (
        {"filters": None},
        {"filters": "not-a-list"},
        {"question": None},
        {"question": []},
        {"question": ""},
        {"question": "   "},
    ):
        capsule = _governed_capsule()
        capsule["task"].update(malformed_task)
        capsule["capsule_id"] = deterministic_id(
            "capsule",
            {
                "task": capsule["task"].get("question"),
                "filters": capsule["task"].get("filters"),
                "workspace": capsule["workspace"]["fingerprint"],
            },
        )
        capsule["fingerprint"] = fingerprint(
            {
                key: item
                for key, item in capsule.items()
                if key not in {"capsule_id", "fingerprint"}
            }
        )

        result = ozone.verify_governed(
            _governed_request(
                capsule=capsule,
                receipt=_governed_receipt(capsule),
            )
        )

        assert result["schema"] == ozone.REFUSAL_SCHEMA
        assert result["reason_codes"] == ["invalid_capsule"]


def test_governed_verification_binds_graphless_declared_checks():
    capsule = _governed_capsule()
    forged = json.loads(json.dumps(capsule))
    forged["required_checks"] = [
        {
            "name": "unit",
            "command": "true",
            "cwd": "/repo/checkout-0",
        }
    ]
    forged["fingerprint"] = fingerprint(
        {
            key: item
            for key, item in forged.items()
            if key not in {"capsule_id", "fingerprint"}
        }
    )

    result = ozone.verify_governed(
        _governed_request(capsule=forged, receipt=False)
    )
    assert result["schema"] == ozone.REFUSAL_SCHEMA
    assert result["reason_codes"] == ["invalid_capsule"]


def test_governed_verification_refuses_graphless_declared_check_cwds_outside_scope():
    for cwd in ("/repo", "/unrelated"):
        capsule = _governed_capsule()
        for checks in (
            capsule["task"]["required_checks"],
            capsule["required_checks"],
        ):
            checks[0]["cwd"] = cwd
        capsule["fingerprint"] = fingerprint(
            {
                key: item
                for key, item in capsule.items()
                if key not in {"capsule_id", "fingerprint"}
            }
        )

        result = ozone.verify_governed(
            _governed_request(capsule=capsule, receipt=False)
        )

        assert result["schema"] == ozone.REFUSAL_SCHEMA
        assert result["reason_codes"] == ["invalid_capsule"]


def test_governed_verification_refuses_graphless_checks_not_declared_by_task():
    capsule = _governed_capsule()
    capsule["required_checks"].append(
        {
            "name": "integration",
            "command": "python -m pytest packages/ozone/tests/test_ozone.py",
            "cwd": "/repo/checkout-0",
        }
    )
    capsule["fingerprint"] = fingerprint(
        {
            key: item
            for key, item in capsule.items()
            if key not in {"capsule_id", "fingerprint"}
        }
    )

    result = ozone.verify_governed(
        _governed_request(
            capsule=capsule,
            receipt=_governed_receipt(capsule),
        )
    )

    assert result["schema"] == ozone.REFUSAL_SCHEMA
    assert result["reason_codes"] == ["graph_required_for_effective_checks"]


def test_governed_verification_refuses_graphless_checks_without_task_declaration():
    capsule = _governed_capsule()
    del capsule["task"]["required_checks"]
    capsule["fingerprint"] = fingerprint(
        {
            key: item
            for key, item in capsule.items()
            if key not in {"capsule_id", "fingerprint"}
        }
    )

    result = ozone.verify_governed(
        _governed_request(
            capsule=capsule,
            receipt=_governed_receipt(capsule),
        )
    )

    assert result["schema"] == ozone.REFUSAL_SCHEMA
    assert result["reason_codes"] == ["graph_required_for_effective_checks"]


def test_governed_verification_requires_graph_for_derived_checks():
    graph = _projected_remote_graph(
        ["https://example.test/project.git"],
        ["a" * 40],
        fact_overrides=[
            {
                "workspace_markers": {
                    "status": "known",
                    "value": ["tropo.toml"],
                    "evidence": [],
                }
            }
        ],
    )
    capsule = compile_task_capsule(
        task={"question": "Review the project.", "scope": ["/repo"]},
        graph=graph,
    )
    assert capsule["required_checks"]
    assert "required_checks" not in capsule["task"]

    graphless = ozone.verify_governed(
        _governed_request(
            capsule=capsule,
            receipt=_governed_receipt(capsule),
        )
    )
    graph_backed = ozone.verify_governed(
        _governed_request(
            capsule=capsule,
            receipt=_governed_receipt(capsule),
            graph=graph,
        )
    )

    assert graphless["schema"] == ozone.REFUSAL_SCHEMA
    assert graphless["reason_codes"] == [
        "graph_required_for_effective_checks"
    ]
    assert graph_backed["schema"] == ozone.VERIFICATION_SCHEMA



def test_governed_verification_binds_gate_driving_facts():
    for fact_name, value, forged_value in (
        ("workspace_markers", ["tropo.toml"], []),
        ("npm_test_script", "vitest run", "true"),
    ):
        graph = _projected_remote_graph(
            ["https://example.test/project.git"],
            ["a" * 40],
            fact_overrides=[
                {
                    fact_name: {
                        "status": "known",
                        "value": value,
                        "evidence": [],
                    }
                }
            ],
        )
        capsule = compile_task_capsule(
            task={"question": "Review the project.", "scope": ["/repo"]},
            graph=graph,
        )
        forged = json.loads(json.dumps(graph))
        checkout = next(
            node
            for node in forged["nodes"]
            if node.get("kind") == "checkout"
        )
        checkout["facts"][fact_name] = {
            "status": "known",
            "value": forged_value,
            "evidence": [],
        }

        result = ozone.verify_governed(
            _governed_request(
                capsule=capsule,
                receipt=False,
                graph=forged,
            )
        )
        assert result["schema"] == ozone.REFUSAL_SCHEMA
        assert result["reason_codes"] == ["invalid_repair_graph"]


def test_governed_verification_rejects_invalid_git_fact_status():
    graph = _projected_remote_graph(
        ["https://example.test/project.git"],
        ["a" * 40],
    )
    capsule = compile_task_capsule(
        task={"question": "Review the project.", "scope": ["/repo"]},
        graph=graph,
    )
    forged = json.loads(json.dumps(graph))
    checkout = next(
        node for node in forged["nodes"] if node.get("kind") == "checkout"
    )
    checkout["facts"]["is_git_repository"]["status"] = "bogus"

    result = ozone.verify_governed(
        _governed_request(
            capsule=capsule,
            receipt=False,
            graph=forged,
        )
    )
    assert result["schema"] == ozone.REFUSAL_SCHEMA
    assert result["reason_codes"] == ["invalid_repair_graph"]


def test_governed_verification_preserves_selection_omissions():
    graph = _projected_remote_graph(
        ["https://example.test/project.git"],
        ["a" * 40],
    )
    capsule = compile_task_capsule(
        task={"question": "Review the project.", "scope": ["/repo"]},
        graph=graph,
        budget={"max_claims": 0},
    )
    assert any(
        omission["kind"] == "claims_over_budget"
        for omission in capsule["omissions"]
    )
    stripped = json.loads(json.dumps(capsule))
    stripped["omissions"] = [
        omission
        for omission in stripped["omissions"]
        if omission["kind"] != "claims_over_budget"
    ]
    stripped["fingerprint"] = fingerprint(
        {
            key: item
            for key, item in stripped.items()
            if key not in {"capsule_id", "fingerprint"}
        }
    )

    result = ozone.verify_governed(
        _governed_request(
            capsule=stripped,
            receipt=False,
            graph=graph,
        )
    )
    assert result["schema"] == ozone.REFUSAL_SCHEMA
    assert result["reason_codes"] == ["repair_graph_context_mismatch"]


def test_governed_verification_preserves_observation_refusals():
    graph = project_workspace_graph(
        {
            "observed_at": NOW,
            "allowlist": ["/repo"],
            "checkouts": [],
            "refusals": [
                {
                    "path": "/outside",
                    "status": "refused",
                    "reason": "outside_allowlist",
                }
            ],
        }
    )
    capsule = compile_task_capsule(
        task={"question": "Review the observed workspace."},
        graph=graph,
    )
    stripped = json.loads(json.dumps(capsule))
    stripped["omissions"] = [
        omission
        for omission in stripped["omissions"]
        if omission["kind"] != "refused_root"
    ]
    stripped["fingerprint"] = fingerprint(
        {
            key: item
            for key, item in stripped.items()
            if key not in {"capsule_id", "fingerprint"}
        }
    )

    result = ozone.verify_governed(
        _governed_request(
            capsule=stripped,
            receipt=False,
            graph=graph,
        )
    )
    assert result["schema"] == ozone.REFUSAL_SCHEMA
    assert result["reason_codes"] == ["repair_graph_context_mismatch"]




def test_governed_verification_validates_budget_omissions_without_repair_graph():
    capsule = _governed_capsule(
        omissions=[
            {
                "kind": "claims_over_budget",
                "reason": "claim budget reached",
            }
        ]
    )

    result = ozone.verify_governed(
        _governed_request(
            capsule=capsule,
            receipt=_governed_receipt(capsule),
        )
    )

    assert result["schema"] == ozone.REFUSAL_SCHEMA
    assert result["reason_codes"] == ["invalid_capsule"]


def test_governed_verification_requires_exact_omission_truncation_marker_without_graph():
    complete_omitted = [
        {
            "subject_path": f"/repo/omitted/{index}",
            "fact": f"omitted:{index}",
            "tier": "allowlisted",
        }
        for index in range(OMITTED_LIST_CAP)
    ]
    malformed_omissions = (
        {
            "kind": "claims_over_budget",
            "reason": "claim budget reached",
            "omitted_count": OMITTED_LIST_CAP + 1,
            "omitted": complete_omitted,
        },
        {
            "kind": "claims_over_budget",
            "reason": "claim budget reached",
            "omitted_count": 1,
            "omitted": complete_omitted[:1],
            "truncated": True,
        },
    )

    for omission in malformed_omissions:
        capsule = _governed_capsule(omissions=[omission])
        result = ozone.verify_governed(
            _governed_request(
                capsule=capsule,
                receipt=_governed_receipt(capsule),
            )
        )

        assert result["schema"] == ozone.REFUSAL_SCHEMA
        assert result["reason_codes"] == ["invalid_capsule"]


def test_governed_verification_requires_graph_for_compiler_selection_omissions():
    graph = _projected_remote_graph(
        ["https://example.test/shared.git"] * 2,
        ["a" * 40, "a" * 40],
    )
    capsule = compile_task_capsule(
        task={
            "question": "Review the shared repository.",
            "scope": ["/repo"],
            "filters": [{"field": "fact", "includes": "is_"}],
            "required_checks": [
                {
                    "name": "unit",
                    "command": "python packages/ozone/tests/test_ozone.py",
                    "cwd": "/repo/checkout-0",
                }
            ],
        },
        graph=graph,
        budget={"max_claims": 1},
    )
    assert any(
        omission["kind"] == "claims_over_budget"
        for omission in capsule["omissions"]
    )

    result = ozone.verify_governed(
        _governed_request(
            capsule=capsule,
            receipt=_governed_receipt(capsule),
        )
    )

    assert result["schema"] == ozone.REFUSAL_SCHEMA
    assert result["reason_codes"] == ["graph_required_for_compiler_omissions"]

    accepted = ozone.verify_governed(
        _governed_request(
            capsule=capsule,
            receipt=_governed_receipt(capsule),
            graph=graph,
        )
    )
    assert accepted["schema"] == ozone.VERIFICATION_SCHEMA


def test_governed_verification_refuses_graphless_stripped_content_omissions():
    graph = _projected_remote_graph(
        ["https://example.test/shared.git"],
        ["a" * 40],
    )
    checkout = next(node for node in graph["nodes"] if node["kind"] == "checkout")
    content = _content_artifact(
        terms=["needle"],
        checkouts=[
            _observed_content_checkout(
                checkout["path"],
                head_revision="a" * 40,
                matches=[
                    {
                        "path": "notes.md",
                        "line": 1,
                        "term": "needle",
                        "excerpt": "needle marker",
                        "evidence": {"command": "git grep needle"},
                    }
                ],
            )
        ],
    )
    capsule = compile_task_capsule(
        task={
            "question": "Find needle.",
            "scope": ["/repo"],
            "filters": [{"field": "fact", "equals": "head_revision"}],
        },
        graph=graph,
        content=content,
    )
    assert any(
        omission["kind"] == "filtered_out"
        for omission in capsule["omissions"]
    )

    downgraded = json.loads(json.dumps(capsule))
    del downgraded["workspace"]["content_fingerprint"]
    downgraded["unknowns"] = [
        record
        for record in downgraded["unknowns"]
        if not str(record.get("kind", "")).startswith("content_")
    ]
    downgraded["omissions"] = [
        record
        for record in downgraded["omissions"]
        if not record["kind"].startswith("content_")
    ]
    downgraded["fingerprint"] = fingerprint(
        {
            key: value
            for key, value in downgraded.items()
            if key not in {"capsule_id", "fingerprint"}
        }
    )

    result = ozone.verify_governed(
        _governed_request(capsule=downgraded, receipt=False)
    )
    assert result["schema"] == ozone.REFUSAL_SCHEMA
    assert result["reason_codes"] == ["graph_required_for_compiler_omissions"]


def test_governed_verification_refuses_blank_filter_values():
    graph = _projected_remote_graph(
        ["https://example.test/shared.git"] * 2,
        ["a" * 40, "a" * 40],
    )
    capsule = compile_task_capsule(
        task={
            "question": "Review the shared repository.",
            "scope": ["/repo"],
            "filters": [{"field": "fact", "includes": "is_"}],
        },
        graph=graph,
        budget={"max_claims": 1},
    )
    capsule["task"]["filters"] = [{"field": "fact", "includes": ""}]
    capsule["fingerprint"] = fingerprint(
        {
            key: item
            for key, item in capsule.items()
            if key not in {"capsule_id", "fingerprint"}
        }
    )

    result = ozone.verify_governed(
        _governed_request(
            capsule=capsule,
            receipt=_governed_receipt(capsule),
        )
    )

    assert result["schema"] == ozone.REFUSAL_SCHEMA
    assert result["reason_codes"] == ["invalid_capsule"]


def test_governed_verification_refuses_claims_that_violate_declared_filters():
    graph = _projected_remote_graph(
        ["https://example.test/shared.git"] * 2,
        ["a" * 40, "a" * 40],
    )
    compiled = compile_task_capsule(
        task={
            "question": "Review the shared repository.",
            "scope": ["/repo"],
            "filters": [{"field": "fact", "equals": "head_revision"}],
        },
        graph=graph,
        budget={"max_claims": 1},
    )

    for keep_match_record in (False, True):
        capsule = json.loads(json.dumps(compiled))
        capsule["claims"][0]["fact"] = "is_dirty"
        if not keep_match_record:
            capsule["claims"][0]["selection"].pop("matched_filters")
        capsule["fingerprint"] = fingerprint(
            {
                key: item
                for key, item in capsule.items()
                if key not in {"capsule_id", "fingerprint"}
            }
        )
        result = ozone.verify_governed(
            _governed_request(
                capsule=capsule,
                receipt=_governed_receipt(capsule),
            )
        )

        assert result["schema"] == ozone.REFUSAL_SCHEMA
        assert result["reason_codes"] == ["invalid_capsule"]

    profile_filter_cases = (
        (
            {"field": "label", "equals": "checkout-0"},
            {"field": "label", "equals": "other-checkout"},
        ),
        (
            {"field": "branch", "equals": "main"},
            {"field": "branch", "equals": "other-branch"},
        ),
        (
            {"field": "repository", "includes": "shared.git"},
            {"field": "repository", "includes": "other.git"},
        ),
    )
    for original_filter, forged_filter in profile_filter_cases:
        capsule = compile_task_capsule(
            task={
                "question": "Review the shared repository.",
                "scope": ["/repo"],
                "filters": [original_filter],
            },
            graph=graph,
            budget={"max_claims": 1},
        )
        capsule["task"]["filters"] = [forged_filter]
        operator = "equals" if "equals" in forged_filter else "includes"
        capsule["claims"][0]["selection"]["matched_filters"] = [
            {
                "field": forged_filter["field"],
                "operator": operator,
                "value": forged_filter[operator],
            }
        ]
        capsule["capsule_id"] = deterministic_id(
            "capsule",
            {
                "task": capsule["task"]["question"],
                "filters": capsule["task"]["filters"],
                "workspace": capsule["workspace"]["fingerprint"],
            },
        )
        capsule["fingerprint"] = fingerprint(
            {
                key: item
                for key, item in capsule.items()
                if key not in {"capsule_id", "fingerprint"}
            }
        )
        result = ozone.verify_governed(
            _governed_request(
                capsule=capsule,
                receipt=_governed_receipt(capsule),
                graph=graph,
            )
        )

        assert result["schema"] == ozone.REFUSAL_SCHEMA
        assert "repair_graph_context_mismatch" in result["reason_codes"]

    filtered_capsule = compile_task_capsule(
        task={
            "question": "Review the shared repository.",
            "scope": ["/repo"],
            "filters": [{"field": "label", "equals": "checkout-0"}],
        },
        graph=graph,
        budget={"max_claims": 1},
    )
    malformed_facts_graph = json.loads(json.dumps(graph))
    checkout_node = next(
        node
        for node in malformed_facts_graph["nodes"]
        if node["kind"] == "checkout"
    )
    checkout_node["facts"] = "not a facts mapping"
    malformed_facts = ozone.verify_governed(
        _governed_request(
            capsule=filtered_capsule,
            receipt=_governed_receipt(filtered_capsule),
            graph=malformed_facts_graph,
        )
    )
    assert malformed_facts["schema"] == ozone.REFUSAL_SCHEMA
    assert malformed_facts["reason_codes"] == ["invalid_repair_graph"]


def test_governed_verification_requires_canonical_graph_allowlist():
    graph = _projected_remote_graph(
        ["https://example.test/shared.git"] * 2,
        ["a" * 40, "a" * 40],
    )
    capsule = compile_task_capsule(
        task={
            "question": "Does the example checkout mirror upstream?",
            "scope": ["/repo"],
        },
        graph=graph,
        budget={"max_claims": 24},
    )
    del graph["allowlist"]

    result = ozone.verify_governed(
        _governed_request(
            capsule=capsule,
            receipt=_governed_receipt(capsule),
            graph=graph,
        )
    )

    assert result["schema"] == ozone.REFUSAL_SCHEMA
    assert result["reason_codes"] == ["invalid_repair_graph"]


def test_governed_verification_binds_claims_and_question_signals_to_graph():
    graph = _projected_remote_graph(
        ["https://example.test/shared.git"] * 2,
        ["a" * 40, "a" * 40],
        fact_overrides=[
            {
                "last_fetch": {
                    "status": "unknown",
                    "reason": "not_observed",
                    "evidence": [],
                }
            },
            {
                "is_dirty": {
                    "status": "known",
                    "value": True,
                    "evidence": [],
                }
            },
        ],
    )
    graph_unknown = next(
        unknown
        for unknown in graph["unknowns"]
        if unknown["fact"] == "last_fetch"
    )
    compiled = compile_task_capsule(
        task={
            "question": "Does the example checkout mirror upstream?",
            "scope": ["/repo"],
        },
        graph=graph,
        budget={"max_claims": 24},
    )
    accepted = ozone.verify_governed(
        _governed_request(
            capsule=compiled,
            receipt=_governed_receipt(compiled),
            graph=graph,
        )
    )
    assert accepted["schema"] == ozone.VERIFICATION_SCHEMA


    variants = []
    missing_subject = json.loads(json.dumps(compiled))
    missing_subject["claims"][0]["subject"] = "checkout:missing"
    missing_subject["claims"][0]["id"] = deterministic_id(
        "claim",
        {
            "subject": missing_subject["claims"][0]["subject"],
            "fact": missing_subject["claims"][0]["fact"],
            "claim": missing_subject["claims"][0]["claim"],
        },
    )
    variants.append(missing_subject)

    mismatched_path = json.loads(json.dumps(compiled))
    mismatched_path["claims"][0]["subject_path"] = "/repo/forged"
    variants.append(mismatched_path)

    forged_signal = json.loads(json.dumps(compiled))
    signal = next(
        signal
        for claim in forged_signal["claims"]
        for signal in claim["selection"]["signals"]
        if signal["signal"] == "question_term_match"
    )
    signal["term"] = "mirror"
    variants.append(forged_signal)

    forged_semantics = json.loads(json.dumps(compiled))
    dirty_claims = [
        claim
        for claim in forged_semantics["claims"]
        if claim["fact"] == "is_dirty"
    ]
    clean_claim = next(
        claim for claim in dirty_claims if claim["claim"] == "worktree is clean"
    )
    dirty_claim = next(
        claim
        for claim in dirty_claims
        if claim["claim"] == "worktree has uncommitted changes"
    )
    dirty_claim["claim"] = clean_claim["claim"]
    dirty_claim["id"] = deterministic_id(
        "claim",
        {
            "subject": dirty_claim["subject"],
            "fact": dirty_claim["fact"],
            "claim": dirty_claim["claim"],
        },
    )
    variants.append(forged_semantics)

    missing_unknown = json.loads(json.dumps(compiled))
    missing_unknown["unknowns"].remove(graph_unknown)
    variants.append(missing_unknown)
    missing_claims = json.loads(json.dumps(compiled))

    missing_claims["claims"] = []
    variants.append(missing_claims)

    for capsule in variants:
        capsule["fingerprint"] = fingerprint(
            {
                key: item
                for key, item in capsule.items()
                if key not in {"capsule_id", "fingerprint"}
            }
        )
        result = ozone.verify_governed(
            _governed_request(
                capsule=capsule,
                receipt=_governed_receipt(capsule),
                graph=graph,
            )
        )
        assert result["schema"] == ozone.REFUSAL_SCHEMA
        assert result["reason_codes"] == ["repair_graph_context_mismatch"]

    forged_id = json.loads(json.dumps(compiled))
    forged_id["claims"][0]["id"] = "claim:forged"
    forged_id["fingerprint"] = fingerprint(
        {
            key: item
            for key, item in forged_id.items()
            if key not in {"capsule_id", "fingerprint"}
        }
    )
    invalid_id = ozone.verify_governed(
        _governed_request(
            capsule=forged_id,
            receipt=_governed_receipt(forged_id),
            graph=graph,
        )
    )
    assert invalid_id["schema"] == ozone.REFUSAL_SCHEMA
    assert invalid_id["reason_codes"] == ["invalid_capsule"]

    missing_graph_unknown = json.loads(json.dumps(graph))
    missing_graph_unknown["unknowns"].remove(graph_unknown)
    forged_graph_unknown = json.loads(json.dumps(graph))
    forged_graph_unknown["unknowns"].append(
        {
            "checkout": graph_unknown["checkout"],
            "path": graph_unknown["path"],
            "fact": "forged_fact",
            "reason": "forged",
        }
    )
    ambiguous_identity_graph = json.loads(json.dumps(graph))
    repository_node = next(
        node
        for node in ambiguous_identity_graph["nodes"]
        if node["kind"] == "repository"
    )
    repository_node["identity_status"] = "ambiguous"

    for altered_graph in (
        missing_graph_unknown,
        forged_graph_unknown,
        ambiguous_identity_graph,
    ):
        invalid_graph = ozone.verify_governed(
            _governed_request(
                capsule=compiled,
                receipt=_governed_receipt(compiled),
                graph=altered_graph,
            )
        )
        assert invalid_graph["schema"] == ozone.REFUSAL_SCHEMA
        assert invalid_graph["reason_codes"] == ["invalid_repair_graph"]


def test_governed_verification_joins_windows_paths_by_persisted_identity():
    graph = _projected_remote_graph(
        ["https://example.test/shared.git"],
        ["a" * 40],
        paths=["c:/Repo"],
    )
    content = _content_artifact(
        terms=["needle"],
        checkouts=[
            _observed_content_checkout(
                "c:/repo",
                head_revision="a" * 40,
                matches=[
                    {
                        "path": "notes.md",
                        "line": 1,
                        "term": "needle",
                        "excerpt": "needle marker",
                        "evidence": {"command": "git grep needle"},
                    }
                ],
            )
        ],
    )
    capsule = compile_task_capsule(
        task={
            "question": "Find needle.",
            "scope": ["c:/repo"],
            "required_checks": [
                {
                    "name": "manual",
                    "command": "python -m pytest",
                    "cwd": "c:/repo",
                }
            ],
        },
        graph=graph,
        content=content,
    )
    assert any(claim["fact"] == "content_match" for claim in capsule["claims"])

    result = ozone.verify_governed(
        _governed_request(
            capsule=capsule,
            receipt=_governed_receipt(capsule),
            graph=graph,
            content=content,
        )
    )
    assert result["schema"] == ozone.VERIFICATION_SCHEMA

def test_governed_verification_preserves_content_ranked_graph_claims():
    graph = _projected_remote_graph(
        ["https://example.test/shared.git"],
        ["a" * 40],
    )
    checkout = next(node for node in graph["nodes"] if node["kind"] == "checkout")
    content = _content_artifact(
        terms=["needle"],
        checkouts=[
            _observed_content_checkout(
                checkout["path"],
                head_revision="a" * 40,
                matches=[
                    {
                        "path": "notes.md",
                        "line": 1,
                        "term": "needle",
                        "excerpt": "needle marker",
                        "evidence": {"command": "git grep needle"},
                    }
                ],
            )
        ],
    )
    capsule = compile_task_capsule(
        task={"question": "Find needle.", "scope": ["/repo"]},
        graph=graph,
        content=content,
        budget={"max_claims": 4},
    )
    assert any(claim["fact"] == "content_match" for claim in capsule["claims"])

    accepted = ozone.verify_governed(
        _governed_request(
            capsule=capsule,
            receipt=False,
            graph=graph,
            content=content,
        )
    )

    assert accepted["schema"] == ozone.VERIFICATION_SCHEMA

    missing_graph_claim = json.loads(json.dumps(capsule))
    missing_graph_claim["claims"].remove(
        next(
            claim
            for claim in missing_graph_claim["claims"]
            if claim["fact"] != "content_match"
        )
    )
    missing_graph_claim["fingerprint"] = fingerprint(
        {
            key: item
            for key, item in missing_graph_claim.items()
            if key not in {"capsule_id", "fingerprint"}
        }
    )
    refused = ozone.verify_governed(
        _governed_request(
            capsule=missing_graph_claim,
            receipt=False,
            graph=graph,
            content=content,
        )
    )

    assert refused["schema"] == ozone.REFUSAL_SCHEMA
    assert refused["reason_codes"] == ["repair_graph_context_mismatch"]


def test_governed_verification_scopes_content_line_omissions_by_checkout():
    graph = _projected_remote_graph(
        ["https://example.test/shared.git"],
        ["a" * 40],
    )
    checkout = next(node for node in graph["nodes"] if node["kind"] == "checkout")
    observed = _observed_content_checkout(
        checkout["path"],
        head_revision="a" * 40,
        matches=[],
    )
    observed["omissions"] = [
        {
            "kind": "content_lines_truncated",
            "path": "tracked.md",
            "omitted_count": 1,
            "reason": "matched-line listing capped at 20 per file",
        }
    ]
    content = _content_artifact(terms=["needle"], checkouts=[observed])
    capsule = compile_task_capsule(
        task={"question": "Find needle.", "scope": ["/repo"]},
        graph=graph,
        content=content,
    )
    assert any(
        omission.get("kind") == "content_lines_truncated"
        for omission in capsule["omissions"]
    )

    result = ozone.verify_governed(
        _governed_request(
            capsule=capsule,
            receipt=False,
            graph=graph,
            content=content,
        )
    )

    assert result["schema"] == ozone.VERIFICATION_SCHEMA


def test_governed_verification_treats_empty_content_as_absent():
    result = ozone.verify_governed(
        _governed_request(content={"checkouts": []})
    )

    assert result["schema"] == ozone.VERIFICATION_SCHEMA

def test_governed_verification_refuses_malformed_present_content():
    for content in (
        {"checkouts": [{"path": "/repo"}]},
        {
            "schema": CONTENT_SCHEMA,
            "observed_at": NOW,
            "terms": ["needle"],
            "allowlist": ["/repo"],
            "checkouts": [],
            "refusals": [],
            "smuggled": True,
        },
    ):
        result = ozone.verify_governed(_governed_request(content=content))

        assert result["schema"] == ozone.REFUSAL_SCHEMA
        assert result["reason_codes"] == ["invalid_content_context"]


def test_governed_verification_binds_graph_identity_freshness_and_node_ids():
    graph = _projected_remote_graph(
        ["https://example.test/shared.git"],
        ["a" * 40],
    )
    task = {
        "question": "Does the example checkout mirror upstream?",
        "scope": ["/repo"],
    }
    compiled = compile_task_capsule(
        task=task,
        graph=graph,
        budget={"max_claims": 24},
    )

    stale_graph = json.loads(json.dumps(graph))
    stale_graph["observed_at"] = "2026-07-28T11:00:00+00:00"
    stale_capsule = compile_task_capsule(
        task=task,
        graph=stale_graph,
        budget={"max_claims": 24},
    )
    stale_capsule["workspace"]["observed_at"] = NOW
    stale_capsule["fingerprint"] = fingerprint(
        {
            key: item
            for key, item in stale_capsule.items()
            if key not in {"capsule_id", "fingerprint"}
        }
    )
    stale = ozone.verify_governed(
        _governed_request(
            capsule=stale_capsule,
            receipt=_governed_receipt(stale_capsule),
            graph=stale_graph,
        )
    )
    assert stale["schema"] == ozone.REFUSAL_SCHEMA
    assert stale["reason_codes"] == ["repair_graph_context_mismatch"]

    missing_observed_at = json.loads(json.dumps(graph))
    del missing_observed_at["observed_at"]
    missing_observed = ozone.verify_governed(
        _governed_request(
            capsule=compiled,
            receipt=_governed_receipt(compiled),
            graph=missing_observed_at,
        )
    )
    assert missing_observed["schema"] == ozone.REFUSAL_SCHEMA
    assert missing_observed["reason_codes"] == ["invalid_repair_graph"]

    altered_graph = json.loads(json.dumps(graph))
    altered_checkout = next(
        node for node in altered_graph["nodes"] if node["kind"] == "checkout"
    )
    altered_checkout["facts"]["is_dirty"]["value"] = True
    altered = ozone.verify_governed(
        _governed_request(
            capsule=compiled,
            receipt=_governed_receipt(compiled),
            graph=altered_graph,
        )
    )
    assert altered["schema"] == ozone.REFUSAL_SCHEMA
    assert altered["reason_codes"] == ["invalid_repair_graph"]

    forged_graph = _replace_graph_node_id(graph, "checkout")
    forged = ozone.verify_governed(
        _governed_request(
            capsule=compiled,
            receipt=_governed_receipt(compiled),
            graph=forged_graph,
        )
    )
    assert forged["schema"] == ozone.REFUSAL_SCHEMA
    assert forged["reason_codes"] == ["invalid_repair_graph"]


def test_governed_verification_binds_every_derived_graph_identifier():
    graph = _projected_remote_graph(
        ["https://example.test/shared.git"] * 2,
        ["a" * 40, "b" * 40],
        fact_overrides=[
            {
                "is_dirty": {
                    "status": "known",
                    "value": True,
                    "evidence": [],
                },
                "dirty_entries": {
                    "status": "known",
                    "value": [{"state": "M", "path": "tracked.md"}],
                    "evidence": [],
                },
            },
            {},
        ],
    )
    capsule = compile_task_capsule(
        task={"question": "Review divergence.", "scope": ["/repo"]},
        graph=graph,
        budget={"max_claims": 64},
    )
    accepted = ozone.verify_governed(
        _governed_request(
            capsule=capsule,
            receipt=_governed_receipt(capsule),
            graph=graph,
        )
    )
    assert accepted["schema"] == ozone.VERIFICATION_SCHEMA

    node_kinds = {
        "checkout",
        "repository",
        "revision",
        "branch",
        "remote",
        "dirty_artifact",
    }
    assert node_kinds <= {node["kind"] for node in graph["nodes"]}
    for kind in node_kinds:
        forged = ozone.verify_governed(
            _governed_request(
                capsule=capsule,
                receipt=_governed_receipt(capsule),
                graph=_replace_graph_node_id(graph, kind),
            )
        )
        assert forged["schema"] == ozone.REFUSAL_SCHEMA
        assert forged["reason_codes"] == ["invalid_repair_graph"]

    forged_edge_graph = json.loads(json.dumps(graph))
    at_revision_edges = [
        edge
        for edge in forged_edge_graph["edges"]
        if edge["kind"] == "at_revision"
    ]
    at_revision_edges[0]["to"] = at_revision_edges[1]["to"]
    at_revision_edges[0]["id"] = deterministic_id(
        "edge",
        {
            "kind": at_revision_edges[0]["kind"],
            "from": at_revision_edges[0]["from"],
            "to": at_revision_edges[0]["to"],
        },
    )
    forged_edge = ozone.verify_governed(
        _governed_request(
            capsule=capsule,
            receipt=_governed_receipt(capsule),
            graph=forged_edge_graph,
        )
    )
    assert forged_edge["schema"] == ozone.REFUSAL_SCHEMA
    assert forged_edge["reason_codes"] == ["invalid_repair_graph"]

    forged_conflict_graph = json.loads(json.dumps(graph))
    forged_conflict_graph["conflicts"][0]["id"] = "conflict:forged"
    forged_conflict = ozone.verify_governed(
        _governed_request(
            capsule=capsule,
            receipt=_governed_receipt(capsule),
            graph=forged_conflict_graph,
        )
    )
    assert forged_conflict["schema"] == ozone.REFUSAL_SCHEMA
    assert forged_conflict["reason_codes"] == ["invalid_repair_graph"]



def test_governed_verification_binds_question_match_signals_to_their_tier():
    malformed_selections = (
        {
            "tier": "allowlisted",
            "signals": [
                {
                    "signal": "question_term_match",
                    "term": "task",
                    "field": "label",
                }
            ],
        },
        {
            "tier": "question_match",
            "signals": [{"signal": "allowlisted"}],
        },
        {
            "tier": "question_match",
            "signals": [
                {
                    "signal": "content_term_match",
                    "term": "task",
                    "path": "forged.md",
                }
            ],
        },
        {
            "tier": "question_match",
            "signals": [
                {
                    "signal": "question_term_match",
                    "term": ["task"],
                    "field": "label",
                }
            ],
        },
        {
            "tier": "content_match",
            "signals": [
                {
                    "signal": "content_term_match",
                    "term": "task",
                    "path": {"forged": "path"},
                }
            ],
        },
        {
            "tier": "question_match",
            "signals": [
                {
                    "signal": "content_term_match",
                    "term": "task",
                    "path": {"forged": "path"},
                }
            ],
        },
    )
    for index, selection in enumerate(malformed_selections):
        claim = {
            "id": f"claim:selection:{index}",
            "selection": selection,
        }
        if index == len(malformed_selections) - 1:
            claim["fact"] = "content_match"
        capsule = _governed_capsule(
            claims=[claim]
        )
        result = ozone.verify_governed(
            _governed_request(
                capsule=capsule,
                receipt=_governed_receipt(capsule),
            )
        )

        assert result["schema"] == ozone.REFUSAL_SCHEMA
        assert result["reason_codes"] == ["invalid_capsule"]

def test_governed_verification_preserves_duplicate_receipt_checks():
    governed_capsule = _governed_capsule(
        claims=[{"id": "claim:first", "subject": "checkout:a", "claim": "first"}]
    )
    governed_receipt = create_integrity_receipt(
        capsule=governed_capsule,
        runtime={"harness": "test", "actor": "agent:test"},
        checks=[
            {
                "name": "unit",
                "command": "python packages/ozone/tests/test_ozone.py",
                "outcome": "passed",
            },
            {
                "name": "unit",
                "command": "python packages/ozone/tests/test_ozone.py",
                "outcome": "failed",
            },
        ],
        now=lambda: NOW,
    )

    result = ozone.verify_governed(
        _governed_request(capsule=governed_capsule, receipt=governed_receipt)
    )

    assert result["schema"] == ozone.VERIFICATION_SCHEMA
    assert result["outcome"] == "insufficient"
    assert result["receipt_verdict"]["outcome"] == "verified"
    assert "required_check_failed" in result["gate_verdict"]["reason_codes"]


def test_governed_verification_refuses_refingerprinted_receipt_checks_outside_capsule_authority():
    capsule = _governed_capsule()
    receipt = _governed_receipt(capsule)
    receipt["checks"] = [
        {
            "name": "self-authored-check",
            "command": "true",
            "outcome": "passed",
        }
    ]
    receipt["fingerprint"] = fingerprint(
        {
            key: value
            for key, value in receipt.items()
            if key not in {"receipt_id", "fingerprint"}
        }
    )

    result = ozone.verify_governed(
        _governed_request(capsule=capsule, receipt=receipt)
    )

    assert result["schema"] == ozone.REFUSAL_SCHEMA
    assert result["reason_codes"] == ["invalid_receipt"]


def test_governed_verification_rejects_graphless_check_cwd_outside_task_scope():
    capsule = _governed_capsule()
    capsule["task"]["required_checks"][0]["cwd"] = "/other/repo"
    capsule["required_checks"][0]["cwd"] = "/other/repo"
    capsule["fingerprint"] = fingerprint(
        {
            key: value
            for key, value in capsule.items()
            if key not in {"capsule_id", "fingerprint"}
        }
    )

    result = ozone.verify_governed(
        _governed_request(capsule=capsule, receipt=_governed_receipt(capsule))
    )

    assert result["schema"] == ozone.REFUSAL_SCHEMA
    assert result["reason_codes"] == ["invalid_capsule"]


def test_governed_verification_refuses_unbounded_content_containment_work():
    request = _governed_request()
    request["content"] = {
        "schema": CONTENT_SCHEMA,
        "observed_at": NOW,
        "terms": ["needle"],
        "allowlist": [f"/allowed/{index}" for index in range(1_001)],
        "checkouts": [
            _observed_content_checkout(
                f"/allowed/{index}",
                head_revision="a" * 40,
                matches=[],
            )
            for index in range(1_000)
        ],
        "refusals": [],
    }

    result = ozone.verify_governed(request)

    assert result["schema"] == ozone.REFUSAL_SCHEMA
    assert result["reason_codes"] == ["repair_work_unbounded"]


def test_governed_verification_types_combined_content_candidate_overflow():
    graph = _projected_remote_graph(
        ["https://example.test/project.git"],
        ["a" * 40],
        paths=["/repo/packages/ozone"],
    )
    capsule = compile_task_capsule(
        task={
            "question": "Can this task pass the release gate?",
            "scope": ["/repo/packages/ozone"],
            "required_checks": [
                {
                    "name": "unit",
                    "command": "python packages/ozone/tests/test_ozone.py",
                    "cwd": "/repo/packages/ozone",
                }
            ],
        },
        graph=graph,
    )
    irrelevant_root = normalize_path(REPO_TMP)
    content = {
        "schema": CONTENT_SCHEMA,
        "observed_at": NOW,
        "terms": ["needle"],
        "allowlist": [irrelevant_root],
        "checkouts": [
            _observed_content_checkout(
                f"{irrelevant_root}/irrelevant-{index}",
                head_revision="a" * 40,
                matches=[],
            )
            for index in range(10_000)
        ],
        "refusals": [],
    }
    capsule["workspace"]["content_fingerprint"] = fingerprint(content)
    capsule["fingerprint"] = fingerprint(
        {
            key: value
            for key, value in capsule.items()
            if key not in {"capsule_id", "fingerprint"}
        }
    )

    result = ozone.verify_governed(
        _governed_request(capsule=capsule, graph=graph, content=content)
    )

    assert result["schema"] == ozone.REFUSAL_SCHEMA
    assert result["reason_codes"] == ["repair_work_unbounded"]


def test_governed_verification_refuses_scalar_content_containment_work():
    request = _governed_request()
    huge_root = "/" + "a" * 500_000
    request["content"] = {
        "schema": CONTENT_SCHEMA,
        "observed_at": NOW,
        "terms": ["needle"],
        "allowlist": [huge_root],
        "checkouts": [],
        "refusals": [
            {
                "raw_path": f"relative-{index}",
                "path": f"relative-{index}",
                "status": "refused",
                "reason": "outside_allowlist",
            }
            for index in range(3)
        ],
    }

    result = ozone.verify_governed(request)

    assert result["schema"] == ozone.REFUSAL_SCHEMA
    assert result["reason_codes"] == ["repair_work_unbounded"]


def test_governed_verification_refuses_graphless_scope_scalar_work():
    capsule = _governed_capsule()
    huge_root = "/" + "a" * 4_000_000
    checks = [
        {
            "name": f"check-{index}",
            "command": f"check {index}",
            "cwd": f"/outside/{index}",
        }
        for index in range(3)
    ]
    capsule["task"]["scope"] = [huge_root]
    capsule["task"]["required_checks"] = checks
    capsule["required_checks"] = checks
    capsule["fingerprint"] = fingerprint(
        {
            key: value
            for key, value in capsule.items()
            if key not in {"capsule_id", "fingerprint"}
        }
    )

    result = ozone.verify_governed(_governed_request(capsule=capsule))

    assert result["schema"] == ozone.REFUSAL_SCHEMA
    assert result["reason_codes"] == ["repair_work_unbounded"]


def test_governed_verification_refuses_graph_scope_scalar_work():
    graph = _projected_remote_graph(
        [
            "https://example.test/a.git",
            "https://example.test/b.git",
            "https://example.test/c.git",
        ],
        ["a" * 40, "b" * 40, "c" * 40],
    )
    capsule = compile_task_capsule(
        task={"question": "Review the project.", "scope": ["/repo"]},
        graph=graph,
    )
    capsule["task"]["scope"] = ["/" + "a" * 4_000_000]
    capsule["fingerprint"] = fingerprint(
        {
            key: value
            for key, value in capsule.items()
            if key not in {"capsule_id", "fingerprint"}
        }
    )

    result = ozone.verify_governed(
        _governed_request(capsule=capsule, graph=graph)
    )

    assert result["schema"] == ozone.REFUSAL_SCHEMA
    assert result["reason_codes"] == ["repair_work_unbounded"]
def test_governed_verification_refuses_graph_refusal_scope_scalar_work():
    graph = _projected_remote_graph(
        ["https://example.test/project.git"],
        ["a" * 40],
    )
    capsule = compile_task_capsule(
        task={
            "question": "Review the project.",
            "scope": [f"/scope/{index}" for index in range(6)],
        },
        graph=graph,
    )
    huge_path = "/" + "a" * 2_000_000
    graph["refusals"] = [
        {
            "raw_path": huge_path,
            "path": huge_path,
            "status": "refused",
            "reason": "outside_allowlist",
        }
    ]

    result = ozone.verify_governed(
        _governed_request(capsule=capsule, graph=graph)
    )

    assert result["schema"] == ozone.REFUSAL_SCHEMA
    assert result["reason_codes"] == ["repair_work_unbounded"]


def test_governed_verification_refuses_worktree_root_scope_scalar_work():
    graph = _projected_remote_graph(
        ["https://example.test/project.git"],
        ["a" * 40],
    )
    capsule = compile_task_capsule(
        task={
            "question": "Review the project.",
            "scope": [f"/scope/{index}" for index in range(6)],
        },
        graph=graph,
    )
    checkout = next(
        node for node in graph["nodes"] if node["kind"] == "checkout"
    )
    checkout["facts"]["worktree_root"] = {
        "status": "known",
        "value": "/" + "a" * 2_000_000,
        "evidence": [],
    }

    result = ozone.verify_governed(
        _governed_request(capsule=capsule, graph=graph)
    )

    assert result["schema"] == ozone.REFUSAL_SCHEMA
    assert result["reason_codes"] == ["repair_work_unbounded"]




def test_governed_verification_refuses_unbounded_question_ranking_work():
    graph = _projected_remote_graph(
        ["https://example.test/project.git"],
        ["a" * 40],
        fact_overrides=[
            {
                "is_dirty": {
                    "status": "known",
                    "value": True,
                    "evidence": [],
                },
                "dirty_entries": {
                    "status": "known",
                    "value": [
                        {"path": f"file-{index}.txt", "state": "M"}
                        for index in range(20)
                    ],
                    "evidence": [],
                },
            }
        ],
    )
    capsule = compile_task_capsule(
        task={"question": "Review the project.", "scope": ["/repo"]},
        graph=graph,
    )
    capsule["task"]["question"] = "Review the project. " + " ".join(
        f"term{index}" for index in range(600_000)
    )
    capsule["capsule_id"] = deterministic_id(
        "capsule",
        {
            "task": capsule["task"]["question"],
            "filters": capsule["task"].get("filters"),
            "workspace": capsule["workspace"]["fingerprint"],
        },
    )
    capsule["fingerprint"] = fingerprint(
        {
            key: value
            for key, value in capsule.items()
            if key not in {"capsule_id", "fingerprint"}
        }
    )

    result = ozone.verify_governed(
        _governed_request(capsule=capsule, graph=graph)
    )

    assert result["schema"] == ozone.REFUSAL_SCHEMA
    assert result["reason_codes"] == ["repair_work_unbounded"]


def test_governed_verification_preserves_content_snapshot_unknowns():
    graph = _projected_remote_graph(
        ["https://example.test/project.git"],
        ["a" * 40],
    )
    content = _content_artifact(
        terms=["modified"],
        checkouts=[
            _observed_content_checkout(
                "/repo/checkout-0",
                head_revision="0" * 40,
                matches=[
                    {
                        "path": "tracked.md",
                        "line": 1,
                        "term": "modified",
                        "excerpt": "modified content",
                        "evidence": {"command": "git grep modified"},
                    }
                ],
            )
        ],
    )
    capsule = compile_task_capsule(
        task={"question": "What modified content exists?", "scope": ["/repo"]},
        graph=graph,
        content=content,
    )
    assert any(
        unknown.get("kind") == "content_snapshot_stale"
        for unknown in capsule["unknowns"]
    )
    honest = ozone.verify_governed(
        _governed_request(capsule=capsule, graph=graph, content=content)
    )
    assert honest["schema"] == ozone.VERIFICATION_SCHEMA

    forged = json.loads(json.dumps(capsule))
    forged["unknowns"] = [
        unknown
        for unknown in forged["unknowns"]
        if unknown.get("kind") != "content_snapshot_stale"
    ]
    forged["fingerprint"] = fingerprint(
        {
            key: value
            for key, value in forged.items()
            if key not in {"capsule_id", "fingerprint"}
        }
    )
    refused = ozone.verify_governed(
        _governed_request(capsule=forged, graph=graph, content=content)
    )

    assert refused["schema"] == ozone.REFUSAL_SCHEMA
    assert refused["reason_codes"] == ["repair_graph_context_mismatch"]


def test_governed_verification_accepts_core_receipt_extensions():
    governed_capsule = _governed_capsule()
    governed_receipt = create_integrity_receipt(
        capsule=governed_capsule,
        runtime={"actor": "agent:test", "runner": {"name": "ci"}},
        checks=[
            {
                "name": "unit",
                "command": "python packages/ozone/tests/test_ozone.py",
                "outcome": "passed",
                "runner": {"attempt": 1},
            }
        ],
        provenance=[
            {
                "kind": "checkpoint",
                "ref": "ci:unit",
                "runner": {"name": "ci"},
            }
        ],
        now=lambda: NOW,
    )

    result = ozone.verify_governed(
        _governed_request(capsule=governed_capsule, receipt=governed_receipt)
    )

    assert result["schema"] == ozone.VERIFICATION_SCHEMA
    assert result["outcome"] == "sufficient"
    assert result["receipt_verdict"]["outcome"] == "verified"


def test_governed_verification_refuses_stale_and_mismatched_evidence():
    stale_request = _governed_request()
    stale_request["verified_at"] = "2026-07-28T12:06:00+00:00"
    mismatch_request = _governed_request()
    mismatch_request["workspace"] = {"fingerprint": "sha256:other-workspace"}

    stale = ozone.verify_governed(stale_request)
    mismatch = ozone.verify_governed(mismatch_request)

    assert stale["schema"] == ozone.REFUSAL_SCHEMA
    assert "stale_capsule" in stale["reason_codes"]
    assert "stale_receipt" in stale["reason_codes"]
    assert mismatch["schema"] == ozone.REFUSAL_SCHEMA
    assert mismatch["reason_codes"] == ["workspace_mismatch"]


def test_governed_verification_enforces_gate_budgets():
    governed_capsule = _governed_capsule(
        unknowns=[
            {
                "checkout": "checkout:a",
                "path": "/repo/packages/ozone",
                "fact": "last_fetch",
                "reason": "not_observed",
            }
        ]
    )
    result = ozone.verify_governed(
        _governed_request(
            capsule=governed_capsule,
            gate={"name": "release", "max_unresolved_unknowns": 0},
        )
    )

    assert result["outcome"] == "insufficient"
    assert result["gate_verdict"]["unresolved_unknowns"] == 1
    assert "unresolved_unknowns_exceed_limit" in result["reason_codes"]


def test_governed_verification_accepts_core_unknown_receipt_records():
    governed_capsule = _governed_capsule(
        unknowns=[
            {
                "checkout": "checkout:a",
                "path": "/repo/packages/ozone",
                "fact": "last_fetch",
                "reason": "not_observed",
            }
        ]
    )

    result = ozone.verify_governed(_governed_request(capsule=governed_capsule))

    assert result["schema"] == ozone.VERIFICATION_SCHEMA
    assert result["outcome"] == "sufficient"
    assert result["receipt_verdict"]["outcome"] == "verified"


def test_governed_repairs_are_typed_bounded_and_dry_run():
    graph = _projected_remote_graph(
        ["https://example.test/alpha.git"],
        ["a" * 40],
    )
    governed_capsule = compile_task_capsule(
        task={
            "question": "Review the checkout.",
            "scope": ["/repo"],
        },
        graph=graph,
        budget={"max_claims": 24},
    )
    result = ozone.verify_governed(
        _governed_request(capsule=governed_capsule, graph=graph)
    )
    proposal = result["repair_proposal"]

    assert proposal["writes_performed"] == 0
    assert proposal["requires_gate"] is True
    assert proposal["proposals"]
    claim_ids = {claim["id"] for claim in governed_capsule["claims"]}
    assert all(item["target"] in claim_ids for item in proposal["proposals"])
    assert proposal["proposals"][0]["requires_gate"] is True


def test_governed_verification_accepts_full_graph_for_scoped_capsule():
    graph = _projected_remote_graph(
        [
            "https://example.test/selected.git",
            "https://example.test/conflicted.git",
            "https://example.test/conflicted.git",
        ],
        ["a" * 40, "b" * 40, "c" * 40],
    )
    capsule = compile_task_capsule(
        task={
            "question": "Review only the selected checkout.",
            "scope": ["/repo/checkout-0"],
            "required_checks": [
                {
                    "name": "unit",
                    "command": "python packages/ozone/tests/test_ozone.py",
                    "cwd": "/repo/checkout-0",
                }
            ],
        },
        graph=graph,
    )
    assert capsule["conflicts"] == []
    assert graph["conflicts"]

    result = ozone.verify_governed(
        _governed_request(capsule=capsule, graph=graph)
    )

    assert result["schema"] == ozone.VERIFICATION_SCHEMA
    assert result["outcome"] == "sufficient"


def test_governed_verification_refuses_forged_in_scope_conflicts():
    graph = _projected_remote_graph(
        ["https://example.test/shared.git"] * 2,
        ["a" * 40, "a" * 40],
    )
    divergent_graph = _projected_remote_graph(
        ["https://example.test/shared.git"] * 2,
        ["a" * 40, "b" * 40],
    )
    capsule = _governed_capsule(
        conflicts=[
            {**conflict, "decision": "review_required"}
            for conflict in divergent_graph["conflicts"]
        ],
        workspace_fingerprint=graph["workspace_fingerprint"],
        topology_fingerprint=repair_topology_fingerprint(graph),
    )
    capsule["task"]["scope"] = ["/repo"]
    capsule["fingerprint"] = fingerprint(
        {
            key: item
            for key, item in capsule.items()
            if key not in {"capsule_id", "fingerprint"}
        }
    )

    result = ozone.verify_governed(
        _governed_request(
            capsule=capsule,
            receipt=_governed_receipt(capsule),
            graph=graph,
        )
    )

    assert result["schema"] == ozone.REFUSAL_SCHEMA
    assert result["reason_codes"] == ["repair_graph_conflicts_mismatch"]
    honest_capsule = compile_task_capsule(
        task={
            "question": "Review both divergent checkouts.",
            "scope": ["/repo"],
        },
        graph=divergent_graph,
    )
    forged_path_graph = json.loads(json.dumps(divergent_graph))
    forged_sides = forged_path_graph["conflicts"][0]["sides"]
    forged_sides[0]["path"] = forged_sides[1]["path"]

    forged_path = ozone.verify_governed(
        _governed_request(
            capsule=honest_capsule,
            graph=forged_path_graph,
        )
    )
    assert forged_path["schema"] == ozone.REFUSAL_SCHEMA
    assert forged_path["reason_codes"] == ["invalid_repair_graph"]
    forged_content_graph = json.loads(json.dumps(divergent_graph))
    forged_content_graph["conflicts"][0]["sides"][0][
        "head_revision"
    ] = "f" * 40
    forged_content_capsule = compile_task_capsule(
        task={
            "question": "Review both divergent checkouts.",
            "scope": ["/repo"],
        },
        graph=forged_content_graph,
    )
    forged_content = ozone.verify_governed(
        _governed_request(
            capsule=forged_content_capsule,
            graph=forged_content_graph,
        )
    )
    assert forged_content["schema"] == ozone.REFUSAL_SCHEMA
    assert forged_content["reason_codes"] == ["invalid_repair_graph"]


def test_governed_verification_preserves_derived_check_unknowns():
    graph = _projected_graph(
        [
            {
                "path": "/repo/project",
                "facts": {
                    "is_git_repository": {
                        "status": "known",
                        "value": True,
                        "evidence": [],
                    },
                    "git_common_dir": {
                        "status": "known",
                        "value": "/repo/.git",
                        "evidence": [],
                    },
                    "workspace_markers": {
                        "status": "known",
                        "value": ["pyproject.toml"],
                        "evidence": ["marker scan"],
                    },
                },
            }
        ],
        allowlist=["/repo"],
    )
    capsule = compile_task_capsule(
        task={
            "question": "Review the project.",
            "scope": ["/repo"],
        },
        graph=graph,
    )
    assert [unknown["kind"] for unknown in capsule["unknowns"]] == [
        "required_check_undetermined"
    ]

    tampered = json.loads(json.dumps(capsule))
    tampered["unknowns"] = []
    tampered["fingerprint"] = fingerprint(
        {
            key: item
            for key, item in tampered.items()
            if key not in {"capsule_id", "fingerprint"}
        }
    )
    result = ozone.verify_governed(
        _governed_request(
            capsule=tampered,
            receipt=False,
            gate={
                "name": "strict",
                "required_checks": [],
                "require_claims_verified": False,
                "max_unresolved_unknowns": 0,
            },
            graph=graph,
        )
    )
    assert result["schema"] == ozone.REFUSAL_SCHEMA
    assert result["reason_codes"] == ["repair_graph_context_mismatch"]
    empty_override = json.loads(json.dumps(capsule))
    empty_override["task"]["required_checks"] = []
    empty_override["unknowns"] = []
    empty_override["fingerprint"] = fingerprint(
        {
            key: item
            for key, item in empty_override.items()
            if key not in {"capsule_id", "fingerprint"}
        }
    )
    empty_result = ozone.verify_governed(
        _governed_request(
            capsule=empty_override,
            receipt=False,
            graph=graph,
        )
    )
    assert empty_result["schema"] == ozone.REFUSAL_SCHEMA
    assert empty_result["reason_codes"] == ["invalid_capsule"]

def test_governed_verification_refuses_declared_check_command_rewrites():
    graph = _projected_remote_graph(
        ["https://example.test/project.git"],
        ["a" * 40],
        fact_overrides=[
            {
                "workspace_markers": {
                    "status": "known",
                    "value": ["package.json"],
                    "evidence": {"command": "fs.scan workspace markers"},
                },
                "npm_test_script": {
                    "status": "known",
                    "value": "jest",
                    "evidence": {"command": "fs.read package.json scripts.test"},
                },
            }
        ],
    )
    capsule = compile_task_capsule(
        task={"question": "Review the project.", "scope": ["/repo"]},
        graph=graph,
    )
    derived = next(
        check for check in capsule["required_checks"] if check["command"] == "npm test"
    )
    forged = json.loads(json.dumps(capsule))
    forged_check = {
        "name": derived["name"],
        "command": "true",
        "cwd": derived["cwd"],
    }
    forged["task"]["required_checks"] = [forged_check]
    forged["required_checks"] = [forged_check]
    forged["fingerprint"] = fingerprint(
        {
            key: item
            for key, item in forged.items()
            if key not in {"capsule_id", "fingerprint"}
        }
    )

    result = ozone.verify_governed(
        _governed_request(capsule=forged, receipt=False, graph=graph)
    )
    assert result["schema"] == ozone.REFUSAL_SCHEMA
    assert result["reason_codes"] == ["repair_graph_context_mismatch"]


def test_governed_verification_scopes_declared_check_authority():
    marker_fact = {
        "status": "known",
        "value": ["pyproject.toml"],
        "evidence": {"command": "fs.scan workspace markers"},
    }
    graph = _projected_remote_graph(
        [
            "https://example.test/a.git",
            "https://example.test/b.git",
        ],
        ["a" * 40, "b" * 40],
        fact_overrides=[
            {"workspace_markers": marker_fact},
            {"workspace_markers": marker_fact},
        ],
    )
    explicit = {
        "name": "python-tests",
        "command": "python -m pytest",
        "cwd": "/repo/checkout-0",
    }
    capsule = compile_task_capsule(
        task={
            "question": "Review both projects.",
            "scope": ["/repo"],
            "required_checks": [explicit],
        },
        graph=graph,
    )
    unresolved_paths = {
        unknown["subject_path"]
        for unknown in capsule["unknowns"]
        if unknown.get("kind") == "required_check_undetermined"
    }
    assert unresolved_paths == {"/repo/checkout-1"}

    dropped = json.loads(json.dumps(capsule))
    dropped["unknowns"] = []
    dropped["fingerprint"] = fingerprint(
        {
            key: item
            for key, item in dropped.items()
            if key not in {"capsule_id", "fingerprint"}
        }
    )
    dropped_result = ozone.verify_governed(
        _governed_request(capsule=dropped, receipt=False, graph=graph)
    )
    assert dropped_result["schema"] == ozone.REFUSAL_SCHEMA
    assert dropped_result["reason_codes"] == ["repair_graph_context_mismatch"]

    scoped = compile_task_capsule(
        task={
            "question": "Review one project.",
            "scope": ["/repo/checkout-0"],
            "required_checks": [explicit],
        },
        graph=graph,
    )
    unresolved_scoped = compile_task_capsule(
        task={
            "question": "Review one project.",
            "scope": ["/repo/checkout-0"],
        },
        graph=graph,
    )
    assert len(unresolved_scoped["unknowns"]) == 1
    outside = json.loads(json.dumps(scoped))
    outside_check = {
        **explicit,
        "cwd": "/repo/checkout-1",
    }
    outside["task"]["required_checks"] = [outside_check]
    outside["required_checks"] = [outside_check]
    outside["unknowns"] = unresolved_scoped["unknowns"]
    outside["fingerprint"] = fingerprint(
        {
            key: item
            for key, item in outside.items()
            if key not in {"capsule_id", "fingerprint"}
        }
    )
    outside_result = ozone.verify_governed(
        _governed_request(capsule=outside, receipt=False, graph=graph)
    )
    assert outside_result["schema"] == ozone.REFUSAL_SCHEMA
    assert outside_result["reason_codes"] == ["repair_graph_context_mismatch"]


def test_governed_verification_rejects_non_git_declared_check_roots():
    graph = _projected_graph(
        [
            {
                "path": "/repo",
                "facts": {
                    "is_git_repository": {
                        "status": "known",
                        "value": False,
                        "evidence": [],
                    }
                },
            },
            {
                "path": "/repo/project",
                "facts": {
                    "is_git_repository": {
                        "status": "known",
                        "value": True,
                        "evidence": [],
                    },
                    "git_common_dir": {
                        "status": "known",
                        "value": "/repo/project/.git",
                        "evidence": [],
                    },
                    "workspace_markers": {
                        "status": "known",
                        "value": ["pyproject.toml"],
                        "evidence": {"command": "fs.scan workspace markers"},
                    },
                },
            },
        ],
        allowlist=["/repo"],
    )
    capsule = compile_task_capsule(
        task={
            "question": "Review the project.",
            "scope": ["/repo"],
        },
        graph=graph,
    )
    assert len(capsule["unknowns"]) == 1

    forged = json.loads(json.dumps(capsule))
    forged_check = {
        "name": "parent-tests",
        "command": "python -m pytest",
        "cwd": "/repo",
    }
    forged["task"]["required_checks"] = [forged_check]
    forged["required_checks"] = [forged_check]
    forged["fingerprint"] = fingerprint(
        {
            key: item
            for key, item in forged.items()
            if key not in {"capsule_id", "fingerprint"}
        }
    )
    result = ozone.verify_governed(
        _governed_request(capsule=forged, receipt=False, graph=graph)
    )
    assert result["schema"] == ozone.REFUSAL_SCHEMA
    assert result["reason_codes"] == ["repair_graph_context_mismatch"]


def test_governed_verification_binds_worktree_root_to_workspace_fingerprint():
    graph = _projected_remote_graph(
        ["https://example.test/project.git"],
        ["a" * 40],
        fact_overrides=[
            {
                "worktree_root": {
                    "status": "known",
                    "value": "/repo/checkout-0",
                    "evidence": {"command": "git rev-parse --show-toplevel"},
                },
                "workspace_markers": {
                    "status": "known",
                    "value": ["tropo.toml"],
                    "evidence": {"command": "fs.scan workspace markers"},
                },
            }
        ],
    )
    capsule = compile_task_capsule(
        task={"question": "Review the project.", "scope": ["/repo"]},
        graph=graph,
    )
    assert any(
        check["cwd"] == "/repo/checkout-0"
        for check in capsule["required_checks"]
    )

    forged = json.loads(json.dumps(graph))
    checkout = next(
        node for node in forged["nodes"] if node.get("kind") == "checkout"
    )
    checkout["facts"]["worktree_root"]["value"] = "/"
    result = ozone.verify_governed(
        _governed_request(capsule=capsule, receipt=False, graph=forged)
    )
    assert result["schema"] == ozone.REFUSAL_SCHEMA
    assert result["reason_codes"] == ["invalid_repair_graph"]


def test_governed_verification_refuses_malformed_scope_without_repair_graph():
    for malformed_scope in (True, None, []):
        capsule = _governed_capsule()
        capsule["task"]["scope"] = malformed_scope
        capsule["fingerprint"] = fingerprint(
            {
                key: item
                for key, item in capsule.items()
                if key not in {"capsule_id", "fingerprint"}
            }
        )

        result = ozone.verify_governed(
            _governed_request(
                capsule=capsule,
                receipt=_governed_receipt(capsule),
            )
        )

        assert result["schema"] == ozone.REFUSAL_SCHEMA
        assert result["reason_codes"] == ["invalid_capsule"]

    outside_claim_capsule = _governed_capsule(
        claims=[
            {
                "id": "claim:outside",
                "subject_path": "/repo/outside",
            }
        ]
    )
    outside_claim = ozone.verify_governed(
        _governed_request(
            capsule=outside_claim_capsule,
            receipt=_governed_receipt(outside_claim_capsule),
        )
    )
    assert outside_claim["schema"] == ozone.REFUSAL_SCHEMA
    assert outside_claim["reason_codes"] == ["invalid_repair_capsule"]




def test_governed_verification_refuses_whitespace_scope_wildcard_without_repair_graph():
    capsule = _governed_capsule(
        claims=[{"subject_path": "/repo/outside"}]
    )
    capsule["task"]["scope"] = [" "]
    capsule["fingerprint"] = fingerprint(
        {
            key: item
            for key, item in capsule.items()
            if key not in {"capsule_id", "fingerprint"}
        }
    )

    result = ozone.verify_governed(
        _governed_request(
            capsule=capsule,
            receipt=_governed_receipt(capsule),
        )
    )

    assert result["schema"] == ozone.REFUSAL_SCHEMA
    assert result["reason_codes"] == ["invalid_capsule"]



def test_governed_verification_refuses_graphs_that_drop_capsule_conflicts():
    graph = _projected_remote_graph(
        ["https://example.test/shared.git"] * 2,
        ["a" * 40, "b" * 40],
    )
    capsule = compile_task_capsule(
        task={"question": "Review divergence.", "scope": ["/repo"]},
        graph=graph,
        budget={"max_claims": 24},
    )
    assert capsule["conflicts"]
    conflict_claim_index = next(
        index
        for index, claim in enumerate(capsule["claims"])
        if claim["selection"]["tier"] == "conflict_side"
    )

    dropped = json.loads(json.dumps(capsule))
    dropped["conflicts"] = []
    dropped["claims"] = [
        claim
        for claim in dropped["claims"]
        if claim["selection"]["tier"] != "conflict_side"
    ]
    dropped["fingerprint"] = fingerprint(
        {
            key: item
            for key, item in dropped.items()
            if key not in {"capsule_id", "fingerprint"}
        }
    )
    dropped_result = ozone.verify_governed(
        _governed_request(
            capsule=dropped,
            receipt=_governed_receipt(dropped),
            graph=graph,
        )
    )
    assert dropped_result["schema"] == ozone.REFUSAL_SCHEMA
    assert dropped_result["reason_codes"] == [
        "repair_graph_conflicts_mismatch"
    ]

    relabeled_capsule = json.loads(json.dumps(capsule))
    relabeled_capsule["claims"][conflict_claim_index]["selection"] = {
        "tier": "allowlisted",
        "signals": [],
    }
    relabeled_capsule["fingerprint"] = fingerprint(
        {
            key: item
            for key, item in relabeled_capsule.items()
            if key not in {"capsule_id", "fingerprint"}
        }
    )
    relabeled = ozone.verify_governed(
        _governed_request(
            capsule=relabeled_capsule,
            receipt=_governed_receipt(relabeled_capsule),
            graph=graph,
        )
    )
    assert relabeled["schema"] == ozone.REFUSAL_SCHEMA
    assert relabeled["reason_codes"] == ["invalid_capsule"]

    promoted_capsule = _governed_capsule(
        claims=[
            {
                "id": "claim:promoted",
                "selection": {
                    "tier": "conflict_side",
                    "signals": [
                        {
                            "signal": "conflict_side",
                            "conflict": "conflict:missing",
                        }
                    ],
                },
            }
        ]
    )
    promoted = ozone.verify_governed(
        _governed_request(
            capsule=promoted_capsule,
            receipt=_governed_receipt(promoted_capsule),
        )
    )
    assert promoted["schema"] == ozone.REFUSAL_SCHEMA
    assert promoted["reason_codes"] == ["invalid_capsule"]

    matching = ozone.verify_governed(
        _governed_request(capsule=capsule, graph=graph)
    )
    assert matching["schema"] == ozone.VERIFICATION_SCHEMA
    assert all(
        proposal["kind"] != "deduplicate"
        for proposal in matching["repair_proposal"]["proposals"]
    )

    incomplete_graph = json.loads(json.dumps(graph))
    incomplete_graph["nodes"].append(
        {"id": "checkout:extra", "kind": "checkout"}
    )
    incomplete = ozone.verify_governed(
        _governed_request(capsule=capsule, graph=incomplete_graph)
    )
    assert incomplete["schema"] == ozone.REFUSAL_SCHEMA
    assert incomplete["reason_codes"] == ["invalid_repair_graph"]


def test_governed_verification_binds_graph_topology_commitment():
    honest_graph = _projected_remote_graph(
        [
            "https://example.test/alpha.git",
            "https://example.test/beta.git",
        ],
        ["a" * 40, "a" * 40],
    )
    checkout_ids = [
        edge["from"]
        for edge in honest_graph["edges"]
        if edge["kind"] == "checkout_of"
    ]
    checkout_paths = {
        node["id"]: node["path"]
        for node in honest_graph["nodes"]
        if node["kind"] == "checkout"
    }
    capsule = _governed_capsule(
        claims=[
            {
                "id": f"claim:{index}",
                "fact": "head_revision",
                "subject": checkout_id,
                "subject_path": checkout_paths[checkout_id],
                "claim": f"HEAD revision is {'a' * 40}",
                "selection": {"tier": "allowlisted"},
                "evidence": [],
            }
            for index, checkout_id in enumerate(checkout_ids)
        ],
        topology_fingerprint=repair_topology_fingerprint(honest_graph),
        workspace_fingerprint=honest_graph["workspace_fingerprint"],
    )
    capsule["task"]["scope"] = ["/repo"]
    capsule["fingerprint"] = fingerprint(
        {
            key: item
            for key, item in capsule.items()
            if key not in {"capsule_id", "fingerprint"}
        }
    )

    fabricated_graph = _projected_remote_graph(
        ["https://example.test/shared.git"] * 2,
        ["a" * 40, "a" * 40],
    )
    fabricated_request = _governed_request(
        capsule=json.loads(json.dumps(capsule)),
        receipt=_governed_receipt(capsule),
        graph=fabricated_graph,
    )
    _bind_request_graph_workspace(fabricated_request)
    fabricated = ozone.verify_governed(fabricated_request)
    assert fabricated["schema"] == ozone.REFUSAL_SCHEMA
    assert fabricated["reason_codes"] == ["repair_graph_topology_unbound"]

    local_graph = _projected_remote_graph(
        [None, None],
        ["a" * 40, "a" * 40],
        common_dirs=["/repo/shared/.git"] * 2,
    )
    local_capsule = compile_task_capsule(
        task={
            "question": "Can this task pass the release gate?",
            "scope": ["/repo"],
            "required_checks": [
                {
                    "name": "unit",
                    "command": "python packages/ozone/tests/test_ozone.py",
                    "cwd": "/repo/checkout-0",
                }
            ],
        },
        graph=local_graph,
    )
    committed_local = ozone.verify_governed(
        _governed_request(capsule=local_capsule, graph=local_graph)
    )
    assert committed_local["schema"] == ozone.VERIFICATION_SCHEMA

    scoped_graph = _projected_remote_graph(
        ["https://example.test/shared.git"] * 2,
        ["a" * 40, "b" * 40],
    )
    scoped_capsule = compile_task_capsule(
        task={"question": "Review divergence.", "scope": ["/repo"]},
        graph=scoped_graph,
        budget={"max_claims": 0},
    )
    assert scoped_capsule["conflicts"]
    forged_capsule = json.loads(json.dumps(scoped_capsule))
    forged_capsule["conflicts"] = []
    forged_capsule["fingerprint"] = fingerprint(
        {
            key: item
            for key, item in forged_capsule.items()
            if key not in {"capsule_id", "fingerprint"}
        }
    )
    moved_graph = _projected_remote_graph(
        ["https://example.test/shared.git"] * 2,
        ["a" * 40, "b" * 40],
        paths=["/outside/checkout-0", "/outside/checkout-1"],
    )
    moved_request = _governed_request(
        capsule=forged_capsule,
        receipt=_governed_receipt(forged_capsule),
        graph=moved_graph,
    )
    _bind_request_graph_workspace(moved_request)
    moved = ozone.verify_governed(moved_request)
    assert moved["schema"] == ozone.REFUSAL_SCHEMA
    assert moved["reason_codes"] == ["repair_graph_topology_unbound"]


def test_governed_verification_refuses_invalid_graph_relationship_endpoints():
    checkout_edges = [
        {"kind": "checkout_of", "from": "checkout:a", "to": "repository:x"},
        {"kind": "checkout_of", "from": "checkout:b", "to": "repository:x"},
    ]
    dangling = _governed_request(graph=True)
    dangling["graph"]["edges"] = checkout_edges

    wrong_kinds = _governed_request(graph=True)
    wrong_kinds["graph"]["edges"] = checkout_edges
    wrong_kinds["graph"]["nodes"] = [
        {"id": "checkout:a", "kind": "repository"},
        {"id": "checkout:b", "kind": "checkout"},
        {"id": "repository:x", "kind": "checkout"},
    ]

    multiple_owners = _governed_request(graph=True)
    multiple_owners["graph"]["edges"] = [
        {"kind": "checkout_of", "from": "checkout:a", "to": "repository:x"},
        {"kind": "checkout_of", "from": "checkout:a", "to": "repository:y"},
    ]
    multiple_owners["graph"]["nodes"] = _checkout_graph_nodes(
        multiple_owners["graph"]["edges"]
    )

    mismatched_conflict = _governed_request(graph=True)
    mismatched_conflict["graph"]["edges"] = [
        {"kind": "checkout_of", "from": "checkout:a", "to": "repository:y"},
        {"kind": "checkout_of", "from": "checkout:b", "to": "repository:y"},
    ]
    mismatched_conflict["graph"]["nodes"] = _checkout_graph_nodes(
        mismatched_conflict["graph"]["edges"]
    ) + [{"id": "repository:x", "kind": "repository"}]
    mismatched_conflict["graph"]["conflicts"] = [
        {
            "id": "conflict:x",
            "kind": "divergent_checkouts",
            "repository": "repository:x",
            "sides": [{"checkout": "checkout:a"}, {"checkout": "checkout:b"}],
        }
    ]

    for request in (dangling, wrong_kinds, multiple_owners, mismatched_conflict):
        result = ozone.verify_governed(request)

        assert result["schema"] == ozone.REFUSAL_SCHEMA
        assert result["reason_codes"] == ["invalid_repair_graph"]


def test_governed_verification_refuses_oversized_repair_identifiers():
    oversized_checkout = "checkout:" + "x" * 1024
    graph_request = _governed_request(graph=True)
    graph_request["graph"]["edges"] = [
        {
            "kind": "checkout_of",
            "from": oversized_checkout,
            "to": "repository:x",
        }
    ]
    graph_request["graph"]["nodes"] = _checkout_graph_nodes(
        graph_request["graph"]["edges"]
    )

    oversized_fact_capsule = _governed_capsule(
        claims=[
            {
                "id": "claim:oversized-fact",
                "fact": "x" * 1024,
                "subject": "checkout:a",
                "claim": "value",
                "evidence": [],
            }
        ]
    )
    capsule_request = _governed_request(
        capsule=oversized_fact_capsule,
        graph=True,
    )

    graph_result = ozone.verify_governed(graph_request)
    capsule_result = ozone.verify_governed(capsule_request)

    assert graph_result["schema"] == ozone.REFUSAL_SCHEMA
    assert graph_result["reason_codes"] == ["invalid_repair_graph"]
    assert capsule_result["schema"] == ozone.REFUSAL_SCHEMA
    assert capsule_result["reason_codes"] == ["invalid_repair_capsule"]


def test_governed_verification_refuses_malformed_repair_inputs_without_crashing():
    malformed_graph = {
        "schema": "vivary.workspace-graph/v0",
        "workspace_fingerprint": "sha256:test-workspace",
        "nodes": [],
        "edges": [None],
        "conflicts": [],
    }
    malformed = ozone.verify_governed(_governed_request(graph=malformed_graph))
    malformed_claim_capsule = _governed_capsule(
        claims=[
            {
                "id": "claim:malformed",
                "fact": [],
                "subject": "checkout:a",
                "claim": "This fact cannot be used as a dedupe key.",
                "selection": {"tier": "allowlisted"},
                "evidence": [],
            }
        ]
    )
    malformed_claim = ozone.verify_governed(
        _governed_request(capsule=malformed_claim_capsule, graph=True)
    )
    missing_capsule_request = _governed_request(graph=True)
    missing_capsule_request["capsule"] = None
    missing_capsule = ozone.verify_governed(missing_capsule_request)
    malformed_unknown_request = _governed_request(graph=True)
    malformed_unknown_request["graph"]["unknowns"] = [None]
    malformed_unknown = ozone.verify_governed(malformed_unknown_request)
    empty_graph = _governed_request(graph=True)["graph"]
    mismatched_graph_request = _governed_request(
        capsule=_governed_capsule(workspace_fingerprint="sha256:other"),
        graph=empty_graph,
    )
    uncollatable_graph_request = _governed_request(graph=True)
    uncollatable_graph_request["graph"]["edges"] = [
        {"kind": "checkout_of", "from": "checkout:a", "to": "repo:🚀"}
    ]
    uncollatable_graph_request["graph"]["nodes"] = _checkout_graph_nodes(
        uncollatable_graph_request["graph"]["edges"]
    )
    uncollatable_graph = ozone.verify_governed(uncollatable_graph_request)
    duplicate_edge_capsule = _governed_capsule(
        claims=[
            {
                "id": "claim:checkout-a",
                "fact": "head_revision",
                "subject": "checkout:a",
                "claim": "abc123",
                "evidence": [],
            }
        ]
    )
    duplicate_edge_request = _governed_request(
        capsule=duplicate_edge_capsule,
        graph=True,
    )
    checkout_edge = {
        "kind": "checkout_of",
        "from": "checkout:a",
        "to": "repository:x",
    }
    duplicate_edge_request["graph"]["edges"] = [checkout_edge, dict(checkout_edge)]
    duplicate_edge_request["graph"]["nodes"] = _checkout_graph_nodes(
        duplicate_edge_request["graph"]["edges"]
    )
    duplicate_edge_graph = ozone.verify_governed(duplicate_edge_request)
    oversized_conflict_request = _governed_request(graph=True)
    checkout_ids = [
        f"checkout:{index}" for index in range(MAX_DEDUPE_CHECKOUTS + 1)
    ]
    oversized_conflict_request["graph"]["edges"] = [
        {"kind": "checkout_of", "from": checkout_id, "to": "repository:x"}
        for checkout_id in checkout_ids
    ]
    oversized_conflict_request["graph"]["nodes"] = _checkout_graph_nodes(
        oversized_conflict_request["graph"]["edges"]
    )
    oversized_conflict_request["graph"]["conflicts"] = [
        {
            "id": "conflict:oversized",
            "kind": "divergent_checkouts",
            "repository": "repository:x",
            "sides": [{"checkout": checkout_id} for checkout_id in checkout_ids],
        }
    ]
    oversized_conflict_graph = ozone.verify_governed(oversized_conflict_request)
    mismatched_graph = ozone.verify_governed(mismatched_graph_request)
    recursive_request = _governed_request()
    nested = []
    cursor = nested
    for _ in range(1100):
        child = []
        cursor.append(child)
        cursor = child
    recursive_request["receipt"] = nested
    recursive = ozone.verify_governed(recursive_request)

    assert malformed["schema"] == ozone.REFUSAL_SCHEMA
    assert malformed["reason_codes"] == ["invalid_repair_graph"]
    assert malformed_claim["schema"] == ozone.REFUSAL_SCHEMA
    assert malformed_claim["reason_codes"] == ["invalid_capsule"]
    assert malformed_unknown["schema"] == ozone.REFUSAL_SCHEMA
    assert malformed_unknown["reason_codes"] == ["invalid_repair_graph"]
    assert missing_capsule["schema"] == ozone.REFUSAL_SCHEMA
    assert missing_capsule["reason_codes"] == [
        "invalid_capsule",
        "invalid_capsule_observed_at",
    ]
    assert uncollatable_graph["schema"] == ozone.REFUSAL_SCHEMA
    assert uncollatable_graph["reason_codes"] == ["invalid_repair_graph"]
    assert duplicate_edge_graph["schema"] == ozone.REFUSAL_SCHEMA
    assert duplicate_edge_graph["reason_codes"] == ["invalid_repair_graph"]
    assert oversized_conflict_graph["schema"] == ozone.REFUSAL_SCHEMA
    assert oversized_conflict_graph["reason_codes"] == ["invalid_repair_graph"]
    assert mismatched_graph["schema"] == ozone.REFUSAL_SCHEMA
    assert mismatched_graph["reason_codes"] == ["repair_graph_workspace_mismatch"]
    assert recursive["schema"] == ozone.REFUSAL_SCHEMA
    assert recursive["reason_codes"] == ["request_too_deeply_nested"]


def test_governed_verification_refuses_oversized_flat_request_before_evaluation():
    request = _governed_request()
    request["receipt"]["checks"][0]["detail"] = "x" * (
        ozone.MAX_REPAIR_PROJECTION_WORK + 1
    )

    result = ozone.verify_governed(request)

    assert result["schema"] == ozone.REFUSAL_SCHEMA
    assert result["outcome"] == "refused"
    assert result["reason_codes"] == ["request_work_unbounded"]
    assert result["receipt_verdict"] is None
    assert result["gate_verdict"] is None


def test_request_work_preflight_does_not_expand_wide_siblings_eagerly():
    class StopAfterFirst(list):
        def __iter__(self):
            yield "x" * ozone.MAX_REPAIR_PROJECTION_WORK
            raise AssertionError("request siblings were expanded before the limit")

    assert (
        ozone._bounded_json_work_units(
            StopAfterFirst(),
            ozone.MAX_REPAIR_PROJECTION_WORK,
        )
        is None
    )


def test_governed_verification_refuses_cycles_before_reexpanding_them():
    class SinglePassCyclicList(list):
        def __init__(self):
            super().__init__()
            self.iterations = 0

        def __iter__(self):
            self.iterations += 1
            if self.iterations > 1:
                raise AssertionError("cyclic request container was expanded twice")
            return super().__iter__()

    cycle = SinglePassCyclicList()
    cycle.append(cycle)
    cycle.append(cycle)
    request = _governed_request()
    request["receipt"]["runtime"]["cycle"] = cycle

    result = ozone.verify_governed(request)

    assert result["schema"] == ozone.REFUSAL_SCHEMA
    assert result["outcome"] == "refused"
    assert result["reason_codes"] == ["request_work_unbounded"]
    assert cycle.iterations == 1



def test_governed_verification_refuses_unbounded_repair_products():
    group_size = 20
    graph = _projected_local_groups(
        [group_size], include_claim_facts=True
    )
    checkout_ids = [
        node["id"] for node in graph["nodes"] if node["kind"] == "checkout"
    ]
    proposal_limit = (
        MAX_DEDUPE_CHECKOUTS * (MAX_DEDUPE_CHECKOUTS - 1) // 2
    )
    index_weight = group_size * (group_size - 1) // 2
    claims_per_checkout = proposal_limit // index_weight + 1
    claims = [
        {
            "fact": f"fact:{claim_index}",
            "subject": checkout_id,
            "claim": f"claim {claim_index}",
            "status": "known",
            "evidence": [],
        }
        for checkout_id in checkout_ids
        for claim_index in range(claims_per_checkout)
    ]
    governed_capsule = _governed_capsule(claims=claims)
    governed_capsule["budget"] = {"max_claims": len(claims)}
    governed_capsule["fingerprint"] = fingerprint(
        {
            key: item
            for key, item in governed_capsule.items()
            if key not in {"capsule_id", "fingerprint"}
        }
    )
    request = _governed_request(
        capsule=governed_capsule,
        receipt=False,
        graph=graph,
    )
    _bind_request_graph_workspace(request)

    result = ozone.verify_governed(request)

    assert result["schema"] == ozone.REFUSAL_SCHEMA
    assert result["reason_codes"] == ["repair_work_unbounded"]

    oversized_estimate_capsule = _governed_capsule(
        omissions=[
            {
                "kind": "claims_over_budget",
                "reason": "claim budget reached",
                "omitted_count": 2**53 - 1,
                "omitted": [
                    {
                        "subject_path": f"/repo/omitted/{index}",
                        "fact": f"omitted:{index}",
                        "tier": "allowlisted",
                    }
                    for index in range(OMITTED_LIST_CAP)
                ],
                "truncated": True,
            }
        ]
    )
    oversized_estimate = ozone.verify_governed(
        _governed_request(
            capsule=oversized_estimate_capsule,
            receipt=_governed_receipt(oversized_estimate_capsule),
            graph=True,
        )
    )

    assert oversized_estimate["schema"] == ozone.REFUSAL_SCHEMA
    assert oversized_estimate["reason_codes"] == [
        "repair_estimate_unbounded"
    ]


def test_governed_verification_refuses_unbounded_checkout_pair_scans():
    request = _governed_request(receipt=False, graph=True)
    request["graph"]["edges"] = [
        {
            "kind": "checkout_of",
            "from": f"checkout:{repository_index}:{checkout_index}",
            "to": f"repository:{repository_index}",
        }
        for repository_index in range(2)
        for checkout_index in range(MAX_DEDUPE_CHECKOUTS)
    ]
    request["graph"]["nodes"] = _checkout_graph_nodes(
        request["graph"]["edges"]
    )
    _bind_request_graph_workspace(request)

    result = ozone.verify_governed(request)

    assert result["schema"] == ozone.REFUSAL_SCHEMA
    assert result["reason_codes"] == ["repair_work_unbounded"]



def test_governed_verification_refuses_unbounded_projection_work():
    expansion_count = ozone.MAX_REPAIR_GRAPH_NODES
    checkout_path = "/" + (
        "a" * (ozone.MAX_REPAIR_PROJECTION_WORK // expansion_count + 1)
    )
    graph = {
        "schema": "vivary.workspace-graph/v0",
        "observed_at": NOW,
        "allowlist": [],
        "refusals": [],
        "nodes": [
            {
                "id": "checkout:projection-work",
                "kind": "checkout",
                "path": checkout_path,
                "facts": {
                    "is_git_repository": {
                        "status": "known",
                        "value": True,
                        "evidence": [],
                    },
                    "dirty_entries": {
                        "status": "known",
                        "value": [
                            {"path": f"file-{index}", "state": "M"}
                            for index in range(expansion_count)
                        ],
                        "evidence": [],
                    },
                },
            }
        ],
        "edges": [],
        "conflicts": [],
        "unknowns": [],
    }
    request = _governed_request(receipt=False, graph=graph)
    _bind_request_graph_workspace(request)

    result = ozone.verify_governed(request)

    assert result["schema"] == ozone.REFUSAL_SCHEMA
    core = ozone._load_core_verification()
    assert not ozone._repair_projection_work_is_bounded(graph, core)
    bounded_graph = json.loads(json.dumps(graph))
    bounded_graph["nodes"][0]["path"] = "/repo"
    assert ozone._repair_projection_work_is_bounded(bounded_graph, core)
    assert result["reason_codes"] == ["repair_work_unbounded"]
    over_expansion_graph = json.loads(json.dumps(bounded_graph))
    over_expansion_graph["nodes"][0]["facts"]["dirty_entries"]["value"].append(
        {"path": "one-too-many", "state": "M"}
    )
    assert not ozone._repair_projection_work_is_bounded(
        over_expansion_graph, core
    )
    over_expansion_request = _governed_request(
        receipt=False, graph=over_expansion_graph
    )
    _bind_request_graph_workspace(over_expansion_request)
    over_expansion = ozone.verify_governed(over_expansion_request)
    assert over_expansion["schema"] == ozone.REFUSAL_SCHEMA
    assert over_expansion["reason_codes"] == ["repair_work_unbounded"]
    pair_graph = _projected_local_groups([47])
    pair_graph["edges"] = []
    assert (
        core["projected_neighbor_pair_count"](pair_graph)
        > ozone.MAX_REPAIR_GRAPH_EDGES
    )
    assert not ozone._repair_projection_work_is_bounded(pair_graph, core)
    pair_request = _governed_request(receipt=False, graph=pair_graph)
    _bind_request_graph_workspace(pair_request)
    pair_result = ozone.verify_governed(pair_request)
    assert pair_result["schema"] == ozone.REFUSAL_SCHEMA
    assert pair_result["reason_codes"] == ["repair_work_unbounded"]

    at_limit_count = ozone.MAX_REPAIR_GRAPH_NODES - 2
    at_limit_graph = _projected_graph(
        [
            {
                "path": "/repo/at-limit",
                "facts": {
                    "is_git_repository": {
                        "status": "known",
                        "value": True,
                        "evidence": [],
                    },
                    "git_common_dir": {
                        "status": "known",
                        "value": "/repo/.git",
                        "evidence": [],
                    },
                    "dirty_entries": {
                        "status": "known",
                        "value": [
                            {"path": f"file-{index}", "state": "M"}
                            for index in range(at_limit_count)
                        ],
                        "evidence": [],
                    },
                },
            }
        ],
        allowlist=["/repo"],
    )
    assert len(at_limit_graph["nodes"]) == ozone.MAX_REPAIR_GRAPH_NODES
    assert ozone._repair_projection_work_is_bounded(at_limit_graph, core)
    at_limit_capsule = compile_task_capsule(
        task={
            "question": "Review the at-limit projection.",
            "scope": ["/repo"],
            "required_checks": [
                {
                    "name": "unit",
                    "command": "python packages/ozone/tests/test_ozone.py",
                    "cwd": "/repo/at-limit",
                }
            ],
        },
        graph=at_limit_graph,
    )
    at_limit = ozone.verify_governed(
        _governed_request(
            capsule=at_limit_capsule,
            receipt=_governed_receipt(at_limit_capsule),
            graph=at_limit_graph,
        )
    )
    assert at_limit["schema"] == ozone.VERIFICATION_SCHEMA
    assert at_limit["outcome"] == "sufficient"


def test_governed_verification_bounds_scope_path_comparisons():
    capsule = _governed_capsule(
        claims=[
            {
                "subject": f"checkout:{index}",
                "subject_path": f"/scope/{index}/checkout",
            }
            for index in range(251)
        ]
    )
    capsule["task"]["scope"] = [
        f"/scope/{index}" for index in range(398)
    ]
    assert ozone._capsule_scope_is_valid(
        capsule,
        {"is_within_allowlist": lambda root, path: path.startswith(root + "/")},
    )

    capsule["task"]["scope"].append("/scope/overflow")
    assert not ozone._capsule_scope_is_valid(
        capsule,
        {"is_within_allowlist": lambda root, path: path.startswith(root + "/")},
    )


def test_governed_verification_bounds_graph_context_scope_comparisons():
    checkout_count = 251
    scope_count = ozone.MAX_SCOPE_PATH_COMPARISONS // checkout_count + 1
    graph = _projected_local_groups([1] * checkout_count)
    capsule = _governed_capsule(
        workspace_fingerprint=graph["workspace_fingerprint"],
        topology_fingerprint=repair_topology_fingerprint(graph),
    )
    capsule["task"].pop("required_checks")
    capsule["required_checks"] = []
    capsule["task"]["scope"] = [
        f"/scope/{index}" for index in range(scope_count)
    ]
    capsule["fingerprint"] = fingerprint(
        {
            key: item
            for key, item in capsule.items()
            if key not in {"capsule_id", "fingerprint"}
        }
    )

    result = ozone.verify_governed(
        _governed_request(capsule=capsule, receipt=False, graph=graph)
    )

    assert result["schema"] == ozone.REFUSAL_SCHEMA
    assert result["reason_codes"] == ["repair_work_unbounded"]
    mixed_checkouts = [
        {
            "path": f"/repo/git-{index}",
            "facts": {
                "is_git_repository": {
                    "status": "known",
                    "value": True,
                    "evidence": [],
                },
                "git_common_dir": {
                    "status": "known",
                    "value": f"/repo/git-{index}/.git",
                    "evidence": [],
                },
            },
        }
        for index in range(250)
    ]
    mixed_checkouts.extend(
        {
            "path": f"/repo/plain-{index}",
            "facts": {
                "is_git_repository": {
                    "status": "known",
                    "value": False,
                    "evidence": [],
                }
            },
        }
        for index in range(60)
    )
    mixed_graph = _projected_graph(mixed_checkouts, allowlist=["/repo"])
    mixed_capsule = compile_task_capsule(
        task={"question": "Review Git checkouts.", "scope": ["/repo"]},
        graph=mixed_graph,
    )
    core = ozone._load_core_verification()
    assert ozone._graph_context_checkouts_bounded(
        mixed_capsule, mixed_graph, core
    )
    mixed_result = ozone.verify_governed(
        _governed_request(
            capsule=mixed_capsule,
            receipt=False,
            graph=mixed_graph,
        )
    )
    assert mixed_result["schema"] == ozone.VERIFICATION_SCHEMA

    unknown_count = 1_000
    unknown_facts = {
        "is_git_repository": {
            "status": "known",
            "value": True,
            "evidence": [],
        },
        "git_common_dir": {
            "status": "known",
            "value": "/outside/.git",
            "evidence": [],
        },
    }
    unknown_facts.update(
        {
            f"unknown_{index}": {
                "status": "unknown",
                "reason": "not_observed",
                "evidence": [],
            }
            for index in range(unknown_count)
        }
    )
    unknown_graph = _projected_graph(
        [{"path": "/outside/checkout", "facts": unknown_facts}]
    )
    unknown_scope_count = (
        ozone.MAX_SCOPE_PATH_COMPARISONS // (unknown_count + 1) + 1
    )
    unknown_capsule = _governed_capsule(
        workspace_fingerprint=unknown_graph["workspace_fingerprint"],
        topology_fingerprint=repair_topology_fingerprint(unknown_graph),
    )
    unknown_capsule["task"].pop("required_checks")
    unknown_capsule["required_checks"] = []
    unknown_capsule["task"]["scope"] = [
        f"/scope/{index}" for index in range(unknown_scope_count)
    ]
    unknown_capsule["fingerprint"] = fingerprint(
        {
            key: item
            for key, item in unknown_capsule.items()
            if key not in {"capsule_id", "fingerprint"}
        }
    )
    unknown_result = ozone.verify_governed(
        _governed_request(
            capsule=unknown_capsule,
            receipt=False,
            graph=unknown_graph,
        )
    )
    assert unknown_result["schema"] == ozone.REFUSAL_SCHEMA
    assert unknown_result["reason_codes"] == ["repair_work_unbounded"]


def test_governed_verification_bounds_actual_scope_conflict_comparisons():
    conflict_count = MAX_DEDUPE_CHECKOUTS // 2
    graph = _projected_local_groups(
        [2] * conflict_count,
        divergent=True,
    )

    def request_for(scope_count):
        capsule = compile_task_capsule(
            task={
                "question": "Review divergence.",
                "scope": [
                    f"/scope/{index}" for index in range(scope_count)
                ],
            },
            graph=graph,
            budget={"max_claims": 0},
        )
        return _governed_request(
            capsule=capsule,
            receipt=_governed_receipt(capsule),
            graph=graph,
        )

    at_limit = ozone.verify_governed(
        request_for(MAX_DEDUPE_CHECKOUTS - 1)
    )
    over_limit = ozone.verify_governed(
        request_for(MAX_DEDUPE_CHECKOUTS + 1)
    )

    assert at_limit["schema"] == ozone.VERIFICATION_SCHEMA
    assert at_limit["outcome"] == "sufficient"
    assert over_limit["schema"] == ozone.REFUSAL_SCHEMA
    assert over_limit["reason_codes"] == ["repair_work_unbounded"]


def test_governed_verification_refuses_unbounded_route_evidence():
    overflow_checkout = f"checkout:{MAX_DEDUPE_CHECKOUTS:03d}"
    claim_facts = (
        ("head_revision", f"HEAD revision is {'a' * 40}"),
        ("is_dirty", "worktree is clean"),
        ("remotes", "no remotes are configured"),
    )
    capsule = _governed_capsule(
        claims=[
            {
                "fact": fact,
                "subject": overflow_checkout,
                "claim": claim,
                "status": "known",
                "evidence": [],
            }
            for fact, claim in claim_facts
        ],
        omissions=[
            {
                "kind": "claims_over_budget",
                "reason": "claim budget reached",
                "omitted_count": 1,
                "omitted": [
                    {
                        "subject_path": "/repo/omitted",
                        "fact": "omitted:0",
                        "tier": "allowlisted",
                    }
                ],
            }
        ],
    )
    request = _governed_request(
        capsule=capsule,
        receipt=False,
        graph=True,
    )
    request["graph"]["edges"] = [
        {
            "kind": "checkout_of",
            "from": f"checkout:{index:03d}",
            "to": "repository:x",
        }
        for index in range(MAX_DEDUPE_CHECKOUTS + 1)
    ]
    request["graph"]["nodes"] = _checkout_graph_nodes(
        request["graph"]["edges"]
    )
    for node in request["graph"]["nodes"]:
        if node["id"] == overflow_checkout:
            node["path"] = "/repo/packages/ozone"
    _bind_request_graph_workspace(request)

    result = ozone.verify_governed(request)

    assert result["schema"] == ozone.REFUSAL_SCHEMA
    assert result["reason_codes"] == ["repair_work_unbounded"]


def test_governed_verification_refuses_unbounded_or_inconsistent_omission_lists():
    oversized_omitted = [
        {
            "subject_path": f"/repo/omitted/{index}",
            "fact": f"omitted:{index}",
            "tier": "allowlisted",
        }
        for index in range(OMITTED_LIST_CAP + 1)
    ]
    inconsistent_omitted = oversized_omitted[:2]

    for omitted_count, omitted in (
        (len(oversized_omitted), oversized_omitted),
        (1, inconsistent_omitted),
    ):
        capsule = _governed_capsule(
            omissions=[
                {
                    "kind": "claims_over_budget",
                    "reason": "claim budget reached",
                    "omitted_count": omitted_count,
                    "omitted": omitted,
                }
            ]
        )

        result = ozone.verify_governed(
            _governed_request(capsule=capsule, graph=True)
        )

        assert result["schema"] == ozone.REFUSAL_SCHEMA
        assert result["reason_codes"] == ["invalid_capsule"]


def test_governed_verification_refuses_malformed_gate_constraints():
    malformed_constraints = (
        ("required_checks", "unit"),
        ("required_checks", ["unit", 1]),
        ("require_claims_verified", 1),
        ("max_unresolved_conflicts", "0"),
        ("max_unresolved_conflicts", True),
        ("max_unresolved_unknowns", []),
    )

    for field, value in malformed_constraints:
        request = _governed_request()
        request["gate"][field] = value

        result = ozone.verify_governed(request)

        assert result["schema"] == ozone.REFUSAL_SCHEMA
        assert result["reason_codes"] == ["invalid_gate"]

    nullable_request = _governed_request()
    nullable_request["gate"].update(
        {
            "required_checks": None,
            "require_claims_verified": None,
            "max_unresolved_conflicts": None,
            "max_unresolved_unknowns": None,
        }
    )
    assert ozone.verify_governed(nullable_request)["schema"] == ozone.VERIFICATION_SCHEMA


def test_governed_verification_refuses_unbound_graph_and_unknown_gate_fields():
    unbound_graph_request = _governed_request(graph=True)
    del unbound_graph_request["graph"]["workspace_fingerprint"]
    unbound_graph = ozone.verify_governed(unbound_graph_request)
    unknown_gate_request = _governed_request()
    unknown_gate_request["gate"]["max_unresolved_conflict"] = 0
    unknown_gate = ozone.verify_governed(unknown_gate_request)

    lossy_integer_request = _governed_request()
    lossy_integer_request["gate"]["max_unresolved_unknowns"] = 2**53
    lossy_integer = ozone.verify_governed(lossy_integer_request)

    assert unbound_graph["schema"] == ozone.REFUSAL_SCHEMA
    assert unbound_graph["reason_codes"] == ["invalid_repair_graph"]
    assert unknown_gate["schema"] == ozone.REFUSAL_SCHEMA
    assert unknown_gate["reason_codes"] == [
        "unknown_gate_field:max_unresolved_conflict"
    ]
    assert lossy_integer["schema"] == ozone.REFUSAL_SCHEMA
    assert lossy_integer["reason_codes"] == ["invalid_json_value"]


def test_governed_verify_cli_escapes_unencodable_refusal_reasons():
    with temp_workspace() as td:
        request_path = td / "request.json"
        request = _governed_request()
        request["\ud800"] = True
        request_path.write_text(json.dumps(request), encoding="utf-8")

        raw_output = io.BytesIO()
        strict_stdout = io.TextIOWrapper(
            raw_output,
            encoding="utf-8",
            errors="strict",
        )
        with contextlib.redirect_stdout(strict_stdout):
            return_code = ozone.main(
                ["verify", str(request_path), "--governed"]
            )
        strict_stdout.flush()
        output = raw_output.getvalue().decode("utf-8")

    assert return_code == 2
    assert output.splitlines() == [
        "ozone verify: refused",
        "reasons: unknown_field:\\ud800",
    ]


def test_governed_verify_rejects_receipts_that_identify_request():
    with temp_workspace() as td:
        request_path = td / "request.json"
        request = _governed_request()
        request_path.write_text(json.dumps(request), encoding="utf-8")
        receipt_alias = td / "request-receipt.json"
        os.link(request_path, receipt_alias)
        original = request_path.read_bytes()
        previous_receipt_path = os.environ.get(ozone.RECEIPT_ENV)
        try:
            for receipt_args, env_receipt_path in (
                (["--receipt", str(request_path)], None),
                ([], str(receipt_alias)),
            ):
                if env_receipt_path is None:
                    os.environ.pop(ozone.RECEIPT_ENV, None)
                else:
                    os.environ[ozone.RECEIPT_ENV] = env_receipt_path
                stdout = io.StringIO()
                stderr = io.StringIO()
                with (
                    contextlib.redirect_stdout(stdout),
                    contextlib.redirect_stderr(stderr),
                ):
                    return_code = ozone.main(
                        ["verify", str(request_path), "--governed", *receipt_args]
                    )

                assert return_code == 2
                assert stdout.getvalue() == ""
                assert stderr.getvalue() == (
                    "ozone: receipt: receipt path must not identify the verification request\n"
                )
                assert request_path.read_bytes() == original
                assert json.loads(request_path.read_text(encoding="utf-8")) == request
        finally:
            if previous_receipt_path is None:
                os.environ.pop(ozone.RECEIPT_ENV, None)
            else:
                os.environ[ozone.RECEIPT_ENV] = previous_receipt_path

        for governed_args in (["--governed"], []):
            with request_path.open("rb") as stdin:
                completed = subprocess.run(
                    [
                        sys.executable,
                        str(OZONE_ROOT / "ozone.py"),
                        "verify",
                        "-",
                        *governed_args,
                        "--receipt",
                        str(request_path),
                    ],
                    stdin=stdin,
                    capture_output=True,
                    text=True,
                    check=False,
                )
            assert completed.returncode == 2
            assert completed.stdout == ""
            assert completed.stderr == (
                "ozone: receipt: receipt path must not identify the verification request\n"
            )
            assert request_path.read_bytes() == original

            piped = subprocess.run(
                [
                    sys.executable,
                    str(OZONE_ROOT / "ozone.py"),
                    "verify",
                    "-",
                    *governed_args,
                    "--receipt",
                    str(request_path),
                ],
                input=json.dumps(request),
                capture_output=True,
                text=True,
                check=False,
            )
            assert piped.returncode == 2
            assert piped.stdout == ""
            assert piped.stderr == (
                "ozone: receipt: receipt path must not identify the verification request\n"
            )
            assert request_path.read_bytes() == original

        invalid_stdout = io.StringIO()
        invalid_stderr = io.StringIO()
        with (
            contextlib.redirect_stdout(invalid_stdout),
            contextlib.redirect_stderr(invalid_stderr),
        ):
            invalid_return_code = ozone.main(
                [
                    "verify",
                    str(request_path),
                    "--receipt",
                    str(request_path),
                ]
            )
        assert invalid_return_code == 2
        assert invalid_stdout.getvalue() == ""
        assert invalid_stderr.getvalue() == (
            "ozone: receipt: receipt path must not identify the verification request\n"
        )
        assert request_path.read_bytes() == original

        help_stdout = io.StringIO()
        help_stderr = io.StringIO()
        help_exit = None
        try:
            with (
                contextlib.redirect_stdout(help_stdout),
                contextlib.redirect_stderr(help_stderr),
            ):
                ozone.main(
                    [
                        "verify",
                        str(request_path),
                        "--rece",
                        str(request_path),
                        "--he",
                    ]
                )
        except SystemExit as exc:
            help_exit = exc
        assert help_exit is not None
        assert help_exit.code == 0
        assert "usage: ozone" in help_stdout.getvalue()
        assert help_stderr.getvalue() == ""
        assert request_path.read_bytes() == original

        stdin_help_receipt = td / "stdin-help.jsonl"
        stdin_help_stdout = io.StringIO()
        stdin_help_exit = None
        try:
            with (
                contextlib.redirect_stdout(stdin_help_stdout),
                contextlib.redirect_stderr(io.StringIO()),
            ):
                ozone.main(
                    [
                        "verify",
                        "-",
                        "--governed",
                        "--receipt",
                        str(stdin_help_receipt),
                        "--help",
                    ]
                )
        except SystemExit as exc:
            stdin_help_exit = exc
        assert stdin_help_exit is not None
        assert stdin_help_exit.code == 0
        assert "usage: ozone" in stdin_help_stdout.getvalue()
        assert not stdin_help_receipt.exists()

        separator_stderr = io.StringIO()
        try:
            os.environ[ozone.RECEIPT_ENV] = str(request_path)
            with contextlib.redirect_stderr(separator_stderr):
                separator_return_code = ozone.main(
                    [
                        "verify",
                        "--governed",
                        str(request_path),
                        "--",
                        "--help",
                    ]
                )
        finally:
            if previous_receipt_path is None:
                os.environ.pop(ozone.RECEIPT_ENV, None)
            else:
                os.environ[ozone.RECEIPT_ENV] = previous_receipt_path
        assert separator_return_code == 2
        assert separator_stderr.getvalue() == (
            "ozone: receipt: receipt path must not identify the verification request\n"
        )
        assert request_path.read_bytes() == original

        invalid_receipt = td / "invalid-runs.jsonl"
        invalid_usage_exit = None
        try:
            with contextlib.redirect_stderr(io.StringIO()):
                ozone.main(
                    [
                        "verify",
                        str(request_path),
                        "--receipt",
                        str(invalid_receipt),
                    ]
                )
        except SystemExit as exc:
            invalid_usage_exit = exc
        assert invalid_usage_exit is not None
        assert invalid_usage_exit.code == 2
        invalid_record = json.loads(invalid_receipt.read_text(encoding="utf-8"))
        assert invalid_record["command"] == "verify"
        assert invalid_record["exit_code"] == 2

        abbreviated_stdout = io.StringIO()
        abbreviated_stderr = io.StringIO()
        with (
            contextlib.redirect_stdout(abbreviated_stdout),
            contextlib.redirect_stderr(abbreviated_stderr),
        ):
            abbreviated_return_code = ozone.main(
                [
                    "verify",
                    str(request_path),
                    "--governed",
                    "--roo",
                    str(td),
                    "--rece",
                    str(request_path),
                ]
            )
        assert abbreviated_return_code == 2
        assert abbreviated_stdout.getvalue() == ""
        assert abbreviated_stderr.getvalue() == (
            "ozone: receipt: receipt path must not identify the verification request\n"
        )
        assert request_path.read_bytes() == original
        receipt_path = td / "runs.jsonl"
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            distinct_return_code = ozone.main(
                [
                    "verify",
                    str(request_path),
                    "--governed",
                    "--json",
                    "--receipt",
                    str(receipt_path),
                ]
            )
        assert distinct_return_code == 0
        assert json.loads(stdout.getvalue())["outcome"] == "sufficient"
        records = [
            json.loads(line)
            for line in receipt_path.read_text(encoding="utf-8").splitlines()
        ]
        assert [record["command"] for record in records] == ["verify"]

        previous_stdin = sys.stdin
        stdin_stdout = io.StringIO()
        stdin_stderr = io.StringIO()
        try:
            sys.stdin = io.StringIO(json.dumps(request))
            with (
                contextlib.redirect_stdout(stdin_stdout),
                contextlib.redirect_stderr(stdin_stderr),
            ):
                stdin_return_code = ozone.main(
                    ["verify", "-", "--governed", "--json", "--receipt", str(receipt_path)]
                )
        finally:
            sys.stdin = previous_stdin
        assert stdin_return_code == 2
        assert stdin_stdout.getvalue() == ""
        assert stdin_stderr.getvalue() == (
            "ozone: receipt: receipt path must not identify the verification request\n"
        )
        records = [
            json.loads(line)
            for line in receipt_path.read_text(encoding="utf-8").splitlines()
        ]
        assert [record["command"] for record in records] == ["verify"]


def test_governed_verify_cli_emits_typed_json_and_honest_exit_codes():
    with temp_workspace() as td:
        request_path = td / "request.json"
        request_path.write_text(
            json.dumps(_governed_request()),
            encoding="utf-8",
        )
        sufficient_rc, sufficient = _run_json(
            ["verify", str(request_path), "--governed", "--json", "--strict"]
        )

        tampered_request = _governed_request()
        tampered_request["receipt"]["checks"][0]["outcome"] = "failed"
        request_path.write_text(json.dumps(tampered_request), encoding="utf-8")
        insufficient_rc, insufficient = _run_json(
            ["verify", str(request_path), "--governed", "--json", "--strict"]
        )
        refused_request = _governed_request(gate={})
        request_path.write_text(json.dumps(refused_request), encoding="utf-8")
        refused_rc, refused = _run_json(
            ["verify", str(request_path), "--governed", "--json"]
        )

        request_path.write_text("{", encoding="utf-8")
        malformed_rc, malformed = _run_json(
            ["verify", str(request_path), "--governed", "--json"]
        )

    assert sufficient_rc == 0
    assert sufficient["outcome"] == "sufficient"
    assert insufficient_rc == 1
    assert insufficient["outcome"] == "insufficient"
    assert refused_rc == 2
    assert refused["schema"] == ozone.REFUSAL_SCHEMA
    assert refused["reason_codes"] == ["invalid_gate"]
    assert malformed_rc == 2
    assert malformed["schema"] == ozone.REFUSAL_SCHEMA
    assert malformed["reason_codes"] == ["invalid_request_document"]


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    passed = 0
    for fn in fns:
        try:
            fn()
            print(f"  ok  {fn.__name__}")
            passed += 1
        except Exception as e:
            print(f"FAIL  {fn.__name__}: {e}")
    print(f"\n{passed}/{len(fns)} passed")
    sys.exit(0 if passed == len(fns) else 1)

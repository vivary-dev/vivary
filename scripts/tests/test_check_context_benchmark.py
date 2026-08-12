"""Tests for scripts/check_context_benchmark.py.

Pins the protocol-only freeze and the hard results gates: 24 unique trials,
derived support, settings/corpus/runtime drift, caller-verdict rejection,
3/3 support, cohort-separated median/IQR/bootstrap summaries, and plausible
tampering bugs. Does not create committed results.json.
"""

from __future__ import annotations

import copy
import hashlib
import importlib.util
import json
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
GUARD = ROOT / "scripts" / "check_context_benchmark.py"
REAL_MANIFEST = ROOT / "benchmarks" / "context-retrieval" / "manifest.json"
REAL_QUESTIONS = ROOT / "benchmarks" / "context-retrieval" / "questions.json"


def _load():
    spec = importlib.util.spec_from_file_location("check_context_benchmark", GUARD)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def _read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def _write_json(path: Path, payload) -> None:
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")


def _settings_hash(manifest) -> str:
    module = _load()
    return module.compute_settings_hash(manifest)


def _digest(label: str) -> str:
    return hashlib.sha256(label.encode("utf-8")).hexdigest()


def _supported_claims(question: dict) -> list[dict]:
    claims = []
    for claim_id in question["required_claim_ids"]:
        expected = question["expected_claims"][claim_id]
        evidence = expected["accepted_evidence"][0]
        claims.append(
            {
                "claim_id": claim_id,
                "value": expected["value"],
                "evidence": [
                    {
                        "path": evidence["path"],
                        "line_hash": evidence["line_hash"],
                    }
                ],
            }
        )
    return claims


def _trial(question: dict, *, arm: str, replicate: int, settings_hash: str, model: str, **overrides):
    claims = _supported_claims(question)
    cited_paths = list(
        dict.fromkeys(
            evidence["path"]
            for claim in claims
            for evidence in claim["evidence"]
        )
    )
    row = {
        "question_id": question["id"],
        "arm": arm,
        "replicate": replicate,
        "model": model,
        "settings_hash": settings_hash,
        "input_tokens": 100 + replicate,
        "output_tokens": 40 + replicate,
        "turns": 2,
        "retrieval_calls": 1 if arm == "vivary" else 3,
        "files_opened": cited_paths,
        "wrong_files_opened": 0,
        "supported": True,
        "time_to_verified_answer_ms": 1000 + 10 * replicate,
        "claims": claims,
        "unknowns": [],
        "raw_answer": f"supported answer for {question['id']} {arm} {replicate}",
    }
    row.update(overrides)
    return row


def _full_results(manifest, questions_doc, *, mutate=None):
    settings_hash = _settings_hash(manifest)
    model = manifest["model"]["id"]
    trials = []
    for question in questions_doc["questions"]:
        for arm in ("baseline", "vivary"):
            for replicate in (1, 2, 3):
                trials.append(
                    _trial(
                        question,
                        arm=arm,
                        replicate=replicate,
                        settings_hash=settings_hash,
                        model=model,
                        input_tokens=120 if arm == "baseline" else 80,
                        output_tokens=50 if arm == "baseline" else 35,
                        turns=4 if arm == "baseline" else 2,
                        time_to_verified_answer_ms=1500 if arm == "baseline" else 900,
                    )
                )
    runtime = {
        "model_runtime_version": "test-runtime/1",
        "runtime_source_hash": _digest("runtime-source"),
        "runtime_package_hashes": {"vivary-tropo": _digest("pkg-tropo")},
        "runtime_wheel_hashes": {"vivary-tropo": _digest("wheel-tropo")},
        "adopted_corpus_tree_hash": _digest("adopted-tree"),
        "settings_hash": settings_hash,
    }
    manifest["runtime"] = copy.deepcopy(runtime)
    payload = {
        "corpus_sha": questions_doc["corpus_sha"],
        "settings_hash": settings_hash,
        "runtime": runtime,
        "trials": trials,
    }
    if mutate is not None:
        mutate(payload, questions_doc, manifest)
    return payload


def test_real_protocol_only_passes_without_results_and_is_not_modified():
    module = _load()
    before_manifest = REAL_MANIFEST.read_bytes()
    before_questions = REAL_QUESTIONS.read_bytes()
    report = module.validate(
        manifest_path=REAL_MANIFEST,
        questions_path=REAL_QUESTIONS,
        results_path=ROOT / "benchmarks" / "context-retrieval" / "results.json",
        require_results=False,
    )
    assert report["ok"] is True
    assert report["mode"] == "protocol_only"
    assert report["total_trials_expected"] == 24
    assert len(report["questions"]) == 4
    assert REAL_MANIFEST.read_bytes() == before_manifest
    assert REAL_QUESTIONS.read_bytes() == before_questions
    assert not (ROOT / "benchmarks" / "context-retrieval" / "results.json").exists()
    assert not (ROOT / "docs" / "BENCHMARK.md").exists()


def test_cli_protocol_only_exit_zero():
    module = _load()
    code = module.main(["--manifest", str(REAL_MANIFEST), "--questions", str(REAL_QUESTIONS), "--results", str(ROOT / "benchmarks" / "context-retrieval" / "no-results.json")])
    assert code == 0


def test_manifest_settings_hash_matches_inputs():
    module = _load()
    manifest = _read_json(REAL_MANIFEST)
    assert manifest["settings_hash"] == module.compute_settings_hash(manifest)
    assert manifest["train_label"] == "Vivary Governed Context"
    assert manifest["model"]["id"] == "openai-codex/gpt-5.6-sol"
    assert manifest["corpus"]["public_sha"] == "cbbd340dbf0ffebfe17ad5257ecd93b83ab570de"


def test_valid_results_pass_and_keep_cohorts_separate():
    module = _load()
    manifest = _read_json(REAL_MANIFEST)
    questions = _read_json(REAL_QUESTIONS)
    payload = _full_results(manifest, questions)

    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        manifest_path = tmp_path / "manifest.json"
        questions_path = tmp_path / "questions.json"
        results_path = tmp_path / "results.json"
        _write_json(manifest_path, manifest)
        _write_json(questions_path, questions)
        _write_json(results_path, payload)

        report = module.validate(
            manifest_path=manifest_path,
            questions_path=questions_path,
            results_path=results_path,
            require_results=True,
        )

    assert report["ok"] is True
    assert report["mode"] == "results"
    assert report["trials"] == 24
    assert report["all_supported"] is True
    assert set(report["arm_summaries"]) == {"baseline", "vivary"}
    # Arms stay separated: baseline medians are higher with the fixture values.
    assert report["arm_summaries"]["baseline"]["input_tokens"]["median"] > report["arm_summaries"]["vivary"]["input_tokens"]["median"]
    for qid, arms in report["question_summaries"].items():
        assert set(arms) == {"baseline", "vivary"}
        assert qid in report["median_deltas_vivary_minus_baseline"]
        delta = report["median_deltas_vivary_minus_baseline"][qid]["input_tokens"]
        assert delta < 0
    # bootstrap CI is deterministic with the fixed seed
    ci_a = report["arm_summaries"]["baseline"]["input_tokens"]["bootstrap_95ci"]
    with tempfile.TemporaryDirectory() as tmp2:
        tmp_path = Path(tmp2)
        m = tmp_path / "manifest.json"
        q = tmp_path / "questions.json"
        r = tmp_path / "results.json"
        _write_json(m, manifest)
        _write_json(q, questions)
        _write_json(r, payload)
        report2 = module.validate(manifest_path=m, questions_path=q, results_path=r, require_results=True)
    assert report2["arm_summaries"]["baseline"]["input_tokens"]["bootstrap_95ci"] == ci_a


def _expect_fail(mutate):
    module = _load()
    manifest = _read_json(REAL_MANIFEST)
    questions = _read_json(REAL_QUESTIONS)
    payload = _full_results(manifest, questions, mutate=mutate)
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        manifest_path = tmp_path / "manifest.json"
        questions_path = tmp_path / "questions.json"
        results_path = tmp_path / "results.json"
        _write_json(manifest_path, manifest)
        _write_json(questions_path, questions)
        _write_json(results_path, payload)
        try:
            module.validate(
                manifest_path=manifest_path,
                questions_path=questions_path,
                results_path=results_path,
                require_results=True,
            )
        except module.ProtocolError as exc:
            return str(exc)
    raise AssertionError("expected ProtocolError")


def test_rejects_caller_supported_value_when_claims_fail():
    def mutate(payload, questions, manifest):
        payload["trials"][0]["claims"] = []
        payload["trials"][0]["supported"] = True

    message = _expect_fail(mutate)
    assert "disagrees with validator-derived support" in message


def test_rejects_unknown_caller_verdict_field():
    def mutate(payload, questions, manifest):
        payload["trials"][0]["verdict"] = "pass"

    message = _expect_fail(mutate)
    assert "unknown caller verdict" in message


def test_rejects_settings_hash_drift():
    def mutate(payload, questions, manifest):
        payload["settings_hash"] = _digest("tampered-settings")
        for row in payload["trials"]:
            row["settings_hash"] = payload["settings_hash"]

    message = _expect_fail(mutate)
    assert "settings_hash" in message


def test_rejects_corpus_sha_drift():
    def mutate(payload, questions, manifest):
        payload["corpus_sha"] = "0" * 40

    message = _expect_fail(mutate)
    assert "corpus" in message.lower()


def test_rejects_missing_manifest_runtime_hash():
    def mutate(payload, questions, manifest):
        del manifest["runtime"]["adopted_corpus_tree_hash"]

    message = _expect_fail(mutate)
    assert "adopted_corpus_tree_hash" in message


def test_rejects_duplicate_or_missing_trial_matrix():
    def mutate(payload, questions, manifest):
        # drop last trial and duplicate the first
        payload["trials"].pop()
        payload["trials"].append(copy.deepcopy(payload["trials"][0]))

    message = _expect_fail(mutate)
    assert "duplicate" in message.lower() or "matrix" in message.lower()


def test_rejects_non_source_evidence_path():
    def mutate(payload, questions, manifest):
        row = payload["trials"][0]
        claim = row["claims"][0]
        claim["evidence"] = [{"path": "site/src/content/docs/fake.md", "line_hash": "a" * 64}]
        row["supported"] = True

    message = _expect_fail(mutate)
    assert "supported" in message.lower() or "derived" in message.lower() or "caller" in message.lower()


def test_rejects_wrong_claim_value():
    def mutate(payload, questions, manifest):
        row = payload["trials"][0]
        row["claims"][0]["value"] = "not-the-owner"
        row["supported"] = True

    message = _expect_fail(mutate)
    assert "supported" in message.lower() or "derived" in message.lower() or "caller" in message.lower()


def test_rejects_wrong_files_opened_mismatch():
    def mutate(payload, questions, manifest):
        row = payload["trials"][0]
        row["files_opened"] = list(row["files_opened"]) + ["totally/unrelated.py"]
        row["wrong_files_opened"] = 0  # lies about wrong files

    message = _expect_fail(mutate)
    assert "wrong_files_opened" in message


def test_rejects_traversal_path_disguised_as_accepted_evidence():
    def mutate(payload, questions, manifest):
        payload["trials"][0]["claims"][0]["evidence"][0]["path"] = "../../README.md"

    message = _expect_fail(mutate)
    assert "canonical and repository-relative" in message


def test_rejects_unknown_results_verdict_field():
    def mutate(payload, questions, manifest):
        payload["verdict"] = "pass"

    message = _expect_fail(mutate)
    assert "fields must be exactly" in message


def test_rejects_cited_evidence_not_recorded_as_opened():
    def mutate(payload, questions, manifest):
        payload["trials"][0]["files_opened"] = []

    message = _expect_fail(mutate)
    assert "absent from files_opened" in message


def test_rejects_vivary_search_even_when_settings_hash_is_recomputed():
    def mutate(payload, questions, manifest):
        manifest["arms"]["vivary"]["allowed_tools"].insert(-1, "search")
        manifest["settings_hash"] = _load().compute_settings_hash(manifest)

    message = _expect_fail(mutate)
    assert "Vivary tools" in message


def test_rejects_noncanonical_runtime_digest():
    def mutate(payload, questions, manifest):
        manifest["runtime"]["runtime_source_hash"] = "A" * 64
        payload["runtime"] = manifest["runtime"]

    message = _expect_fail(mutate)
    assert "lowercase sha256" in message


def test_rejects_partial_support_matrix():
    def mutate(payload, questions, manifest):
        # poison one replicate's claims so derived support becomes false and caller matches
        row = payload["trials"][0]
        row["claims"] = []
        row["supported"] = False

    message = _expect_fail(mutate)
    assert "3/3" in message or "support" in message.lower()


def test_rejects_protocol_when_question_missing():
    module = _load()
    manifest = _read_json(REAL_MANIFEST)
    questions = _read_json(REAL_QUESTIONS)
    questions["questions"] = questions["questions"][:3]
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        m = tmp_path / "manifest.json"
        q = tmp_path / "questions.json"
        _write_json(m, manifest)
        _write_json(q, questions)
        try:
            module.validate(manifest_path=m, questions_path=q, results_path=tmp_path / "missing.json")
        except module.ProtocolError as exc:
            assert "4" in str(exc) or "question" in str(exc).lower()
            return
    raise AssertionError("expected ProtocolError")


def test_rejects_frozen_source_line_hash_drift():
    module = _load()
    manifest = _read_json(REAL_MANIFEST)
    questions = _read_json(REAL_QUESTIONS)
    first_claim = next(iter(questions["questions"][0]["expected_claims"].values()))
    first_claim["accepted_evidence"][0]["line_hash"] = "0" * 64
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        manifest_path = tmp_path / "manifest.json"
        questions_path = tmp_path / "questions.json"
        _write_json(manifest_path, manifest)
        _write_json(questions_path, questions)
        try:
            module.validate(
                manifest_path=manifest_path,
                questions_path=questions_path,
                results_path=tmp_path / "missing.json",
            )
        except module.ProtocolError as exc:
            assert "frozen evidence hash drift" in str(exc)
            return
    raise AssertionError("expected ProtocolError")


def test_bootstrap_and_median_helpers_are_deterministic():
    module = _load()
    values = [3.0, 1.0, 4.0, 2.0, 5.0]
    assert module.median(values) == 3.0
    # sorted = [1,2,3,4,5]; lower=[1,2] median 1.5; upper=[4,5] median 4.5; iqr=3.0
    assert module.iqr(values) == 3.0
    ci1 = module.bootstrap_ci(values, samples=200, seed=20260809)
    ci2 = module.bootstrap_ci(values, samples=200, seed=20260809)
    assert ci1 == ci2
    assert ci1[0] <= module.median(values) <= ci1[1]

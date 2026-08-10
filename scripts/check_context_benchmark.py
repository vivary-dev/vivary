"""Validate the frozen context-retrieval benchmark protocol and optional results.

The protocol is complete without results.json. When results appear, this guard
recomputes support from questions.json, rejects caller verdicts, checks the exact
24-trial matrix, and emits deterministic median/IQR/bootstrap summaries with a
fixed seed. Dependency-free Python 3.11 stdlib only.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import random
import subprocess
import sys
from pathlib import Path, PurePosixPath
from typing import Any, Iterable, Mapping, MutableMapping, Sequence

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MANIFEST = ROOT / "benchmarks" / "context-retrieval" / "manifest.json"
DEFAULT_QUESTIONS = ROOT / "benchmarks" / "context-retrieval" / "questions.json"
DEFAULT_RESULTS = ROOT / "benchmarks" / "context-retrieval" / "results.json"

REQUIRED_ROW_FIELDS = (
    "question_id",
    "arm",
    "replicate",
    "model",
    "settings_hash",
    "input_tokens",
    "output_tokens",
    "turns",
    "retrieval_calls",
    "files_opened",
    "wrong_files_opened",
    "supported",
    "time_to_verified_answer_ms",
    "claims",
    "unknowns",
    "raw_answer",
)

RUNTIME_HASH_KEYS = (
    "runtime_source_hash",
    "runtime_package_hashes",
    "runtime_wheel_hashes",
    "adopted_corpus_tree_hash",
)

METRIC_FIELDS = (
    "input_tokens",
    "output_tokens",
    "total_tokens",
    "turns",
    "wrong_files_opened",
    "time_to_verified_answer_ms",
)


class ProtocolError(Exception):
    """Raised when the protocol or results fail a hard check."""


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ProtocolError(message)


def require_fields(value: Any, expected: set[str], label: str) -> None:
    require(isinstance(value, Mapping), f"{label} must be an object")
    require(set(value) == expected, f"{label} fields must be exactly {sorted(expected)}")


def load_json(path: Path) -> Any:
    require(path.is_file(), f"missing JSON file: {path}")
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ProtocolError(f"invalid JSON in {path}: {exc}") from exc


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def is_sha256(value: Any) -> bool:
    return (
        isinstance(value, str)
        and len(value) == 64
        and all(char in "0123456789abcdef" for char in value)
    )


def compute_settings_hash(manifest: Mapping[str, Any]) -> str:
    design = manifest.get("design")
    material = {
        "corpus_sha": manifest.get("corpus", {}).get("public_sha"),
        "model": manifest.get("model"),
        "prompt": manifest.get("prompt"),
        "ceilings": manifest.get("ceilings"),
        "arms": manifest.get("arms"),
        "replicates_per_question_arm": design.get("replicates_per_question_arm") if isinstance(design, dict) else None,
        "total_trials": design.get("total_trials") if isinstance(design, dict) else None,
    }
    return sha256_text(canonical_json(material))


def normalize_path(path: str) -> str:
    require(isinstance(path, str) and path, "path must be a non-empty string")
    value = path.replace("\\", "/")
    parts = PurePosixPath(value).parts
    require(
        value == "/".join(parts)
        and not value.startswith("/")
        and parts
        and parts[0] not in {".", ".."}
        and ":" not in parts[0]
        and all(part not in {"", ".", ".."} for part in parts),
        f"path must be canonical and repository-relative: {path}",
    )
    return value


def index_questions(questions_doc: Mapping[str, Any]) -> dict[str, dict[str, Any]]:
    items = questions_doc.get("questions")
    require(isinstance(items, list) and items, "questions.json must declare a non-empty questions list")
    out: dict[str, dict[str, Any]] = {}
    question_fields = {
        "id",
        "question",
        "required_claim_ids",
        "expected_claims",
        "accepted_evidence_paths",
    }
    for item in items:
        require_fields(item, question_fields, "question")
        qid = item["id"]
        require(isinstance(qid, str) and qid, "each question needs a non-empty id")
        require(qid not in out, f"duplicate question id: {qid}")
        require(isinstance(item["question"], str) and item["question"], f"{qid}: question text required")
        expected = item["expected_claims"]
        require(isinstance(expected, dict) and expected, f"{qid}: expected_claims required")
        required_ids = item["required_claim_ids"]
        require(
            isinstance(required_ids, list)
            and required_ids
            and all(isinstance(claim_id, str) and claim_id for claim_id in required_ids),
            f"{qid}: required_claim_ids must be non-empty strings",
        )
        require(len(required_ids) == len(set(required_ids)), f"{qid}: duplicate required claim ids")
        require(set(required_ids) == set(expected), f"{qid}: expected claims must exactly match required claim ids")
        evidence_paths: set[str] = set()
        for claim_id, claim in expected.items():
            require_fields(claim, {"value", "accepted_evidence"}, f"{qid}.{claim_id}")
            evidence = claim["accepted_evidence"]
            require(isinstance(evidence, list) and evidence, f"{qid}.{claim_id}: accepted_evidence required")
            seen_evidence: set[tuple[str, int, str]] = set()
            for row in evidence:
                require_fields(row, {"path", "line", "line_hash"}, f"{qid}.{claim_id} evidence row")
                path = row["path"]
                require(
                    isinstance(path, str) and normalize_path(path) == path,
                    f"{qid}.{claim_id}: evidence path must be canonical",
                )
                require(is_sha256(row["line_hash"]), f"{qid}.{claim_id}: line_hash must be lowercase sha256 hex")
                require(
                    isinstance(row["line"], int) and not isinstance(row["line"], bool) and row["line"] >= 1,
                    f"{qid}.{claim_id}: line must be a positive int",
                )
                evidence_key = (path, row["line"], row["line_hash"])
                require(evidence_key not in seen_evidence, f"{qid}.{claim_id}: duplicate accepted evidence")
                seen_evidence.add(evidence_key)
                evidence_paths.add(path)
        paths = item["accepted_evidence_paths"]
        require(
            isinstance(paths, list)
            and paths
            and all(isinstance(path, str) and normalize_path(path) == path for path in paths),
            f"{qid}: accepted_evidence_paths must be canonical paths",
        )
        require(len(paths) == len(set(paths)), f"{qid}: duplicate accepted evidence paths")
        require(set(paths) == evidence_paths, f"{qid}: accepted evidence paths do not match claim evidence")
        out[qid] = item
    return out



def validate_frozen_evidence_lines(
    qmap: Mapping[str, Mapping[str, Any]],
    *,
    corpus_sha: str,
) -> None:
    expected: dict[str, dict[int, str]] = {}
    for question in qmap.values():
        for claim in question["expected_claims"].values():
            for row in claim["accepted_evidence"]:
                path = row["path"]
                normalized = normalize_path(path)
                require(
                    normalized == path and not Path(path).is_absolute() and ".." not in Path(path).parts,
                    f"unsafe frozen evidence path: {path}",
                )
                line_hash = row["line_hash"].lower()
                previous = expected.setdefault(path, {}).setdefault(row["line"], line_hash)
                require(previous == line_hash, f"conflicting hashes for {path}:{row['line']}")

    for path, line_hashes in sorted(expected.items()):
        try:
            completed = subprocess.run(
                ["git", "-C", str(ROOT), "show", f"{corpus_sha}:{path}"],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=False,
                timeout=10,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise ProtocolError(f"cannot read frozen corpus blob {corpus_sha}:{path}: {exc}") from exc
        require(
            completed.returncode == 0,
            f"cannot read frozen corpus blob {corpus_sha}:{path}: {completed.stderr.decode('utf-8', errors='replace').strip()}",
        )
        lines = completed.stdout.splitlines(keepends=True)
        for line_number, expected_hash in sorted(line_hashes.items()):
            require(line_number <= len(lines), f"frozen evidence line missing: {path}:{line_number}")
            actual_hash = hashlib.sha256(lines[line_number - 1]).hexdigest()
            require(
                actual_hash == expected_hash,
                f"frozen evidence hash drift: {path}:{line_number}",
            )

def validate_protocol(manifest: Mapping[str, Any], questions_doc: Mapping[str, Any]) -> dict[str, Any]:
    manifest_fields = {
        "schema_version",
        "benchmark_id",
        "title",
        "verified",
        "train_label",
        "status",
        "corpus",
        "runtime_requirements",
        "model",
        "design",
        "prompt",
        "ceilings",
        "arms",
        "trial_row_schema",
        "statistics",
        "validator",
        "line_hash",
        "settings_hash",
    }
    if "runtime" in manifest:
        manifest_fields.add("runtime")
    require_fields(manifest, manifest_fields, "manifest")
    require_fields(
        questions_doc,
        {"schema_version", "corpus_sha", "verified", "authorities", "questions"},
        "questions.json",
    )
    require(manifest.get("benchmark_id") == "context-retrieval", "benchmark_id must be context-retrieval")
    require(manifest.get("status") == "protocol_frozen", "manifest.status must be protocol_frozen")
    require(manifest.get("schema_version") == 1, "manifest.schema_version must be 1")
    require(questions_doc.get("schema_version") == 1, "questions.schema_version must be 1")
    require(manifest.get("train_label") == "Vivary Governed Context", "train_label must be exactly 'Vivary Governed Context'")
    require(manifest.get("verified") == "2026-08-09", "manifest.verified must be 2026-08-09")
    require(questions_doc.get("verified") == "2026-08-09", "questions.verified must be 2026-08-09")

    corpus = manifest.get("corpus")
    require(isinstance(corpus, dict), "manifest.corpus must be an object")
    require_fields(corpus, {"public_sha", "description"}, "manifest.corpus")
    public_sha = corpus.get("public_sha")
    require(public_sha == questions_doc.get("corpus_sha") == "cbbd340dbf0ffebfe17ad5257ecd93b83ab570de", "corpus SHA must be cbbd340dbf0ffebfe17ad5257ecd93b83ab570de")

    runtime_requirements = manifest.get("runtime_requirements")
    require_fields(
        runtime_requirements,
        {"when_results_present", "notes"},
        "manifest.runtime_requirements",
    )
    require(
        runtime_requirements["when_results_present"]
        == ["model_runtime_version", *RUNTIME_HASH_KEYS, "settings_hash"],
        "runtime requirements do not match the validator contract",
    )

    model = manifest.get("model")
    require(isinstance(model, dict), "manifest.model must be an object")
    require(model.get("id") == "openai-codex/gpt-5.6-sol", "model.id must be openai-codex/gpt-5.6-sol")
    require(model.get("effort") == "medium", "model.effort must be medium")
    require(model.get("sampling_overrides") is None, "sampling_overrides must be null")
    require_fields(model, {"id", "effort", "sampling_overrides"}, "manifest.model")

    design = manifest.get("design")
    require(isinstance(design, dict), "manifest.design must be an object")
    require(design.get("questions") == 4, "design.questions must be 4")
    require(design.get("arms") == ["baseline", "vivary"], "design.arms must be [baseline, vivary]")
    require(design.get("replicates_per_question_arm") == 3, "design.replicates_per_question_arm must be 3")
    require(design.get("total_trials") == 24, "design.total_trials must be 24")
    require_fields(
        design,
        {
            "questions",
            "arms",
            "replicates_per_question_arm",
            "total_trials",
            "support_gate",
            "support_rule",
        },
        "manifest.design",
    )
    require(design.get("support_gate") == "all_24_supported", "design.support_gate must be all_24_supported")

    prompt = manifest.get("prompt")
    require(isinstance(prompt, dict), "manifest.prompt must be an object")
    template = prompt.get("template")
    require(isinstance(template, str) and "{question}" in template, "prompt.template must include {question}")
    require(prompt.get("byte_identical") is True, "prompt.byte_identical must be true")
    require_fields(prompt, {"template", "byte_identical"}, "manifest.prompt")

    ceilings = manifest.get("ceilings")
    require(isinstance(ceilings, dict), "manifest.ceilings must be an object")
    require(ceilings.get("answer_words_max") == 500, "answer_words_max must be 500")
    require(ceilings.get("retrieval_calls_max") == 8, "retrieval_calls_max must be 8")
    require(ceilings.get("files_opened_max") == 6, "files_opened_max must be 6")
    require(ceilings.get("lines_per_read_max") == 200, "lines_per_read_max must be 200")
    require(ceilings.get("cross_trial_memory") is False, "cross_trial_memory must be false")
    require_fields(
        ceilings,
        {
            "answer_words_max",
            "retrieval_calls_max",
            "files_opened_max",
            "lines_per_read_max",
            "cross_trial_memory",
        },
        "manifest.ceilings",
    )

    arms = manifest.get("arms")
    require(isinstance(arms, dict) and set(arms) == {"baseline", "vivary"}, "manifest.arms must contain baseline and vivary")
    baseline = arms["baseline"]
    vivary = arms["vivary"]
    require_fields(baseline, {"description", "allowed_tools", "denied"}, "manifest.arms.baseline")
    require_fields(
        vivary,
        {"description", "allowed_tools", "max_governed_find_calls", "denied"},
        "manifest.arms.vivary",
    )
    require(
        isinstance(baseline, dict) and baseline.get("allowed_tools") == ["list", "search", "read"],
        "baseline tools must be deterministic list, search, and read",
    )
    require(
        isinstance(vivary, dict)
        and vivary.get("allowed_tools")
        == ["tropo find --root <adopted-root> --governed --max-claims 8 --json", "read"]
        and vivary.get("max_governed_find_calls") == 1,
        "Vivary tools must be one governed Tropo call followed only by reads",
    )
    required_denials = {
        "mcp",
        "network",
        "prior_transcripts",
        "arbitrary_shell",
        "helper_agents",
        "generated_answers",
        "reads_outside_corpus",
    }
    for arm_name, arm_contract in arms.items():
        require(
            set(arm_contract.get("denied", [])) == required_denials,
            f"{arm_name} denied tools do not match the protocol",
        )

    row_schema = manifest.get("trial_row_schema")
    require(isinstance(row_schema, dict), "manifest.trial_row_schema must be an object")
    require_fields(
        row_schema,
        {
            "required_fields",
            "wrong_files_opened_definition",
            "timing_definition",
            "supported_definition",
        },
        "manifest.trial_row_schema",
    )
    require(
        row_schema.get("required_fields") == list(REQUIRED_ROW_FIELDS),
        "manifest trial row fields do not match the validator contract",
    )

    stats = manifest.get("statistics")
    require(isinstance(stats, dict), "manifest.statistics must be an object")
    require_fields(
        stats,
        {"metrics", "summaries", "bootstrap", "cohort_separation", "publish_rule"},
        "manifest.statistics",
    )
    bootstrap = stats.get("bootstrap")
    require(isinstance(bootstrap, dict), "statistics.bootstrap must be an object")
    require_fields(bootstrap, {"samples", "seed", "method"}, "manifest.statistics.bootstrap")
    require(bootstrap.get("seed") == 20260809, "bootstrap.seed must be 20260809")
    require(bootstrap.get("samples") == 10000, "bootstrap.samples must be 10000")
    require(bootstrap.get("method") == "percentile", "bootstrap.method must be percentile")

    expected_settings = compute_settings_hash(manifest)
    require(manifest.get("settings_hash") == expected_settings, "manifest.settings_hash does not match the frozen trial settings")

    qmap = index_questions(questions_doc)
    require(stats.get("metrics") == list(METRIC_FIELDS), "statistics.metrics do not match the validator contract")
    require(
        stats.get("summaries") == ["median", "iqr", "bootstrap_95ci"],
        "statistics.summaries do not match the validator contract",
    )

    validator = manifest.get("validator")
    require_fields(validator, {"script", "python", "dependencies"}, "manifest.validator")
    require(
        validator
        == {
            "script": "scripts/check_context_benchmark.py",
            "python": "3.11",
            "dependencies": [],
        },
        "manifest.validator does not describe this stdlib Python 3.11 validator",
    )
    line_hash = manifest.get("line_hash")
    require_fields(line_hash, {"algorithm", "encoding", "input"}, "manifest.line_hash")
    require(
        line_hash["algorithm"] == "sha256"
        and line_hash["encoding"] == "utf-8"
        and "trailing newline" in line_hash["input"],
        "manifest.line_hash must freeze sha256 over exact UTF-8 source lines",
    )
    require(len(qmap) == 4, f"expected exactly 4 questions, found {len(qmap)}")
    roadmap = {
        "where is release truth owned?",
        "what depends on this module or decision?",
        "which file should an agent open first?",
        "what changed and what must be reviewed?",
    }
    found = {item["question"] for item in qmap.values()}
    require(found == roadmap, f"questions must match the four roadmap prompts exactly; found {sorted(found)}")

    validate_frozen_evidence_lines(qmap, corpus_sha=public_sha)
    authorities = questions_doc.get("authorities")
    require(isinstance(authorities, dict), "questions.authorities must be an object")
    require(set(authorities) == {"release_status", "release_workflow"}, "canonical authorities are release_status and release_workflow")
    require_fields(
        authorities["release_status"],
        {"path", "role"},
        "questions.authorities.release_status",
    )
    require_fields(
        authorities["release_workflow"],
        {"path", "role"},
        "questions.authorities.release_workflow",
    )
    require(authorities["release_status"].get("path") == "README.md", "release_status authority path must be README.md")
    require(authorities["release_workflow"].get("path") == "docs/RELEASE-WORKFLOW.md", "release_workflow authority path must be docs/RELEASE-WORKFLOW.md")

    require("results" not in manifest, "protocol manifest must not embed or placeholder results")

    return {
        "ok": True,
        "mode": "protocol_only",
        "questions": sorted(qmap),
        "settings_hash": expected_settings,
        "corpus_sha": public_sha,
        "total_trials_expected": 24,
    }


def accepted_evidence_index(question: Mapping[str, Any]) -> dict[str, dict[tuple[str, str], Any]]:
    """claim_id -> {(path, line_hash): evidence row}"""
    out: dict[str, dict[tuple[str, str], Any]] = {}
    for claim_id, claim in question["expected_claims"].items():
        mapping: dict[tuple[str, str], Any] = {}
        for row in claim["accepted_evidence"]:
            key = (normalize_path(row["path"]), row["line_hash"].lower())
            mapping[key] = row
        out[claim_id] = mapping
    return out


def claim_supported(question: Mapping[str, Any], claim_id: str, value: Any, evidence: Sequence[Mapping[str, Any]]) -> bool:
    expected = question["expected_claims"][claim_id]
    if value != expected["value"]:
        return False
    if not isinstance(evidence, list) or not evidence:
        return False
    accepted = accepted_evidence_index(question)[claim_id]
    accepted_paths = {normalize_path(p) for p in question["accepted_evidence_paths"]}
    matched = False
    for row in evidence:
        if not isinstance(row, dict):
            return False
        require(set(row) == {"path", "line_hash"}, "claim evidence rows must contain only path and line_hash")
        path = row.get("path")
        line_hash = row.get("line_hash")
        if not isinstance(path, str) or not is_sha256(line_hash):
            return False
        norm = normalize_path(path)
        if norm not in accepted_paths:
            return False
        key = (norm, line_hash.lower())
        if key not in accepted:
            return False
        matched = True
    return matched


def derive_supported(question: Mapping[str, Any], claims: Any) -> bool:
    if not isinstance(claims, list):
        return False
    seen: dict[str, Mapping[str, Any]] = {}
    for claim in claims:
        if not isinstance(claim, dict):
            return False
        require(
            set(claim) == {"claim_id", "value", "evidence"},
            "result claims must contain only claim_id, value, and evidence",
        )
        claim_id = claim.get("claim_id")
        if not isinstance(claim_id, str) or not claim_id:
            return False
        if claim_id in seen:
            return False
        seen[claim_id] = claim
    for claim_id in question["required_claim_ids"]:
        claim = seen.get(claim_id)
        if claim is None:
            return False
        if not claim_supported(question, claim_id, claim.get("value"), claim.get("evidence") or []):
            return False
    # Extra claims are allowed only when they also satisfy an expected claim definition.
    for claim_id, claim in seen.items():
        if claim_id not in question["expected_claims"]:
            return False
        if not claim_supported(question, claim_id, claim.get("value"), claim.get("evidence") or []):
            return False
    return True


def as_nonneg_number(value: Any, field: str) -> float | int:
    require(isinstance(value, (int, float)) and not isinstance(value, bool), f"{field} must be a number")
    require(value >= 0, f"{field} must be >= 0")
    if isinstance(value, float):
        require(math.isfinite(value), f"{field} must be finite")
    return value


def as_nonneg_int(value: Any, field: str) -> int:
    require(isinstance(value, int) and not isinstance(value, bool), f"{field} must be an int")
    require(value >= 0, f"{field} must be >= 0")
    return value


def validate_row(
    row: Mapping[str, Any],
    *,
    index: int,
    qmap: Mapping[str, Mapping[str, Any]],
    manifest: Mapping[str, Any],
    settings_hash: str,
) -> dict[str, Any]:
    require(isinstance(row, dict), f"results[{index}] must be an object")
    missing = [field for field in REQUIRED_ROW_FIELDS if field not in row]
    unknown = sorted(set(row) - set(REQUIRED_ROW_FIELDS))
    require(not missing, f"results[{index}] missing fields: {', '.join(missing)}")
    require(not unknown, f"results[{index}] unknown caller verdict or field: {', '.join(unknown)}")

    qid = row["question_id"]
    require(isinstance(qid, str), f"results[{index}].question_id must be a string")
    require(qid in qmap, f"results[{index}].question_id unknown: {qid}")
    question = qmap[qid]

    arm = row["arm"]
    require(isinstance(arm, str), f"results[{index}].arm must be a string")
    require(arm in ("baseline", "vivary"), f"results[{index}].arm must be baseline or vivary")
    replicate = as_nonneg_int(row["replicate"], f"results[{index}].replicate")
    require(replicate in (1, 2, 3), f"results[{index}].replicate must be 1, 2, or 3")
    require(row["model"] == manifest["model"]["id"], f"results[{index}].model must be {manifest['model']['id']}")
    require(row["settings_hash"] == settings_hash, f"results[{index}].settings_hash drift")

    input_tokens = as_nonneg_int(row["input_tokens"], f"results[{index}].input_tokens")
    output_tokens = as_nonneg_int(row["output_tokens"], f"results[{index}].output_tokens")
    turns = as_nonneg_int(row["turns"], f"results[{index}].turns")
    retrieval_calls = as_nonneg_int(row["retrieval_calls"], f"results[{index}].retrieval_calls")
    files_opened = row["files_opened"]
    require(isinstance(files_opened, list), f"results[{index}].files_opened must be a list")
    opened_paths = []
    for path in files_opened:
        require(isinstance(path, str) and path, f"results[{index}].files_opened entries must be non-empty strings")
        opened_paths.append(normalize_path(path))
    require(len(opened_paths) == len(set(opened_paths)), f"results[{index}].files_opened has duplicates")
    require(len(opened_paths) <= manifest["ceilings"]["files_opened_max"], f"results[{index}] opened too many files")
    require(retrieval_calls <= manifest["ceilings"]["retrieval_calls_max"], f"results[{index}] too many retrieval calls")
    if arm == "vivary":
        require(retrieval_calls == 1, f"results[{index}] Vivary arm requires exactly one governed retrieval call")

    accepted_paths = {normalize_path(p) for p in question["accepted_evidence_paths"]}
    derived_wrong = sorted(path for path in opened_paths if path not in accepted_paths)
    reported_wrong = as_nonneg_int(
        row["wrong_files_opened"],
        f"results[{index}].wrong_files_opened",
    )
    require(reported_wrong == len(derived_wrong), f"results[{index}].wrong_files_opened count mismatch")

    as_nonneg_number(row["time_to_verified_answer_ms"], f"results[{index}].time_to_verified_answer_ms")
    require(
        isinstance(row["unknowns"], list)
        and all(isinstance(item, str) and item for item in row["unknowns"]),
        f"results[{index}].unknowns must be a list of non-empty strings",
    )
    require(isinstance(row["raw_answer"], str) and row["raw_answer"].strip(), f"results[{index}].raw_answer must be a non-empty string")
    words = [part for part in row["raw_answer"].split() if part]
    require(len(words) <= manifest["ceilings"]["answer_words_max"], f"results[{index}].raw_answer exceeds 500 words")

    derived = derive_supported(question, row["claims"])
    require(
        isinstance(row["supported"], bool) and row["supported"] is derived,
        f"results[{index}].supported caller value disagrees with validator-derived support={derived}",
    )
    if derived:
        cited_paths = {
            normalize_path(evidence["path"])
            for claim in row["claims"]
            for evidence in claim["evidence"]
        }
        require(
            cited_paths.issubset(set(opened_paths)),
            f"results[{index}] cites evidence that is absent from files_opened",
        )

    return {
        "question_id": qid,
        "arm": arm,
        "replicate": replicate,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "total_tokens": input_tokens + output_tokens,
        "files_opened": len(opened_paths),
        "turns": turns,
        "wrong_files_opened": len(derived_wrong),
        "time_to_verified_answer_ms": float(row["time_to_verified_answer_ms"]),
        "supported": derived,
    }


def median(values: Sequence[float]) -> float:
    data = sorted(values)
    n = len(data)
    require(n > 0, "median requires values")
    mid = n // 2
    if n % 2:
        return float(data[mid])
    return (float(data[mid - 1]) + float(data[mid])) / 2.0


def iqr(values: Sequence[float]) -> float:
    data = sorted(values)
    n = len(data)
    require(n > 0, "iqr requires values")
    if n == 1:
        return 0.0
    # Exclusive median split keeps even/odd simple and deterministic.
    if n % 2:
        lower = data[: n // 2]
        upper = data[n // 2 + 1 :]
    else:
        lower = data[: n // 2]
        upper = data[n // 2 :]
    if not lower or not upper:
        return 0.0
    return median(upper) - median(lower)


def bootstrap_ci(values: Sequence[float], *, samples: int, seed: int) -> list[float]:
    data = list(values)
    n = len(data)
    require(n > 0, "bootstrap requires values")
    if n == 1:
        value = float(data[0])
        return [value, value]
    rng = random.Random(seed)
    medians: list[float] = []
    for _ in range(samples):
        draw = [data[rng.randrange(n)] for _ in range(n)]
        medians.append(median(draw))
    medians.sort()
    lo_index = int(math.floor(0.025 * (samples - 1)))
    hi_index = int(math.floor(0.975 * (samples - 1)))
    return [medians[lo_index], medians[hi_index]]


def summarize_cohort(rows: Sequence[Mapping[str, Any]], *, bootstrap_samples: int, bootstrap_seed: int) -> dict[str, Any]:
    summary: dict[str, Any] = {"n": len(rows), "supported": all(row["supported"] for row in rows)}
    for field in METRIC_FIELDS:
        values = [float(row[field]) for row in rows]
        summary[field] = {
            "median": median(values),
            "iqr": iqr(values),
            "bootstrap_95ci": bootstrap_ci(values, samples=bootstrap_samples, seed=bootstrap_seed),
        }
    return summary


def validate_results(
    results_doc: Mapping[str, Any],
    *,
    manifest: Mapping[str, Any],
    questions_doc: Mapping[str, Any],
    qmap: Mapping[str, Mapping[str, Any]],
    settings_hash: str,
) -> dict[str, Any]:
    require(isinstance(results_doc, dict), "results.json must be an object")
    required_result_fields = {"corpus_sha", "settings_hash", "runtime", "trials"}
    require(
        set(results_doc) == required_result_fields,
        f"results.json fields must be exactly {sorted(required_result_fields)}",
    )
    runtime = manifest.get("runtime")
    require(isinstance(runtime, dict), "manifest.runtime is required when results are present")
    required_runtime_fields = {
        "model_runtime_version",
        "runtime_source_hash",
        "runtime_package_hashes",
        "runtime_wheel_hashes",
        "adopted_corpus_tree_hash",
        "settings_hash",
    }
    require(
        set(runtime) == required_runtime_fields,
        f"manifest.runtime fields must be exactly {sorted(required_runtime_fields)}",
    )
    version = runtime["model_runtime_version"]
    require(isinstance(version, str) and version, "manifest.runtime.model_runtime_version must be a non-empty string")
    for key in RUNTIME_HASH_KEYS:
        value = runtime[key]
        if key.endswith("hashes"):
            require(isinstance(value, dict) and value, f"manifest.runtime.{key} must be a non-empty object")
            for name, digest in value.items():
                require(isinstance(name, str) and name, f"manifest.runtime.{key} keys must be non-empty strings")
                require(is_sha256(digest), f"manifest.runtime.{key}.{name} must be lowercase sha256 hex")
        else:
            require(is_sha256(value), f"manifest.runtime.{key} must be lowercase sha256 hex")
    require(
        set(runtime["runtime_package_hashes"]) == set(runtime["runtime_wheel_hashes"]),
        "runtime package and wheel hash keys must match",
    )
    require(runtime["settings_hash"] == settings_hash, "manifest.runtime.settings_hash drift against protocol")
    results_runtime = results_doc["runtime"]
    require(isinstance(results_runtime, dict), "results.json.runtime must be an object")
    require(canonical_json(results_runtime) == canonical_json(runtime), "results runtime drift against manifest")

    require(results_doc["settings_hash"] == settings_hash, "results.json settings_hash drift against manifest")
    corpus_sha = results_doc["corpus_sha"]
    require(corpus_sha == questions_doc["corpus_sha"] == manifest["corpus"]["public_sha"], "results corpus_sha drift")

    rows = results_doc["trials"]
    require(isinstance(rows, list), "results.json.trials must be a list")
    require(len(rows) == 24, f"expected exactly 24 trial rows, found {len(rows)}")

    validated: list[dict[str, Any]] = []
    keys: set[tuple[str, str, int]] = set()
    for index, row in enumerate(rows):
        item = validate_row(row, index=index, qmap=qmap, manifest=manifest, settings_hash=settings_hash)
        key = (item["question_id"], item["arm"], item["replicate"])
        require(key not in keys, f"duplicate trial key: {key}")
        keys.add(key)
        validated.append(item)

    expected_keys = {
        (qid, arm, replicate)
        for qid in qmap
        for arm in ("baseline", "vivary")
        for replicate in (1, 2, 3)
    }
    require(keys == expected_keys, "trial matrix is incomplete or has unexpected keys")

    # 3/3 support per question and arm.
    support_matrix: dict[str, dict[str, int]] = {qid: {"baseline": 0, "vivary": 0} for qid in qmap}
    for row in validated:
        if row["supported"]:
            support_matrix[row["question_id"]][row["arm"]] += 1
    for qid, arms in support_matrix.items():
        for arm, count in arms.items():
            require(count == 3, f"{qid}/{arm} support is {count}/3; release gate requires 3/3")

    bootstrap = manifest["statistics"]["bootstrap"]
    samples = int(bootstrap["samples"])
    seed = int(bootstrap["seed"])

    by_arm: dict[str, list[dict[str, Any]]] = {"baseline": [], "vivary": []}
    by_question: dict[str, dict[str, list[dict[str, Any]]]] = {
        qid: {"baseline": [], "vivary": []} for qid in qmap
    }
    for row in validated:
        by_arm[row["arm"]].append(row)
        by_question[row["question_id"]][row["arm"]].append(row)

    # Cohort separation: never pool arms together for published summaries.
    arm_summaries = {
        arm: summarize_cohort(rows_for_arm, bootstrap_samples=samples, bootstrap_seed=seed)
        for arm, rows_for_arm in by_arm.items()
    }
    question_summaries = {
        qid: {
            arm: summarize_cohort(arm_rows, bootstrap_samples=samples, bootstrap_seed=seed + 17 + idx)
            for arm, arm_rows in arms.items()
        }
        for idx, (qid, arms) in enumerate(sorted(by_question.items()))
    }

    deltas: dict[str, dict[str, float]] = {}
    for qid, arms in question_summaries.items():
        deltas[qid] = {}
        for field in METRIC_FIELDS:
            base = arms["baseline"][field]["median"]
            treat = arms["vivary"][field]["median"]
            deltas[qid][field] = treat - base

    return {
        "ok": True,
        "mode": "results",
        "trials": 24,
        "all_supported": True,
        "settings_hash": settings_hash,
        "corpus_sha": corpus_sha,
        "support_matrix": support_matrix,
        "arm_summaries": arm_summaries,
        "question_summaries": question_summaries,
        "median_deltas_vivary_minus_baseline": deltas,
    }


def validate(
    *,
    manifest_path: Path = DEFAULT_MANIFEST,
    questions_path: Path = DEFAULT_QUESTIONS,
    results_path: Path | None = DEFAULT_RESULTS,
    require_results: bool = False,
) -> dict[str, Any]:
    manifest = load_json(manifest_path)
    questions_doc = load_json(questions_path)
    protocol = validate_protocol(manifest, questions_doc)
    qmap = index_questions(questions_doc)
    settings_hash = protocol["settings_hash"]

    results_file = results_path
    if results_file is None:
        results_file = DEFAULT_RESULTS

    if not results_file.is_file():
        require(not require_results, f"results required but missing: {results_file}")
        return protocol

    results_doc = load_json(results_file)
    return validate_results(
        results_doc,
        manifest=manifest,
        questions_doc=questions_doc,
        qmap=qmap,
        settings_hash=settings_hash,
    )


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--questions", type=Path, default=DEFAULT_QUESTIONS)
    parser.add_argument("--results", type=Path, default=DEFAULT_RESULTS)
    parser.add_argument("--require-results", action="store_true", help="fail when results.json is absent")
    parser.add_argument("--json", action="store_true", help="print the validation report as JSON")
    args = parser.parse_args(argv)

    try:
        report = validate(
            manifest_path=args.manifest,
            questions_path=args.questions,
            results_path=args.results,
            require_results=args.require_results,
        )
    except ProtocolError as exc:
        print(f"context-benchmark: FAIL: {exc}", file=sys.stderr)
        return 1

    if args.json:
        print(json.dumps(report, indent=2, sort_keys=True))
    else:
        mode = report.get("mode")
        if mode == "protocol_only":
            print(
                "context-benchmark: OK protocol-only "
                f"(questions={len(report['questions'])}, settings_hash={report['settings_hash'][:12]}…)"
            )
        else:
            print(
                "context-benchmark: OK results "
                f"(trials={report['trials']}, all_supported={report['all_supported']})"
            )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

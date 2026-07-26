"""Tests for the optional Vivary Cognee memory adapter."""

from __future__ import annotations

import asyncio
import contextlib
import io
import json
import os
import shutil
import sys
import types
import tomllib
import unittest
import uuid
from contextlib import contextmanager
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[3]
PKG = ROOT / "packages" / "memory-cognee"
TROPO = ROOT / "packages" / "tropo"

sys.path.insert(0, str(PKG))
sys.path.insert(0, str(TROPO))

import vivary_cognee  # noqa: E402


@contextmanager
def temp_workspace():
    path = ROOT / "sandboxes" / f"test-memory-cognee-{uuid.uuid4().hex}"
    path.mkdir(parents=True)
    try:
        yield path
    finally:
        shutil.rmtree(path)


class FakeCognee:
    def __init__(self, recall_items=None):
        self.remember_calls = []
        self.forget_calls = []
        self.recall_calls = []
        self.recall_items = recall_items or []

    async def remember(self, text, *, dataset_name=None, **kwargs):
        self.remember_calls.append(
            {"text": text, "dataset_name": dataset_name, "kwargs": kwargs}
        )
        return {"status": "ok", "dataset_name": dataset_name}

    async def recall(self, query_text, *, datasets=None, top_k=15, **kwargs):
        self.recall_calls.append(
            {"query_text": query_text, "datasets": datasets, "top_k": top_k, "kwargs": kwargs}
        )
        return self.recall_items

    async def forget(self, *, dataset=None, memory_only=False, **kwargs):
        self.forget_calls.append(
            {"dataset": dataset, "memory_only": memory_only, "kwargs": kwargs}
        )
        return {"status": "forgotten", "dataset": dataset}


class NoisyFakeCognee(FakeCognee):
    async def remember(self, text, *, dataset_name=None, **kwargs):
        print("provider remember noise")
        return await super().remember(text, dataset_name=dataset_name, **kwargs)

    async def recall(self, query_text, *, datasets=None, top_k=15, **kwargs):
        print("provider recall noise")
        return await super().recall(query_text, datasets=datasets, top_k=top_k, **kwargs)


class MissingDatasetOnForgetCognee(FakeCognee):
    async def forget(self, *, dataset=None, memory_only=False, **kwargs):
        self.forget_calls.append(
            {"dataset": dataset, "memory_only": memory_only, "kwargs": kwargs}
        )
        raise ValueError(f"Dataset {dataset} not found.")


class InaccessibleDatasetOnForgetCognee(FakeCognee):
    async def forget(self, *, dataset=None, memory_only=False, **kwargs):
        self.forget_calls.append(
            {"dataset": dataset, "memory_only": memory_only, "kwargs": kwargs}
        )
        raise PermissionError(f"Dataset {dataset} not accessible.")


class FailingRecallCognee(FakeCognee):
    async def recall(self, query_text, *, datasets=None, top_k=15, **kwargs):
        self.recall_calls.append(
            {"query_text": query_text, "datasets": datasets, "top_k": top_k, "kwargs": kwargs}
        )
        raise RuntimeError("provider leaked secret payload")


class CachedFunction:
    def __init__(self):
        self.cleared = 0

    def __call__(self):
        return object()

    def cache_clear(self):
        self.cleared += 1


def write_workspace(
    root: Path,
    *,
    allow_network: bool = False,
    api_key_env: str = "",
    allow_without_api_key: bool = False,
    allow_telemetry: bool = False,
    state_path: str = ".vivary/memory/cognee",
    dataset: str = "",
) -> None:
    (root / ".vivary").mkdir()
    (root / "modules" / "auth").mkdir(parents=True)
    (root / "changes").mkdir()
    (root / "verification").mkdir()
    (root / "memory").mkdir()
    (root / "heartbeat-reports").mkdir()

    (root / "tropo.toml").write_text(
        """packs = ["repo-graph"]

[types.module.optional]
depends_on = "ref-list"
""",
        encoding="utf-8",
    )
    (root / ".gitignore").write_text(
        "USER.md\nMEMORY.md\nmemory/*\n!memory/.gitkeep\nheartbeat-reports/*\n.vivary/memory/\n",
        encoding="utf-8",
    )
    allow_network_text = "true" if allow_network else "false"
    allow_without_api_key_text = "true" if allow_without_api_key else "false"
    allow_telemetry_text = "true" if allow_telemetry else "false"
    dataset_text = f'dataset = "{dataset}"\n' if dataset else ""
    (root / ".vivary" / "memory.toml").write_text(
        f"""[memory]
enabled = true
mode = "semantic-provider"
provider = "cognee"

[memory.privacy]
respect_gitignore = true
respect_vivary_private = true
private_paths = ["USER.md", "MEMORY.md", "memory/**", "heartbeat-reports/**"]
fail_closed = true

[memory.cognee]
state_path = "{state_path}"
require_explicit_index = true
allow_network = {allow_network_text}
api_key_env = "{api_key_env}"
allow_without_api_key = {allow_without_api_key_text}
allow_telemetry = {allow_telemetry_text}
{dataset_text}""",
        encoding="utf-8",
    )
    (root / "modules" / "auth" / "index.md").write_text(
        """---
project: demo
status: active
module_area: authentication
related_changes: [login-flow]
verification: [auth-smoke]
source_files: ["src/auth.py"]
depends_on: [login-flow]
---
# Auth

Owns login, tokens, and account identity.
""",
        encoding="utf-8",
    )
    (root / "changes" / "login-flow.md").write_text(
        """---
project: demo
status: active
slice: login flow
related_modules: [auth]
verification: [auth-smoke]
---
# Login Flow

Make the sign-in path predictable for agents and humans.
""",
        encoding="utf-8",
    )
    (root / "verification" / "auth-smoke.md").write_text(
        """---
project: demo
status: planned
target: login-flow
related_modules: [auth]
related_changes: [login-flow]
---
# Auth Smoke

Verify one login path against the auth module.
""",
        encoding="utf-8",
    )
    (root / "USER.md").write_text("private identity token\n", encoding="utf-8")
    (root / "MEMORY.md").write_text("private durable memory\n", encoding="utf-8")


class CogneeMemoryAdapterTests(unittest.TestCase):
    def test_build_snapshot_returns_typed_nodes_and_filters_private_paths(self):
        with temp_workspace() as root:
            write_workspace(root)

            snapshot = vivary_cognee.build_snapshot(root)

        ids = {node.id for node in snapshot.nodes}
        self.assertIn("auth", ids)
        self.assertIn("login-flow", ids)
        self.assertNotIn("user", ids)
        self.assertNotIn("memory", ids)
        auth = next(node for node in snapshot.nodes if node.id == "auth")
        self.assertEqual(auth.type, "module")
        self.assertEqual(auth.path, "modules/auth/index.md")
        self.assertIn("vivary_node_id: auth", auth.text)
        self.assertIn("vivary_type: module", auth.text)
        self.assertIn("source_files", auth.text)
        self.assertTrue(any(edge.source_id == "auth" for edge in snapshot.edges))

    def test_build_snapshot_filters_strato_private_floor(self):
        with temp_workspace() as root:
            write_workspace(root)
            strato_dir = ".STRATO" if os.name == "nt" else ".strato"
            private_dir = root / strato_dir / "private"
            private_dir.mkdir(parents=True)
            (private_dir / "agent-secret.md").write_text(
                "---\nproject: demo\nstatus: active\nmodule_area: private\n---\n"
                "# Private\n\nstrato private sentinel\n",
                encoding="utf-8",
            )

            snapshot = vivary_cognee.build_snapshot(root)

        sent_text = "\n".join(node.text for node in snapshot.nodes)
        self.assertNotIn("strato private sentinel", sent_text)

    def test_private_patterns_are_case_insensitive_on_windows(self):
        with mock.patch.object(vivary_cognee.os, "name", "nt"):
            self.assertTrue(
                vivary_cognee._pattern_matches(
                    ".strato/private/**",
                    ".STRATO/PRIVATE/agent-secret.md",
                )
            )

    def test_build_snapshot_honors_gitignore_directory_pattern(self):
        with temp_workspace() as root:
            write_workspace(root)
            with (root / ".gitignore").open("a", encoding="utf-8") as fh:
                fh.write("secrets/\n")
            secret_dir = root / "modules" / "secrets"
            secret_dir.mkdir()
            (secret_dir / "index.md").write_text(
                "---\nproject: demo\nstatus: active\nmodule_area: secrets\n---\n"
                "# Secrets\n\nprivate token from ignored directory\n",
                encoding="utf-8",
            )

            snapshot = vivary_cognee.build_snapshot(root)

        sent_text = "\n".join(node.text for node in snapshot.nodes)
        self.assertNotIn("private token from ignored directory", sent_text)

    def test_build_snapshot_honors_nested_gitignore_rules(self):
        with temp_workspace() as root:
            write_workspace(root)
            private_dir = root / "modules" / "auth" / "private"
            private_dir.mkdir()
            (root / "modules" / "auth" / ".gitignore").write_text("private/\n", encoding="utf-8")
            (private_dir / "index.md").write_text(
                "---\nproject: demo\nstatus: active\nmodule_area: hidden\n---\n"
                "# Hidden\n\nnested private adapter leak\n",
                encoding="utf-8",
            )

            snapshot = vivary_cognee.build_snapshot(root)

        sent_text = "\n".join(node.text for node in snapshot.nodes)
        self.assertNotIn("nested private adapter leak", sent_text)

    def test_nested_gitignore_cannot_reinclude_parent_ignored_directory(self):
        with temp_workspace() as root:
            write_workspace(root)
            with (root / ".gitignore").open("a", encoding="utf-8") as fh:
                fh.write("secrets/\n")
            secret_dir = root / "modules" / "secrets"
            secret_dir.mkdir()
            (secret_dir / ".gitignore").write_text("!index.md\n", encoding="utf-8")
            (secret_dir / "index.md").write_text(
                "---\nproject: demo\nstatus: active\nmodule_area: secrets\n---\n"
                "# Secrets\n\nreincluded parent ignored leak\n",
                encoding="utf-8",
            )

            snapshot = vivary_cognee.build_snapshot(root)

        sent_text = "\n".join(node.text for node in snapshot.nodes)
        self.assertNotIn("reincluded parent ignored leak", sent_text)

    def test_parent_exception_for_gitignore_does_not_reinclude_ignored_directory(self):
        with temp_workspace() as root:
            write_workspace(root)
            with (root / ".gitignore").open("a", encoding="utf-8") as fh:
                fh.write("modules/secrets/\n!modules/secrets/.gitignore\n")
            secret_dir = root / "modules" / "secrets"
            secret_dir.mkdir()
            (secret_dir / ".gitignore").write_text("!index.md\n", encoding="utf-8")
            (secret_dir / "index.md").write_text(
                "---\nproject: demo\nstatus: active\nmodule_area: secrets\n---\n"
                "# Secrets\n\nparent exception private leak\n",
                encoding="utf-8",
            )

            snapshot = vivary_cognee.build_snapshot(root)

        sent_text = "\n".join(node.text for node in snapshot.nodes)
        self.assertNotIn("parent exception private leak", sent_text)

    def test_dataset_name_is_workspace_bound_even_when_configured(self):
        with temp_workspace() as root:
            write_workspace(root, dataset="shared-prod")
            snapshot = vivary_cognee.build_snapshot(root)

        self.assertRegex(snapshot.dataset, r"^vivary-shared-prod-[0-9a-f]{12}$")
        self.assertNotEqual(snapshot.dataset, "shared-prod")

    def test_memory_config_alone_does_not_make_workspace_valid(self):
        with temp_workspace() as root:
            (root / ".vivary").mkdir()
            (root / ".vivary" / "memory.toml").write_text(
                '[memory]\nenabled = true\nprovider = "cognee"\n',
                encoding="utf-8",
            )

            report = vivary_cognee.doctor(root)

        self.assertFalse(report["ok"])
        self.assertEqual(report["status"], "misconfigured")
        self.assertIn("not a Vivary workspace", report["detail"])

    def test_index_dry_run_does_not_call_cognee(self):
        with temp_workspace() as root:
            write_workspace(root)
            fake = FakeCognee()
            adapter = vivary_cognee.CogneeMemoryAdapter(root, cognee_client=fake)

            report = asyncio.run(adapter.index(dry_run=True))

        self.assertTrue(report["dry_run"])
        self.assertEqual(report["indexed"], 0)
        self.assertGreater(report["would_index"], 0)
        self.assertEqual(fake.remember_calls, [])

    def test_index_requires_explicit_approval_for_provider_writes(self):
        with temp_workspace() as root:
            write_workspace(root, allow_network=True, allow_without_api_key=True)
            adapter = vivary_cognee.CogneeMemoryAdapter(root, cognee_client=FakeCognee())

            with self.assertRaisesRegex(vivary_cognee.AdapterError, "--yes"):
                asyncio.run(adapter.index())

    def test_index_refuses_provider_runtime_when_network_is_disabled(self):
        with temp_workspace() as root:
            write_workspace(root)
            adapter = vivary_cognee.CogneeMemoryAdapter(root, cognee_client=FakeCognee())

            with self.assertRaisesRegex(vivary_cognee.AdapterError, "allow_network"):
                asyncio.run(adapter.index(approved=True))

    def test_index_sends_typed_packets_and_writes_manifest(self):
        with temp_workspace() as root:
            write_workspace(root, allow_network=True, allow_without_api_key=True)
            fake = FakeCognee()
            adapter = vivary_cognee.CogneeMemoryAdapter(root, cognee_client=fake)

            report = asyncio.run(adapter.index(approved=True))

            manifest = root / ".vivary" / "memory" / "cognee" / "manifest.json"
            manifest_data = json.loads(manifest.read_text(encoding="utf-8"))

        self.assertEqual(report["indexed"], len(fake.remember_calls))
        self.assertEqual(report["dataset"], fake.remember_calls[0]["dataset_name"])
        self.assertEqual(manifest_data["dataset"], report["dataset"])
        sent_text = "\n".join(call["text"] for call in fake.remember_calls)
        self.assertIn("vivary_node_id: auth", sent_text)
        self.assertNotIn("private identity token", sent_text)
        self.assertNotIn("private durable memory", sent_text)
        self.assertEqual(len(fake.forget_calls), 1)
        self.assertFalse(fake.forget_calls[0]["memory_only"])

    def test_index_replaces_provider_dataset_every_time(self):
        with temp_workspace() as root:
            write_workspace(root, allow_network=True, allow_without_api_key=True)
            fake = FakeCognee()
            adapter = vivary_cognee.CogneeMemoryAdapter(root, cognee_client=fake)

            asyncio.run(adapter.index(approved=True))
            asyncio.run(adapter.index(approved=True))

        self.assertEqual(len(fake.forget_calls), 2)
        self.assertTrue(all(not call["memory_only"] for call in fake.forget_calls))

    def test_first_index_allows_missing_provider_dataset_cleanup(self):
        with temp_workspace() as root:
            write_workspace(root, allow_network=True, allow_without_api_key=True)
            fake = MissingDatasetOnForgetCognee()
            adapter = vivary_cognee.CogneeMemoryAdapter(root, cognee_client=fake)

            report = asyncio.run(adapter.index(approved=True))

        self.assertGreater(report["indexed"], 0)
        self.assertEqual(len(fake.forget_calls), 1)

    def test_forget_is_idempotent_when_provider_dataset_is_missing(self):
        with temp_workspace() as root:
            write_workspace(root, allow_network=True, allow_without_api_key=True)
            fake = MissingDatasetOnForgetCognee()
            adapter = vivary_cognee.CogneeMemoryAdapter(root, cognee_client=fake)
            manifest = root / ".vivary" / "memory" / "cognee" / "manifest.json"
            manifest.parent.mkdir(parents=True, exist_ok=True)
            manifest.write_text("{}", encoding="utf-8")

            report = asyncio.run(adapter.forget(approved=True))

        self.assertTrue(report["forgot"])
        self.assertEqual(report["result"]["status"], "missing")
        self.assertFalse(manifest.exists())

    def test_forget_preserves_manifest_when_dataset_is_inaccessible(self):
        with temp_workspace() as root:
            write_workspace(root, allow_network=True, allow_without_api_key=True)
            fake = InaccessibleDatasetOnForgetCognee()
            adapter = vivary_cognee.CogneeMemoryAdapter(root, cognee_client=fake)
            manifest = root / ".vivary" / "memory" / "cognee" / "manifest.json"
            manifest.parent.mkdir(parents=True, exist_ok=True)
            manifest.write_text("{}", encoding="utf-8")

            with self.assertRaisesRegex(vivary_cognee.AdapterError, "PermissionError"):
                asyncio.run(adapter.forget(approved=True))

            self.assertTrue(manifest.exists())

    def test_index_keeps_provider_chatter_off_stdout(self):
        with temp_workspace() as root:
            write_workspace(root, allow_network=True, allow_without_api_key=True)
            fake = NoisyFakeCognee()
            adapter = vivary_cognee.CogneeMemoryAdapter(root, cognee_client=fake)
            stdout = io.StringIO()
            stderr = io.StringIO()

            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                report = asyncio.run(adapter.index(approved=True))

        self.assertEqual(stdout.getvalue(), "")
        self.assertGreater(report["indexed"], 0)

    def test_recall_returns_only_known_public_typed_node_hits(self):
        recall_items = [
            {"text": "strong match\nvivary_node_id: auth\nreason: auth"},
            {"text": "stale match\nvivary_node_id: missing-node"},
            {"text": "private match\nvivary_node_id: user"},
            {"text": "opaque untyped chunk with no Vivary marker"},
        ]
        with temp_workspace() as root:
            write_workspace(root, allow_network=True, allow_without_api_key=True)
            fake = FakeCognee(recall_items=recall_items)
            adapter = vivary_cognee.CogneeMemoryAdapter(root, cognee_client=fake)
            asyncio.run(adapter.index(approved=True))

            hits = asyncio.run(adapter.recall("login identity", k=3))

        self.assertEqual([hit.node_id for hit in hits], ["auth"])
        self.assertEqual(hits[0].type, "module")
        self.assertEqual(hits[0].path, "modules/auth/index.md")
        self.assertEqual(hits[0].source, "provider")
        self.assertEqual(hits[0].provider, "cognee")
        self.assertEqual(fake.recall_calls[0]["top_k"], 3)

    def test_recall_rejects_zero_k_and_caps_large_k(self):
        recall_items = [{"text": "strong match\nvivary_node_id: auth\nreason: auth"}]
        with temp_workspace() as root:
            write_workspace(root, allow_network=True, allow_without_api_key=True)
            fake = FakeCognee(recall_items=recall_items)
            adapter = vivary_cognee.CogneeMemoryAdapter(root, cognee_client=fake)
            asyncio.run(adapter.index(approved=True))

            with self.assertRaisesRegex(vivary_cognee.AdapterError, "at least 1"):
                asyncio.run(adapter.recall("login identity", k=0))
            hits = asyncio.run(adapter.recall("login identity", k=1_000_000))

        self.assertEqual([hit.node_id for hit in hits], ["auth"])
        self.assertEqual(fake.recall_calls[-1]["top_k"], vivary_cognee.MAX_RECALL_K)

    def test_recall_sanitizes_provider_error_detail(self):
        with temp_workspace() as root:
            write_workspace(root, allow_network=True, allow_without_api_key=True)
            fake = FailingRecallCognee()
            adapter = vivary_cognee.CogneeMemoryAdapter(root, cognee_client=fake)
            asyncio.run(adapter.index(approved=True))

            with self.assertRaisesRegex(vivary_cognee.AdapterError, "RuntimeError") as cm:
                asyncio.run(adapter.recall("login identity"))

        self.assertNotIn("secret payload", str(cm.exception))
        self.assertIsNone(cm.exception.__cause__)

    def test_recall_keeps_provider_chatter_off_stdout(self):
        with temp_workspace() as root:
            write_workspace(root, allow_network=True, allow_without_api_key=True)
            fake = NoisyFakeCognee(
                recall_items=[{"text": "strong match\nvivary_node_id: auth"}]
            )
            adapter = vivary_cognee.CogneeMemoryAdapter(root, cognee_client=fake)
            stdout = io.StringIO()
            stderr = io.StringIO()

            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                asyncio.run(adapter.index(approved=True))
                hits = asyncio.run(adapter.recall("login identity"))

        self.assertEqual(stdout.getvalue(), "")
        self.assertEqual([hit.node_id for hit in hits], ["auth"])

    def test_recall_refuses_provider_runtime_when_network_is_disabled(self):
        with temp_workspace() as root:
            write_workspace(root)
            adapter = vivary_cognee.CogneeMemoryAdapter(root, cognee_client=FakeCognee())

            with self.assertRaisesRegex(vivary_cognee.AdapterError, "allow_network"):
                asyncio.run(adapter.recall("login identity"))

    def test_recall_refuses_stale_or_missing_manifest(self):
        with temp_workspace() as root:
            write_workspace(root, allow_network=True, allow_without_api_key=True)
            fake = FakeCognee(recall_items=[{"text": "vivary_node_id: auth"}])
            adapter = vivary_cognee.CogneeMemoryAdapter(root, cognee_client=fake)

            with self.assertRaisesRegex(vivary_cognee.AdapterError, "stale"):
                asyncio.run(adapter.recall("login identity"))

    def test_recall_refuses_after_workspace_changes_since_index(self):
        with temp_workspace() as root:
            write_workspace(root, allow_network=True, allow_without_api_key=True)
            fake = FakeCognee(recall_items=[{"text": "vivary_node_id: auth"}])
            adapter = vivary_cognee.CogneeMemoryAdapter(root, cognee_client=fake)
            asyncio.run(adapter.index(approved=True))
            (root / "modules" / "auth" / "index.md").write_text(
                "# Auth\n\nChanged after provider indexing.\n",
                encoding="utf-8",
            )

            with self.assertRaisesRegex(vivary_cognee.AdapterError, "stale"):
                asyncio.run(adapter.recall("login identity"))

    def test_recall_refuses_manifest_with_wrong_dataset_metadata(self):
        with temp_workspace() as root:
            write_workspace(root, allow_network=True, allow_without_api_key=True)
            fake = FakeCognee(recall_items=[{"text": "vivary_node_id: auth"}])
            adapter = vivary_cognee.CogneeMemoryAdapter(root, cognee_client=fake)
            asyncio.run(adapter.index(approved=True))
            manifest = root / ".vivary" / "memory" / "cognee" / "manifest.json"
            data = json.loads(manifest.read_text(encoding="utf-8"))
            data["dataset"] = "wrong-dataset"
            manifest.write_text(json.dumps(data), encoding="utf-8")

            with self.assertRaisesRegex(vivary_cognee.AdapterError, "stale"):
                asyncio.run(adapter.recall("login identity"))
            with mock.patch.object(vivary_cognee, "_cognee_available", return_value=True):
                report = vivary_cognee.doctor(root)

        self.assertEqual(report["status"], "stale")

    def test_index_requires_configured_api_key_env_when_present(self):
        with temp_workspace() as root:
            write_workspace(root, allow_network=True, api_key_env="VIVARY_TEST_COGNEE_KEY")
            adapter = vivary_cognee.CogneeMemoryAdapter(root, cognee_client=FakeCognee())

            with self.assertRaisesRegex(vivary_cognee.AdapterError, "VIVARY_TEST_COGNEE_KEY"):
                asyncio.run(adapter.index(approved=True))

    def test_index_requires_api_key_env_or_explicit_local_provider(self):
        with temp_workspace() as root:
            write_workspace(root, allow_network=True)
            adapter = vivary_cognee.CogneeMemoryAdapter(root, cognee_client=FakeCognee())

            with self.assertRaisesRegex(vivary_cognee.AdapterError, "api_key_env"):
                asyncio.run(adapter.index(approved=True))

    def test_invalid_memory_config_types_are_rejected(self):
        with temp_workspace() as root:
            write_workspace(root)
            (root / ".vivary" / "memory.toml").write_text(
                """[memory]
enabled = "false"
provider = "cognee"

[memory.cognee]
allow_network = 1
""",
                encoding="utf-8",
            )

            with self.assertRaisesRegex(vivary_cognee.AdapterError, "memory.enabled"):
                vivary_cognee.CogneeMemoryAdapter(root)

    def test_memory_config_accepts_leading_utf8_bom(self):
        with temp_workspace() as root:
            write_workspace(root)
            (root / ".vivary" / "memory.toml").write_text(
                """[memory]
enabled = true
mode = "semantic-provider"
provider = "cognee"

[memory.cognee]
allow_network = false
""",
                encoding="utf-8-sig",
            )
            with mock.patch.object(vivary_cognee, "_cognee_available", return_value=False):
                report = vivary_cognee.doctor(root)

        self.assertEqual(report["provider"], "cognee")
        self.assertEqual(report["status"], "unavailable")

    def test_state_path_must_stay_inside_workspace(self):
        with temp_workspace() as root:
            outside = root.parent / "outside-cognee-state"
            write_workspace(
                root,
                allow_network=True,
                allow_without_api_key=True,
                state_path=str(outside).replace("\\", "/"),
            )
            adapter = vivary_cognee.CogneeMemoryAdapter(root, cognee_client=FakeCognee())

            with self.assertRaisesRegex(vivary_cognee.AdapterError, "state_path"):
                asyncio.run(adapter.index(approved=True))

    def test_out_of_root_indexed_files_are_refused(self):
        with temp_workspace() as root:
            write_workspace(root)
            outside = root.parent / f"outside-{uuid.uuid4().hex}.md"
            outside.write_text("# Outside\n\nsecret\n", encoding="utf-8")
            try:
                class Doc:
                    full = str(outside)
                    rel = "modules/auth/outside.md"
                    derived = {"id": "outside", "title": "Outside"}
                    declared = {}
                    type = "module"

                fake_tropo = types.SimpleNamespace(
                    ConfigResolver=lambda *args: object(),
                    __file__=str(ROOT / "packages" / "tropo" / "tropo.py"),
                    analyze=lambda *args: [Doc()],
                    build_graph=lambda docs: (
                        {"outside": {"path": "modules/auth/outside.md", "type": "module"}},
                        [],
                    ),
                )

                with mock.patch.object(vivary_cognee, "_import_tropo", return_value=fake_tropo):
                    with self.assertRaisesRegex(vivary_cognee.AdapterError, "out-of-root"):
                        vivary_cognee.build_snapshot(root)
            finally:
                outside.unlink(missing_ok=True)

    def test_linked_indexed_files_are_refused(self):
        with temp_workspace() as root:
            write_workspace(root)
            link = root / "modules" / "auth" / "linked-user.md"
            try:
                link.symlink_to(root / "USER.md")
            except (NotImplementedError, OSError):
                self.skipTest("filesystem does not permit symlink creation")

            class Doc:
                full = str(link)
                rel = "modules/auth/linked-user.md"
                derived = {"id": "linked-user", "title": "Linked User"}
                declared = {}
                type = "module"

            fake_tropo = types.SimpleNamespace(
                ConfigResolver=lambda *args: object(),
                __file__=str(ROOT / "packages" / "tropo" / "tropo.py"),
                analyze=lambda *args: [Doc()],
                build_graph=lambda docs: (
                    {"linked-user": {"path": "modules/auth/linked-user.md", "type": "module"}},
                    [],
                ),
            )

            with mock.patch.object(vivary_cognee, "_import_tropo", return_value=fake_tropo):
                with self.assertRaisesRegex(vivary_cognee.AdapterError, "linked file"):
                    vivary_cognee.build_snapshot(root)

    def test_hard_linked_indexed_files_are_refused(self):
        with temp_workspace() as root:
            write_workspace(root)
            hard_link = root / "modules" / "auth" / "hard-user.md"
            try:
                os.link(root / "USER.md", hard_link)
            except (AttributeError, NotImplementedError, OSError):
                self.skipTest("filesystem does not permit hardlink creation")

            class Doc:
                full = str(hard_link)
                rel = "modules/auth/hard-user.md"
                derived = {"id": "hard-user", "title": "Hard User"}
                declared = {}
                type = "module"

            fake_tropo = types.SimpleNamespace(
                ConfigResolver=lambda *args: object(),
                __file__=str(ROOT / "packages" / "tropo" / "tropo.py"),
                analyze=lambda *args: [Doc()],
                build_graph=lambda docs: (
                    {"hard-user": {"path": "modules/auth/hard-user.md", "type": "module"}},
                    [],
                ),
            )

            with mock.patch.object(vivary_cognee, "_import_tropo", return_value=fake_tropo):
                with self.assertRaisesRegex(vivary_cognee.AdapterError, "hard-linked"):
                    vivary_cognee.build_snapshot(root)

    def test_doctor_reports_unavailable_without_cognee_package(self):
        with temp_workspace() as root:
            write_workspace(root)
            with mock.patch.object(vivary_cognee, "_cognee_available", return_value=False):
                report = vivary_cognee.doctor(root)

        self.assertEqual(report["status"], "unavailable")
        self.assertEqual(report["provider"], "cognee")

    def test_doctor_resolves_subdirectory_to_workspace_root(self):
        with temp_workspace() as root:
            write_workspace(root)
            with mock.patch.object(vivary_cognee, "_cognee_available", return_value=True):
                report = vivary_cognee.doctor(root / "modules" / "auth")

        self.assertEqual(report["provider"], "cognee")
        self.assertEqual(report["status"], "stale")

    def test_doctor_rejects_non_workspace_target(self):
        with temp_workspace() as root:
            empty = root / "empty"
            empty.mkdir()

            report = vivary_cognee.doctor(empty)

        self.assertFalse(report["ok"])
        self.assertEqual(report["status"], "misconfigured")
        self.assertIn("not a Vivary workspace", report["detail"])

    def test_doctor_reports_missing_root_without_promoting_to_workspace(self):
        with temp_workspace() as root:
            write_workspace(root)

            report = vivary_cognee.doctor(root / "modules" / "aut")

        self.assertFalse(report["ok"])
        self.assertEqual(report["status"], "misconfigured")
        self.assertIn("does not exist", report["detail"])

    def test_adapter_rejects_missing_root_without_promoting_to_workspace(self):
        with temp_workspace() as root:
            write_workspace(root)

            with self.assertRaisesRegex(vivary_cognee.AdapterError, "does not exist"):
                vivary_cognee.CogneeMemoryAdapter(root / "modules" / "aut")

    def test_doctor_does_not_import_cognee(self):
        with temp_workspace() as root:
            write_workspace(root)
            with mock.patch.object(vivary_cognee, "_cognee_available", return_value=True):
                with mock.patch.object(vivary_cognee, "_import_cognee", side_effect=AssertionError):
                    report = vivary_cognee.doctor(root)

        self.assertEqual(report["status"], "stale")

    def test_doctor_reports_bad_state_path_without_traceback(self):
        with temp_workspace() as root:
            outside = root.parent / "outside-cognee-state"
            write_workspace(root, state_path=str(outside).replace("\\", "/"))
            with mock.patch.object(vivary_cognee, "_cognee_available", return_value=True):
                report = vivary_cognee.doctor(root)

        self.assertFalse(report["ok"])
        self.assertEqual(report["status"], "misconfigured")
        self.assertIn("state_path", report["detail"])

    def test_index_refuses_linked_manifest_target(self):
        with temp_workspace() as root:
            write_workspace(root, allow_network=True, allow_without_api_key=True)
            fake = FakeCognee()
            adapter = vivary_cognee.CogneeMemoryAdapter(root, cognee_client=fake)
            manifest = root / ".vivary" / "memory" / "cognee" / "manifest.json"
            manifest.parent.mkdir(parents=True, exist_ok=True)
            outside = root.parent / f"outside-manifest-{uuid.uuid4().hex}.json"
            outside.write_text("keep me\n", encoding="utf-8")
            try:
                try:
                    manifest.symlink_to(outside)
                except (NotImplementedError, OSError):
                    self.skipTest("filesystem does not permit symlink creation")
                with self.assertRaisesRegex(vivary_cognee.AdapterError, "linked Cognee manifest"):
                    asyncio.run(adapter.index(approved=True))
                self.assertEqual(fake.forget_calls, [])
                self.assertEqual(fake.remember_calls, [])
                self.assertEqual(outside.read_text(encoding="utf-8"), "keep me\n")
            finally:
                outside.unlink(missing_ok=True)

    def test_index_refuses_hard_linked_manifest_target(self):
        with temp_workspace() as root:
            write_workspace(root, allow_network=True, allow_without_api_key=True)
            fake = FakeCognee()
            adapter = vivary_cognee.CogneeMemoryAdapter(root, cognee_client=fake)
            manifest = root / ".vivary" / "memory" / "cognee" / "manifest.json"
            manifest.parent.mkdir(parents=True, exist_ok=True)
            outside = root.parent / f"outside-manifest-{uuid.uuid4().hex}.json"
            outside.write_text("keep me\n", encoding="utf-8")
            try:
                try:
                    os.link(outside, manifest)
                except (AttributeError, NotImplementedError, OSError):
                    self.skipTest("filesystem does not permit hardlink creation")
                with self.assertRaisesRegex(vivary_cognee.AdapterError, "hard-linked Cognee manifest"):
                    asyncio.run(adapter.index(approved=True))
                self.assertEqual(fake.forget_calls, [])
                self.assertEqual(fake.remember_calls, [])
                self.assertEqual(outside.read_text(encoding="utf-8"), "keep me\n")
            finally:
                outside.unlink(missing_ok=True)

    def test_client_configures_cognee_state_under_workspace_before_import(self):
        with temp_workspace() as root:
            write_workspace(root)
            state_root = root / ".vivary" / "memory" / "cognee"

            def fake_import():
                self.assertEqual(os.environ["DATA_ROOT_DIRECTORY"], str(state_root / "data"))
                self.assertEqual(os.environ["SYSTEM_ROOT_DIRECTORY"], str(state_root / "system"))
                self.assertEqual(os.environ["CACHE_ROOT_DIRECTORY"], str(state_root / "cache"))
                self.assertEqual(os.environ["COGNEE_LOGS_DIR"], str(state_root / "logs"))
                self.assertEqual(os.environ["COGNEE_TRACING_ENABLED"], "false")
                self.assertEqual(os.environ["TELEMETRY_DISABLED"], "1")
                return object()

            with mock.patch.dict(
                os.environ,
                {"COGNEE_TRACING_ENABLED": "true", "TELEMETRY_DISABLED": ""},
                clear=False,
            ):
                with mock.patch.object(vivary_cognee, "_import_cognee", side_effect=fake_import):
                    client = vivary_cognee.CogneeMemoryAdapter(root)._client()

        self.assertIsNotNone(client)

    def test_client_preserves_explicit_telemetry_when_allowed(self):
        with temp_workspace() as root:
            write_workspace(root, allow_telemetry=True)

            with mock.patch.dict(os.environ, {}, clear=True):
                with mock.patch.object(vivary_cognee, "_import_cognee", return_value=object()):
                    client = vivary_cognee.CogneeMemoryAdapter(root)._client()

                self.assertNotIn("TELEMETRY_DISABLED", os.environ)

        self.assertIsNotNone(client)

    def test_client_clears_existing_cognee_config_caches_after_binding_workspace(self):
        with temp_workspace() as root:
            write_workspace(root)
            cached = CachedFunction()
            fake_module = types.SimpleNamespace(get_base_config=cached)

            with mock.patch.dict(sys.modules, {"cognee.base_config": fake_module}):
                with mock.patch.object(vivary_cognee, "_import_cognee", return_value=object()):
                    client = vivary_cognee.CogneeMemoryAdapter(root)._client()

        self.assertIsNotNone(client)
        self.assertEqual(cached.cleared, 1)

    def test_client_keeps_provider_import_chatter_off_stdout(self):
        with temp_workspace() as root:
            write_workspace(root)

            def noisy_import():
                print("cognee import noise")
                return object()

            stdout = io.StringIO()
            stderr = io.StringIO()
            with mock.patch.object(vivary_cognee, "_import_cognee", side_effect=noisy_import):
                with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                    client = vivary_cognee.CogneeMemoryAdapter(root)._client()

        self.assertEqual(stdout.getvalue(), "")
        self.assertIsNotNone(client)

    def test_client_suppresses_dotenv_autoload_during_import(self):
        with temp_workspace() as root:
            write_workspace(root)
            original_env = "outside"
            dotenv_module = types.SimpleNamespace(
                load_dotenv=lambda *args, **kwargs: os.environ.__setitem__(
                    "DATA_ROOT_DIRECTORY", original_env
                )
            )

            def fake_import():
                dotenv_module.load_dotenv(override=True)
                return object()

            with mock.patch.dict(os.environ, {}, clear=False):
                with mock.patch.dict(sys.modules, {"dotenv": dotenv_module}):
                    with mock.patch.object(vivary_cognee, "_import_cognee", side_effect=fake_import):
                        vivary_cognee.CogneeMemoryAdapter(root)._client()

                    expected = str(root / ".vivary" / "memory" / "cognee" / "data")
                    self.assertEqual(os.environ["DATA_ROOT_DIRECTORY"], expected)

    def test_client_does_not_import_workspace_local_dotenv(self):
        with temp_workspace() as root:
            write_workspace(root)
            (root / "dotenv.py").write_text(
                "raise AssertionError('workspace dotenv imported')\n",
                encoding="utf-8",
            )
            old_cwd = Path.cwd()
            sys.path.insert(0, str(root))
            try:
                os.chdir(root)
                with mock.patch.object(vivary_cognee, "_import_cognee", return_value=object()):
                    client = vivary_cognee.CogneeMemoryAdapter(root)._client()
            finally:
                os.chdir(old_cwd)
                sys.path.remove(str(root))

        self.assertIsNotNone(client)

    def test_version_constant_matches_pyproject(self):
        declared = tomllib.loads((PKG / "pyproject.toml").read_text(encoding="utf-8"))["project"]["version"]
        self.assertEqual(vivary_cognee.__version__, declared)


if __name__ == "__main__":
    unittest.main()

"""Tests for the optional Vivary Cognee memory adapter."""

from __future__ import annotations

import asyncio
import json
import shutil
import sys
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

    async def forget(self, *, dataset=None, memory_only=True, **kwargs):
        self.forget_calls.append(
            {"dataset": dataset, "memory_only": memory_only, "kwargs": kwargs}
        )
        return {"status": "forgotten", "dataset": dataset}


def write_workspace(root: Path) -> None:
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
    (root / ".vivary" / "memory.toml").write_text(
        """[memory]
enabled = true
mode = "semantic-provider"
provider = "cognee"

[memory.privacy]
respect_gitignore = true
respect_vivary_private = true
private_paths = ["USER.md", "MEMORY.md", "memory/**", "heartbeat-reports/**"]
fail_closed = true

[memory.cognee]
state_path = ".vivary/memory/cognee"
require_explicit_index = true
allow_network = false
api_key_env = ""
""",
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
            write_workspace(root)
            adapter = vivary_cognee.CogneeMemoryAdapter(root, cognee_client=FakeCognee())

            with self.assertRaisesRegex(vivary_cognee.AdapterError, "--yes"):
                asyncio.run(adapter.index())

    def test_index_sends_typed_packets_and_writes_manifest(self):
        with temp_workspace() as root:
            write_workspace(root)
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

    def test_recall_returns_only_known_public_typed_node_hits(self):
        recall_items = [
            {"text": "strong match\nvivary_node_id: auth\nreason: auth"},
            {"text": "stale match\nvivary_node_id: missing-node"},
            {"text": "private match\nvivary_node_id: user"},
            {"text": "opaque untyped chunk with no Vivary marker"},
        ]
        with temp_workspace() as root:
            write_workspace(root)
            fake = FakeCognee(recall_items=recall_items)
            adapter = vivary_cognee.CogneeMemoryAdapter(root, cognee_client=fake)

            hits = asyncio.run(adapter.recall("login identity", k=3))

        self.assertEqual([hit.node_id for hit in hits], ["auth"])
        self.assertEqual(hits[0].type, "module")
        self.assertEqual(hits[0].path, "modules/auth/index.md")
        self.assertEqual(hits[0].provider, "cognee")
        self.assertEqual(fake.recall_calls[0]["top_k"], 3)

    def test_doctor_reports_unavailable_without_cognee_import(self):
        with temp_workspace() as root:
            write_workspace(root)
            with mock.patch.object(vivary_cognee, "_import_cognee", side_effect=ImportError("no cognee")):
                report = vivary_cognee.doctor(root)

        self.assertEqual(report["status"], "unavailable")
        self.assertEqual(report["provider"], "cognee")


if __name__ == "__main__":
    unittest.main()

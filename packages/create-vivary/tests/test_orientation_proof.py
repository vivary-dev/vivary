"""Focused regression coverage for issue #200's orientation proof artifact."""

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import orientation_proof


class OrientationProofTests(unittest.TestCase):
    def run_fixtures(self, *kinds: str) -> dict:
        with tempfile.TemporaryDirectory(prefix="orientation-proof-test-") as raw:
            receipt_path = Path(raw) / "receipt.json"
            receipt = orientation_proof.run_proof(
                receipt_path,
                fixture_kinds=kinds,
                transports=orientation_proof.local_test_transports(),
                strict_transports=False,
            )
            self.assertEqual(receipt, json.loads(receipt_path.read_text(encoding="utf-8")))
            self.assertTrue(receipt["ok"], receipt)
            serialized = receipt_path.read_text(encoding="utf-8")
            self.assertNotIn("vivary-orientation-proof-", serialized)
            self.assertEqual(receipt["versions"]["node"], "test-override")
            for fixture in receipt["fixtures"]:
                self.assertTrue(fixture["map"]["read_only"])
                self.assertLessEqual(fixture["map"]["directories"], fixture["map"]["entry_limit"])
                self.assertLessEqual(fixture["map"]["deepest_directory"], fixture["map"]["depth_limit"])
                self.assertTrue(fixture["doctor"]["read_only"])
                self.assertTrue(fixture["find"]["read_only"])
                self.assertTrue(fixture["unsafe_boundary_pruned"])
                self.assertTrue(fixture["find"]["contained_in_fixture"])
                capabilities = fixture["doctor"]["capabilities"]
                expected_preset = orientation_proof.EXPECTED_FIXTURE_PRESETS[
                    fixture["kind"]
                ]
                self.assertTrue(
                    capabilities["reports_match_doctor"],
                )
                self.assertEqual(
                    capabilities["python"]["preset"],
                    expected_preset,
                )
                self.assertEqual(
                    capabilities["npm"]["preset"],
                    expected_preset,
                )
                self.assertEqual(
                    set(capabilities["python"]["governed"]),
                    orientation_proof.GOVERNED_CAPABILITY_IDS,
                )
                self.assertEqual(
                    set(capabilities["npm"]["governed"]),
                    orientation_proof.GOVERNED_CAPABILITY_IDS,
                )
            return receipt

    def test_brownfield_dry_run_precedes_exact_bounded_apply(self):
        fixture = self.run_fixtures("brownfield")["fixtures"][0]

        self.assertTrue(fixture["adopt"]["dry_run_read_only"])
        self.assertTrue(fixture["adopt"]["applied"])
        self.assertTrue(fixture["adopt"]["idempotent"])
        self.assertGreater(len(fixture["expected_mutations"]), 0)
        self.assertEqual(fixture["actual_mutations"]["created"], fixture["expected_mutations"])
        self.assertEqual(fixture["actual_mutations"]["changed"], [])
        self.assertEqual(fixture["actual_mutations"]["deleted"], [])
        self.assertTrue(fixture["doctor"]["actual_ok"])
        self.assertGreater(fixture["find"]["results"], 0)

    def test_corrupt_fixture_fails_doctor_without_repairing(self):
        fixture = self.run_fixtures("corrupt")["fixtures"][0]

        self.assertFalse(fixture["doctor"]["expected_ok"])
        self.assertFalse(fixture["doctor"]["actual_ok"])
        self.assertGreater(fixture["doctor"]["errors"], 0)
        self.assertFalse(fixture["adopt"]["applied"])
        self.assertEqual(fixture["actual_mutations"], {"created": [], "changed": [], "deleted": []})
        self.assertEqual(fixture["expected_mutations"], ["AGENTS.md"])

    def test_divergent_checkout_preserves_branch_head_and_refs(self):
        fixture = self.run_fixtures("divergent-checkout")["fixtures"][0]
        before = fixture["git"]["before"]
        after = fixture["git"]["after"]

        self.assertEqual(before["branch"], "feature")
        self.assertEqual(before["branch"], after["branch"])
        self.assertEqual(before["head"], after["head"])
        self.assertEqual(before["refs_fingerprint"], after["refs_fingerprint"])
        self.assertEqual(fixture["actual_mutations"]["created"], fixture["expected_mutations"])
        self.assertTrue(fixture["adopt"]["idempotent"])

    def test_legacy_stays_compatible_and_adopted_loop_is_idempotent(self):
        receipt = self.run_fixtures("legacy", "adopted")
        fixtures = {fixture["kind"]: fixture for fixture in receipt["fixtures"]}

        self.assertTrue(fixtures["legacy"]["doctor"]["actual_ok"])
        self.assertEqual(fixtures["legacy"]["doctor"]["compatibility_schema"], 1)
        self.assertEqual(fixtures["legacy"]["doctor"]["workspace_contract"], "legacy-v0.1")
        self.assertGreater(fixtures["legacy"]["doctor"]["warnings"], 0)
        self.assertTrue(fixtures["legacy"]["doctor"]["upgrade_guidance_present"])
        self.assertEqual(
            fixtures["legacy"]["expected_mutations"],
            [
                "modules/agent-workspace/index.md",
                "modules/codebase/index.md",
                "modules/index.md",
            ],
        )
        self.assertGreater(fixtures["legacy"]["find"]["results"], 0)
        self.assertEqual(fixtures["adopted"]["expected_mutations"], [])
        self.assertEqual(
            fixtures["adopted"]["actual_mutations"],
            {"created": [], "changed": [], "deleted": []},
        )
        self.assertTrue(fixtures["adopted"]["adopt"]["dry_run_read_only"])
        self.assertTrue(fixtures["adopted"]["adopt"]["idempotent"])


    def test_capability_truth_rejects_status_reason_disagreement(self):
        capabilities = json.loads(
            json.dumps(
                orientation_proof.create_vivary.capability_report("coding")
            )
        )
        core = next(
            row
            for row in capabilities["available_capabilities"]
            if row["id"] == "governed-context:core"
        )
        core.update(
            installed=False,
            install_status="not-installed",
            reason_codes=[],
            missing_install=["vivary-core"],
        )

        with self.assertRaises(orientation_proof.ProofFailure):
            orientation_proof._require_capability_truth(
                {"capabilities": capabilities},
                transport="test",
                kind="current",
            )

    def test_capability_truth_rejects_incomplete_static_declarations(self):
        capabilities = json.loads(
            json.dumps(
                orientation_proof.create_vivary.capability_report("coding")
            )
        )
        capabilities["available_capabilities"][0]["label"] = "forged"

        with self.assertRaises(orientation_proof.ProofFailure):
            orientation_proof._require_capability_truth(
                {"capabilities": capabilities},
                transport="test",
                kind="current",
            )

    def test_fixture_failure_still_writes_a_sanitized_receipt(self):
        with tempfile.TemporaryDirectory(prefix="orientation-proof-failure-") as raw:
            receipt_path = Path(raw) / "receipt.json"
            python_transport, _ = orientation_proof.local_test_transports()
            invalid_json_transport = orientation_proof.CreateTransport(
                "npm-test-double",
                (
                    orientation_proof.sys.executable,
                    "-c",
                    "import sys; sys.stderr.write(' '.join(sys.argv)); print('not-json')",
                ),
                {},
            )

            receipt = orientation_proof.run_proof(
                receipt_path,
                fixture_kinds=("current",),
                transports=(python_transport, invalid_json_transport),
                strict_transports=False,
            )

            self.assertFalse(receipt["ok"])
            self.assertEqual(receipt, json.loads(receipt_path.read_text(encoding="utf-8")))
            self.assertEqual(len(receipt["fixtures"]), 1)
            fixture = receipt["fixtures"][0]
            self.assertFalse(fixture["ok"])
            self.assertEqual(fixture["phase"], "proof")
            self.assertIn("invalid JSON", fixture["error"])
            self.assertIn("<fixture>", fixture["error"])
            self.assertEqual(fixture["root"], "<fixture>")
            self.assertNotIn(
                "vivary-orientation-proof-",
                receipt_path.read_text(encoding="utf-8"),
            )

    def test_privacy_failure_discards_leaking_details_but_keeps_fixture_summary(self):
        with tempfile.TemporaryDirectory(prefix="orientation-proof-privacy-") as raw:
            receipt_path = Path(raw) / "receipt.json"
            python_transport, _ = orientation_proof.local_test_transports()
            invalid_json_transport = orientation_proof.CreateTransport(
                "npm-test-double",
                (
                    orientation_proof.sys.executable,
                    "-c",
                    "import sys; sys.stderr.write(' '.join(sys.argv)); print('not-json')",
                ),
                {},
            )

            with mock.patch.object(
                orientation_proof,
                "_sanitize_text",
                side_effect=lambda text, fixture, temp_root: text,
            ):
                receipt = orientation_proof.run_proof(
                    receipt_path,
                    fixture_kinds=("current",),
                    transports=(python_transport, invalid_json_transport),
                    strict_transports=False,
                )

            self.assertFalse(receipt["ok"])
            self.assertEqual(receipt["phase"], "receipt-privacy")
            self.assertEqual(receipt["fixtures"], [{"kind": "current", "ok": False}])
            self.assertEqual(receipt, json.loads(receipt_path.read_text(encoding="utf-8")))
            self.assertNotIn(
                "vivary-orientation-proof-",
                receipt_path.read_text(encoding="utf-8"),
            )

    def test_strict_receipt_rejects_the_python_test_double(self):
        receipt = self.run_fixtures("current")

        with self.assertRaises(orientation_proof.ProofFailure):
            orientation_proof.validate_receipt(receipt, strict_transports=True)


if __name__ == "__main__":
    unittest.main()

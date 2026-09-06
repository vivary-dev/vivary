"""Adversarial tests for planning drift and false execution readiness."""
import importlib.util
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location('plan_check', Path(__file__).resolve().parents[1] / 'check_multi_project_plan.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class PlanCheckTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.plan = self.root / 'docs/product/multi-project'
        for folder in ('tickets', 'packets'):
            (self.plan / folder).mkdir(parents=True)
        for number in range(1, 37):
            key = f'{number:02}'
            self.ticket(key).write_text(f'# {key}: fixture\nType: outcome\nStatus: planned\nBlocked-by: []\nUnlocks: []\n\n## Goal\nGoal.\n## Context\nContext.\n## Done condition\nAccepted.\n## Verify\n```console\npython check.py\n```\n## Log\nEvidence not yet produced.\n', encoding='utf-8')
        for name in ('design', 'execution-contract', 'audit', 'external-dependencies'):
            (self.plan / f'{name}.md').write_text(f'# {name}\n', encoding='utf-8')
        (self.plan / 'execution-contract.md').write_text(
            '# execution-contract\n\n## Maintaining the graph\n\nRun the common checks.\n', encoding='utf-8')
        retained_scopes = ['S-00A'] + [f'S-{n:02}' for n in range(14)]
        coverage_rows = []
        for number in range(1, 37):
            scope = retained_scopes[number - 1] if number <= len(retained_scopes) else 'none'
            coverage_rows.append(f'| {number:02} | outcome {scope} | baseline | completion |')
        coverage = '\n'.join([
            '| ID | Retained outcome and source scope | Bounded baseline path | Completion work |',
            '| --- | --- | --- | --- |',
            *coverage_rows,
        ])
        (self.plan / 'capability-matrix.md').write_text(coverage, encoding='utf-8')
        (self.plan / 'receipts').mkdir()
        (self.plan / 'receipts/fixture.md').write_text(
            '# Fixture receipt\n\nEvidence-record: 02a\n', encoding='utf-8')
        self.packet = self.plan / 'packets/02a-fixture.md'
        self.packet.write_text('# 02a: fixture\n\nType: packet\nParent: 02\nStatus: ready-for-agent\nDepends-on: []\nOwner: fixture agent\nScope: isolated fixture\nTimebox: one context\nVerification-kind: runtime\n\n## Goal\nRound trip.\n## Context\nSynthetic inputs.\n## Owned files\nCreate fixture.mjs.\n## Done condition\nExact roundtrip.\n## Verify\n```console\nnode --test fixture.mjs\n```\n## Stop conditions\nNo external writes.\n## Log\nPrepared.\n', encoding='utf-8')
        self.render()

    def ticket(self, key):
        return self.plan / f'tickets/{key}-fixture.md'

    def replace(self, path, old, new):
        path.write_text(path.read_text(encoding='utf-8').replace(old, new), encoding='utf-8')

    def render(self):
        records = module.read_records(self.plan)
        (self.plan / 'graph.md').write_text(module.render_graph(self.plan, records), encoding='utf-8')
        render_index = getattr(module, 'render_index', None)
        if render_index:
            (self.plan / 'index.md').write_text(render_index(self.plan, records), encoding='utf-8')
        else:
            (self.plan / 'index.md').write_text('# Current Vivary program frontier\n\nFrontier: 02a.\n', encoding='utf-8')

    def assert_error(self, text):
        self.assertTrue(any(text in error for error in module.check(self.root)), module.check(self.root))

    def test_consistent_graph_passes(self):
        self.assertEqual(module.check(self.root), [])

    def test_dangling_dependency_fails(self):
        self.replace(self.ticket('01'), 'Blocked-by: []', 'Blocked-by: [99]')
        self.assert_error('unknown dependency 99')

    def test_consistent_reverse_edges_do_not_hide_cycle(self):
        for key, other in [('01', '02'), ('02', '01')]:
            self.replace(self.ticket(key), 'Blocked-by: []', f'Blocked-by: [{other}]')
            self.replace(self.ticket(key), 'Unlocks: []', f'Unlocks: [{other}]')
        self.render()
        self.assert_error('dependency cycle')

    def test_frontier_drift_fails(self):
        self.replace(self.plan / 'graph.md', 'Frontier: 02a.', 'Frontier: none.')
        self.assert_error('graph/frontier drift')

    def test_mermaid_drift_fails(self):
        self.replace(self.plan / 'graph.md', 'graph TD', 'graph TD\n T01 --> T02')
        self.assert_error('graph/frontier drift')

    def test_frontier_index_drift_fails(self):
        self.replace(self.plan / 'index.md', '02a', 'none')
        self.assert_error('frontier index drift')

    def test_waiting_requires_specific_input(self):
        self.replace(self.packet, 'Status: ready-for-agent', 'Status: needs-info')
        self.render()
        self.assert_error('waiting status requires exact Needs')

    def test_ready_packet_cannot_hide_unfinished_start_dependency(self):
        self.replace(self.packet, 'Depends-on: []', 'Depends-on: [01]')
        self.render()
        self.assert_error('unfinished start dependency 01')

    def test_human_gated_packet_cannot_hide_unfinished_start_dependency(self):
        self.replace(self.packet, 'Status: ready-for-agent', 'Status: ready-for-human')
        self.replace(self.packet, 'Depends-on: []', 'Depends-on: [01]')
        self.replace(self.packet, 'Owner: fixture agent', 'Needs: Human approval of the prepared operation.\nOwner: fixture agent')
        self.render()
        self.assert_error('unfinished start dependency 01')

    def test_independent_packet_can_start_before_parent_completes(self):
        self.assertEqual(module.frontier(module.read_records(self.plan)), ['02a'])
        self.assertEqual(module.check(self.root), [])

    def test_runtime_packet_cannot_use_only_document_checks(self):
        self.replace(self.packet, 'node --test fixture.mjs', 'python scripts/check_multi_project_plan.py --check')
        self.assert_error('runtime packet has only common planning checks')

    def test_done_requires_evidence(self):
        self.replace(self.packet, 'Status: ready-for-agent', 'Status: done')
        self.render()
        self.assert_error('done requires evidence')

    def test_done_requires_a_resolvable_receipt_link(self):
        self.replace(self.packet, 'Status: ready-for-agent', 'Status: done')
        self.replace(self.packet, 'Timebox: one context', 'Evidence: pending\nTimebox: one context')
        self.replace(self.packet, 'Prepared.', 'Verification completed and passed.')
        self.render()
        self.assert_error('done requires linked evidence receipt')

    def test_done_requires_structured_verification_result(self):
        self.replace(self.packet, 'Status: ready-for-agent', 'Status: done')
        self.replace(self.packet, 'Timebox: one context', 'Evidence: [Fixture receipt](../receipts/fixture.md)\nTimebox: one context')
        self.replace(self.packet, 'Prepared.', 'Implementation has not started.')
        self.render()
        self.assert_error('done requires Verification-result: passed')

    def test_evidence_receipt_directory_returns_validation_errors(self):
        receipt = self.plan / 'receipts/fixture.md'
        receipt.unlink()
        receipt.mkdir()
        self.replace(self.packet, 'Status: ready-for-agent', 'Status: done')
        self.replace(self.packet, 'Timebox: one context',
                     'Evidence: [Fixture receipt](../receipts/fixture.md)\n'
                     'Verification-result: passed\nTimebox: one context')
        self.render()
        for anchor in ('', '#receipt'):
            with self.subTest(anchor=anchor):
                if anchor:
                    self.replace(self.packet, '../receipts/fixture.md)', '../receipts/fixture.md#receipt)')
                self.assert_error('done requires linked evidence receipt')

    def test_unreadable_evidence_receipt_returns_validation_errors(self):
        receipt = self.plan / 'receipts/fixture.md'
        receipt.write_bytes(b'# Receipt\n\nEvidence-record: 02a\n\xff')
        self.replace(self.packet, 'Status: ready-for-agent', 'Status: done')
        self.replace(self.packet, 'Timebox: one context',
                     'Evidence: [Fixture receipt](../receipts/fixture.md)\n'
                     'Verification-result: passed\nTimebox: one context')
        self.render()
        for anchor in ('', '#receipt'):
            with self.subTest(anchor=anchor):
                if anchor:
                    self.replace(self.packet, '../receipts/fixture.md)', '../receipts/fixture.md#receipt)')
                self.assert_error('done requires linked evidence receipt')
        original_read = Path.read_text
        def unavailable(path, *args, **kwargs):
            if path == receipt:
                raise PermissionError('synthetic receipt access failure')
            return original_read(path, *args, **kwargs)
        with mock.patch.object(Path, 'read_text', unavailable):
            self.assert_error('done requires linked evidence receipt')

    def test_structured_pass_allows_historical_failure_detail_in_log(self):
        self.replace(self.packet, 'Status: ready-for-agent', 'Status: done')
        self.replace(self.packet, 'Timebox: one context',
                     'Evidence: [Fixture receipt](../receipts/fixture.md)\n'
                     'Verification-result: passed\nTimebox: one context')
        self.replace(self.packet, 'Prepared.', 'The earlier verification failed; see the receipt for the current run.')
        self.render()
        self.assertEqual(module.check(self.root), [])

    def test_failed_structured_result_rejects_positive_log_prose(self):
        self.replace(self.packet, 'Status: ready-for-agent', 'Status: done')
        self.replace(self.packet, 'Timebox: one context',
                     'Evidence: [Fixture receipt](../receipts/fixture.md)\n'
                     'Verification-result: failed\nTimebox: one context')
        self.replace(self.packet, 'Prepared.', 'Verification completed and passed.')
        self.render()
        self.assert_error('done requires Verification-result: passed')

    def test_done_record_rejects_duplicate_structured_result(self):
        self.replace(self.packet, 'Status: ready-for-agent', 'Status: done')
        self.replace(self.packet, 'Timebox: one context',
                     'Evidence: [Fixture receipt](../receipts/fixture.md)\n'
                     'Verification-result: failed\n'
                     'Verification-result: passed\nTimebox: one context')
        self.replace(self.packet, 'Prepared.', 'Verification completed and passed.')
        self.render()
        self.assert_error('duplicate metadata field Verification-result')

    def test_done_record_rejects_receipt_bound_to_another_record(self):
        self.replace(self.packet, 'Status: ready-for-agent', 'Status: done')
        self.replace(self.packet, 'Timebox: one context',
                     'Evidence: [Fixture receipt](../receipts/fixture.md)\nVerification-result: passed\nTimebox: one context')
        self.replace(self.packet, 'Prepared.', 'Verification completed and passed.')
        self.replace(self.plan / 'receipts/fixture.md', 'Evidence-record: 02a', 'Evidence-record: 01')
        self.render()
        self.assert_error('evidence receipt does not bind record 02a')

    def test_done_record_rejects_ambiguous_structured_result(self):
        self.replace(self.packet, 'Status: ready-for-agent', 'Status: done')
        self.replace(self.packet, 'Timebox: one context',
                     'Evidence: [Fixture receipt](../receipts/fixture.md)\n'
                     'Verification-result: failed; passed\nTimebox: one context')
        self.replace(self.packet, 'Prepared.', 'Verification completed and passed.')
        self.render()
        self.assert_error('done requires Verification-result: passed')

    def test_done_record_rejects_duplicate_receipt_binding_metadata(self):
        self.replace(self.packet, 'Status: ready-for-agent', 'Status: done')
        self.replace(self.packet, 'Timebox: one context',
                     'Evidence: [Fixture receipt](../receipts/fixture.md)\n'
                     'Verification-result: passed\nTimebox: one context')
        self.replace(self.packet, 'Prepared.', 'Verification completed and passed.')
        receipt = self.plan / 'receipts/fixture.md'
        receipt.write_text(
            '# Fixture receipt\n\nEvidence-record: 01\nEvidence-record: 02a\n', encoding='utf-8')
        self.render()
        self.assert_error('evidence receipt has duplicate metadata field Evidence-record')

    def test_done_outcome_cannot_have_unfinished_child_packet(self):
        ticket = self.ticket('02')
        self.replace(ticket, 'Status: planned', 'Status: done')
        self.replace(ticket, 'Blocked-by: []', 'Blocked-by: []\nEvidence: [Fixture receipt](../receipts/fixture.md)')
        self.replace(ticket, 'Evidence not yet produced.', 'Verification completed and passed.')
        self.render()
        self.assert_error('done outcome has unfinished child packet 02a')

    def test_missing_source_scope_fails(self):
        self.replace(self.plan / 'capability-matrix.md', 'S-09', 'scope omitted')
        self.assert_error('missing retained source scope')

    def test_scope_token_outside_outcome_rows_does_not_satisfy_coverage(self):
        matrix = self.plan / 'capability-matrix.md'
        self.replace(matrix, 'outcome S-09', 'outcome scope omitted')
        matrix.write_text(matrix.read_text(encoding='utf-8') + '\nS-09\n', encoding='utf-8')
        self.assert_error('missing retained source scope')

    def test_duplicate_scope_owner_row_fails(self):
        self.replace(self.plan / 'capability-matrix.md', '| 36 |', '| 35 |')
        self.assert_error('each of 36 outcomes exactly once')

    def test_missing_and_escaping_links_fail(self):
        self.replace(self.ticket('01'), 'Context.', '[missing](missing.md) [escape](../../../../../outside.md)')
        self.assertEqual(sum('missing or escaping link' in e for e in module.check(self.root)), 2)

    def test_missing_anchor_fails(self):
        self.replace(self.ticket('01'), 'Context.', '[bad](../design.md#missing)')
        self.assert_error('missing anchor')

    def test_private_path_fails(self):
        self.replace(self.ticket('01'), 'Context.', 'C:/Users/example/private.txt')
        self.assert_error('possible private path')

    def test_private_path_in_raw_evidence_fails(self):
        (self.plan / 'raw-evidence.txt').write_text('C:/Users/example/private.txt\n', encoding='utf-8')
        self.assert_error('possible private path')

    def test_credential_in_json_planning_artifact_fails(self):
        (self.plan / 'fixtures').mkdir()
        (self.plan / 'fixtures/public.json').write_text(
            '{"sourceId":"ghp_12345678901234567890"}\n', encoding='utf-8')
        self.assert_error('possible private path or credential')

    def test_encoded_private_values_in_json_planning_artifact_fail(self):
        (self.plan / 'fixtures').mkdir()
        artifact = self.plan / 'fixtures/public.json'
        cases = [
            '{"path":"C:\\\\Users\\\\example\\\\private.txt"}\n',
            '{"token":"\\u0067\\u0068\\u0070\\u005f12345678901234567890"}\n',
        ]
        for body in cases:
            with self.subTest(body=body):
                artifact.write_text(body, encoding='utf-8')
                self.assert_error('possible private path or credential')

    def test_private_value_in_any_utf8_program_artifact_fails(self):
        (self.plan / 'fixtures').mkdir()
        cases = [
            ('public.yaml', 'token: ghp_12345678901234567890\n'),
            ('public.JSON', '{"path":"C:\\\\Users\\\\example\\\\private.txt"}\n'),
        ]
        for name, body in cases:
            with self.subTest(name=name):
                artifact = self.plan / 'fixtures' / name
                artifact.write_text(body, encoding='utf-8')
                self.assert_error('possible private path or credential')
                artifact.unlink()

    def test_encoded_private_value_in_duplicate_json_key_fails(self):
        (self.plan / 'fixtures').mkdir()
        (self.plan / 'fixtures/public.json').write_text(
            '{"token":"\\u0067\\u0068\\u0070\\u005f12345678901234567890","token":"safe"}\n',
            encoding='utf-8')
        self.assert_error('possible private path or credential')

    def test_malformed_json_planning_artifact_fails(self):
        (self.plan / 'fixtures').mkdir()
        (self.plan / 'fixtures/public.json').write_text('{"value":\n', encoding='utf-8')
        self.assert_error('invalid JSON')

    def test_json_with_utf8_bom_is_decoded_and_scanned(self):
        (self.plan / 'fixtures').mkdir()
        (self.plan / 'fixtures/public.json').write_text(
            '\ufeff{"token":"\\u0067\\u0068\\u0070\\u005f12345678901234567890"}\n',
            encoding='utf-8')
        self.assert_error('possible private path or credential')

    def test_non_utf8_json_planning_artifact_fails(self):
        (self.plan / 'fixtures').mkdir()
        (self.plan / 'fixtures/public.json').write_bytes(b'{"value":"\xff"}\n')
        self.assert_error('invalid UTF-8 JSON')

    def test_invalid_utf8_cannot_hide_private_text_artifacts(self):
        for suffix in ('.txt', '.yaml', '.data'):
            with self.subTest(suffix=suffix):
                artifact = self.plan / f'raw-evidence{suffix}'
                artifact.write_bytes(b'ghp_12345678901234567890\n\xff')
                try:
                    self.assert_error('invalid UTF-8')
                finally:
                    artifact.unlink()

    def test_deep_json_returns_privacy_or_nesting_diagnostics(self):
        (self.plan / 'fixtures').mkdir()
        artifact = self.plan / 'fixtures/public.json'
        artifact.write_text('{"child":' * 600 + '"\\u0067hp_12345678901234567890"' + '}' * 600,
                            encoding='utf-8')
        self.assert_error('possible private path or credential')
        artifact.write_text('{"child":' * 2000 + '"ordinary"' + '}' * 2000, encoding='utf-8')
        errors = module.check(self.root)
        self.assertTrue(not errors or all('JSON nesting exceeds parser limit' in error for error in errors), errors)
        with mock.patch.object(module.json, 'loads', side_effect=RecursionError):
            self.assert_error('JSON nesting exceeds parser limit')
        decoded = 'ordinary'
        for _ in range(2000):
            decoded = [('child', decoded)]
        with mock.patch.object(module.json, 'loads', return_value=decoded):
            self.assertEqual(module.check(self.root), [])

    def test_non_finite_json_constants_fail(self):
        (self.plan / 'fixtures').mkdir()
        artifact = self.plan / 'fixtures/public.json'
        for constant in ('NaN', 'Infinity', '-Infinity'):
            with self.subTest(constant=constant):
                artifact.write_text(f'{{"value":{constant}}}\n', encoding='utf-8')
                self.assert_error('invalid JSON constant')

    def test_plan_preflight_rejects_all_symlink_kinds_without_reading_targets(self):
        original_resolve = Path.resolve
        with tempfile.TemporaryDirectory() as outside_temp:
            outside = Path(outside_temp)
            file_target = outside / 'private.txt'
            file_target.write_text('private sentinel\n', encoding='utf-8')
            directory_target = outside / 'private-directory'
            directory_target.mkdir()
            cases = (
                ('file', self.plan / 'tickets/file-link.md', file_target, False),
                ('directory', self.plan / 'receipts/directory-link', directory_target, True),
                ('broken', self.plan / 'packets/broken-link.md', outside / 'missing', False),
            )
            for kind, link, target, target_is_directory in cases:
                with self.subTest(kind=kind):
                    link.symlink_to(target, target_is_directory=target_is_directory)

                    def guarded_read_text(path, *args, **kwargs):
                        raise AssertionError(f'read {path} before rejecting {kind} symlink')

                    def guarded_resolve(path, *args, **kwargs):
                        if path == link:
                            raise AssertionError(f'resolved known {kind} symlink')
                        return original_resolve(path, *args, **kwargs)

                    try:
                        with mock.patch.object(Path, 'read_text', new=guarded_read_text), \
                                mock.patch.object(Path, 'resolve', new=guarded_resolve):
                            errors = module.check(self.root)
                        relative = link.relative_to(self.root)
                        self.assertIn(f'{relative}: symbolic link is not allowed', errors)
                    finally:
                        link.unlink(missing_ok=True)

    def test_plan_preflight_stops_at_symlinked_ancestor(self):
        product = self.root / 'docs/product'
        target = self.root / 'real-product'
        product.rename(target)
        product.symlink_to(target, target_is_directory=True)
        original_is_symlink = Path.is_symlink

        def guarded_is_symlink(path):
            if path == self.plan:
                raise AssertionError('inspected a descendant of a known symlink')
            return original_is_symlink(path)

        def guarded_read_text(path, *args, **kwargs):
            raise AssertionError(f'read {path} before rejecting ancestor symlink')

        with mock.patch.object(Path, 'is_symlink', new=guarded_is_symlink), \
                mock.patch.object(Path, 'read_text', new=guarded_read_text):
            errors = module.check(self.root)
        relative = product.relative_to(self.root)
        self.assertEqual(errors, [f'{relative}: symbolic link is not allowed'])

    def test_render_cli_refuses_symlink_before_writing_outputs(self):
        scripts = self.root / 'scripts'
        scripts.mkdir()
        checker = scripts / 'check_multi_project_plan.py'
        shutil.copyfile(module.__file__, checker)
        graph = self.plan / 'graph.md'
        index = self.plan / 'index.md'
        graph.write_text('graph sentinel\n', encoding='utf-8')
        index.write_text('index sentinel\n', encoding='utf-8')
        before = (graph.read_bytes(), index.read_bytes())

        with tempfile.TemporaryDirectory() as outside_temp:
            target = Path(outside_temp) / 'private.txt'
            target.write_text('private sentinel\n', encoding='utf-8')
            link = self.plan / 'receipts/private-link'
            link.symlink_to(target)
            try:
                result = subprocess.run(
                    [sys.executable, str(checker), '--render'],
                    cwd=self.root,
                    capture_output=True,
                    text=True,
                    check=False,
                )
            finally:
                link.unlink(missing_ok=True)

        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn('symbolic link is not allowed', result.stdout)
        self.assertEqual((graph.read_bytes(), index.read_bytes()), before)

    def test_duplicate_record_id_fails(self):
        (self.plan / 'tickets/01-duplicate.md').write_bytes(self.ticket('01').read_bytes())
        self.assert_error('duplicate record ID')

    def test_metadata_after_header_cannot_override_status(self):
        with self.packet.open('a', encoding='utf-8') as handle:
            handle.write('\nStatus: done\n')
        self.assertEqual(module.check(self.root), [])

    def test_duplicate_header_field_fails(self):
        self.replace(self.packet, 'Status: ready-for-agent', 'Status: ready-for-agent\nStatus: done')
        self.assert_error('duplicate metadata field Status')

    def test_heading_id_must_match_filename(self):
        self.replace(self.packet, '# 02a: fixture', '# 99: fixture')
        self.render()
        self.assert_error('heading ID does not match filename')

    def test_packet_id_must_match_parent(self):
        self.replace(self.packet, 'Parent: 02', 'Parent: 03')
        self.render()
        self.assert_error('packet ID does not match parent')

    def test_outcome_dependency_cannot_target_packet(self):
        self.replace(self.ticket('01'), 'Blocked-by: []', 'Blocked-by: [02a]')
        self.replace(self.packet, 'Depends-on: []', 'Depends-on: []\nUnlocks: [01]')
        self.render()
        self.assert_error('outcome dependency must name an outcome')

    def test_outcome_verify_can_link_to_canonical_common_checks(self):
        public_doc = self.root / 'docs/common-checks.md'
        public_doc.write_text('# Common checks\n\n## Maintaining the graph\n\nRun them.\n', encoding='utf-8')
        self.replace(self.ticket('01'), '```console\npython check.py\n```',
                     '[Run the canonical common planning checks](../../../common-checks.md#maintaining-the-graph).')
        self.assertEqual(module.check(self.root), [])

    def test_held_external_gate_blocks_done_outcome(self):
        external = self.plan / 'external-dependencies.md'
        external.write_text('# External delivery dependencies\n\n## Template installer\nGate: template-installer\nStatus: held\nOwner: template installer program\nRequired-by: [19]\n', encoding='utf-8')
        ticket = self.ticket('19')
        self.replace(ticket, 'Blocked-by: []', 'Blocked-by: []\nExternal-gates: [template-installer]\nEvidence: [Fixture receipt](../receipts/fixture.md)')
        self.replace(ticket, 'Status: planned', 'Status: done')
        self.replace(ticket, 'Evidence not yet produced.', 'Verification completed and passed.')
        self.render()
        self.assert_error('unfinished external gate template-installer')

    def test_malformed_external_gate_list_fails(self):
        ticket = self.ticket('19')
        self.replace(ticket, 'Blocked-by: []', 'Blocked-by: []\nExternal-gates: [Template Installer]')
        self.assert_error('invalid External-gates')

    def test_duplicate_external_gate_id_fails(self):
        external = self.plan / 'external-dependencies.md'
        gate = 'Gate: template-installer\nStatus: held\nOwner: template installer program\nRequired-by: [19]\n'
        external.write_text(f'# External delivery dependencies\n\n## First\n{gate}\n## Duplicate\n{gate}', encoding='utf-8')
        self.replace(self.ticket('19'), 'Blocked-by: []', 'Blocked-by: []\nExternal-gates: [template-installer]')
        self.assert_error('duplicate external gate template-installer')

    def test_duplicate_external_gate_header_field_fails(self):
        external = self.plan / 'external-dependencies.md'
        external.write_text(
            '# External delivery dependencies\n\n## Template installer\n'
            'Gate: template-installer\nStatus: held\nStatus: done\n'
            'Owner: template installer program\nRequired-by: []\n', encoding='utf-8')
        self.assert_error('external gate template-installer: duplicate metadata field Status')

    def test_duplicate_gate_field_is_reported_when_last_value_is_empty(self):
        external = self.plan / 'external-dependencies.md'
        external.write_text(
            '# External delivery dependencies\n\n## Template installer\n'
            'Gate: template-installer\n' + 'Gate: ' + '\nStatus: held\n'
            'Owner: template installer program\nRequired-by: []\n', encoding='utf-8')
        self.assert_error('external gate section Template installer: duplicate metadata field Gate')

    def test_external_gate_section_requires_gate_id(self):
        external = self.plan / 'external-dependencies.md'
        external.write_text(
            '# External delivery dependencies\n\n## Template installer\n'
            'Status: held\nOwner: template installer program\nRequired-by: []\n', encoding='utf-8')
        self.assert_error('external gate section Template installer: missing Gate')

    def test_outputs_cannot_be_start_prerequisites(self):
        self.replace(self.packet, 'Create fixture.mjs.', 'Output files must exist before this ticket is actionable.')
        self.assert_error('outputs are incorrectly required')


if __name__ == '__main__':
    unittest.main()

"""Adversarial tests for planning drift and false execution readiness."""
import importlib.util
from pathlib import Path
import tempfile
import unittest

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
        coverage = '\n'.join(f'| {n:02} | outcome |' for n in range(1, 37)) + '\nS-00A ' + ' '.join(f'S-{n:02}' for n in range(14))
        (self.plan / 'capability-matrix.md').write_text(coverage, encoding='utf-8')
        self.packet = self.plan / 'packets/02a-fixture.md'
        self.packet.write_text('# 02a: fixture\nType: packet\nParent: 02\nStatus: ready-for-agent\nDepends-on: []\nOwner: fixture agent\nScope: isolated fixture\nTimebox: one context\nVerification-kind: runtime\n\n## Goal\nRound trip.\n## Context\nSynthetic inputs.\n## Owned files\nCreate fixture.mjs.\n## Done condition\nExact roundtrip.\n## Verify\n```console\nnode --test fixture.mjs\n```\n## Stop conditions\nNo external writes.\n## Log\nPrepared.\n', encoding='utf-8')
        self.render()

    def ticket(self, key):
        return self.plan / f'tickets/{key}-fixture.md'

    def replace(self, path, old, new):
        path.write_text(path.read_text(encoding='utf-8').replace(old, new), encoding='utf-8')

    def render(self):
        (self.plan / 'graph.md').write_text(module.render_graph(self.plan, module.read_records(self.plan)), encoding='utf-8')

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

    def test_waiting_requires_specific_input(self):
        self.replace(self.packet, 'Status: ready-for-agent', 'Status: needs-info')
        self.render()
        self.assert_error('waiting status requires exact Needs')

    def test_ready_packet_cannot_hide_unfinished_start_dependency(self):
        self.replace(self.packet, 'Depends-on: []', 'Depends-on: [01]')
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

    def test_missing_source_scope_fails(self):
        self.replace(self.plan / 'capability-matrix.md', 'S-09', 'scope omitted')
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

    def test_duplicate_record_id_fails(self):
        (self.plan / 'tickets/01-duplicate.md').write_bytes(self.ticket('01').read_bytes())
        self.assert_error('duplicate record ID')

    def test_outputs_cannot_be_start_prerequisites(self):
        self.replace(self.packet, 'Create fixture.mjs.', 'Output files must exist before this ticket is actionable.')
        self.assert_error('outputs are incorrectly required')


if __name__ == '__main__':
    unittest.main()

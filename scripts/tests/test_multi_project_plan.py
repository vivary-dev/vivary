"""Adversarial fixtures for program drift that must block a planning update."""
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
        (self.plan / 'tickets').mkdir(parents=True)
        rows = []
        for number in range(1, 37):
            key = f'{number:02}'
            self.ticket(key).write_text(f'# {key}\nStatus: done\nBlocked-by: []\nUnlocks: []\n\n## Goal\nGoal.\n## Context\nContext.\n## Done condition\nAccepted.\n## Verify\n```console\npython check.py\n```\n## Log\nEvidence.\n', encoding='utf-8')
            rows.append(f'| [{key}](tickets/{key}-fixture.md) | done | outcome | [] |')
        (self.plan / 'graph.md').write_text('\n'.join(rows), encoding='utf-8')

    def ticket(self, key):
        return self.plan / f'tickets/{key}-fixture.md'

    def replace(self, key, old, new):
        path = self.ticket(key)
        path.write_text(path.read_text(encoding='utf-8').replace(old, new), encoding='utf-8')

    def test_consistent_graph_passes(self):
        self.assertEqual(module.check(self.root), [])

    def test_dangling_dependency_fails(self):
        self.replace('01', 'Blocked-by: []', 'Blocked-by: [99]')
        self.assertTrue(any('unknown dependency 99' in e for e in module.check(self.root)))

    def test_consistent_reverse_edges_do_not_hide_cycle(self):
        for key, other in [('01', '02'), ('02', '01')]:
            self.replace(key, 'Blocked-by: []', f'Blocked-by: [{other}]')
            self.replace(key, 'Unlocks: []', f'Unlocks: [{other}]')
        self.assertTrue(any('dependency cycle' in e for e in module.check(self.root)))

    def test_status_drift_fails(self):
        self.replace('01', 'Status: done', 'Status: needs-info')
        self.assertTrue(any('graph status' in e for e in module.check(self.root)))

    def test_missing_and_escaping_links_fail(self):
        self.replace('01', 'Context.', '[missing](missing.md) [escape](../../../../../outside.md)')
        self.assertEqual(sum('missing or escaping link' in e for e in module.check(self.root)), 2)

    def test_private_path_fails(self):
        self.replace('01', 'Context.', 'C:/Users/example/private.txt')
        self.assertTrue(any('possible private path' in e for e in module.check(self.root)))


if __name__ == '__main__':
    unittest.main()

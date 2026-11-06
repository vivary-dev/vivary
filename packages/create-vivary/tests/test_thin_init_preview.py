"""Exact creation previews share their bytes with the actual thin scaffolder."""
from concurrent.futures import ThreadPoolExecutor
import hashlib
import io
from contextlib import contextmanager, redirect_stdout, redirect_stderr
import json
import os
from pathlib import Path
import sys
import tempfile
from threading import Barrier, Event
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[3]
sys.path[:0] = [str(ROOT/'packages/create-vivary'), str(ROOT/'packages/tropo')]
import create_vivary as cv
import tropo


class ThinInitPreviewTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='vivary-preview-')
        self.addCleanup(self.temporary.cleanup)
        self.parent = Path(self.temporary.name).resolve()

    def test_non_bmp_choice_round_trips_through_toml_and_doctor(self):
        import tomllib
        target = self.parent/'emoji-project'
        choices = ({'id': 'capture', 'name': 'Capture 😀', 'path': 'notes/😀.md'},)
        plan = cv.plan_thin_workspace(target, pattern_choices=choices)
        config = next(row['content'] for row in plan['files']
                      if row['path'] == '.vivary/workspace.toml')
        self.assertEqual(
            tomllib.loads(config)['workspace']['vivary']['pattern_outputs'][0]['name'],
            'Capture 😀')
        self.assertFalse(target.exists())
        cv.scaffold_thin_workspace(target, pattern_choices=choices, repo_root=ROOT)
        self.assertEqual(cv.workspace_pattern_state(target)['choices'], list(choices))
        for field in ('name', 'path'):
            bad = dict(choices[0])
            bad[field] = 'bad\ud800' + ('.md' if field == 'path' else '')
            with self.assertRaises(cv.ScaffoldError):
                cv.plan_thin_workspace(self.parent/'surrogate', pattern_choices=(bad,))

    def test_pattern_preview_allows_missing_parent_chain_without_writes(self):
        target = self.parent/'not-yet'/'nested'/'project'
        choices = ({'id': 'capture', 'name': 'Capture',
                    'path': 'inbox/README.md'},)
        plan = cv.plan_thin_workspace(target, pattern_choices=choices)
        self.assertEqual(plan['pattern_choices'], list(choices))
        self.assertFalse((self.parent/'not-yet').exists())

    def test_typed_guidance_path_is_refused_before_init_writes(self):
        target = self.parent/'typed-project'
        choices = ({'id': 'capture', 'name': 'Capture',
                    'path': 'projects/capture.md'},)
        with self.assertRaisesRegex(cv.ScaffoldError, 'E101'):
            cv.plan_thin_workspace(target, pattern_choices=choices)
        self.assertFalse(target.exists())
        self.assertEqual(list(self.parent.iterdir()), [])

    def test_preview_is_repeatable_and_does_not_create_absent_target(self):
        target = self.parent/'new-project'
        first = cv.plan_thin_workspace(target)
        self.assertEqual(first, cv.plan_thin_workspace(target))
        self.assertFalse(target.exists())
        self.assertEqual(list(self.parent.iterdir()), [])
        self.assertEqual(first['schema'], 'vivary.thin-init-plan/v1')
        self.assertEqual([row['path'] for row in first['files']],
            ['.gitignore','.vivary/context.md','.vivary/workspace.toml','AGENTS.md','STATE.md'])
        self.assertEqual(json.loads(json.dumps(first)), first)

    def test_exact_bytes_match_apply_and_doctor_across_supported_options(self):
        options = [{'preset': preset} for preset in cv.PRESETS]
        options += [{'adapters':['claude','agents']}, {'active_context':'cocoindex-code'}]
        for index, selected in enumerate(options):
            with self.subTest(selected=selected):
                target = self.parent/f'project-{index}'
                plan = cv.plan_thin_workspace(target, **selected)
                created = cv.scaffold_thin_workspace(target, repo_root=ROOT, **selected)
                self.assertEqual([str(path.relative_to(target)).replace(os.sep,'/') for path in created],
                    [row['path'] for row in plan['files']])
                self.assertEqual({str(p.relative_to(target)).replace(os.sep,'/') for p in target.rglob('*') if p.is_file()},
                    {row['path'] for row in plan['files']})
                for row in plan['files']:
                    data = (target/row['path']).read_bytes()
                    self.assertEqual(data, row['content'].encode('utf-8'))
                    self.assertEqual(len(data), row['bytes'])
                    self.assertEqual('sha256:'+hashlib.sha256(data).hexdigest(), row['sha256'])
                self.assertTrue(cv.doctor_workspace(target, repo_root=ROOT)['ok'])
                output=io.StringIO()
                with redirect_stdout(output), redirect_stderr(output):
                    status=tropo.main(['check','--root',str(target)])
                self.assertEqual(status,0,output.getvalue())

    def test_portable_content_and_target_bound_plan_are_distinct(self):
        for name in ('a','b'):
            (self.parent/name).mkdir()
        first = cv.plan_thin_workspace(self.parent/'a'/'same-name')
        second = cv.plan_thin_workspace(self.parent/'b'/'same-name')
        self.assertEqual(first['content_sha256'], second['content_sha256'])
        self.assertNotEqual(first['plan_sha256'], second['plan_sha256'])
        changed = cv.plan_thin_workspace(self.parent/'a'/'same-name', preset='writing')
        self.assertNotEqual(first['content_sha256'], changed['content_sha256'])
        self.assertNotEqual(first['plan_sha256'], changed['plan_sha256'])
        one = cv.plan_thin_workspace(self.parent/'adapters', adapters=['agents','claude'])
        two = cv.plan_thin_workspace(self.parent/'adapters', adapters=['claude','agents'])
        self.assertEqual(one, two)

    def test_concurrent_applies_do_not_roll_back_the_winning_files(self):
        target = self.parent/'concurrent'
        plan = cv.plan_thin_workspace(target)
        meet = Barrier(2)
        loser_finished = Event()
        original_write = cv._write_bytes_no_follow

        def race_write(root, path, data, **options):
            if path.name == '.gitignore':
                meet.wait(timeout=10)
                original_write(root, path, data, **options)
                self.assertTrue(loser_finished.wait(timeout=10))
                return
            original_write(root, path, data, **options)

        def apply():
            try:
                return cv.apply_thin_workspace(
                    target, plan['plan_sha256'], repo_root=ROOT
                )
            except cv.ScaffoldError as error:
                loser_finished.set()
                return error

        with mock.patch.object(cv, '_write_bytes_no_follow', side_effect=race_write):
            with ThreadPoolExecutor(max_workers=2) as workers:
                results = [future.result(timeout=15) for future in
                           (workers.submit(apply), workers.submit(apply))]
        self.assertEqual(sum(isinstance(row, dict) for row in results), 1, results)
        self.assertEqual(next(row for row in results if isinstance(row, dict))['code'],
                         'created')
        for row in plan['files']:
            self.assertEqual((target/row['path']).read_bytes(),
                             row['content'].encode('utf-8'))
        self.assertTrue(cv.doctor_workspace(target, repo_root=ROOT)['ok'])

    def test_postcommit_error_rolls_back_only_its_own_created_file(self):
        target = self.parent/'postcommit'
        accepted = cv.plan_thin_workspace(target)['plan_sha256']
        original_write = cv._write_bytes_no_follow
        def fail_after_commit(root, path, data, **options):
            original_write(root, path, data, **options)
            if path.name == '.gitignore':
                raise cv.ScaffoldError('injected postcommit failure')
        with mock.patch.object(cv, '_write_bytes_no_follow',
                               side_effect=fail_after_commit):
            with self.assertRaisesRegex(cv.ScaffoldError, 'postcommit failure'):
                cv.apply_thin_workspace(target, accepted, repo_root=ROOT)
        self.assertFalse(target.exists())

    def test_parent_postcommit_error_rolls_back_callback_owned_file(self):
        target = self.parent/'post-parent-check'
        accepted = cv.plan_thin_workspace(target)['plan_sha256']
        original_parent = cv._safe_destination_parent
        injected = False
        @contextmanager
        def fail_after_parent_commit(root, path, **options):
            nonlocal injected
            with original_parent(root, path, **options) as parent:
                yield parent
                if path.name == '.gitignore' and not injected:
                    injected = True
                    raise cv.ScaffoldError('injected postcommit parent check')
        with mock.patch.object(cv, '_safe_destination_parent',
                               side_effect=fail_after_parent_commit):
            with self.assertRaisesRegex(cv.ScaffoldError,
                                        'postcommit parent check'):
                cv.apply_thin_workspace(target, accepted, repo_root=ROOT)
        self.assertFalse(target.exists())

    def test_precommit_error_removes_only_its_owned_empty_directory(self):
        target = self.parent/'precommit'
        accepted = cv.plan_thin_workspace(target)['plan_sha256']
        def fail_after_mkdir(root, path, _data, **options):
            with cv._safe_destination_parent(
                root, path, on_create_directory=options['on_create_directory']
            ):
                raise cv.ScaffoldError('injected precommit failure')
        with mock.patch.object(cv, '_atomic_write_bytes_no_follow',
                               side_effect=fail_after_mkdir):
            with self.assertRaisesRegex(cv.ScaffoldError, 'precommit failure'):
                cv.apply_thin_workspace(target, accepted, repo_root=ROOT)
        self.assertFalse(target.exists())

    def test_exact_retry_requires_read_only_doctor(self):
        target = self.parent/'invalid-retry'
        plan = cv.plan_thin_workspace(target)
        cv.apply_thin_workspace(target, plan['plan_sha256'], repo_root=ROOT)
        before = {row['path']: (target/row['path']).read_bytes()
                  for row in plan['files']}
        accepted = plan['plan_sha256']
        # The retry must not claim success when the installed runtime fails Doctor.
        with mock.patch.object(cv, 'doctor_workspace',
                               return_value={'ok': False,
                                             'errors': ['runtime unavailable']}) as doctor:
            with self.assertRaisesRegex(cv.ScaffoldError,
                                        'Doctor failed after init: runtime unavailable'):
                cv.apply_thin_workspace(target, accepted, repo_root=ROOT)
        doctor.assert_called_once()
        for relative, data in before.items():
            self.assertEqual((target/relative).read_bytes(), data)

    def test_unreadable_existing_target_is_a_scaffold_refusal(self):
        target = self.parent/'unreadable'
        target.mkdir()
        with mock.patch.object(Path, 'iterdir',
                               side_effect=PermissionError('access denied')):
            with self.assertRaisesRegex(cv.ScaffoldError,
                                        'cannot inspect init target: access denied'):
                cv.apply_thin_workspace(target, 'sha256:' + '0' * 64)
        self.assertEqual(list(target.iterdir()), [])

    def test_creator_apply_binds_target_options_and_exact_retry(self):
        target = self.parent/'shared'
        plan = cv.plan_thin_workspace(target, preset='writing')
        wrong = cv.apply_thin_workspace(target, plan['plan_sha256'], preset='coding')
        self.assertEqual(wrong, {'code': 'plan-changed'})
        other = cv.apply_thin_workspace(
            self.parent/'other', plan['plan_sha256'], preset='writing'
        )
        self.assertEqual(other, {'code': 'plan-changed'})
        self.assertFalse(target.exists())
        self.assertFalse((self.parent/'other').exists())

        created = cv.apply_thin_workspace(
            target, plan['plan_sha256'], preset='writing', repo_root=ROOT
        )
        self.assertEqual(created['code'], 'created')
        reviewed = (target/'AGENTS.md').read_bytes()
        before = (target/'AGENTS.md').stat().st_mtime_ns
        replay = cv.apply_thin_workspace(
            target, plan['plan_sha256'], preset='writing', repo_root=ROOT
        )
        self.assertEqual(replay['code'], 'already-created')
        self.assertEqual((target/'AGENTS.md').read_bytes(), reviewed)
        self.assertEqual((target/'AGENTS.md').stat().st_mtime_ns, before)

        (target/'extra.txt').write_text('keep me\n', encoding='utf-8')
        with self.assertRaisesRegex(cv.ScaffoldError, 'init requires a new or empty directory'):
            cv.apply_thin_workspace(
                target, plan['plan_sha256'], preset='writing', repo_root=ROOT
            )
        self.assertEqual((target/'extra.txt').read_text(), 'keep me\n')

    def test_creator_rechecks_rendered_content_at_write_boundary(self):
        target = self.parent/'drift'
        accepted = cv.plan_thin_workspace(target)['plan_sha256']
        render = cv._thin_context_doc
        calls = 0
        def change_between_checks(project, preset, pattern_choices=()):
            nonlocal calls
            calls += 1
            text = render(project, preset, pattern_choices)
            return text if calls == 1 else text + 'changed after approval\n'
        with mock.patch.object(cv, '_thin_context_doc', side_effect=change_between_checks):
            with self.assertRaisesRegex(cv.ScaffoldError, 'plan changed before writing'):
                cv.apply_thin_workspace(target, accepted, repo_root=ROOT)
        self.assertFalse(target.exists())

    def test_adapter_options_are_snapshotted_before_target_validation(self):
        target=self.parent/'snapshot'
        adapters=['agents']
        validate=cv._validate_thin_init_target
        def change_callers_options(*args, **kwargs):
            validate(*args, **kwargs)
            adapters.append('claude')
        with mock.patch.object(cv,'_validate_thin_init_target',side_effect=change_callers_options):
            plan=cv.plan_thin_workspace(target,adapters=adapters)
        self.assertEqual(adapters,['agents','claude'])
        self.assertEqual(plan['adapters'],['agents'])
        self.assertIn('.agents/skills/vivary/SKILL.md',[row['path'] for row in plan['files']])
        self.assertFalse(any(row['path'].startswith('.claude/') for row in plan['files']))
        self.assertFalse(target.exists())

    def test_empty_target_is_unchanged_and_occupied_target_refuses(self):
        target=self.parent/'empty'
        target.mkdir()
        before=target.stat().st_mtime_ns
        cv.plan_thin_workspace(target)
        self.assertEqual(list(target.iterdir()), [])
        self.assertEqual(target.stat().st_mtime_ns, before)
        original=b'preserve these bytes\r\n'
        (target/'user.txt').write_bytes(original)
        with self.assertRaises(cv.ScaffoldError):
            cv.plan_thin_workspace(target)
        self.assertEqual((target/'user.txt').read_bytes(), original)
        self.assertEqual([p.name for p in target.iterdir()], ['user.txt'])

    def test_invalid_options_refuse_without_creating_target(self):
        target=self.parent/'invalid'
        for options in [{'preset':'unknown'}, {'adapters':['unknown']},
                        {'adapters':['agents','agents']}, {'active_context':'unknown'},
                        {'preset':'writing','active_context':'cocoindex-code'}]:
            with self.subTest(options=options), self.assertRaises(cv.ScaffoldError):
                cv.plan_thin_workspace(target, **options)
            self.assertFalse(target.exists())

    @unittest.skipIf(os.name=='nt', 'real symlink proof runs in Habitat')
    def test_symlink_target_and_ancestor_refuse(self):
        outside=self.parent/'outside'
        outside.mkdir()
        alias=self.parent/'alias'
        alias.symlink_to(outside, target_is_directory=True)
        for target in (alias, alias/'new'):
            with self.subTest(target=target), self.assertRaises(cv.ScaffoldError):
                cv.plan_thin_workspace(target)
        self.assertEqual(list(outside.iterdir()), [])


if __name__=='__main__':
    unittest.main()

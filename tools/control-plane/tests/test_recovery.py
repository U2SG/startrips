"""Real process-provider and same-owner recovery regressions. GitHub CI only."""
import os
import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock
import test_control_plane as fixture
import execution
import runtime_preflight as runtime
import boundary_restart


def process(pid, ppid=0, name='bash', command=''):
    return {'pid': pid, 'ppid': ppid, 'name': name, 'command': command}


class ProcessClassificationCases(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.gettempdir()).resolve() / 'synthetic-workspace'
        self.base = [process(1, name='python'), process(2, 1, 'bash', str(self.root / 'run-loop.sh')), process(3, 2, 'python')]

    def test_own_loop_ancestry_is_not_a_competitor(self):
        self.assertEqual([], execution.competitors(self.base, self.root, 3))

    def test_other_actual_loop_blocks_duplicate(self):
        rows = self.base + [process(10, command='bash ' + str(self.root / 'run-loop.sh'))]
        self.assertEqual(10, execution.competitors(rows, self.root, 3)[0]['pid'])

    def test_orphan_worker_marker_blocks_new_carrier(self):
        rows = self.base + [process(10, name='node.exe', command='node worker STARTRIPS_EXECUTION_OWNER=' + str(self.root) + ';feature=ST-001;')]
        self.assertEqual('worker', execution.competitors(rows, self.root, 3)[0]['kind'])

    def test_unknown_relative_legacy_loop_is_not_treated_as_ended(self):
        rows = self.base + [process(10, command='bash ./run-loop.sh')]
        self.assertEqual('unknown-cwd', execution.competitors(rows, self.root, 3)[0]['state'])

    def test_caller_missing_from_snapshot_is_unknown(self):
        with self.assertRaises(execution.EvidenceUnknown): execution.competitors([], self.root, 3)

    def test_unrelated_process_text_is_not_execution(self):
        rows = self.base + [process(10, name='python.exe', command='python inspector mentions run-loop.sh')]
        self.assertEqual([], execution.competitors(rows, self.root, 3))

    def test_absolute_windows_executable_does_not_prove_relative_script_cwd(self):
        rows = self.base + [process(10, name='bash.exe', command='"C:/Program Files/Git/bin/bash.exe" ./run-loop.sh')]
        self.assertEqual('unknown-cwd', execution.competitors(rows, self.root, 3)[0]['state'])

    def test_common_workspace_prefix_is_not_the_same_workspace(self):
        other = str(self.root) + '-other'
        rows = self.base + [process(10, command='bash "' + other + '/run-loop.sh"')]
        self.assertEqual([], execution.competitors(rows, self.root, 3))

    def test_quoted_workspace_path_with_spaces_remains_observable(self):
        root = self.root / 'workspace with spaces'
        rows = self.base + [process(10, command='bash "' + str(root / 'run-loop.sh') + '"')]
        self.assertEqual('active', execution.competitors(rows, root, 3)[0]['state'])

    def test_other_absolute_workspace_is_not_this_owner(self):
        other = self.root.parent / 'other-workspace'
        rows = self.base + [process(10, command='bash ' + str(other / 'run-loop.sh'))]
        self.assertEqual([], execution.competitors(rows, self.root, 3))

    def severed(self):
        """run-loop whose recorded parent is an MSYS stub that already exited."""
        return [process(1, name='python'), process(2, 999, 'bash', str(self.root / 'run-loop.sh')),
                process(3, 2, 'python'),
                process(20, 19, 'bash', 'bash ' + str(self.root / 'loop-supervisor.sh'))]

    def test_severed_msys_ancestry_reports_our_own_supervisor(self):
        # The failure this guards: ancestry stops at the exited stub, so the
        # supervisor that launched this very check reads as a second execution.
        self.assertEqual(20, execution.competitors(self.severed(), self.root, 3)[0]['pid'])

    def test_published_supervisor_pid_is_not_a_competitor(self):
        with mock.patch.dict(os.environ, {'STARTRIPS_OWN_PIDS': '20'}):
            self.assertEqual([], execution.competitors(self.severed(), self.root, 3))

    def test_fork_stub_of_a_published_pid_is_not_a_competitor(self):
        # A stub briefly carries its child's command line while MSYS completes the
        # fork; being a direct child of the published supervisor, it is never a
        # second execution.
        rows = self.severed() + [process(21, 20, 'bash', 'bash ' + str(self.root / 'run-loop.sh'))]
        with mock.patch.dict(os.environ, {'STARTRIPS_OWN_PIDS': '20'}):
            self.assertEqual([], execution.competitors(rows, self.root, 3))

    def test_published_pids_never_hide_an_unrelated_execution(self):
        rows = self.base + [process(10, command='bash ' + str(self.root / 'run-loop.sh'))]
        with mock.patch.dict(os.environ, {'STARTRIPS_OWN_PIDS': '20,not-a-pid'}):
            self.assertEqual(10, execution.competitors(rows, self.root, 3)[0]['pid'])


class StopAndPermissionCases(fixture.SyntheticOne):
    def test_inherit_probe_really_writes_and_removes_only_its_file(self):
        before = self.path.read_bytes()
        result = execution.permission_probe(self.root)
        self.assertEqual('success', result['actual_write_read_delete'])
        self.assertEqual(before, self.path.read_bytes())
        self.assertEqual([], list((self.root / '.agent-artifacts').glob('worker-permission-probe-*')))

    def test_actual_permission_denial_is_visible(self):
        with mock.patch.object(execution.tempfile, 'mkstemp', side_effect=PermissionError('synthetic permission denied')):
            with self.assertRaises(PermissionError): execution.permission_probe(self.root)

    def test_stop_cleanup_requires_exact_ownership(self):
        path = self.root / 'AGENT_STOP'; path.write_bytes(b'owner-stop')
        with self.assertRaises(fixture.store.StoreConflict): execution.clear_owned_stop(self.root, 'AGENT_STOP', b'my-repair-stop')
        self.assertEqual(b'owner-stop', path.read_bytes())

    def test_only_matching_boundary_marker_can_be_removed(self):
        path = self.root / 'AGENT_STOP'; path.write_bytes(b'my-exact-boundary-stop')
        self.assertTrue(execution.clear_owned_stop(self.root, 'AGENT_STOP', path.read_bytes()))
        self.assertFalse(path.exists())

    def test_cancellation_is_never_automatically_cleared(self):
        path = self.root / 'CANCEL_SCHEDULED_RESTART'; path.write_bytes(b'cancel')
        with self.assertRaises(fixture.store.StoreConflict): execution.clear_owned_stop(self.root, path.name, b'cancel')
        self.assertEqual(b'cancel', path.read_bytes())

    def test_manual_resume_requires_explicit_local_command(self):
        (self.root / 'AGENT_STOP').write_text('human stop')
        with mock.patch.dict(os.environ, {'STARTRIPS_EXPLICIT_RESUME': ''}):
            with self.assertRaises(fixture.store.StoreConflict): execution.manual_resume(self.root)
        self.assertEqual('human stop', (self.root / 'AGENT_STOP').read_text())

    def test_explicit_resume_preserves_cancellation(self):
        (self.root / 'CANCEL_SCHEDULED_RESTART').write_text('cancel')
        with mock.patch.dict(os.environ, {'STARTRIPS_EXPLICIT_RESUME': '1'}), mock.patch.object(execution, 'ensure_idle'):
            with self.assertRaises(fixture.store.StoreConflict): execution.manual_resume(self.root)
        self.assertTrue((self.root / 'CANCEL_SCHEDULED_RESTART').exists())

    def test_explicit_resume_clears_only_two_requested_stops(self):
        for name in ['AGENT_STOP', 'SUPERVISOR_STOP']: (self.root / name).write_text('human stop')
        before = self.path.read_bytes()
        with mock.patch.dict(os.environ, {'STARTRIPS_EXPLICIT_RESUME': '1'}), mock.patch.object(execution, 'ensure_idle'):
            result = execution.manual_resume(self.root)
        self.assertEqual({'AGENT_STOP', 'SUPERVISOR_STOP'}, set(result['cleared']))
        self.assertFalse(result['worker_started']); self.assertEqual(before, self.path.read_bytes())

    def test_boundary_restart_never_overrides_existing_stop(self):
        (self.root / 'SUPERVISOR_STOP').write_text('stop')
        with mock.patch.object(boundary_restart.subprocess, 'call') as launch:
            self.assertEqual(0, boundary_restart.restart(self.root, 1)); launch.assert_not_called()
        self.assertEqual('stop', (self.root / 'SUPERVISOR_STOP').read_text())

    def test_transient_provider_failure_preserves_state(self):
        before = self.path.read_bytes()
        with mock.patch.object(execution, 'snapshot', side_effect=execution.EvidenceUnknown('provider offline')):
            with self.assertRaises(execution.EvidenceUnknown): execution.ensure_idle(self.root)
        self.assertEqual(before, self.path.read_bytes()); self.assertFalse((self.root / 'AGENT_STOP').exists())


class RealCarrierCases(fixture.WiringTests):
    # The inherited WiringTests also exercise the actual target bash boundary.
    def test_real_process_provider_observes_exit_without_owner_change(self):
        script = self.root / 'run-loop.sh'
        script.write_text('#!/usr/bin/env bash\nprintf "READY\\n"\nread -r release\n', encoding='utf-8', newline='\n')
        original = self.path.read_bytes()
        child = subprocess.Popen([self.bash, str(script)], cwd=self.root, stdin=subprocess.PIPE,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8')
        try:
            self.assertEqual('READY', child.stdout.readline().strip())
            with self.assertRaises(execution.EvidenceUnknown): execution.ensure_idle(self.root)
            child.communicate('finish\n', timeout=10)
            self.assertEqual(0, child.returncode)
            self.assertEqual('ended', execution.ensure_idle(self.root)['old_execution'])
            self.assertEqual(original, self.path.read_bytes())
        finally:
            if child.poll() is None:
                child.terminate(); child.communicate(timeout=10)

    def test_stopped_real_run_loop_never_starts_a_model(self):
        (self.root / 'AGENT_STOP').write_text('human stop')
        before = self.path.read_bytes()
        result = self.invoke('export STARTRIPS_LANE=backend; bash run-loop.sh')
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertIn('STOP', result.stdout); self.assertEqual(before, self.path.read_bytes())
        self.assertFalse((self.root / '.agent-artifacts').exists())

    def test_existing_backend_owner_reserves_slot_during_review(self):
        self.write(fixture.feature('ST-001', status='ready_to_merge', phase='P0-process', passes=True),
                   fixture.feature('ST-002', phase='P0-process'))
        result = self.invoke('export STARTRIPS_LANE=backend; bash run-loop.sh --next')
        self.assertEqual(0, result.returncode, result.stderr); self.assertEqual('', result.stdout.strip())


class RealWorktreeCases(fixture.SyntheticOne):
    def setUp(self):
        super().setUp()
        self.repo = self.root / 'startrips'; self.repo.mkdir()
        self.git('init', '-b', 'main'); self.git('config', 'user.name', 'Synthetic CI')
        self.git('config', 'user.email', 'ci@example.invalid')
        (self.repo / 'code.txt').write_text('source')
        self.git('add', '.'); self.git('commit', '-m', 'Create synthetic source')
        self.sha = self.git('rev-parse', 'HEAD')
        self.git('checkout', '-b', 'feat/issue1-synthetic')
        self.write(fixture.feature(status='in_progress', phase='P0-process', issue=1,
                                   pr_links=['https://github.com/synthetic/project/pull/1']))

    def git(self, *args):
        result = subprocess.run(['git', '-C', str(self.repo), *args], capture_output=True, text=True, encoding='utf-8', timeout=10)
        self.assertEqual(0, result.returncode, result.stderr); return result.stdout.strip()

    def preflight(self):
        old = Path.cwd()
        try:
            os.chdir(self.root)
            with mock.patch.dict(os.environ, {'STARTRIPS_LANE': 'backend'}), mock.patch.object(runtime, 'api', return_value={
                    'state': 'open', 'merged': False, 'head': {'ref': 'feat/issue1-synthetic', 'sha': self.sha}}):
                return runtime.preflight(self.root, self.repo, 'backend', 'ST-001', 'synthetic/project')
        finally:
            os.chdir(old)

    def test_same_owner_dirty_worktree_is_preserved(self):
        (self.repo / 'code.txt').write_text('uncommitted-owner-work')
        result = self.preflight()
        self.assertTrue(result['dirty']); self.assertEqual(self.repo.resolve(), Path(result['worktree']))
        self.assertEqual('uncommitted-owner-work', (self.repo / 'code.txt').read_text())
        self.assertEqual('RESUME_OWNER', runtime.local_action(self.repo, 1, self.sha))

    def test_unpushed_descendant_resumes_original_owner(self):
        (self.repo / 'code.txt').write_text('new-owner-source')
        self.git('add', '.'); self.git('commit', '-m', 'Continue synthetic owner source')
        head = self.git('rev-parse', 'HEAD')
        self.preflight(); self.assertEqual(head, self.git('rev-parse', 'HEAD'))
        self.assertEqual('RESUME_OWNER', runtime.local_action(self.repo, 1, self.sha))

    def test_ledger_only_pending_work_does_not_trigger_reimplementation(self):
        path = self.repo / 'docs/pr-history/1.md'; path.parent.mkdir(parents=True); path.write_text('pending ledger')
        self.preflight(); self.assertEqual('CONTINUE_PLAN', runtime.local_action(self.repo, 1, self.sha))

    def test_new_worktree_not_created_by_read_only_probe(self):
        before = self.git('worktree', 'list', '--porcelain')
        with self.assertRaises(fixture.store.StoreConflict):
            runtime.prepare_unmapped(self.root, self.repo, fixture.feature('ST-002', issue=2), 'synthetic/project', False)
        self.assertEqual(before, self.git('worktree', 'list', '--porcelain'))

    def test_wrong_target_lane_is_refused(self):
        old = Path.cwd()
        try:
            os.chdir(self.root)
            with mock.patch.dict(os.environ, {'STARTRIPS_LANE': 'experience'}):
                with self.assertRaises(fixture.store.StoreConflict):
                    runtime.preflight(self.root, self.repo, 'backend', 'ST-001', 'synthetic/project')
        finally: os.chdir(old)



class OutageCases(fixture.SyntheticOne):
    def test_pause_does_not_replace_a_human_stop(self):
        path = self.root / 'AGENT_STOP'; path.write_bytes(b'user-stop')
        self.assertFalse(execution.outage_window(self.root, 'pause')['launch_allowed'])
        self.assertEqual(b'user-stop', path.read_bytes())

    def test_resume_does_not_clear_a_human_stop(self):
        path = self.root / 'AGENT_STOP'; path.write_bytes(b'user-stop')
        with mock.patch.object(execution, 'ensure_idle') as provider:
            self.assertFalse(execution.outage_window(self.root, 'resume')['launch_allowed'])
            provider.assert_not_called()
        self.assertEqual(b'user-stop', path.read_bytes())

    def test_own_window_can_end_without_touching_feature_state(self):
        before = self.path.read_bytes(); execution.outage_window(self.root, 'pause')
        with mock.patch.object(execution, 'ensure_idle'):
            self.assertTrue(execution.outage_window(self.root, 'resume')['launch_allowed'])
        self.assertFalse((self.root / 'AGENT_STOP').exists()); self.assertEqual(before, self.path.read_bytes())

    def test_owner_supervisor_stop_prevents_window_resume(self):
        execution.outage_window(self.root, 'pause'); (self.root / 'SUPERVISOR_STOP').write_text('human')
        self.assertFalse(execution.outage_window(self.root, 'resume')['launch_allowed'])
        self.assertTrue((self.root / 'AGENT_STOP').exists())
        self.assertEqual('human', (self.root / 'SUPERVISOR_STOP').read_text())

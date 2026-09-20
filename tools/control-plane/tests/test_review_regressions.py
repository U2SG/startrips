"""Pre-merge review regressions: synthetic fixtures; GitHub CI only."""
import json
import os
import subprocess
import sys
import unittest
from pathlib import Path
from unittest import mock
import test_control_plane as fixture
import action_plan
import evidence_capture
import execution
import intake_guard
import progress_budget
import runtime_preflight


class AmendWindowCases(fixture.SyntheticOne):
    def setUp(self):
        super().setUp()
        self.row = fixture.feature(issue=1, notes='auto-intake synthetic', acceptance=['A','B','C'],
                                   issue_snapshot_at='2026-01-01T00:00:00Z', issue_snapshot_comments=1)
        self.write(self.row)
        self.token = fixture.state.row_token(self.row)

    def test_user_new_gate_invalidates_old_model_result(self):
        changed = dict(self.row, human_gate='New product decision')
        with self.assertRaises(fixture.store.StoreConflict):
            intake_guard.require_amend_snapshot(changed, self.token, '2026-01-02T00:00:00Z', '2')

    def test_new_acceptance_invalidates_old_model_result(self):
        changed = dict(self.row, acceptance=['new A', 'B', 'C'])
        with self.assertRaises(fixture.store.StoreConflict):
            intake_guard.require_amend_snapshot(changed, self.token, '2026-01-02T00:00:00Z', '2')

    def test_matching_row_still_rejects_issue_snapshot_regression(self):
        with self.assertRaises(fixture.store.StoreConflict):
            intake_guard.require_amend_snapshot(self.row, self.token, '2025-12-31T00:00:00Z', '0')

    def test_no_pre_model_identity_is_not_an_authorized_amend(self):
        with self.assertRaises(fixture.store.StoreConflict):
            intake_guard.require_amend_snapshot(self.row, None, '2026-01-02T00:00:00Z', '2')

    def test_same_revision_cannot_regress_comment_count(self):
        with self.assertRaises(fixture.store.StoreConflict):
            intake_guard.require_amend_snapshot(self.row, self.token, self.row['issue_snapshot_at'], '0')

    def apply_actual_heredoc(self, payload, expected_token):
        source = (fixture.ROOT / 'lib/intake.sh').read_text(encoding='utf-8')
        body = source.split('intake_apply_amend() {', 1)[1].split("<<'PY'\n", 1)[1].split('\nPY\n', 1)[0]
        log = self.root / 'model.log'; log.write_text('<<<INTAKE\n' + json.dumps(payload) + '\nINTAKE>>>', encoding='utf-8')
        result = self.root / 'result.json'
        env = dict(os.environ, PYTHONUTF8='1', PYTHONDONTWRITEBYTECODE='1',
                   INTAKE_EXPECTED_ROW=expected_token, INTAKE_ISSUE_UPDATED_AT='2026-01-02T00:00:00Z', INTAKE_ISSUE_COMMENTS='2')
        return subprocess.run([sys.executable, '-B', '-c', body, str(self.path), str(log), '1', 'ST-001', str(result), '0', str(fixture.ROOT / 'lib')],
                              env=env, capture_output=True, text=True, encoding='utf-8', timeout=15)

    def test_real_amend_apply_cannot_overwrite_intervening_gate(self):
        self.write(dict(self.row, human_gate='new decision'))
        before = self.path.read_bytes()
        result = self.apply_actual_heredoc({'amend': {'rationale':'old model', 'human_gate':None}}, self.token)
        self.assertNotEqual(0, result.returncode)
        self.assertIn('changed during model execution', result.stderr)
        self.assertEqual(before, self.path.read_bytes())

    def test_matching_snapshot_amends_only_approved_fields(self):
        result = self.apply_actual_heredoc({'amend': {'rationale':'current issue', 'description':'bounded new text'}}, self.token)
        self.assertEqual(0, result.returncode, result.stderr)
        row = fixture.store.load_document(self.path)['features'][0]
        self.assertEqual('bounded new text', row['description']); self.assertEqual(self.row['acceptance'], row['acceptance'])

    def test_unchanged_and_moot_results_also_require_original_snapshot(self):
        for payload in [{'unchanged':True}, {'skip':True, 'reason':'old moot'}]:
            with self.subTest(payload=payload):
                self.write(dict(self.row, acceptance=['new','contract','now']))
                before = self.path.read_bytes()
                result = self.apply_actual_heredoc(payload, self.token)
                self.assertNotEqual(0, result.returncode); self.assertEqual(before,self.path.read_bytes())


class UnreadableCarrierCases(unittest.TestCase):
    def test_potential_carrier_with_unreadable_command_is_unknown(self):
        for name in ['bash.exe', 'claude.exe', 'node.exe', 'codex.exe']:
            for command in [None, '', '  ']:
                with self.subTest(name=name, command=command):
                    rows = [{'pid':1,'ppid':0,'name':'python','command':'caller'},
                            {'pid':2,'ppid':0,'name':name,'command':command}]
                    result = execution.competitors(rows, Path.cwd(), 1)
                    self.assertEqual('unknown-command', result[0]['state'])

    def test_windows_shell_ui_processes_are_not_worker_interpreters(self):
        for name in ['ShellExperienceHost.exe', 'ShellHost.exe', 'shutter.exe', 'node-helper.exe']:
            rows = [{'pid':1,'ppid':0,'name':'python','command':'caller'},
                    {'pid':2,'ppid':0,'name':name,'command':None}]
            self.assertEqual([], execution.competitors(rows,Path.cwd(),1))

    def test_exact_shell_interpreter_still_requires_readable_command(self):
        for name in ['sh.exe', 'sh', 'bash.EXE', 'nodejs']:
            rows = [{'pid':1,'ppid':0,'name':'python','command':'caller'},
                    {'pid':2,'ppid':0,'name':name,'command':None}]
            self.assertEqual('unknown-command', execution.competitors(rows,Path.cwd(),1)[0]['state'])

    def test_unreadable_ancestor_is_not_a_competing_owner(self):
        rows = [{'pid':1,'ppid':2,'name':'python','command':'caller'},
                {'pid':2,'ppid':0,'name':'bash.exe','command':None}]
        self.assertEqual([], execution.competitors(rows,Path.cwd(),1))

    def test_unrelated_non_carrier_with_unreadable_command_is_not_owner(self):
        rows = [{'pid':1,'ppid':0,'name':'python','command':'caller'},
                {'pid':2,'ppid':0,'name':'explorer.exe','command':None}]
        self.assertEqual([], execution.competitors(rows,Path.cwd(),1))


class FailureFamilyOwnerCases(fixture.SyntheticOne):
    def record(self):
        fingerprint = 'd' * 64
        return {'root_cause_required': True, 'fingerprint': fingerprint,
                'family': fingerprint[:16]}

    def issue_api(self, endpoint):
        return {'title': '', 'body': ''}

    def test_unique_other_active_mapped_issue_with_exact_token_owns_family(self):
        self.write(
            fixture.feature('ST-001', status='in_progress', issue=445),
            fixture.feature('ST-002', status='in_progress', issue=427),
        )
        token = self.record()['fingerprint'][:16]
        def comments(endpoint):
            return [{'body': 'parser family ' + token}] if '/issues/427/comments' in endpoint else []
        with mock.patch.object(action_plan, 'api', side_effect=self.issue_api), \
             mock.patch.object(action_plan, 'pages', side_effect=comments):
            owner = action_plan.failure_family_owner(
                self.path, 'ST-001', fixture.REPO, [self.record()])
        self.assertEqual({'feature': 'ST-002', 'issue': 427, 'matched_tokens': [token]}, owner)

    def test_unique_current_owner_keeps_repair_on_current_feature(self):
        self.write(
            fixture.feature('ST-001', status='in_progress', issue=445),
            fixture.feature('ST-002', status='in_progress', issue=427),
        )
        token = self.record()['fingerprint'][:16]
        def comments(endpoint):
            return [{'body': token}] if '/issues/445/comments' in endpoint else []
        with mock.patch.object(action_plan, 'api', side_effect=self.issue_api), \
             mock.patch.object(action_plan, 'pages', side_effect=comments):
            self.assertIsNone(action_plan.failure_family_owner(
                self.path, 'ST-001', fixture.REPO, [self.record()]))

    def test_terminal_or_human_gated_rows_do_not_become_external_owner(self):
        self.write(
            fixture.feature('ST-001', status='in_progress', issue=445),
            fixture.feature('ST-002', status='passed', issue=427),
            fixture.feature('ST-003', status='pending', issue=428, human_gate='decision'),
        )
        with mock.patch.object(action_plan, 'api', side_effect=self.issue_api), \
             mock.patch.object(action_plan, 'pages', return_value=[]):
            self.assertIsNone(action_plan.failure_family_owner(
                self.path, 'ST-001', fixture.REPO, [self.record()]))

    def test_current_and_other_exact_owner_is_ambiguous_and_fails_closed(self):
        self.write(
            fixture.feature('ST-001', status='in_progress', issue=445),
            fixture.feature('ST-002', status='in_progress', issue=427),
        )
        token = self.record()['fingerprint'][:16]
        with mock.patch.object(action_plan, 'api', return_value={'title': '', 'body': token}), \
             mock.patch.object(action_plan, 'pages', return_value=[]):
            with self.assertRaises(action_plan.EvidenceUnknown):
                action_plan.failure_family_owner(
                    self.path, 'ST-001', fixture.REPO, [self.record()])


class HandoffIdentityCases(fixture.SyntheticOne):
    def setUp(self):
        super().setUp()
        self.write(fixture.feature(status='in_progress', pr_links=['https://github.com/synthetic/project/pull/1']))
        self.observed = {'action':'HANDOFF_REVIEW','pr':1,'source_sha':fixture.A,'final_sha':fixture.B,
                         'ci_run':12,'ci_attempt':1,'row_token':fixture.state.row_token(fixture.store.load_document(self.path)['features'][0])}
        self.captured = {'exit':0,'kind':'final','path':'.agent-artifacts/exact.log','head':fixture.B,
                         'source_sha':fixture.A,'ci_run':12,'ci_attempt':1}

    def handoff(self, captured=None, confirmed=None):
        with mock.patch.object(action_plan,'plan',side_effect=[self.observed, confirmed or self.observed]), \
             mock.patch.object(runtime_preflight,'preflight',return_value={'worktree':str(self.root)}), \
             mock.patch.object(evidence_capture,'capture',return_value=captured or self.captured):
            return action_plan.handoff(self.path,'ST-001','synthetic/project')

    def test_only_matching_plan_capture_and_review_handoff(self):
        self.assertTrue(self.handoff()['changed'])
        self.assertEqual('ready_for_eval', fixture.store.load_document(self.path)['features'][0]['status'])

    def test_new_final_source_or_attempt_between_plan_and_capture_cannot_pass(self):
        for field, value in [('head',fixture.C),('source_sha',fixture.C),('ci_run',13),('ci_attempt',2)]:
            with self.subTest(field=field):
                before=self.path.read_bytes()
                with self.assertRaises(fixture.store.StoreConflict): self.handoff(dict(self.captured, **{field:value}))
                self.assertEqual(before,self.path.read_bytes())

    def test_revoked_review_after_capture_prevents_handoff(self):
        before=self.path.read_bytes()
        with self.assertRaises(fixture.store.StoreConflict): self.handoff(confirmed=dict(self.observed, action='WAIT_SOURCE_REVIEW'))
        self.assertEqual(before,self.path.read_bytes())

    def test_new_identity_during_gate_revalidation_prevents_handoff(self):
        before=self.path.read_bytes()
        with self.assertRaises(fixture.store.StoreConflict): self.handoff(confirmed=dict(self.observed, final_sha=fixture.C))
        self.assertEqual(before,self.path.read_bytes())

    def test_capture_itself_rejects_mixed_initial_head_and_new_relation(self):
        with mock.patch.object(evidence_capture,'git',side_effect=[fixture.B,'owner','']), \
             mock.patch.object(evidence_capture,'api',return_value={'head':{'sha':fixture.B,'ref':'owner'}}), \
             mock.patch.object(evidence_capture,'source_relation',return_value={'final_sha':fixture.C,'source_sha':fixture.A,'sealed':True}), \
             mock.patch.object(evidence_capture,'latest_ci') as ci:
            with self.assertRaises(fixture.store.StoreConflict): evidence_capture.capture(self.root,self.root,'ST-001',1,'synthetic/project')
        ci.assert_not_called()


class ProgressBudgetCases(fixture.SyntheticOne):
    def test_restarts_do_not_reset_no_progress_count(self):
        context={'action':'IMPLEMENT','source_sha':fixture.A}
        before=self.path.read_bytes()
        for count in range(1,4):
            result=progress_budget.update(self.root,'ST-001','fingerprint',context,3,'fingerprint')
            self.assertEqual(count,result['consecutive_no_progress'])
        for _ in range(4):
            self.assertFalse(progress_budget.update(self.root,'ST-001','fingerprint',context,3)['allowed'])
        self.assertEqual(before,self.path.read_bytes())

    def test_real_source_or_review_change_unlocks_but_timestamp_does_not(self):
        context={'action':'REPAIR_REVIEW','source_sha':fixture.A,'row_token':'prose'}
        progress_budget.update(self.root,'ST-001','same',context,1,'same')
        self.assertFalse(progress_budget.update(self.root,'ST-001','same',dict(context,row_token='new prose'),1)['allowed'])
        self.assertTrue(progress_budget.update(self.root,'ST-001','same',dict(context,source_sha=fixture.B),1)['allowed'])
        self.assertTrue(progress_budget.update(self.root,'ST-001','new content',context,1)['allowed'])


class ActualLoopReplayCases(fixture.WiringTests):
    def test_real_loop_restarts_only_launch_bounded_fake_builders(self):
        # The real loop and progress budget run across five fresh processes, as
        # supervisor does. External providers are fakes, never metered agents.
        self.write(fixture.feature(phase='P0-process', status='in_progress'))
        (self.root/'startrips').mkdir()
        stubs={
          'execution.py':'print("{}")\n',
          'runtime_preflight.py':'from pathlib import Path\nprint(Path.cwd() / "startrips")\n',
          'action_plan.py':'import sys,json\nprint("IMPLEMENT" if "--action-only" in sys.argv else json.dumps({"action":"IMPLEMENT","feature":"ST-001"}))\n',
          'feature_state.py':'import sys\nif __name__=="__main__": print("same-fingerprint" if sys.argv[1]=="fingerprint" else "")\n',
          'intake.sh':'intake_new_issues() { :; }\nintake_reconcile_issues() { :; }\n',
        }
        for name,body in stubs.items():(self.root/'lib'/name).write_text(body,encoding='utf-8',newline='\n')
        binpath=self.root/'fake-bin';binpath.mkdir()
        for name,body in [('gh','#!/usr/bin/env bash\nexit 0\n'),('claude','#!/usr/bin/env bash\nprintf "called\\n" >> .agent-artifacts/model-calls.log\nexit 0\n')]:
            path=binpath/name;path.write_text(body,encoding='utf-8',newline='\n');path.chmod(0o755)
        for _ in range(5):
            result=self.invoke('export PATH="$PWD/fake-bin:$PATH"; export STARTRIPS_LANE=backend; MAX_NO_CHANGE=3 bash run-loop.sh')
            self.assertEqual(7,result.returncode,result.stdout+result.stderr)
        self.assertEqual(['called']*3,(self.root/'.agent-artifacts/model-calls.log').read_text().splitlines())
        self.assertFalse((self.root/'AGENT_STOP').exists())
        self.assertEqual('in_progress',fixture.store.load_document(self.path)['features'][0]['status'])


class IntakeDiscoveryCases(fixture.WiringTests):
    def test_failed_github_discovery_propagates_transient_not_no_work(self):
        before=self.path.read_bytes()
        command='set -euo pipefail; ROOT="$PWD"; source lib/intake.sh; gh() { return 1; }; intake_new_issues'
        result=self.invoke(command)
        self.assertEqual(6,result.returncode,result.stdout+result.stderr)
        self.assertIn('UNKNOWN',result.stderr); self.assertNotIn('no new open issues',result.stdout)
        self.assertEqual(before,self.path.read_bytes())

    def test_empty_response_is_not_an_empty_issue_list(self):
        result=self.invoke('set -euo pipefail; ROOT="$PWD"; source lib/intake.sh; gh() { return 0; }; intake_new_issues')
        self.assertEqual(6,result.returncode,result.stdout+result.stderr)
        self.assertNotIn('no new open issues',result.stdout)

    def test_invalid_json_is_not_an_empty_issue_list(self):
        result=self.invoke('set -euo pipefail; ROOT="$PWD"; source lib/intake.sh; gh() { echo malformed; }; intake_new_issues')
        self.assertEqual(6,result.returncode,result.stdout+result.stderr)
        self.assertNotIn('no new open issues',result.stdout)

    def test_runtime_triage_failure_propagates_from_new_issue_loop(self):
        command=('set -euo pipefail; ROOT="$PWD"; source lib/intake.sh; '
                 'gh() { :; }; intake_candidates() { echo 448; }; '
                 'intake_budget_take() { :; }; intake_issue() { return 6; }; '
                 'intake_new_issues')
        result=self.invoke(command)
        self.assertEqual(6,result.returncode,result.stdout+result.stderr)
        self.assertIn('evidence UNKNOWN',result.stderr)
        self.assertNotIn('no new open issues',result.stdout)

    def test_peer_evidence_unknown_never_launches_triage(self):
        command=('set -euo pipefail; ROOT="$PWD"; source lib/intake.sh; '
                 'intake_issue_state() { return 1; }; '
                 'intake_triage_peer_active() { return 6; }; '
                 'intake_triage() { echo TRIAGE_SHOULD_NOT_RUN; return 0; }; '
                 'intake_issue 448')
        result=self.invoke(command)
        self.assertEqual(6,result.returncode,result.stdout+result.stderr)
        self.assertIn('peer evidence UNKNOWN',result.stderr)
        self.assertNotIn('TRIAGE_SHOULD_NOT_RUN',result.stdout+result.stderr)

    def test_urgent_mode_sees_p0_p1_without_bulk_intake(self):
        import shlex
        issues=[{'number':50,'title':'ordinary feature','labels':[],'createdAt':'2020-01-01'},
                {'number':51,'title':'[P1] regression','labels':[],'createdAt':'2026-01-01'},
                {'number':52,'title':'[P0] outage','labels':[],'createdAt':'2026-01-02'},
                {'number':53,'title':'[P0] excluded','labels':[{'name':'no-loop'}],'createdAt':'2026-01-03'}]
        payload=shlex.quote(json.dumps(issues))
        command='set -euo pipefail; ROOT="$PWD"; source lib/intake.sh; gh() { printf "%s" '+payload+'; }; INTAKE_URGENT_ONLY=1 intake_candidates'
        before=self.path.read_bytes();result=self.invoke(command)
        self.assertEqual(0,result.returncode,result.stdout+result.stderr)
        self.assertEqual(['52','51'],result.stdout.strip().splitlines());self.assertEqual(before,self.path.read_bytes())

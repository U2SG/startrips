"""Synthetic regressions. Run only in GitHub CI; never load the live ONE."""
from __future__ import annotations
import base64
import copy
import json
import multiprocessing
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'lib'))
# A spawned child re-imports this module by name to unpickle the helpers below,
# and it inherits this sys.path. Keep our own directory ahead of lib/ so a stale
# same-named module left there cannot answer that import instead.
sys.path.insert(0, str(Path(__file__).resolve().parent))
import feature_store as store
import github_evidence as gh
import feature_state as state
import runtime_preflight as runtime
import external_execution as external

A, B, C = 'a' * 40, 'b' * 40, 'c' * 40
REPO = 'synthetic/project'


def feature(fid='ST-001', status='pending', **extra):
    result = dict(id=fid, status=status, passes=False, attempts=0, priority=int(fid[3:]),
                  phase='P1-globe', dependencies=[], human_gate=None,
                  evidence=[], pr_links=[], notes='unchanged')
    result.update(extra)
    return result


def document(*rows):
    return {'rules': {'terminal_statuses': list(state.TERMINAL)}, 'features': list(rows)}


def concurrent_write(path, fid, gate, loaded, result):
    try:
        doc = store.load_document(path)
        loaded.put(fid)
        if not gate.wait(10):
            raise RuntimeError('barrier timeout')
        state.target(doc, fid)['notes'] = 'written-' + fid
        store.commit_document(path, doc, allowed={fid: {'notes'}})
        result.put(('ok', fid))
    except Exception as exc:
        result.put(('error', str(exc)))


def report_module_file(queue):
    import test_control_plane as module
    queue.put(module.__file__)


def crash_with_mutex(path, ready):
    with store._storage_mutex(Path(path)):
        ready.set()
        os._exit(0)


class SyntheticOne(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.path = self.root / 'feature_list.json'
        self.path.write_text(json.dumps(document(feature(), feature('ST-002')), indent=2) + '\n', encoding='utf-8')

    def tearDown(self):
        self.temp.cleanup()

    def write(self, *rows):
        self.path.write_text(json.dumps(document(*rows), ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


class ExternalExecutionReceiptTests(SyntheticOne):
    def owner_args(self):
        worktree = self.root / 'owner'
        worktree.mkdir()
        (worktree / '.git').write_text('gitdir: synthetic', encoding='utf-8')
        return SimpleNamespace(root=str(self.root), feature='ST-001', worktree=str(worktree),
                               action='IMPLEMENT', row_token='row-token-1')

    def test_prepare_is_evidence_only_and_request_id_is_stable(self):
        before = self.path.read_bytes()
        args = self.owner_args()
        with mock.patch.object(external, 'branch_of', return_value='feat/issue1-st001'):
            first = external.prepare(args)
            second = external.prepare(args)
        self.assertEqual('startrips-experience-st-001-owner', first['owner_key'])
        self.assertEqual(first['request_id'], second['request_id'])
        self.assertEqual(1, first['generation'])
        self.assertEqual('prepared', second['status'])
        self.assertEqual(before, self.path.read_bytes())
        self.assertTrue(external.receipt_path(self.root, 'ST-001').exists())

    def test_running_receipt_requires_provider_identity(self):
        args = self.owner_args()
        with mock.patch.object(external, 'branch_of', return_value='feat/issue1-st001'):
            prepared = external.prepare(args)
        with self.assertRaises(external.ReceiptError):
            external.record(SimpleNamespace(
                root=str(self.root), feature='ST-001', status='running',
                request_id=prepared['request_id'], agent_ref=None, task_ref=None, turn_id=None))
        current = external.load_receipt(self.root, 'ST-001')
        self.assertEqual('prepared', current['status'])
        self.assertIsNone(current['agent_ref'])

    def test_same_agent_followup_advances_task_and_turn_identity(self):
        args = self.owner_args()
        with mock.patch.object(external, 'branch_of', return_value='feat/issue1-st001'):
            prepared = external.prepare(args)
        external.record(SimpleNamespace(
            root=str(self.root), feature='ST-001', status='running',
            request_id=prepared['request_id'], agent_ref='agent-1', task_ref='task-1', turn_id='turn-1'))
        current = external.record(SimpleNamespace(
            root=str(self.root), feature='ST-001', status='running',
            request_id=prepared['request_id'], agent_ref='agent-1', task_ref='task-2', turn_id='turn-2'))
        self.assertEqual(('agent-1', 'task-2', 'turn-2'),
                         (current['agent_ref'], current['task_ref'], current['turn_id']))

    def test_provider_identity_cannot_drift_within_generation(self):
        args = self.owner_args()
        with mock.patch.object(external, 'branch_of', return_value='feat/issue1-st001'):
            prepared = external.prepare(args)
        external.record(SimpleNamespace(
            root=str(self.root), feature='ST-001', status='running',
            request_id=prepared['request_id'], agent_ref='agent-1', task_ref='task-1', turn_id='turn-1'))
        with self.assertRaises(external.ReceiptError):
            external.record(SimpleNamespace(
                root=str(self.root), feature='ST-001', status='running',
                request_id=prepared['request_id'], agent_ref='agent-2', task_ref=None, turn_id=None))

    def test_ended_generation_gets_fresh_idempotency_key(self):
        args = self.owner_args()
        with mock.patch.object(external, 'branch_of', return_value='feat/issue1-st001'):
            first = external.prepare(args)
            external.record(SimpleNamespace(
                root=str(self.root), feature='ST-001', status='idle',
                request_id=first['request_id'], agent_ref='agent-1', task_ref='task-1', turn_id='turn-1'))
            second = external.prepare(args)
            repeated = external.prepare(args)
        self.assertEqual(2, second['generation'])
        self.assertNotEqual(first['request_id'], second['request_id'])
        self.assertEqual(second['request_id'], repeated['request_id'])
        self.assertIsNone(second['agent_ref'])


class StoreTests(SyntheticOne):
    def test_unrelated_stale_snapshots_both_survive(self):
        x, y = store.load_document(self.path), store.load_document(self.path)
        x['features'][0]['notes'] = 'first'
        y['features'][1]['notes'] = 'second'
        store.commit_document(self.path, x, allowed={'ST-001': {'notes'}})
        store.commit_document(self.path, y, allowed={'ST-002': {'notes'}})
        self.assertEqual(['first', 'second'], [f['notes'] for f in store.load_document(self.path)['features']])

    def test_same_row_stale_writer_rejected(self):
        x, y = store.load_document(self.path), store.load_document(self.path)
        x['features'][0]['notes'] = 'first'
        y['features'][0]['status'] = 'in_progress'
        store.commit_document(self.path, x, allowed={'ST-001': {'notes'}})
        before = self.path.read_bytes()
        with self.assertRaises(store.StoreConflict):
            store.commit_document(self.path, y, allowed={'ST-001': {'status'}})
        self.assertEqual(before, self.path.read_bytes())

    def test_read_set_dependency_drift_rejected(self):
        x, y = store.load_document(self.path), store.load_document(self.path)
        x['features'][0]['status'] = 'blocked'
        y['features'][1]['notes'] = 'depends-on-observation'
        store.commit_document(self.path, x, allowed={'ST-001': {'status'}})
        with self.assertRaises(store.StoreConflict):
            store.commit_document(self.path, y, allowed={'ST-002': {'notes'}}, expected_rows={'ST-001'})

    def test_noop_preserves_bytes_and_mtime(self):
        before, stamp = self.path.read_bytes(), self.path.stat().st_mtime_ns
        self.assertFalse(store.commit_document(self.path, store.load_document(self.path), allowed={})['changed'])
        self.assertEqual(before, self.path.read_bytes())
        self.assertEqual(stamp, self.path.stat().st_mtime_ns)

    def test_unicode_bom_crlf_and_unrelated_bytes_preserved(self):
        raw = ('\ufeff' + json.dumps(document(feature(notes='原文'), feature('ST-002')), ensure_ascii=False, indent=3)).replace('\n', '\r\n').encode('utf-8')
        self.path.write_bytes(raw)
        doc = store.load_document(self.path)
        doc['features'][0]['notes'] = '保留历史'
        store.commit_document(self.path, doc, allowed={'ST-001': {'notes'}})
        self.assertEqual(raw.replace('原文'.encode(), '保留历史'.encode()), self.path.read_bytes())

    def test_unapproved_field_rejected(self):
        doc = store.load_document(self.path)
        doc['features'][0]['dependencies'] = ['ST-002']
        with self.assertRaises(store.StoreConflict):
            store.commit_document(self.path, doc, allowed={'ST-001': {'notes'}})

    def test_metadata_change_rejected(self):
        doc = store.load_document(self.path)
        doc['rules']['anything'] = True
        with self.assertRaises(store.StoreConflict):
            store.commit_document(self.path, doc, allowed={})

    def test_reorder_rejected(self):
        doc = store.load_document(self.path)
        doc['features'].reverse()
        with self.assertRaises(store.StoreConflict):
            store.commit_document(self.path, doc, allowed={})

    def test_duplicate_property_rejected(self):
        self.path.write_bytes(b'{"features":[],"features":[]}')
        with self.assertRaises(store.StoreConflict):
            store.load_document(self.path)

    def test_append_preserves_existing_bytes(self):
        before = self.path.read_text(encoding='utf-8')
        doc = store.load_document(self.path)
        doc['features'].append(feature('ST-003'))
        store.commit_document(self.path, doc, allowed={}, allow_append=True)
        after = self.path.read_text(encoding='utf-8')
        self.assertIn(before[:before.rfind('\n  ]')], after)
        self.assertEqual(3, len(store.load_document(self.path)['features']))

    def test_concurrent_intake_id_collision_rejected(self):
        x, y = store.load_document(self.path), store.load_document(self.path)
        for doc in [x, y]:
            doc['features'].append(feature('ST-003'))
        store.commit_document(self.path, x, allowed={}, allow_append=True)
        with self.assertRaises(store.StoreConflict):
            store.commit_document(self.path, y, allowed={}, allow_append=True)

    def test_replace_failure_keeps_complete_original(self):
        before = self.path.read_bytes()
        doc = store.load_document(self.path)
        doc['features'][0]['notes'] = 'new'
        with mock.patch.object(store.os, 'replace', side_effect=OSError('synthetic interruption')):
            with self.assertRaises(OSError):
                store.commit_document(self.path, doc, allowed={'ST-001': {'notes'}})
        self.assertEqual(before, self.path.read_bytes())
        self.assertEqual([], list(self.root.glob('*.tmp')))

    def test_actual_parallel_processes_keep_both_updates(self):
        ctx = multiprocessing.get_context('spawn')
        gate, loaded, result = ctx.Event(), ctx.Queue(), ctx.Queue()
        workers = [ctx.Process(target=concurrent_write, args=(str(self.path), fid, gate, loaded, result))
                   for fid in ['ST-001', 'ST-002']]
        try:
            for worker in workers:
                worker.start()
            self.assertEqual({'ST-001', 'ST-002'}, {loaded.get(timeout=15), loaded.get(timeout=15)})
            gate.set()
            self.assertEqual({'ok'}, {result.get(timeout=15)[0], result.get(timeout=15)[0]})
            for worker in workers:
                worker.join(15)
                self.assertEqual(0, worker.exitcode)
            self.assertEqual(['written-ST-001', 'written-ST-002'], [f['notes'] for f in store.load_document(self.path)['features']])
        finally:
            for worker in workers:
                if worker.is_alive():
                    worker.terminate()
                worker.join(5)

    def test_process_exit_releases_storage_mutex(self):
        ctx = multiprocessing.get_context('spawn')
        ready = ctx.Event()
        worker = ctx.Process(target=crash_with_mutex, args=(str(self.path), ready))
        worker.start()
        try:
            self.assertTrue(ready.wait(15))
            worker.join(10)
            self.assertEqual(0, worker.exitcode)
            doc = store.load_document(self.path)
            doc['features'][0]['notes'] = 'after-crash'
            store.commit_document(self.path, doc, allowed={'ST-001': {'notes'}})
        finally:
            if worker.is_alive():
                worker.terminate()
            worker.join(5)


def review_api(threads, reviews=(), decision=None, drift=False, partial=False):
    count = 0
    def invoke(endpoint, fields):
        nonlocal count
        count += 1
        connection = 'reviewThreads' if 'reviewThreads(' in fields['query'] else 'latestOpinionatedReviews'
        pr = {'headRefOid': B if drift and count > 1 else A, 'updatedAt': '2026-01-01T00:00:00Z',
              'reviewDecision': decision, connection: {'nodes': list(threads if connection == 'reviewThreads' else reviews),
               'pageInfo': {'hasNextPage': False, 'endCursor': None}}}
        if partial:
            del pr[connection]['pageInfo']
        return {'data': {'repository': {'pullRequest': pr}}}
    return invoke


class EvidenceTests(unittest.TestCase):
    def test_resolved_without_reply_is_clear(self):
        with mock.patch.object(gh, 'api', side_effect=review_api([{'id': 't', 'isResolved': True, 'isOutdated': False}])):
            result = gh.review_backlog(REPO, 1)
        self.assertEqual((0, 0), (result['unresolved'], result['changes_requested']))

    def test_outdated_unresolved_still_blocks(self):
        with mock.patch.object(gh, 'api', side_effect=review_api([{'id': 't', 'isResolved': False, 'isOutdated': True}])):
            self.assertEqual(1, gh.review_backlog(REPO, 1)['unresolved'])

    def test_latest_effective_approval_not_historical_request(self):
        with mock.patch.object(gh, 'api', side_effect=review_api([], [{'id': 'r', 'state': 'APPROVED'}])):
            self.assertEqual(0, gh.review_backlog(REPO, 1)['changes_requested'])

    def test_effective_change_request_blocks(self):
        with mock.patch.object(gh, 'api', side_effect=review_api([], [{'id': 'r', 'state': 'CHANGES_REQUESTED'}])):
            self.assertEqual(1, gh.review_backlog(REPO, 1)['changes_requested'])

    def test_missing_thread_state_is_unknown(self):
        with mock.patch.object(gh, 'api', side_effect=review_api([{'id': 't'}])):
            with self.assertRaises(gh.EvidenceUnknown):
                gh.review_backlog(REPO, 1)

    def test_partial_connection_is_unknown(self):
        with mock.patch.object(gh, 'api', side_effect=review_api([], partial=True)):
            with self.assertRaises(gh.EvidenceUnknown):
                gh.review_backlog(REPO, 1)

    def test_head_changed_during_review_is_unknown(self):
        with mock.patch.object(gh, 'api', side_effect=review_api([], drift=True)):
            with self.assertRaises(gh.EvidenceUnknown):
                gh.review_backlog(REPO, 1)

    def test_failed_api_never_returns_zero(self):
        with mock.patch.object(gh, 'api', side_effect=gh.EvidenceUnknown('offline')):
            with self.assertRaises(gh.EvidenceUnknown):
                gh.review_backlog(REPO, 1)

    def test_graphql_errors_reject_partial_data(self):
        result = subprocess.CompletedProcess([], 0, json.dumps({'data': {}, 'errors': [{'message': 'failed'}]}), '')
        with mock.patch.object(gh.subprocess, 'run', return_value=result):
            with self.assertRaises(gh.EvidenceUnknown):
                gh.api('graphql', {'query': 'synthetic'})

    def source_api(self, source=A, mixed=False, drift=False, crlf=False):
        reads = 0
        def invoke(endpoint, fields=None):
            nonlocal reads
            if '/pulls/' in endpoint:
                reads += 1
                return {'head': {'sha': C if drift and reads > 1 else B}}
            if '/commits/' in endpoint:
                if endpoint.endswith('/' + A):
                    return {'parents': [{'sha': C}], 'files': [{'filename': 'src/code.ts', 'status': 'modified'}]}
                files = [{'filename': 'docs/pr-history/1.md', 'status': 'added'}]
                if mixed:
                    files.append({'filename': 'src/code.ts', 'status': 'modified'})
                return {'parents': [{'sha': A}], 'files': files}
            if '/contents/' in endpoint:
                content = '- **Source head:** `' + source + '`' + ('\r\n' if crlf else '\n')
                return {'encoding': 'base64', 'content': base64.b64encode(content.encode()).decode()}
            raise AssertionError(endpoint)
        return invoke

    def test_one_ledger_final_preserves_source(self):
        with mock.patch.object(gh, 'api', side_effect=self.source_api()):
            self.assertEqual({'source_sha': A, 'final_sha': B, 'sealed': True}, gh.source_relation(REPO, 1))

    def test_ledger_crlf_preserves_source(self):
        with mock.patch.object(gh, 'api', side_effect=self.source_api(crlf=True)):
            self.assertTrue(gh.source_relation(REPO, 1)['sealed'])

    def test_wrong_source_parent_rejected(self):
        with mock.patch.object(gh, 'api', side_effect=self.source_api(source=C)):
            with self.assertRaises(gh.EvidenceUnknown):
                gh.source_relation(REPO, 1)

    def test_mixed_code_and_ledger_is_not_a_seal(self):
        with mock.patch.object(gh, 'api', side_effect=self.source_api(mixed=True)):
            self.assertFalse(gh.source_relation(REPO, 1)['sealed'])

    def test_source_observation_drift_rejected(self):
        with mock.patch.object(gh, 'api', side_effect=self.source_api(drift=True)):
            with self.assertRaises(gh.EvidenceUnknown):
                gh.source_relation(REPO, 1)

    @staticmethod
    def run_result(**extra):
        row = dict(id=1, run_attempt=1, head_sha=A, event='push', head_branch='main', status='completed', conclusion='success')
        row.update(extra)
        return row

    def test_exact_green_main_run(self):
        with mock.patch.object(gh, 'api', return_value={'workflow_runs': [self.run_result()]}):
            self.assertEqual(1, gh.exact_main_run(REPO, A)['id'])

    def test_pending_or_failed_main_cannot_pass(self):
        for status, conclusion in [('queued', None), ('in_progress', None), ('completed', 'failure'), ('completed', 'cancelled')]:
            with self.subTest(status=status, conclusion=conclusion):
                with mock.patch.object(gh, 'api', return_value={'workflow_runs': [self.run_result(status=status, conclusion=conclusion)]}):
                    with self.assertRaises(gh.EvidenceUnknown):
                        gh.exact_main_run(REPO, A)

    def test_wrong_sha_branch_or_event_cannot_pass(self):
        for extra in [{'head_sha': B}, {'head_branch': 'feature'}, {'event': 'pull_request'}]:
            with self.subTest(extra=extra):
                with mock.patch.object(gh, 'api', return_value={'workflow_runs': [self.run_result(**extra)]}):
                    with self.assertRaises(gh.EvidenceUnknown):
                        gh.exact_main_run(REPO, A)

    def test_newer_failed_run_beats_older_success(self):
        with mock.patch.object(gh, 'api', return_value={'workflow_runs': [self.run_result(), self.run_result(id=2, conclusion='failure')]}):
            with self.assertRaises(gh.EvidenceUnknown):
                gh.exact_main_run(REPO, A)

    def merge_api(self, moved=False, comparison='ahead'):
        reads = 0
        def invoke(endpoint, fields=None):
            nonlocal reads
            if '/pulls/' in endpoint:
                return {'merged': True, 'base': {'ref': 'main'}, 'merge_commit_sha': A}
            if '/git/ref/' in endpoint:
                reads += 1
                return {'object': {'sha': C if moved and reads > 1 else B}}
            if '/compare/' in endpoint:
                return {'status': comparison}
            if '/actions/' in endpoint:
                return {'workflow_runs': [self.run_result(head_sha=B)]}
            raise AssertionError(endpoint)
        return invoke

    def test_merge_requires_ancestry_and_exact_green(self):
        with mock.patch.object(gh, 'api', side_effect=self.merge_api()):
            self.assertEqual(B, gh.merge_proof(REPO, 1)['main_sha'])

    def test_merge_not_in_main_rejected(self):
        with mock.patch.object(gh, 'api', side_effect=self.merge_api(comparison='diverged')):
            with self.assertRaises(gh.EvidenceUnknown):
                gh.merge_proof(REPO, 1)

    def test_main_moves_during_proof_rejected(self):
        with mock.patch.object(gh, 'api', side_effect=self.merge_api(moved=True)):
            with self.assertRaises(gh.EvidenceUnknown):
                gh.merge_proof(REPO, 1)


class StateTests(SyntheticOne):
    def candidate(self):
        self.write(feature(status='ready_for_eval', pr_links=['https://github.com/' + REPO + '/pull/1']))

    def test_resolved_review_does_not_demote_or_write(self):
        self.candidate()
        before = self.path.read_bytes()
        with mock.patch.object(state, 'api', return_value={'state': 'open', 'head': {'sha': A}}), mock.patch.object(state, 'review_backlog', return_value={'head_sha': A, 'unresolved': 0, 'changes_requested': 0}):
            self.assertEqual(0, state.reconcile(self.path, REPO, 'main'))
        self.assertEqual(before, self.path.read_bytes())

    def test_unknown_review_preserves_state(self):
        self.candidate()
        before = self.path.read_bytes()
        with mock.patch.object(state, 'api', return_value={'state': 'open', 'head': {'sha': A}}), mock.patch.object(state, 'review_backlog', side_effect=gh.EvidenceUnknown('offline')):
            self.assertEqual(6, state.reconcile(self.path, REPO, 'main'))
        self.assertEqual(before, self.path.read_bytes())

    def test_merge_pending_never_unlocks(self):
        self.candidate()
        before = self.path.read_bytes()
        with mock.patch.object(state, 'api', return_value={'merged': True}), mock.patch.object(state, 'merge_proof', side_effect=gh.EvidenceUnknown('pending')):
            self.assertEqual(6, state.reconcile(self.path, REPO, 'main'))
        self.assertEqual(before, self.path.read_bytes())

    def test_verified_merge_promotes(self):
        self.candidate()
        with mock.patch.object(state, 'api', return_value={'merged': True}), mock.patch.object(state, 'merge_proof', return_value={'merge_sha': A, 'main_sha': B, 'main_ci': 1}):
            self.assertEqual(0, state.reconcile(self.path, REPO, 'main'))
        self.assertEqual('passed', store.load_document(self.path)['features'][0]['status'])

    def test_review_finding_does_not_charge_implementation_attempt(self):
        self.candidate()
        with mock.patch.object(state, 'api', return_value={'state': 'open', 'head': {'sha': A}}), mock.patch.object(state, 'review_backlog', return_value={'head_sha': A, 'unresolved': 1, 'changes_requested': 0}):
            self.assertEqual(0, state.reconcile(self.path, REPO, 'main'))
        row = store.load_document(self.path)['features'][0]
        self.assertEqual(('needs_work', 0), (row['status'], row['attempts']))

    def test_stale_evaluation_row_rejected_before_git_or_write(self):
        self.candidate()
        before = self.path.read_bytes()
        with self.assertRaises(store.StoreConflict):
            state.mark_ready(self.path, 'ST-001', 'evidence', expected_row='old', repo_path=self.root, expected_head=A)
        self.assertEqual(before, self.path.read_bytes())

    def test_stale_source_evaluation_rejected(self):
        self.candidate()
        before = self.path.read_bytes()
        row = store.load_document(self.path)['features'][0]
        with mock.patch.object(state.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, B + '\n', '')):
            with self.assertRaises(store.StoreConflict):
                state.mark_ready(self.path, 'ST-001', 'evidence', expected_row=state.row_token(row), repo_path=self.root, expected_head=A)
        self.assertEqual(before, self.path.read_bytes())

    def test_ready_candidate_is_evaluation_not_implementation(self):
        self.assertEqual('EVALUATE', state.next_action(feature(status='ready_for_eval')))
        self.assertEqual('WAIT_REVIEW', state.next_action(feature(status='ready_to_merge')))
        self.assertEqual('OBSERVE', state.next_action(feature(status='blocked')))


class RecoveryTests(unittest.TestCase):
    def test_ended_session_keeps_same_owner(self):
        self.assertEqual('RESUME_SAME_OWNER', runtime.recovery_action('owner', 'owner', 'ended', True, True))

    def test_live_execution_is_not_duplicated(self):
        self.assertEqual('OBSERVE_EXISTING_EXECUTION', runtime.recovery_action('owner', 'owner', 'active', True, True))

    def test_unknown_execution_does_not_grant_ownership(self):
        self.assertEqual('WAIT_EXECUTION_EVIDENCE', runtime.recovery_action('owner', 'owner', 'unknown', True, True))

    def test_different_worktree_or_owner_is_conflict(self):
        self.assertEqual('OWNERSHIP_CONFLICT', runtime.recovery_action('owner', 'someone', 'ended', True, True))
        self.assertEqual('OWNERSHIP_CONFLICT', runtime.recovery_action('owner', 'owner', 'ended', False, True))


class ImportResolutionTests(unittest.TestCase):
    def test_this_directory_precedes_lib_on_sys_path(self):
        # The regression itself: lib/ used to come first, so a stale copy left there
        # answered the by-name import the spawned cases above depend on.
        self.assertLess(sys.path.index(str(Path(__file__).resolve().parent)),
                        sys.path.index(str(ROOT / 'lib')))

    def test_spawned_child_resolves_this_module_over_a_shadowing_copy(self):
        # And the mechanism, in a real spawned interpreter: it inherits sys.path and
        # re-imports this module BY NAME to unpickle the target. find_spec() cannot
        # show this -- for an already imported name it answers from sys.modules
        # instead of searching -- so plant a shadowing copy where lib/ sits and look.
        with tempfile.TemporaryDirectory() as temp:
            (Path(temp) / 'test_control_plane.py').write_text('SHADOW = True\n', encoding='utf-8')
            own = str(Path(__file__).resolve().parent)
            path = [own, temp] + [entry for entry in sys.path if entry != own]
            context = multiprocessing.get_context('spawn')
            queue = context.Queue()
            with mock.patch.object(sys, 'path', path):
                worker = context.Process(target=report_module_file, args=(queue,))
                worker.start()
            try:
                self.assertEqual(Path(__file__).resolve(), Path(queue.get(timeout=60)).resolve())
            finally:
                worker.join(30)


class WiringTests(SyntheticOne):
    def setUp(self):
        super().setUp()
        shutil.copy2(ROOT / 'run-loop.sh', self.root / 'run-loop.sh')
        shutil.copytree(ROOT / 'lib', self.root / 'lib', ignore=shutil.ignore_patterns('__pycache__'))
        self.bash = shutil.which('bash')
        if os.name == 'nt':
            for candidate in [Path(os.environ.get('ProgramFiles', 'C:/Program Files')) / 'Git/bin/bash.exe', Path('C:/Program Files/Git/usr/bin/bash.exe')]:
                if candidate.exists():
                    self.bash = str(candidate)
                    break
        if not self.bash:
            self.fail('GitHub CI must supply bash, not skip startup regressions')

    def invoke(self, script):
        env = dict(os.environ, PYTHONIOENCODING='utf-8', PYTHONUTF8='1', PYTHONDONTWRITEBYTECODE='1')
        env.pop('STARTRIPS_LANE', None)
        return subprocess.run([self.bash, '-c', script], cwd=self.root, env=env, capture_output=True, text=True, encoding='utf-8', timeout=20)

    def test_missing_target_lane_fails_before_any_state_write(self):
        before = self.path.read_bytes()
        result = self.invoke('unset STARTRIPS_LANE; bash run-loop.sh --next')
        self.assertEqual(64, result.returncode, result.stderr)
        self.assertIn('LANE_REQUIRED', result.stderr)
        self.assertEqual(before, self.path.read_bytes())
        self.assertFalse((self.root / '.agent-artifacts').exists())

    def test_invalid_target_lane_fails(self):
        result = self.invoke('export STARTRIPS_LANE=typo; bash run-loop.sh --next')
        self.assertEqual(64, result.returncode, result.stderr)

    def test_executing_shell_lane_selects_experience_only(self):
        self.write(feature(), feature('ST-002', phase='P0-process'))
        result = self.invoke('export STARTRIPS_LANE=experience; bash run-loop.sh --next')
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertEqual('ST-001', result.stdout.strip())

    def test_executing_shell_lane_selects_backend_only(self):
        self.write(feature(), feature('ST-002', phase='P0-process'))
        result = self.invoke('export STARTRIPS_LANE=backend; bash run-loop.sh --next')
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertEqual('ST-002', result.stdout.strip())

    def write_occupied_probe(self, *, features, available_slots):
        (self.root / 'lib' / 'execution.py').write_text(
            'import json\nprint(json.dumps(' + repr({
                'lane': 'experience', 'capacity': 2,
                'occupied_slots': 2 - available_slots,
                'available_slots': available_slots,
                'features': features, 'worktrees': [], 'claim_count': 0,
            }) + '))\n',
            encoding='utf-8', newline='\n')

    def test_experience_selector_skips_provider_occupied_owner(self):
        self.write(
            feature('ST-001', phase='P1-globe', status='in_progress',
                    pr_links=['https://github.com/synthetic/project/pull/1']),
            feature('ST-002', phase='P1-globe', priority=2),
        )
        self.write_occupied_probe(features=['ST-001'], available_slots=1)
        result = self.invoke('export STARTRIPS_LANE=experience; bash run-loop.sh --next')
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertEqual('ST-002', result.stdout.strip())

    def test_experience_selector_returns_no_third_owner_when_two_slots_full(self):
        self.write(feature('ST-003', phase='P1-globe', priority=3))
        self.write_occupied_probe(features=['ST-001', 'ST-002'], available_slots=0)
        result = self.invoke('export STARTRIPS_LANE=experience; bash run-loop.sh --next')
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertEqual('', result.stdout.strip())

    def test_next_action_does_not_start_builder_or_create_artifacts(self):
        self.write(feature(status='ready_for_eval'))
        before = self.path.read_bytes()
        result = self.invoke('export STARTRIPS_LANE=experience; bash run-loop.sh --next-action')
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertEqual('EVALUATE', result.stdout.strip())
        self.assertEqual(before, self.path.read_bytes())
        self.assertFalse((self.root / '.agent-artifacts').exists())

    def test_all_loop_one_writes_use_safe_boundary(self):
        loop = (ROOT / 'run-loop.sh').read_text(encoding='utf-8')
        intake = (ROOT / 'lib/intake.sh').read_text(encoding='utf-8')
        self.assertNotIn('reset -q --hard', loop)
        self.assertNotIn('open(p,\'w\'', loop)
        self.assertNotIn("open(feat_p, 'w'", intake)
        self.assertIn('commit_document(feat_p', intake)
        self.assertIn('--setting-sources project --strict-mcp-config --agent startrips-triage', intake)
        self.assertIn('--model sonnet', intake)
        self.assertNotIn('--model opus', intake)
        self.assertIn('triage-${BASHPID}.log', intake)
        self.assertIn('>"$INTAKE_LAST_LOG" 2>&1', intake)
        self.assertIn('triage_rc=$?', intake)
        self.assertIn('cat "$INTAKE_LAST_LOG"', intake)
        self.assertIn('intake_triage "$num" || return $?', intake)
        self.assertIn('intake_triage "$num" "$prompt" "amend-$fid" || return $?', intake)
        self.assertIn('intake_triage "$num" "$prompt" "followup-$fid" || return $?', intake)
        self.assertNotIn('| tee "$INTAKE_LAST_LOG"', intake)
        self.assertIn('intake_triage_peer_active()', intake)
        self.assertIn('triage-active; deferred to existing invocation', intake)
        self.assertIn('catch { exit 6 }', intake)
        self.assertIn('raise SystemExit(6)', intake)
        self.assertIn('triage-peer-unknown rc=', intake)
        self.assertIn('issue #$n evidence UNKNOWN; propagating transient failure', intake)
        self.assertNotIn('intake_issue "$n" || echo', intake)
        self.assertIn('gh api --paginate "repos/$INTAKE_GH_REPO/issues?state=all&per_page=100"', intake)
        self.assertIn('mapped-issues-${BASHPID}.jsonl', intake)
        self.assertNotIn('line="$(intake_issue_state "$n" || true)"', intake)
        triage_agent = (ROOT / '.claude/agents/startrips-triage.md').read_text(encoding='utf-8')
        self.assertIn('do **not** dump the whole raw file into model context', triage_agent)
        self.assertNotIn('The **whole** of `feature_list.json`', triage_agent)
        self.assertIn('feature_state.py', loop)
        self.assertIn('github_evidence.py', loop)
        self.assertNotIn('|| echo 0', loop)

    def test_runtime_does_not_disable_scheduled_observation(self):
        text = '\n'.join((ROOT / name).read_text(encoding='utf-8') for name in ['run-loop.sh', 'wake-if-work.sh', 'loop-supervisor.sh'])
        for forbidden in ['Disable-ScheduledTask', 'schtasks /change', 'is_enabled=false', 'is_enabled=False']:
            self.assertNotIn(forbidden, text)

    def test_backend_wake_and_restart_guards_are_lane_scoped(self):
        for name in ['wake-if-work.sh', 'scheduled-restart.sh']:
            text = (ROOT / name).read_text(encoding='utf-8')
            self.assertIn('execution.py\" check \"$ROOT\" --lane backend', text, name)

    def test_real_carrier_publishes_exact_owner_scope_before_work(self):
        loop = (ROOT / 'run-loop.sh').read_text(encoding='utf-8')
        self.assertIn('"--carrier-feature=$FEATURE" "--carrier-worktree64=$OWNER_WORKTREE64"', loop)
        self.assertIn('--worktree64 "$CARRIER_WORKTREE64"', loop)
        self.assertNotIn('CARRIER_WORKTREE="$(python3', loop)
        self.assertIn('CARRIER_SCOPE_DRIFT', loop)
        self.assertIn('SCOPED_SELECTED="$(FEATURE_ALLOW="$CARRIER_FEATURE" read_next_feature)', loop)
        self.assertIn('CARRIER_LANE_OR_GATE_DRIFT', loop)
        self.assertIn('FEATURE="$CARRIER_FEATURE"', loop)
        self.assertIn('worktree64=$OWNER_WORKTREE64', loop)
        self.assertIn('read_next_feature()', loop)
        self.assertIn('SELECTOR_UNKNOWN: next_feature rc=', loop)
        self.assertIn('PRE_INTAKE_FEATURE="$(read_next_feature)" || exit 6', loop)
        self.assertIn('FEATURE="$(read_next_feature)" || exit 6', loop)
        self.assertIn('SCOPED_SELECTED="$(FEATURE_ALLOW="$CARRIER_FEATURE" read_next_feature)" || exit 6', loop)
        self.assertIn('yield_waiting_feature()', loop)
        self.assertIn('FEATURE_SKIP', loop)
        self.assertIn('failure_family_owner', loop)
        self.assertIn('Recurring CI family is canonically owned by $FAMILY_OWNER', loop)
        self.assertIn('EXPERIENCE_EXTERNAL_DISPATCH=', loop)
        self.assertIn('LOCAL_MODEL_PROVIDER_FORBIDDEN_FOR_LANE=', loop)
        self.assertIn('Experience provider is external Codexless; model intake/re-triage delegated to Orchestrator', loop)
        self.assertLess(loop.index('EXPERIENCE_EXTERNAL_DISPATCH='), loop.index('claude_run -p'))
        self.assertIn('if [[ "${EVAL_ONLY:-0}" == "1" ]]; then', loop)
        self.assertNotIn('if [[ "\\${EVAL_ONLY:-0}" == "1" ]]; then', loop)


if __name__ == '__main__':
    multiprocessing.freeze_support()
    unittest.main(verbosity=2)

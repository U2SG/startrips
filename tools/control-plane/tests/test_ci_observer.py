"""Latest-attempt CI, failure history and non-replayable targeted reruns (CI only)."""
import copy
import json
import subprocess
import unittest
from unittest import mock
import test_control_plane as fixture
import ci_observer as ci


def run(**extra):
    value = {'id': 10, 'head_sha': fixture.A, 'run_attempt': 1, 'status': 'completed',
             'conclusion': 'failure', 'event': 'pull_request', 'head_branch': 'feature', 'html_url': 'https://github.com/synthetic/project/actions/runs/10'}
    value.update(extra); return value


def job(name='core', ident=1, conclusion='success', **extra):
    value = {'id': ident, 'name': name, 'status': 'completed', 'conclusion': conclusion,
             'run_id': 10, 'run_attempt': 1, 'head_sha': fixture.A, 'steps': []}
    if name == 'ledger' and conclusion == 'failure':
        value['steps'] = [{'name': 'Validate current PR ledger', 'conclusion': 'failure'}]
    value.update(extra); return value


def complete_jobs():
    return [job('ledger', 1), job('core', 2), job('verify', 3), job('browser-qa / fixture', 4)]


class ClassificationCases(unittest.TestCase):
    def test_new_failure_beats_historical_same_name_success(self):
        jobs = complete_jobs() + [job('core', 5, 'failure', run_attempt=2)]
        result = ci.classify(run(run_attempt=2), jobs)
        self.assertFalse(result['source_green']); self.assertEqual(5, result['failures'][0]['id'])

    def test_new_pending_beats_historical_success(self):
        jobs = complete_jobs() + [job('core', 5, None, status='in_progress', run_attempt=2)]
        self.assertEqual('pending', ci.classify(run(run_attempt=2), jobs)['state'])

    def test_latest_retry_success_keeps_unrerun_jobs(self):
        jobs = complete_jobs() + [job('core', 5, 'success', run_attempt=2)]
        result = ci.classify(run(run_attempt=2, conclusion='success'), jobs)
        self.assertTrue(result['final_green'])

    def test_missing_ledger_exception_is_source_only(self):
        jobs = [job('ledger', 1, 'failure'), job('verify', 2, 'failure'), job('core', 3)]
        result = ci.classify(run(), jobs, missing_ledger=True)
        self.assertTrue(result['source_green']); self.assertFalse(result['final_green'])

    def test_no_unproven_ledger_exception(self):
        jobs = [job('ledger', 1, 'failure'), job('verify', 2, 'failure'), job('core', 3)]
        self.assertFalse(ci.classify(run(), jobs)['source_green'])

    def test_cancelled_run_cannot_pass_with_old_green_jobs(self):
        result = ci.classify(run(conclusion='cancelled'), complete_jobs(), True)
        self.assertEqual('unknown', result['state']); self.assertFalse(result['source_green'])

    def test_missing_required_job_is_unknown(self):
        with self.assertRaises(ci.EvidenceUnknown): ci.classify(run(), [job('core')])

    def test_skipped_product_job_is_not_success(self):
        jobs = complete_jobs() + [job('core', 5, 'skipped')]
        self.assertFalse(ci.classify(run(conclusion='success'), jobs)['source_green'])

    def test_two_job_names_do_not_hide_each_other(self):
        result = ci.effective_jobs([job('lane-a', 1), job('lane-b', 2, 'failure'), job('lane-a', 3)])
        self.assertEqual({'lane-a', 'lane-b'}, {j['name'] for j in result})
        self.assertEqual('failure', next(j for j in result if j['name'] == 'lane-b')['conclusion'])

    def test_missing_job_identity_rejected(self):
        with self.assertRaises(ci.EvidenceUnknown): ci.effective_jobs([{'name': 'core'}])

    def test_capture_rejects_attempt_drift(self):
        def api(endpoint):
            if 'workflows/ci.yml/runs?' in endpoint: return {'workflow_runs': [run()]}
            if '/jobs?' in endpoint: return {'jobs': complete_jobs()}
            return run(run_attempt=2)
        with mock.patch.object(ci, 'api', side_effect=api):
            with self.assertRaises(ci.EvidenceUnknown): ci.latest_ci('synthetic/project', fixture.A)

    def test_no_matching_head_does_not_use_another_run(self):
        with mock.patch.object(ci, 'api', return_value={'workflow_runs': [run(head_sha=fixture.B)]}):
            self.assertEqual('missing', ci.latest_ci('synthetic/project', fixture.A)['state'])


class FingerprintCases(fixture.SyntheticOne):
    def failed(self, ident=7):
        return job('browser-qa / city-label-anchoring', ident, 'failure', steps=[{'name': 'Run browser QA', 'conclusion': 'failure'}])

    def record(self, run_data=None, job_data=None, text='AssertionError: Hong Kong label; fixture=city viewport=1280x720 DPR=3'):
        failed = job_data or self.failed(); data = {'run': run_data or run(), 'failures': [failed], 'source_green': False}
        with mock.patch.object(ci.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, text, '')):
            return ci.observe_failures(self.root, 'synthetic/project', data)[0]

    def test_fingerprint_contains_all_dimensions(self):
        value = ci.normalize_failure(self.failed(), 'AssertionError: label missing fixture=city viewport=1280x720 DPR=3')
        self.assertTrue(set(ci.DIMENSIONS) <= set(value))
        self.assertEqual(('city', '1280x720', '3'), (value['fixture'], value['viewport'], value['dpr']))

    def test_same_observation_does_not_count_twice(self):
        self.record(); result = self.record()
        self.assertEqual(1, result['family_occurrences']); self.assertFalse(result['root_cause_required'])

    def test_failed_older_job_kept_in_new_attempt_is_not_new_failure(self):
        self.record(); result = self.record(run(run_attempt=2), self.failed())
        self.assertEqual(1, result['family_occurrences'])

    def test_repeated_family_across_sources_requires_root_cause(self):
        self.record(); result = self.record(run(id=11, head_sha=fixture.B), self.failed(8))
        self.assertEqual(2, result['family_occurrences']); self.assertTrue(result['root_cause_required'])

    def test_changing_dpr_changes_exact_fingerprint(self):
        a = ci.normalize_failure(self.failed(), 'AssertionError: missing fixture=city viewport=1280x720 DPR=2')
        b = ci.normalize_failure(self.failed(), 'AssertionError: missing fixture=city viewport=1280x720 DPR=3')
        self.assertNotEqual(a['fingerprint'], b['fingerprint']); self.assertEqual(a['family'], b['family'])

    def test_known_visibility_lifecycle_never_gets_flaky_retry(self):
        value = self.record(text='AssertionError: Journey Rail stayed hidden')
        self.assertTrue(value['root_cause_required']); self.assertFalse(value['infrastructure'])

    def test_assertion_with_service_unavailable_is_not_blanket_infra(self):
        value = ci.normalize_failure(self.failed(), 'AssertionError: Service Unavailable was rendered')
        self.assertFalse(value['infrastructure'])

    def test_known_action_download_failure_is_infrastructure(self):
        value = ci.normalize_failure(job('core'), 'Error: Failed to resolve action download info')
        self.assertTrue(value['infrastructure'])

    def test_no_raw_log_or_credentials_persisted(self):
        self.record(text='random_private_token=DO_NOT_PERSIST\nAssertionError: label missing')
        raw = ''.join(p.read_text(encoding='utf-8') for p in (self.root / '.agent-artifacts/ci-failures').glob('failure-*.json'))
        self.assertNotIn('DO_NOT_PERSIST', raw)

    def test_unavailable_log_is_unknown_not_infra_retry(self):
        with mock.patch.object(ci.subprocess, 'run', return_value=subprocess.CompletedProcess([], 1, '', 'offline')):
            with self.assertRaises(ci.EvidenceUnknown):
                ci.observe_failures(self.root, 'synthetic/project', {'run': run(), 'failures': [self.failed()]})


class RetryCases(fixture.SyntheticOne):
    def setUp(self):
        super().setUp()
        self.write(fixture.feature(status='in_progress', pr_links=['https://github.com/synthetic/project/pull/1']))
        self.records = [{'job_id': 7, 'infrastructure': True, 'root_cause_required': False}]
        self.ci = {'run': run()}

    def request(self):
        return ci.rerun_once(self.root, 'synthetic/project', self.ci, self.records, number=1, feature='ST-001')

    def api(self, endpoint):
        if '/pulls/' in endpoint: return {'state': 'open', 'merged': False, 'head': {'sha': fixture.A}}
        return run()

    def test_only_first_attempt_is_eligible(self):
        self.assertTrue(ci.rerun_eligibility(run(), self.records)[0])
        self.assertFalse(ci.rerun_eligibility(run(run_attempt=2), self.records)[0])

    def test_unknown_or_recurring_failure_is_not_rerunnable(self):
        self.assertFalse(ci.rerun_eligibility(run(), [dict(self.records[0], infrastructure=False)])[0])
        self.assertFalse(ci.rerun_eligibility(run(), [dict(self.records[0], root_cause_required=True)])[0])

    def test_targeted_request_is_not_replayed(self):
        with mock.patch.object(ci, 'api', side_effect=self.api), mock.patch.object(ci.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, '', '')) as post:
            self.assertTrue(self.request()['requested']); self.assertFalse(self.request()['requested'])
            self.assertEqual(1, post.call_count)
            self.assertIn('/actions/jobs/7/rerun', post.call_args.args[0][2])

    def test_uncertain_post_is_not_replayed(self):
        with mock.patch.object(ci, 'api', side_effect=self.api), mock.patch.object(ci.subprocess, 'run', side_effect=subprocess.TimeoutExpired('synthetic', 1)) as post:
            with self.assertRaises(subprocess.TimeoutExpired): self.request()
            self.assertFalse(self.request()['requested']); self.assertEqual(1, post.call_count)

    def test_head_change_prevents_post(self):
        def api(endpoint):
            return {'state': 'open', 'merged': False, 'head': {'sha': fixture.B}} if '/pulls/' in endpoint else run()
        with mock.patch.object(ci, 'api', side_effect=api), mock.patch.object(ci.subprocess, 'run') as post:
            with self.assertRaises(ci.EvidenceUnknown): self.request()
            post.assert_not_called()

    def test_new_attempt_prevents_post(self):
        with mock.patch.object(ci, 'api', return_value=run(run_attempt=2)), mock.patch.object(ci.subprocess, 'run') as post:
            with self.assertRaises(ci.EvidenceUnknown): self.request()
            post.assert_not_called()

    def test_owner_stop_prevents_post(self):
        (self.root / 'AGENT_STOP').write_text('user stop')
        with mock.patch.object(ci, 'api') as api:
            self.assertFalse(self.request()['requested']); api.assert_not_called()
        self.assertEqual('user stop', (self.root / 'AGENT_STOP').read_text())

    def test_wrong_owner_mapping_prevents_post(self):
        self.write(fixture.feature(pr_links=['https://github.com/synthetic/project/pull/2']))
        with mock.patch.object(ci, 'api') as api:
            with self.assertRaises(fixture.store.StoreConflict): self.request()
            api.assert_not_called()



class HistoricalCases(fixture.SyntheticOne):
    def test_exact_attempt_backfill_does_not_request_a_rerun(self):
        data = run(status='completed', run_attempt=1)
        jobs = [job('core', 5, 'failure')]
        def api(endpoint):
            return {'jobs': jobs} if '/jobs?' in endpoint else data
        with mock.patch.object(ci, 'api', side_effect=api), mock.patch.object(ci, 'observe_failures', return_value=[]) as observe:
            result = ci.backfill_attempt(self.root, 'synthetic/project', 10, 1)
        self.assertTrue(result['historical_only']); self.assertFalse(result['rerun_requested'])
        observe.assert_called_once()

    def test_wrong_attempt_is_not_imported(self):
        with mock.patch.object(ci, 'api', return_value=run(run_attempt=2)):
            with self.assertRaises(ci.EvidenceUnknown): ci.backfill_attempt(self.root, 'synthetic/project', 10, 1)

    def test_pending_attempt_is_not_historical_evidence(self):
        with mock.patch.object(ci, 'api', return_value=run(status='in_progress')):
            with self.assertRaises(ci.EvidenceUnknown): ci.backfill_attempt(self.root, 'synthetic/project', 10, 1)

    def test_ledger_tooling_failure_cannot_use_preledger_exception(self):
        jobs = complete_jobs() + [job('ledger', 7, 'failure', steps=[{'name': 'Test ledger tooling', 'conclusion': 'failure'}])]
        self.assertFalse(ci.classify(run(), jobs, missing_ledger=True)['source_green'])

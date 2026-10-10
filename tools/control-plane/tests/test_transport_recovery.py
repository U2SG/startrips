"""Transport categories and idempotent review receipt regressions (CI only)."""
import io
import json
from pathlib import Path
import subprocess
import sys
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'lib'))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import test_control_plane as fixture
import action_plan as plan
import github_evidence as gh


class QueryFailureCases(unittest.TestCase):
    def response(self, code=0, stdout='{}', stderr=''):
        return subprocess.CompletedProcess(['gh', 'api'], code, stdout, stderr)

    def test_timeout_is_bounded_and_classified(self):
        with mock.patch.object(gh.subprocess, 'run',
                               side_effect=subprocess.TimeoutExpired(['gh'], 25)) as run:
            with self.assertRaises(gh.EvidenceUnknown) as caught:
                gh.api('repos/synthetic/project/pulls/1')
        self.assertEqual(2, run.call_count)
        self.assertEqual('transport', caught.exception.category)
        self.assertTrue(caught.exception.retryable)

    def test_transient_read_failure_can_recover_once(self):
        responses = [self.response(1, stderr='Post https://api.github.com/graphql: EOF'),
                     self.response(stdout='{"ok": true}')]
        with mock.patch.object(gh.subprocess, 'run', side_effect=responses) as run:
            self.assertEqual({'ok': True}, gh.api('graphql', {'query': 'query { viewer { login } }'}))
        self.assertEqual(2, run.call_count)

    def test_permission_rejection_is_not_a_transient_timeout(self):
        response = self.response(1, stderr='gh: Resource not accessible (HTTP 403); timeout policy')
        with mock.patch.object(gh.subprocess, 'run', return_value=response) as run:
            with self.assertRaises(gh.EvidenceUnknown) as caught:
                gh.api('repos/synthetic/project/pulls/1')
        self.assertEqual(1, run.call_count)
        self.assertEqual('authorization', caught.exception.category)
        self.assertFalse(caught.exception.retryable)

    def test_spawn_failures_do_not_retry(self):
        for error, category in [(FileNotFoundError('missing gh'), 'runtime'),
                                (PermissionError('denied'), 'authorization')]:
            with self.subTest(category=category):
                with mock.patch.object(gh.subprocess, 'run', side_effect=error) as run:
                    with self.assertRaises(gh.EvidenceUnknown) as caught:
                        gh.api('repos/synthetic/project/pulls/1')
                self.assertEqual(1, run.call_count)
                self.assertEqual(category, caught.exception.category)
                self.assertFalse(caught.exception.retryable)

    def test_service_unavailable_gets_one_read_retry(self):
        responses = [self.response(1, stderr='gh: Service Unavailable (HTTP 503)'),
                     self.response(stdout='{"ok": true}')]
        with mock.patch.object(gh.subprocess, 'run', side_effect=responses) as run:
            self.assertEqual({'ok': True}, gh.api('repos/synthetic/project/pulls/1'))
        self.assertEqual(2, run.call_count)

    def test_rate_limit_waits_for_later_observation(self):
        for detail in ['gh: API rate limit exceeded (HTTP 403)', 'gh: Too Many Requests (HTTP 429)']:
            with self.subTest(detail=detail):
                with mock.patch.object(gh.subprocess, 'run',
                                       return_value=self.response(1, stderr=detail)) as run:
                    with self.assertRaises(gh.EvidenceUnknown) as caught:
                        gh.api('repos/synthetic/project/pulls/1')
                self.assertEqual(1, run.call_count)
                self.assertEqual('rate_limit', caught.exception.category)
                self.assertTrue(caught.exception.retryable)

    def test_certificate_configuration_failure_is_not_retried(self):
        response = self.response(1, stderr='TLS: certificate verify failed')
        with mock.patch.object(gh.subprocess, 'run', return_value=response) as run:
            with self.assertRaises(gh.EvidenceUnknown) as caught:
                gh.api('repos/synthetic/project/pulls/1')
        self.assertEqual(1, run.call_count)
        self.assertEqual('runtime', caught.exception.category)
        self.assertFalse(caught.exception.retryable)

    def test_response_failures_are_not_clean_evidence(self):
        for stdout in ['not json', '{"data": {}, "errors": [{"message": "partial"}]}']:
            with self.subTest(stdout=stdout):
                with mock.patch.object(gh.subprocess, 'run',
                                       return_value=self.response(stdout=stdout)) as run:
                    with self.assertRaises(gh.EvidenceUnknown) as caught:
                        gh.api('graphql', {'query': 'query { viewer { login } }'})
                self.assertEqual(1, run.call_count)
                self.assertEqual('response', caught.exception.category)
                self.assertFalse(caught.exception.retryable)


class ReviewReplayCases(fixture.SyntheticOne):
    def setUp(self):
        super().setUp()
        self.write(fixture.feature(status='in_progress',
                                   pr_links=['https://github.com/synthetic/project/pull/1']),
                   fixture.feature('ST-002'))
        self.input = self.root / 'review-input.json'
        self.data = {'feature': 'ST-001', 'pr': 1, 'source_sha': fixture.A,
                     'verdict': 'CLEAR', 'findings': [], 'reviewed_paths': ['src/example.ts'],
                     'evidence': ['Independent inspection of the exact Source.']}
        self.input.write_text(json.dumps(self.data), encoding='utf-8')
        self.relation = {'source_sha': fixture.A, 'final_sha': fixture.A, 'sealed': False}
        source_patch = mock.patch.object(plan, 'source_relation', return_value=self.relation)
        pages_patch = mock.patch('ci_observer.pages', return_value=[{'filename': 'src/example.ts'}])
        self.source = source_patch.start()
        self.addCleanup(source_patch.stop)
        self.pages = pages_patch.start()
        self.addCleanup(pages_patch.stop)

    def record(self):
        return plan.record_source_review(self.path, 'ST-001', 'synthetic/project', self.input)

    def receipt(self):
        return plan.receipt_path(self.root, 'ST-001', fixture.A)

    def test_identical_replay_keeps_bytes_and_completion_time(self):
        before_one = self.path.read_bytes()
        first = self.record()
        before_receipt = self.receipt().read_bytes()
        with mock.patch.object(plan, 'write_json', side_effect=AssertionError('duplicate write')):
            replay = self.record()
        self.assertTrue(first['changed'])
        self.assertFalse(replay['changed'])
        self.assertEqual(before_receipt, self.receipt().read_bytes())
        self.assertEqual(before_one, self.path.read_bytes())
        self.assertEqual(4, self.source.call_count)
        self.assertEqual(2, self.pages.call_count)

    def test_replay_revalidates_source_and_preserves_old_receipt_on_drift(self):
        self.record()
        before = self.receipt().read_bytes()
        self.source.return_value = {**self.relation, 'source_sha': fixture.B}
        with self.assertRaises(gh.EvidenceUnknown):
            self.record()
        self.assertEqual(before, self.receipt().read_bytes())

    def test_transport_failure_preserves_review_input_receipt_and_one(self):
        self.record()
        watched = [self.input, self.receipt(), self.path]
        before = {str(path): path.read_bytes() for path in watched}
        self.source.side_effect = gh.EvidenceUnknown('GitHub read unavailable',
                                                    category='transport', retryable=True)
        with self.assertRaises(gh.EvidenceUnknown):
            self.record()
        self.assertEqual(before, {str(path): path.read_bytes() for path in watched})

    def test_first_failed_record_does_not_manufacture_receipt(self):
        before_one, before_input = self.path.read_bytes(), self.input.read_bytes()
        self.source.side_effect = gh.EvidenceUnknown('GitHub read unavailable', category='transport')
        with self.assertRaises(gh.EvidenceUnknown):
            self.record()
        self.assertFalse(self.receipt().exists())
        self.assertEqual(before_one, self.path.read_bytes())
        self.assertEqual(before_input, self.input.read_bytes())

    def test_replay_still_checks_complete_changed_file_coverage(self):
        self.record()
        before = self.receipt().read_bytes()
        self.pages.return_value.append({'filename': 'src/unreviewed.ts'})
        with self.assertRaises(fixture.store.StoreConflict):
            self.record()
        self.assertEqual(before, self.receipt().read_bytes())

    def test_replay_does_not_accept_invalid_stored_authority(self):
        self.record()
        recorded = json.loads(self.receipt().read_bytes())
        recorded['reviewer_role'] = 'local-backend'
        self.receipt().write_text(json.dumps(recorded), encoding='utf-8')
        before = self.receipt().read_bytes()
        with self.assertRaises(gh.EvidenceUnknown):
            self.record()
        self.assertEqual(before, self.receipt().read_bytes())

    def test_corrupt_receipt_is_not_silently_overwritten(self):
        self.record()
        for content in ['null', '[]', 'not json']:
            with self.subTest(content=content):
                self.receipt().write_text(content, encoding='utf-8')
                with self.assertRaises(gh.EvidenceUnknown):
                    self.record()
                self.assertEqual(content, self.receipt().read_text(encoding='utf-8'))

    def test_changed_verdict_is_not_deduplicated(self):
        self.record()
        self.data.update(verdict='CHANGES_REQUESTED', findings=['The Source has a verified defect.'])
        self.input.write_text(json.dumps(self.data), encoding='utf-8')
        result = self.record()
        self.assertTrue(result['changed'])
        self.assertEqual('CHANGES_REQUESTED', plan.source_review(self.root, 'ST-001', 1, fixture.A))


class ActionFailureOutputCases(unittest.TestCase):
    def test_failure_retains_exit_code_and_emits_typed_diagnostic_only_on_stderr(self):
        error = gh.EvidenceUnknown('GitHub request timed out', category='transport', retryable=True)
        stdout, stderr = io.StringIO(), io.StringIO()
        with mock.patch.object(sys, 'argv', ['action_plan.py', 'synthetic.json', 'ST-001']), \
                mock.patch.object(plan, 'plan', side_effect=error), \
                mock.patch.object(sys, 'stdout', stdout), mock.patch.object(sys, 'stderr', stderr):
            result = plan.main()
        self.assertEqual(6, result)
        self.assertEqual('', stdout.getvalue())
        lines = stderr.getvalue().splitlines()
        self.assertTrue(lines[0].startswith('ACTION_UNKNOWN: '))
        diagnostic = json.loads(lines[1].removeprefix('ACTION_FAILURE: '))
        self.assertEqual({'feature': 'ST-001', 'operation': 'plan',
                          'failure': {'category': 'transport', 'retryable': True,
                                      'message': 'GitHub request timed out'}}, diagnostic)


if __name__ == '__main__':
    unittest.main()

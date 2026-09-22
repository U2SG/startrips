"""Known amendment drift must not stall unrelated work. Synthetic GitHub CI only."""
import json
import os
import shutil
import unittest
from pathlib import Path
from unittest import mock

import test_control_plane as fixture
import intake_guard


class KnownSnapshotCases(unittest.TestCase):
    def setUp(self):
        self.row = fixture.feature(notes='auto-intake synthetic')
        self.token = fixture.state.row_token(self.row)

    def test_only_observed_row_drift_has_the_internal_deferral_code(self):
        changed = dict(self.row, human_gate='new owner decision')
        with self.assertRaises(SystemExit) as caught:
            intake_guard.require_amend_snapshot_or_defer(changed, self.token, '', '')
        self.assertEqual(10, caught.exception.code)

    def test_missing_or_malformed_identity_is_not_known_drift(self):
        for token in [None, '', 'old', 'z' * 64, 42]:
            with self.subTest(token=token):
                with self.assertRaises(fixture.store.StoreConflict) as caught:
                    intake_guard.require_amend_snapshot_or_defer(self.row, token, '', '')
                self.assertNotIsInstance(caught.exception, intake_guard.AmendSnapshotChanged)

    def test_unreadable_timestamp_is_not_known_drift(self):
        row = dict(self.row, issue_snapshot_at='not-a-time')
        with self.assertRaises(fixture.store.StoreConflict) as caught:
            intake_guard.require_amend_snapshot_or_defer(
                row, fixture.state.row_token(row), '2026-01-02T00:00:00Z', '1')
        self.assertNotIsInstance(caught.exception, intake_guard.AmendSnapshotChanged)

    def test_unclassified_store_failure_is_not_a_deferral(self):
        with mock.patch.object(intake_guard, 'require_amend_snapshot',
                               side_effect=fixture.store.StoreConflict('unreadable ONE')):
            with self.assertRaises(fixture.store.StoreConflict):
                intake_guard.require_amend_snapshot_or_defer(self.row, self.token, '', '')


class AmendmentDeferralWiringCases(fixture.SyntheticOne):
    # Use the real shell caller and selector, but never a real GitHub/model/process
    # provider. These tests do not read or write the installed control plane.
    def setUp(self):
        super().setUp()
        shutil.copy2(fixture.ROOT / 'run-loop.sh', self.root / 'run-loop.sh')
        shutil.copytree(fixture.ROOT / 'lib', self.root / 'lib',
                        ignore=shutil.ignore_patterns('__pycache__'))
        (self.root / 'lib/execution.py').write_text('print("{}")\n', encoding='utf-8')
        self.bash = shutil.which('bash')
        if os.name == 'nt':
            for candidate in [Path(os.environ.get('ProgramFiles', 'C:/Program Files')) / 'Git/bin/bash.exe',
                              Path('C:/Program Files/Git/usr/bin/bash.exe')]:
                if candidate.exists():
                    self.bash = str(candidate)
                    break
        self.assertTrue(self.bash, 'CI must provide bash')
        self.seed()
        (self.root / 'drift.py').write_text(
            "from pathlib import Path\nimport sys\nsys.path.insert(0, 'lib')\n"
            "from feature_store import load_document, commit_document\n"
            "p = Path('feature_list.json')\nd = load_document(p)\n"
            "d['features'][0]['notes'] = 'auto-intake newer owner decision'\n"
            "d['features'][0]['human_gate'] = 'new gate must survive'\n"
            "commit_document(p, d, allowed={'ST-001': {'notes', 'human_gate'}})\n"
            "Path('after-owner-write.json').write_bytes(p.read_bytes())\n",
            encoding='utf-8', newline='\n')

    def seed(self):
        self.write(
            fixture.feature(issue=1, phase='P0-process', notes='auto-intake synthetic',
                            description='original scope', acceptance=['A', 'B', 'C'],
                            issue_snapshot_at='2026-01-01T00:00:00Z', issue_snapshot_comments=1),
            fixture.feature('ST-002', issue=2, phase='P0-process',
                            issue_snapshot_at='2026-01-01T00:00:00Z', issue_snapshot_comments=0),
            fixture.feature('ST-003', phase='P0-process', dependencies=['ST-001']),
        )
        states = [dict(number=1, state='OPEN', updatedAt='2026-01-02T00:00:00Z', comments=2, labels=[]),
                  dict(number=2, state='OPEN', updatedAt='2026-01-01T00:00:00Z', comments=0, labels=[])]
        (self.root / 'states.jsonl').write_text(
            ''.join(json.dumps(row) + '\n' for row in states), encoding='utf-8')

    def invoke(self, script):
        return fixture.WiringTests.invoke(self, script)

    def command(self, payload, stage='apply', suffix='', reconcile=True):
        (self.root / 'model.log').write_text(
            '<<<INTAKE\n' + json.dumps(payload) + '\nINTAKE>>>\n', encoding='utf-8')
        drift = 'python3 drift.py;' if stage == 'apply' else ':'
        script = r'''set -euo pipefail
ROOT="$PWD"
source lib/intake.sh
gh() { :; }
intake_init_dirs
intake_budget_take() { return 0; }
intake_fetch_issue_states() { printf '%s' "$PWD/states.jsonl"; }
intake_triage() {
  printf 'called\n' >> model-calls.log
  INTAKE_LAST_LOG="$PWD/model.log"
''' + drift + '\n}\n'
        if stage == 'snapshot':
            script += r'''original_touch="$(declare -f intake_touch_feature)"
eval "${original_touch/intake_touch_feature/intake_original_touch}"
intake_touch_feature() {
  python3 drift.py
  intake_original_touch "$@"
}
'''
        script += suffix + '\n'
        script += ('intake_reconcile_issues\n' if reconcile else
                   'intake_amend 1 ST-001 2026-01-02T00:00:00Z 2\n')
        script += r'''echo CONTINUED_AFTER_INTAKE
printf 'SKIP=%s\n' "${FEATURE_SKIP:-}"
export STARTRIPS_LANE=backend
bash run-loop.sh --carrier-lane=backend --carrier-token=synthetic-intake-probe --next
'''
        return script

    def assert_preserved(self):
        self.assertEqual((self.root / 'after-owner-write.json').read_bytes(), self.path.read_bytes())
        rows = fixture.store.load_document(self.path)['features']
        self.assertEqual('new gate must survive', rows[0]['human_gate'])
        self.assertEqual('2026-01-01T00:00:00Z', rows[0]['issue_snapshot_at'])
        self.assertTrue(all(row['status'] == 'pending' and row['attempts'] == 0 for row in rows))
        self.assertFalse((self.root / 'claude-progress.md').exists())
        self.assertEqual({}, json.loads((self.root / '.agent-artifacts/intake/skipped.json').read_text()))

    def test_amend_unchanged_and_moot_drift_preserve_one_and_continue_real_selector(self):
        payloads = [dict(amend=dict(rationale='old model', human_gate=None)),
                    dict(unchanged=True, reason='old unchanged'),
                    dict(skip=True, reason='old moot')]
        for payload in payloads:
            with self.subTest(payload=payload):
                self.seed()
                result = self.invoke(self.command(payload))
                self.assertEqual(0, result.returncode, result.stdout + result.stderr)
                self.assertIn('INTAKE_AMEND_DEFERRED', result.stderr)
                self.assertIn('amend-deferred stage=apply', result.stdout)
                self.assertIn('CONTINUED_AFTER_INTAKE', result.stdout)
                self.assertIn('SKIP=ST-001', result.stdout)
                self.assertEqual('ST-002', result.stdout.strip().splitlines()[-1])
                self.assert_preserved()

    def test_snapshot_touch_race_also_defers_without_moot_or_unchanged_claim(self):
        for payload in [dict(unchanged=True), dict(skip=True, reason='old moot')]:
            with self.subTest(payload=payload):
                self.seed()
                result = self.invoke(self.command(payload, stage='snapshot'))
                self.assertEqual(0, result.returncode, result.stdout + result.stderr)
                self.assertIn('amend-deferred stage=snapshot', result.stdout)
                self.assertNotIn('decision=moot', result.stdout)
                self.assertNotIn('decision=unchanged', result.stdout)
                self.assert_preserved()

    def test_repeated_amend_in_same_invocation_does_not_replay_model_or_duplicate_skip(self):
        script = self.command(dict(unchanged=True))
        script += 'intake_amend 1 ST-001 2026-01-02T00:00:00Z 2\nprintf "SKIP=%s\\n" "$FEATURE_SKIP"\n'
        result = self.invoke(script)
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        self.assertEqual(['called'], (self.root / 'model-calls.log').read_text().splitlines())
        self.assertEqual('SKIP=ST-001', result.stdout.strip().splitlines()[-1])
        self.assert_preserved()

    def test_fresh_invocation_reads_new_snapshot_and_can_amend_without_clearing_gate(self):
        result = self.invoke(self.command(dict(unchanged=True)))
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        payload = dict(amend=dict(rationale='fresh model', description='fresh bounded scope'))
        result = self.invoke(self.command(payload, stage='none'))
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        row = fixture.store.load_document(self.path)['features'][0]
        self.assertEqual('fresh bounded scope', row['description'])
        self.assertEqual('new gate must survive', row['human_gate'])
        self.assertEqual('2026-01-02T00:00:00Z', row['issue_snapshot_at'])
        self.assertIn('SKIP=\n', result.stdout)

    def test_missing_identity_still_stops_the_loop(self):
        suffix = "intake_dump_feature() { printf '%s\\tinvalid\\n' \"$PWD/feature_list.json\"; }"
        result = self.invoke(self.command(dict(unchanged=True), stage='none', suffix=suffix))
        self.assertEqual(6, result.returncode, result.stdout + result.stderr)
        self.assertIn('snapshot identity unavailable', result.stderr)
        self.assertNotIn('CONTINUED_AFTER_INTAKE', result.stdout)
        self.assertNotIn('amend-deferred', result.stdout)

    def test_unreadable_one_still_stops_the_loop(self):
        script = self.command(dict(unchanged=True), stage='none')
        script = script.replace('  INTAKE_LAST_LOG="$PWD/model.log"',
                                '  INTAKE_LAST_LOG="$PWD/model.log"\n  printf "{" > feature_list.json')
        result = self.invoke(script)
        self.assertEqual(6, result.returncode, result.stdout + result.stderr)
        self.assertNotIn('CONTINUED_AFTER_INTAKE', result.stdout)
        self.assertNotIn('amend-deferred', result.stdout)

    def test_storage_failure_is_not_converted_to_a_skip(self):
        suffix = 'intake_touch_feature() { echo synthetic-write-failure >&2; return 1; }'
        result = self.invoke(self.command(dict(unchanged=True), stage='none', suffix=suffix))
        self.assertEqual(6, result.returncode, result.stdout + result.stderr)
        self.assertIn('synthetic-write-failure', result.stderr)
        self.assertNotIn('CONTINUED_AFTER_INTAKE', result.stdout)
        self.assertNotIn('amend-deferred', result.stdout)

    def test_model_provider_failure_is_not_converted_to_a_skip(self):
        suffix = 'intake_triage() { return 6; }'
        result = self.invoke(self.command(dict(unchanged=True), stage='none', suffix=suffix))
        self.assertEqual(6, result.returncode, result.stdout + result.stderr)
        self.assertNotIn('CONTINUED_AFTER_INTAKE', result.stdout)

    def test_result_path_cannot_consume_another_invocations_old_verdict(self):
        artifacts = self.root / '.agent-artifacts/intake'
        artifacts.mkdir(parents=True)
        old_result = artifacts / 'amend-ST-001.json'
        old_result.write_text(json.dumps(dict(decision='moot', reason='peer verdict')), encoding='utf-8')
        result = self.invoke(self.command(dict(unchanged=True), stage='none'))
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        self.assertNotIn('peer verdict', result.stdout)
        self.assertTrue(list(artifacts.glob('amend-ST-001-*.json')))
        self.assertEqual('moot', json.loads(old_result.read_text())['decision'])
        row = fixture.store.load_document(self.path)['features'][0]
        self.assertEqual('auto-intake synthetic', row['notes'])


if __name__ == '__main__':
    unittest.main()

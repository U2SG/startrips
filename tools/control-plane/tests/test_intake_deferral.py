"""Item-local stale intake handling; synthetic fixtures run in GitHub CI only."""
import contextlib
import io
import json
import unittest
from unittest import mock

import test_control_plane as fixture
import intake_guard


class DeferralBoundaryCases(fixture.SyntheticOne):
    def test_missing_model_identity_is_not_a_stale_observation(self):
        row = fixture.feature()
        with self.assertRaises(fixture.store.StoreConflict) as raised:
            with intake_guard.defer_stale_amend():
                intake_guard.require_amend_snapshot(row, None, '', '')
        self.assertNotIsInstance(raised.exception, fixture.store.StaleObservation)

    def test_malformed_snapshot_is_not_a_stale_observation(self):
        row = fixture.feature(issue_snapshot_at='unreadable')
        with self.assertRaises(fixture.store.StoreConflict) as raised:
            with intake_guard.defer_stale_amend():
                intake_guard.require_amend_snapshot(
                    row, fixture.state.row_token(row), '2026-01-02T00:00:00Z', '2')
        self.assertNotIsInstance(raised.exception, fixture.store.StaleObservation)

    def test_storage_and_permission_failures_are_never_deferred(self):
        for error in [PermissionError('replace denied'),
                      fixture.store.StoreConflict('ONE writer busy/unavailable'),
                      fixture.store.StoreConflict('ONE unreadable'),
                      ValueError('invalid result')]:
            with self.subTest(error=str(error)):
                with self.assertRaises(type(error)):
                    with intake_guard.defer_stale_amend():
                        raise error

    def test_non_model_bookkeeping_keeps_the_original_failure(self):
        with self.assertRaises(fixture.store.StaleObservation):
            with intake_guard.defer_stale_amend(enabled=False):
                raise fixture.store.StaleObservation('changed')

    def test_same_row_commit_race_is_deferred_without_overwrite(self):
        observed = fixture.store.load_document(self.path)
        observed['features'][0]['notes'] = 'old model'
        current = fixture.store.load_document(self.path)
        current['features'][0]['human_gate'] = 'new user decision'
        fixture.store.commit_document(self.path, current, allowed={'ST-001': {'human_gate'}})
        before = self.path.read_bytes()
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as raised:
            with intake_guard.defer_stale_amend():
                fixture.store.commit_document(self.path, observed, allowed={'ST-001': {'notes'}})
        self.assertEqual(intake_guard.INTAKE_DEFERRED_EXIT, raised.exception.code)
        self.assertEqual(before, self.path.read_bytes())

    def test_changed_amend_read_set_is_deferred_without_overwrite(self):
        observed = fixture.store.load_document(self.path)
        observed['features'][0]['notes'] = 'old model'
        current = fixture.store.load_document(self.path)
        current['features'][1]['notes'] = 'concurrent owner progress'
        fixture.store.commit_document(self.path, current, allowed={'ST-002': {'notes'}})
        before = self.path.read_bytes()
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as raised:
            with intake_guard.defer_stale_amend():
                fixture.store.commit_document(self.path, observed, allowed={'ST-001': {'notes'}},
                                              expected_rows={'ST-001', 'ST-002'})
        self.assertEqual(intake_guard.INTAKE_DEFERRED_EXIT, raised.exception.code)
        self.assertEqual(before, self.path.read_bytes())

    def test_unobserved_read_set_member_is_still_a_hard_error(self):
        observed = fixture.store.load_document(self.path)
        before = self.path.read_bytes()
        with self.assertRaises(fixture.store.StoreConflict) as raised:
            with intake_guard.defer_stale_amend():
                fixture.store.commit_document(self.path, observed, allowed={},
                                              expected_rows={'ST-999'})
        self.assertNotIsInstance(raised.exception, fixture.store.StaleObservation)
        self.assertEqual(before, self.path.read_bytes())

    def test_actual_amend_commit_race_uses_the_deferral_boundary(self):
        # Execute the real embedded Python in-process with only the storage race
        # injected. No model, GitHub call, or real workspace is involved.
        row = fixture.feature(issue=1, notes='auto-intake synthetic', description='old',
                              acceptance=['A', 'B', 'C'], issue_snapshot_at='2026-01-01T00:00:00Z',
                              issue_snapshot_comments=1)
        self.write(row)
        token = fixture.state.row_token(row)
        log = self.root / 'model.log'
        log.write_text('<<<INTAKE\n' + json.dumps({'amend': {
            'rationale': 'old model', 'description': 'obsolete'}}) + '\nINTAKE>>>', encoding='utf-8')
        result = self.root / 'result.json'
        source = (fixture.ROOT / 'lib/intake.sh').read_text(encoding='utf-8')
        body = source.split('intake_apply_amend() {', 1)[1].split("<<'PY'\n", 1)[1].split('\nPY\n', 1)[0]
        real_commit = fixture.store.commit_document
        def intervene(path, document, **kwargs):
            current = fixture.store.load_document(path)
            current['features'][0]['human_gate'] = 'new user decision'
            real_commit(path, current, allowed={'ST-001': {'human_gate'}})
            return real_commit(path, document, **kwargs)
        argv = ['-', str(self.path), str(log), '1', 'ST-001', str(result), '0', str(fixture.ROOT / 'lib')]
        environment = {'INTAKE_EXPECTED_ROW': token, 'INTAKE_ISSUE_UPDATED_AT': '2026-01-02T00:00:00Z',
                       'INTAKE_ISSUE_COMMENTS': '2'}
        with mock.patch('sys.argv', argv), mock.patch.dict('os.environ', environment), \
             mock.patch.object(fixture.store, 'commit_document', side_effect=intervene), \
             contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as raised:
            exec(compile(body, 'intake_apply_amend', 'exec'), {})
        self.assertEqual(intake_guard.INTAKE_DEFERRED_EXIT, raised.exception.code)
        current = fixture.store.load_document(self.path)['features'][0]
        self.assertEqual(dict(row, human_gate='new user decision'), current)
        self.assertFalse(result.exists(), 'A rejected commit cannot emit an applied result')


class ActualIntakeDeferralCases(fixture.WiringTests):
    def run_amend(self, payload, *, after_result=False, hard_failure=False, corrupt_one=False):
        row = fixture.feature(issue=1, phase='P0-process', notes='auto-intake synthetic',
                              description='original', acceptance=['A', 'B', 'C'],
                              issue_snapshot_at='2026-01-01T00:00:00Z', issue_snapshot_comments=1)
        sibling = fixture.feature('ST-002', phase='P0-process', status='in_progress')
        self.write(row, sibling)
        (self.root / 'model.log').write_text(
            '<<<INTAKE\n' + json.dumps(payload) + '\nINTAKE>>>', encoding='utf-8')
        (self.root / 'intervene.py').write_text(
            "from pathlib import Path\nimport sys\nsys.path.insert(0, 'lib')\n"
            "from feature_store import load_document, commit_document\n"
            "p=Path('feature_list.json'); d=load_document(p)\n"
            "d['features'][0]['human_gate']='new user decision'\n"
            "commit_document(p,d,allowed={'ST-001':{'human_gate'}})\n"
            "Path('expected-live.json').write_bytes(p.read_bytes())\n",
            encoding='utf-8', newline='\n')
        script = """set -euo pipefail
ROOT="$PWD"
source lib/intake.sh
mkdir -p "$INTAKE_DIR"
# A receipt left by an earlier attempt must not be consumed after deferral.
printf '%s' '{"decision":"amend","reason":"obsolete receipt"}' > "$INTAKE_DIR/amend-ST-001.json"
intake_budget_take() { return 0; }
intake_comment_issue() { echo unexpected-comment >> side-effects.log; }
intake_owner_attention() { echo unexpected-attention >> side-effects.log; }
intake_triage() {
  echo called >> model-calls.log
  INTAKE_LAST_LOG="$ROOT/model.log"
"""
        if corrupt_one:
            script += "  printf broken > feature_list.json\n"
        elif not after_result and not hard_failure:
            script += '  python3 "$ROOT/intervene.py"\n'
        script += '}\n'
        if after_result:
            # The last result-field read falls between apply and touch. The
            # real touch helper must still reject this newly obsolete token.
            script += """eval "$(declare -f intake_field | sed '1s/intake_field/intake_original_field/')"
intake_field() {
  if [[ "$2" == "changed" ]]; then python3 "$ROOT/intervene.py"; fi
  intake_original_field "$@"
}
"""
        if hard_failure:
            script += 'intake_apply_amend() { return 1; }\n'
        script += """intake_amend 1 ST-001 2026-01-02T00:00:00Z 2
echo SELECTOR_CONTINUED
export STARTRIPS_LANE=backend
bash run-loop.sh --next
"""
        result = self.invoke(script)
        self.assertEqual(['called'], (self.root / 'model-calls.log').read_text().splitlines())
        self.assertFalse((self.root / 'side-effects.log').exists())
        self.assertFalse((self.root / 'AGENT_STOP').exists())
        self.assertFalse((self.root / 'SUPERVISOR_STOP').exists())
        if hard_failure or corrupt_one:
            self.assertEqual(6, result.returncode, result.stdout + result.stderr)
            self.assertNotIn('SELECTOR_CONTINUED', result.stdout)
            self.assertIn('amend-transaction-failed', result.stdout)
            return
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        self.assertIn('INTAKE_DEFERRED:', result.stderr)
        self.assertIn('decision=deferred', result.stdout)
        self.assertIn('SELECTOR_CONTINUED', result.stdout)
        self.assertEqual('ST-002', result.stdout.strip().splitlines()[-1])
        self.assertEqual((self.root / 'expected-live.json').read_bytes(), self.path.read_bytes())
        current = fixture.store.load_document(self.path)['features']
        self.assertEqual(dict(row, human_gate='new user decision'), current[0])
        self.assertEqual(sibling, current[1])

    def test_stale_unchanged_result_continues_to_existing_backend_owner(self):
        self.run_amend({'unchanged': True, 'reason': 'label only'})

    def test_stale_amend_cannot_clear_a_new_gate(self):
        self.run_amend({'amend': {'rationale': 'old model', 'human_gate': None}})

    def test_stale_moot_result_cannot_emit_owner_attention(self):
        self.run_amend({'skip': True, 'reason': 'obsolete'})

    def test_unchanged_bookkeeping_race_is_also_item_local(self):
        self.run_amend({'unchanged': True, 'reason': 'label only'}, after_result=True)

    def test_moot_bookkeeping_race_does_not_emit_owner_attention(self):
        self.run_amend({'skip': True, 'reason': 'obsolete'}, after_result=True)

    def test_unknown_apply_failure_still_stops_with_platform_status(self):
        self.run_amend({'unchanged': True}, hard_failure=True)

    def test_unreadable_one_still_stops_with_platform_status(self):
        self.run_amend({'unchanged': True}, corrupt_one=True)

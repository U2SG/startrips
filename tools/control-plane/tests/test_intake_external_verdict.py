"""External Codexless intake verdict transport; no nested model process."""
import json
import os
import shutil
import subprocess
from pathlib import Path

import test_control_plane as fixture


class ExternalVerdictCases(fixture.SyntheticOne):
    def setUp(self):
        super().setUp()
        shutil.copytree(fixture.ROOT / 'lib', self.root / 'lib',
                        ignore=shutil.ignore_patterns('__pycache__'))
        self.bash = shutil.which('bash')
        if os.name == 'nt':
            git = shutil.which('git')
            candidates = []
            if git:
                git_root = Path(git).resolve().parent.parent
                candidates.extend([git_root / 'bin/bash.exe', git_root / 'usr/bin/bash.exe'])
            candidates.extend([
                Path(os.environ.get('ProgramFiles', 'C:/Program Files')) / 'Git/bin/bash.exe',
                Path('C:/Program Files/Git/usr/bin/bash.exe'),
            ])
            for candidate in candidates:
                if candidate.exists():
                    self.bash = str(candidate)
                    break
        self.assertTrue(self.bash)
        self.write(
            fixture.feature('ST-001', phase='P0-process', priority=1,
                            title='Process anchor', description='anchor', issue=1),
            fixture.feature('ST-002', phase='P1-globe', priority=2,
                            title='Other', description='other', issue=2),
        )

    def invoke(self, script):
        env = dict(os.environ, PYTHONIOENCODING='utf-8', PYTHONUTF8='1',
                   PYTHONDONTWRITEBYTECODE='1')
        return subprocess.run([self.bash, '-c', script], cwd=self.root, env=env,
                              capture_output=True, text=True, encoding='utf-8', timeout=20)

    def verdict(self, issue=433, mode='new', feature=None):
        payload = {
            'phase': 'P0-process',
            'title': 'Codexless intake transport',
            'description': 'Legacy intake spawned Claude; the real gap is external verdict ingestion.',
            'dependencies': [],
            'acceptance': [
                'intake consumes an issue-bound envelope',
                'no nested model process is started',
                'ONE append remains guarded by feature_store',
            ],
            'verification_commands': ['./init.sh smoke', './init.sh ci <feature-id> <PR>'],
            'evidence_required': ['control-plane CI'],
            'human_gate': None,
            'placement': {
                'anchor': 'ST-001',
                'position': 'after',
                'rationale': 'process work belongs after the process anchor',
            },
        }
        envelope = {'issue': issue, 'mode': mode, 'verdict': payload}
        if feature is not None:
            envelope['feature'] = feature
        return envelope

    def script(self, extra=''):
        return """set -euo pipefail
ROOT="$PWD"
source lib/intake.sh
gh() { :; }
intake_issue_state() { printf '{"updatedAt":"2026-09-29T00:00:00Z","comments":0}\n'; }
""" + extra

    def test_missing_verdict_defers_without_state_change_or_skip(self):
        before = self.path.read_bytes()
        result = self.invoke(self.script() + '\nintake_issue 433\n')
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        self.assertIn('external-verdict-required', result.stdout)
        self.assertEqual(before, self.path.read_bytes())
        self.assertEqual({}, json.loads(
            (self.root / '.agent-artifacts/intake/skipped.json').read_text()))

    def test_issue_bound_verdict_applies_through_existing_safe_store(self):
        verdict = self.root / 'verdict.json'
        verdict.write_text(json.dumps(self.verdict()), encoding='utf-8')
        extra = f'INTAKE_VERDICT_FILE="{verdict.as_posix()}"; export INTAKE_VERDICT_FILE\n'
        result = self.invoke(self.script(extra) + '\nintake_issue 433\n')
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        rows = fixture.store.load_document(self.path)['features']
        self.assertEqual(3, len(rows))
        self.assertEqual(433, rows[-1]['issue'])
        self.assertEqual('Codexless intake transport', rows[-1]['title'])
        self.assertTrue(rows[-1]['notes'].startswith('auto-intake '))

    def test_cross_issue_verdict_fails_closed_without_skip_or_write(self):
        before = self.path.read_bytes()
        verdict = self.root / 'wrong.json'
        verdict.write_text(json.dumps(self.verdict(issue=76)), encoding='utf-8')
        extra = f'INTAKE_VERDICT_FILE="{verdict.as_posix()}"; export INTAKE_VERDICT_FILE\n'
        result = self.invoke(self.script(extra) + '\nintake_issue 433\n')
        self.assertEqual(6, result.returncode, result.stdout + result.stderr)
        self.assertIn('invalid external verdict', result.stderr)
        self.assertEqual(before, self.path.read_bytes())
        self.assertEqual({}, json.loads(
            (self.root / '.agent-artifacts/intake/skipped.json').read_text()))

    def test_mode_and_feature_binding_prevent_replay(self):
        verdict_dir = self.root / 'verdicts'
        verdict_dir.mkdir()
        verdict = verdict_dir / 'issue-433-amend-ST-001.json'
        verdict.write_text(
            json.dumps(self.verdict(issue=433, mode='followup', feature='ST-001')),
            encoding='utf-8')
        extra = f'INTAKE_VERDICT_DIR="{verdict_dir.as_posix()}"; export INTAKE_VERDICT_DIR\n'
        result = self.invoke(
            self.script(extra) + '\nintake_triage 433 "ignored" "amend-ST-001"\n')
        self.assertEqual(6, result.returncode, result.stdout + result.stderr)
        self.assertIn('invalid external verdict', result.stderr)


class StaticNoNestedModelCases(fixture.SyntheticOne):
    def test_intake_has_no_nested_model_launch(self):
        source = (fixture.ROOT / 'lib/intake.sh').read_text(encoding='utf-8')
        self.assertNotIn('claude_run', source)
        self.assertNotIn('--model sonnet', source)
        self.assertNotIn('claude.exe', source)
        self.assertIn('external-verdict-required', source)
        self.assertIn('verdict envelope issue mismatch', source)

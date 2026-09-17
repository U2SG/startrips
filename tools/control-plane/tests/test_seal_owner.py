"""Real git / local synthetic remote tests for interrupted seal recovery, CI only."""
import os
import subprocess
from pathlib import Path
from unittest import mock
import test_control_plane as fixture
import seal_owner as seal


class SealRecoveryCases(fixture.SyntheticOne):
    def setUp(self):
        super().setUp()
        self.repo = self.root / 'startrips'; self.repo.mkdir()
        self.remote = self.root / 'synthetic-remote.git'
        self.command('git', 'init', '--bare', str(self.remote))
        self.git('init', '-b', 'main'); self.git('config', 'user.name', 'Synthetic CI')
        self.git('config', 'user.email', 'ci@example.invalid')
        (self.repo / 'code.txt').write_text('source')
        self.git('add', '.'); self.git('commit', '-m', 'Create synthetic source')
        self.source = self.git('rev-parse', 'HEAD')
        self.git('checkout', '-b', 'feat/issue1-synthetic')
        self.git('remote', 'add', 'origin', str(self.remote))
        self.git('push', 'origin', 'main', 'feat/issue1-synthetic')
        self.git('fetch', 'origin')
        self.write(fixture.feature(status='in_progress', phase='P0-process', title='Synthetic delivery',
                                   description='A synthetic test-only delivery.',
                                   pr_links=['https://github.com/synthetic/project/pull/1']))
        self.environ = mock.patch.dict(os.environ, {'STARTRIPS_ROLE': 'local-backend'})
        self.environ.start(); self.addCleanup(self.environ.stop)
        self.idle = mock.patch.object(seal, 'ensure_idle', return_value={'old_execution': 'ended'})
        self.idle.start(); self.addCleanup(self.idle.stop)
        self.validator = mock.patch.object(seal, 'validate_node')
        self.validator.start(); self.addCleanup(self.validator.stop)
        self.api_patch = mock.patch.object(seal, 'api', side_effect=self.api)
        self.api_patch.start(); self.addCleanup(self.api_patch.stop)
        self.plan_patch = mock.patch.object(seal, 'plan', side_effect=self.plan)
        self.plan_patch.start(); self.addCleanup(self.plan_patch.stop)

    def command(self, *args):
        result = subprocess.run(list(args), capture_output=True, text=True, encoding='utf-8', timeout=15)
        self.assertEqual(0, result.returncode, result.stderr); return result.stdout.strip()

    def git(self, *args):
        return self.command('git', '-C', str(self.repo), *args)

    def remote_head(self):
        return self.command('git', '--git-dir', str(self.remote), 'rev-parse', 'refs/heads/feat/issue1-synthetic')

    def api(self, endpoint):
        return {'state': 'open', 'merged': False, 'head': {'sha': self.remote_head(), 'ref': 'feat/issue1-synthetic'}}

    def plan(self, *args, **kwargs):
        if self.remote_head() != self.source:
            return {'action': 'WAIT_FINAL_CI'}
        return {'action': 'SEAL', 'source_sha': self.source, 'final_sha': self.source,
                'pr': 1, 'ci_run': 99, 'ci_attempt': 1}

    def invoke(self):
        return seal.seal(self.root, self.repo, 'ST-001', 'synthetic/project')

    def test_normal_seal_creates_exactly_one_ledger_commit(self):
        result = self.invoke()
        self.assertEqual('WAIT_FINAL_CI', result['action'])
        self.assertEqual(self.source, result['source_sha'])
        self.assertEqual(result['final_sha'], self.remote_head())
        self.assertEqual('2', self.git('rev-list', '--count', 'HEAD'))
        self.assertTrue(seal.candidate_is_final(self.repo, self.source, 'docs/pr-history/1.md'))
        self.assertEqual('', self.git('status', '--porcelain'))

    def test_already_pushed_final_never_duplicates_commit(self):
        first = self.invoke(); second = self.invoke()
        self.assertFalse(second['changed']); self.assertEqual('WAIT_FINAL_CI', second['action'])
        self.assertEqual(first['final_sha'], self.git('rev-parse', 'HEAD'))
        self.assertEqual('2', self.git('rev-list', '--count', 'HEAD'))

    def test_interrupted_commit_resumes_checkpoint_not_product_code(self):
        actual = seal.git
        def fail_commit(worktree, *args):
            if args[0] == 'commit': raise seal.EvidenceUnknown('synthetic interruption before commit')
            return actual(worktree, *args)
        with mock.patch.object(seal, 'git', side_effect=fail_commit):
            with self.assertRaises(seal.EvidenceUnknown): self.invoke()
        self.assertEqual(self.source, self.git('rev-parse', 'HEAD'))
        pending = (self.repo / 'docs/pr-history/1.md').read_bytes()
        result = self.invoke()
        self.assertEqual(pending, (self.repo / 'docs/pr-history/1.md').read_bytes())
        self.assertEqual(result['final_sha'], self.remote_head())
        self.assertEqual('2', self.git('rev-list', '--count', 'HEAD'))

    def test_interrupted_push_reuses_existing_final_commit(self):
        actual = seal.git
        def fail_push(worktree, *args):
            if args[0] == 'push': raise seal.EvidenceUnknown('synthetic disconnected push')
            return actual(worktree, *args)
        with mock.patch.object(seal, 'git', side_effect=fail_push):
            with self.assertRaises(seal.EvidenceUnknown): self.invoke()
        existing = self.git('rev-parse', 'HEAD')
        self.assertNotEqual(existing, self.source); self.assertEqual(self.source, self.remote_head())
        result = self.invoke()
        self.assertEqual(existing, result['final_sha']); self.assertEqual(existing, self.remote_head())
        self.assertEqual('2', self.git('rev-list', '--count', 'HEAD'))

    def test_push_accepted_but_response_lost_is_not_resealed(self):
        actual = seal.git
        def uncertain_push(worktree, *args):
            result = actual(worktree, *args)
            if args[0] == 'push': raise seal.EvidenceUnknown('response lost after accepted push')
            return result
        with mock.patch.object(seal, 'git', side_effect=uncertain_push):
            with self.assertRaises(seal.EvidenceUnknown): self.invoke()
        final = self.remote_head(); self.assertNotEqual(final, self.source)
        self.assertFalse(self.invoke()['changed']); self.assertEqual(final, self.git('rev-parse', 'HEAD'))
        self.assertEqual('2', self.git('rev-list', '--count', 'HEAD'))

    def test_unrelated_dirty_work_is_never_committed(self):
        (self.repo / 'code.txt').write_text('owner uncommitted changes')
        with self.assertRaises(fixture.store.StoreConflict): self.invoke()
        self.assertEqual(self.source, self.git('rev-parse', 'HEAD'))
        self.assertEqual('owner uncommitted changes', (self.repo / 'code.txt').read_text())
        self.assertEqual(self.source, self.remote_head())

    def test_existing_other_ledger_is_not_overwritten(self):
        path = self.repo / 'docs/pr-history/1.md'; path.parent.mkdir(parents=True); path.write_text('different owner ledger')
        with self.assertRaises(fixture.store.StoreConflict): self.invoke()
        self.assertEqual('different owner ledger', path.read_text()); self.assertEqual(self.source, self.remote_head())

    def test_stop_before_seal_prevents_any_product_write(self):
        (self.root / 'AGENT_STOP').write_text('human stop')
        with self.assertRaises(fixture.store.StoreConflict): self.invoke()
        self.assertEqual('', self.git('status', '--porcelain')); self.assertEqual(self.source, self.remote_head())
        self.assertEqual('human stop', (self.root / 'AGENT_STOP').read_text())

    def test_stop_after_commit_preserves_final_without_push(self):
        actual = seal.git
        def stop_after_commit(worktree, *args):
            result = actual(worktree, *args)
            if args[0] == 'commit': (self.root / 'SUPERVISOR_STOP').write_text('human stop')
            return result
        with mock.patch.object(seal, 'git', side_effect=stop_after_commit):
            with self.assertRaises(fixture.store.StoreConflict): self.invoke()
        self.assertNotEqual(self.source, self.git('rev-parse', 'HEAD')); self.assertEqual(self.source, self.remote_head())
        self.assertEqual('human stop', (self.root / 'SUPERVISOR_STOP').read_text())

    def test_read_only_maintainer_cannot_seal_owner_branch(self):
        with mock.patch.dict(os.environ, {'STARTRIPS_ROLE': 'hourly-review'}):
            with self.assertRaises(fixture.store.StoreConflict): self.invoke()
        self.assertEqual('', self.git('status', '--porcelain'))

    def test_source_review_wait_does_not_create_ledger(self):
        with mock.patch.object(seal, 'plan', return_value={'action': 'WAIT_SOURCE_REVIEW'}):
            self.assertFalse(self.invoke()['changed'])
        self.assertFalse((self.repo / 'docs/pr-history/1.md').exists())

    def test_unpublished_product_commit_is_not_mistaken_for_final(self):
        (self.repo / 'code.txt').write_text('new source')
        self.git('add', '.'); self.git('commit', '-m', 'Change synthetic source')
        head = self.git('rev-parse', 'HEAD')
        with self.assertRaises(fixture.store.StoreConflict): self.invoke()
        self.assertEqual(head, self.git('rev-parse', 'HEAD')); self.assertEqual(self.source, self.remote_head())

    def test_checkpoint_tampering_fails_closed(self):
        actual = seal.git
        def fail_commit(worktree, *args):
            if args[0] == 'commit': raise seal.EvidenceUnknown('interruption')
            return actual(worktree, *args)
        with mock.patch.object(seal, 'git', side_effect=fail_commit):
            with self.assertRaises(seal.EvidenceUnknown): self.invoke()
        checkpoint = next((self.root / '.agent-artifacts/evaluations').glob('*-seal-intent.json'))
        import json
        data = json.loads(checkpoint.read_bytes()); data['body'] += 'unapproved change'
        checkpoint.write_text(json.dumps(data), encoding='utf-8')
        with self.assertRaises(fixture.store.StoreConflict): self.invoke()
        self.assertEqual(self.source, self.remote_head())


    def test_code_fix_after_prior_seal_gets_one_new_valid_final(self):
        self.invoke()
        (self.repo / 'code.txt').write_text('review fix after seal')
        self.git('add', 'code.txt'); self.git('commit', '-m', 'Repair reviewed synthetic source')
        self.source = self.git('rev-parse', 'HEAD'); self.git('push', 'origin', 'feat/issue1-synthetic')
        result = self.invoke()
        self.assertEqual(self.source, result['source_sha'])
        self.assertTrue(seal.candidate_is_final(self.repo, self.source, 'docs/pr-history/1.md'))
        self.assertEqual('4', self.git('rev-list', '--count', 'HEAD'))

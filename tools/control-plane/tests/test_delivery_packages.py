"""Synthetic coherent-delivery-package regressions. GitHub CI only."""
from __future__ import annotations
import copy
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'lib'))
import delivery
import delivery_package as packages
import delivery_runtime as runtime
import feature_state as state
import feature_store as store
from github_evidence import EvidenceUnknown

A, B = 'a' * 40, 'b' * 40
REPO = 'synthetic/project'


def row(fid, issue, *, status='pending', lane='experience', priority=None,
        dependencies=None, human_gate=None, pr_links=None, acceptance=None):
    return {
        'id': fid, 'issue': issue, 'phase': 'P1-globe', 'priority': priority or int(fid[3:]),
        'target': 'startrips', 'title': 'Feature ' + fid, 'description': 'scope ' + fid,
        'lane': lane, 'dependencies': list(dependencies or []),
        'acceptance': list(acceptance or ['criterion one', 'criterion two', 'criterion three']),
        'verification_commands': ['./init.sh smoke', './init.sh ci <feature-id> <PR>'],
        'evidence_required': ['CI'], 'human_gate': human_gate, 'status': status,
        'passes': status == 'passed', 'attempts': 0, 'evidence': [],
        'pr_links': list(pr_links or []), 'notes': 'synthetic',
        'issue_snapshot_at': '2026-09-23T00:00:00Z', 'issue_snapshot_comments': 0,
    }


def document(*rows):
    return {'rules': {'one_feature_per_builder_loop': True,
                      'terminal_statuses': ['passed','blocked','cancelled_by_product_decision']},
            'features': list(rows)}


def package_rows(*, status='pending', pr=False):
    lead = row('ST-001', 101, status=status, priority=1,
               pr_links=['https://github.com/' + REPO + '/pull/7'] if pr else [])
    member = row('ST-002', 102, status=status, priority=2, dependencies=['ST-001'],
                 pr_links=['https://github.com/' + REPO + '/pull/7'] if pr else [])
    for item in (lead, member):
        item['delivery_issue_observation'] = {'issue': item['issue'], 'body_sha256': 'b', 'comments': {}}
        item['delivery_decisions'] = {'body_sha256': 'b', 'comments': {}}
    member['delivery_lead'] = 'ST-001'
    lead['delivery_package'] = {'schema_version': 1, 'revision': 1, 'lane': 'experience',
                                'members': ['ST-001','ST-002'], 'contracts': {}}
    lead['delivery_package']['contracts'] = {
        item['id']: delivery.contract_revision(item) for item in (lead, member)
    }
    if status == 'ready_to_merge':
        for item in (lead, member): item['passes'] = True
    return lead, member


def issue_observations(*rows):
    return {item['id']: copy.deepcopy(item['delivery_issue_observation']) for item in rows}


def write_activation_receipt(root):
    files = {}
    for name in runtime.REQUIRED:
        body = (root / name).read_bytes()
        files[name] = hashlib.sha256(body).hexdigest()
    path = root / runtime.RECEIPT
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({'schema_version': runtime.VERSION, 'source_sha': A,
                                'files': files, 'ci': {'head_sha': A, 'conclusion': 'success'},
                                'boundary_verified': True}), encoding='utf-8')


def write_review_receipt(root, contract, *, source=A, pr=7):
    coverage = {
        member['id']: {
            'verdict': 'PASS',
            'contract_sha256': member['contract_sha256'],
            'acceptance_evidence': {
                str(index + 1): ['exact Source review evidence']
                for index in range(len(member['acceptance']))
            },
        }
        for member in contract['members']
    }
    path = Path(root) / '.agent-artifacts' / 'evaluations' / ('ST-001-' + source + '-source-review.json')
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({
        'feature': 'ST-001', 'pr': pr, 'source_sha': source,
        'reviewer_role': 'hourly-review', 'completed_at': '2026-09-23T00:00:00Z',
        'verdict': 'CLEAR', 'findings': [], 'reviewed_paths': ['src/example.ts'],
        'evidence': ['review'], 'delivery_package': contract, 'member_coverage': coverage,
    }), encoding='utf-8')
    return path


class DeliveryContractTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.path = self.root / 'feature_list.json'
        self.path.write_text(json.dumps(document(row('ST-001',101), row('ST-002',102)), indent=2)+'\n', encoding='utf-8')

    def tearDown(self): self.temp.cleanup()

    def test_legacy_single_issue_is_unchanged(self):
        doc = store.load_document(self.path)
        self.assertEqual(['ST-001'], delivery.members(doc, 'ST-001'))
        self.assertIsNone(delivery.package_snapshot(doc, 'ST-001'))
        self.assertEqual('ST-001', delivery.canonical_lead(doc, 'ST-001'))

    def test_register_is_atomic_traceable_and_idempotent(self):
        observed = {
            'ST-001': {'issue':101,'body_sha256':'x','comments':{}},
            'ST-002': {'issue':102,'body_sha256':'y','comments':{}},
        }
        with mock.patch.object(packages, 'verify_runtime'), \
             mock.patch.object(packages, '_ownership_conflicts', return_value=[]), \
             mock.patch.object(packages, 'live_issues', return_value=observed):
            packages.register(self.path,'ST-001',['ST-002'],'experience',self.root,self.root,REPO)
            again = packages.register(self.path,'ST-001',['ST-002'],'experience',self.root,self.root,REPO)
        doc = store.load_document(self.path)
        self.assertEqual(['ST-001','ST-002'], delivery.members(doc,'ST-001'))
        self.assertEqual('ST-001', delivery.canonical_lead(doc,'ST-002'))
        self.assertEqual('experience', doc['features'][0]['delivery_package']['lane'])
        self.assertTrue(again['idempotent'])

    def test_atomic_replace_permission_error_preserves_live_one_and_recovery_copy(self):
        before = self.path.read_bytes()
        doc = store.load_document(self.path)
        doc['features'][0]['notes'] = 'candidate'
        with mock.patch.object(store.os, 'replace', side_effect=PermissionError('reader blocks replace')):
            with self.assertRaisesRegex(store.StoreConflict, 'Atomic replace blocked'):
                store.commit_document(self.path, doc, allowed={'ST-001': {'notes'}})
        self.assertEqual(before, self.path.read_bytes())
        recovery = list(self.root.glob('.feature_list.json.*.tmp'))
        self.assertEqual(1, len(recovery))
        recovered = json.loads(recovery[0].read_text(encoding='utf-8'))
        self.assertEqual('candidate', recovered['features'][0]['notes'])

    def test_atomic_replace_failure_never_clobbers_concurrent_live_update(self):
        doc = store.load_document(self.path)
        doc['features'][0]['notes'] = 'candidate'
        current = json.loads(self.path.read_text(encoding='utf-8'))
        current['features'][1]['notes'] = 'concurrent-newer'
        newer = (json.dumps(current, indent=2) + '\n').encode('utf-8')

        def block_after_live_change(_source, _target):
            self.path.write_bytes(newer)
            raise PermissionError('reader blocks replace')

        with mock.patch.object(store.os, 'replace', side_effect=block_after_live_change):
            with self.assertRaisesRegex(store.StoreConflict, 'live ONE changed concurrently'):
                store.commit_document(self.path, doc, allowed={'ST-001': {'notes'}})
        self.assertEqual(newer, self.path.read_bytes())
        recovery = list(self.root.glob('.feature_list.json.*.tmp'))
        self.assertEqual(1, len(recovery))
        recovered = json.loads(recovery[0].read_text(encoding='utf-8'))
        self.assertEqual('candidate', recovered['features'][0]['notes'])

    def test_registration_requires_verified_runtime(self):
        with mock.patch.object(packages, 'verify_runtime', side_effect=store.StoreConflict('DELIVERY_RUNTIME_NOT_INSTALLED')):
            with self.assertRaises(store.StoreConflict):
                packages.register(self.path,'ST-001',['ST-002'],'experience',self.root,self.root,REPO)
        self.assertFalse(any(delivery.grouped(r) for r in store.load_document(self.path)['features']))

    def test_owned_or_open_pr_member_rejected(self):
        observed = {'ST-001': {'issue':101,'body_sha256':'x','comments':{}},
                    'ST-002': {'issue':102,'body_sha256':'y','comments':{}}}
        for conflict in ['open-pr:#9', 'worktree:dirty-owner']:
            with self.subTest(conflict=conflict), \
                 mock.patch.object(packages,'verify_runtime'), \
                 mock.patch.object(packages,'_ownership_conflicts', return_value=[conflict]), \
                 mock.patch.object(packages,'live_issues', return_value=observed):
                with self.assertRaises(store.StoreConflict):
                    packages.register(self.path,'ST-001',['ST-002'],'experience',self.root,self.root,REPO)
        doc=store.load_document(self.path); doc['features'][1]['status']='in_progress'
        store.commit_document(self.path,doc,allowed={'ST-002':{'status'}})
        with mock.patch.object(packages,'verify_runtime'), mock.patch.object(packages,'_ownership_conflicts',return_value=[]):
            with self.assertRaises(store.StoreConflict):
                packages.register(self.path,'ST-001',['ST-002'],'experience',self.root,self.root,REPO)

    def test_open_pr_issue_link_rejects_member_without_branch_token(self):
        unit=[row('ST-001',101),row('ST-002',102)]
        worktrees=mock.Mock(returncode=0,stdout='worktree C:/repo/main\nHEAD abc\nbranch refs/heads/main\n\n')
        cases=[
            {'number':9,'headRefName':'feature/arbitrary','body':'Fixes #102','closingIssuesReferences':[]},
            {'number':10,'headRefName':'feature/unrelated','body':'no inline issue token',
             'closingIssuesReferences':[{'number':102}]},
        ]
        for item in cases:
            with self.subTest(pr=item['number']):
                prs=mock.Mock(returncode=0,stdout=json.dumps([item]))
                with mock.patch.object(packages.subprocess,'run',side_effect=[worktrees,prs]):
                    self.assertEqual(['open-pr:#'+str(item['number'])],
                                     packages._ownership_conflicts(self.root,REPO,unit))

    def test_duplicate_member_and_missing_member_fail_closed(self):
        lead, member = package_rows()
        other = row('ST-003',103)
        other['delivery_package']={'schema_version':1,'revision':1,'lane':'experience',
                                   'members':['ST-003','ST-002'],'contracts':{}}
        other['delivery_package']['contracts']={'ST-003':delivery.contract_revision(other),
                                                'ST-002':delivery.contract_revision(member)}
        path=self.root/'bad.json';path.write_text(json.dumps(document(lead,member,other)),encoding='utf-8')
        with self.assertRaises(store.StoreConflict): delivery.members(store.load_document(path),'ST-001')
        lead2, member2=package_rows();lead2['delivery_package']['members'].append('ST-999')
        path.write_text(json.dumps(document(lead2,member2)),encoding='utf-8')
        with self.assertRaises(store.StoreConflict): delivery.members(store.load_document(path),'ST-001')

    def test_internal_dependency_stays_internal_external_dependency_blocks(self):
        lead, member=package_rows();doc=document(lead,member)
        self.assertEqual([],delivery.external_dependencies(doc,'ST-001'))
        self.assertEqual(['ST-001','ST-002'],delivery.implementation_order(doc,'ST-001'))
        ext=row('ST-003',103,status='pending');member['dependencies']=['ST-001','ST-003']
        lead['delivery_package']['contracts']={x['id']:delivery.contract_revision(x) for x in (lead,member)}
        doc=document(lead,member,ext)
        self.assertTrue(any(b.get('dependency')=='ST-003' for b in delivery.blockers(doc,'ST-001')))

    def test_dependency_cycle_rejected_without_erasing_edges(self):
        lead, member=package_rows();lead['dependencies']=['ST-002']
        lead['delivery_package']['contracts']={x['id']:delivery.contract_revision(x) for x in (lead,member)}
        with self.assertRaises(store.StoreConflict): delivery.dependency_read_set(document(lead,member),'ST-001')

    def test_package_lifecycle_cannot_be_half_written_or_stale(self):
        lead, member=package_rows();self.path.write_text(json.dumps(document(lead,member),indent=2)+'\n',encoding='utf-8')
        stale=store.load_document(self.path);concurrent=store.load_document(self.path)
        concurrent['features'][1]['notes']='newer'
        store.commit_document(self.path,concurrent,allowed={'ST-002':{'notes'}})
        for r in stale['features']: r['status']='in_progress';r['delivery_owner']={'lead':'ST-001'}
        with self.assertRaises(store.StoreConflict):
            store.commit_document(self.path,stale,
                allowed={r['id']:{'status','delivery_owner'} for r in stale['features']},
                expected_rows={'ST-001','ST-002'}, delivery_operation='claim')
        fresh=store.load_document(self.path);fresh['features'][0]['status']='in_progress'
        with self.assertRaises(store.StoreConflict):
            store.commit_document(self.path,fresh,allowed={'ST-001':{'status'}},delivery_operation='unit')

    def test_scope_revision_changes_review_contract(self):
        lead,member=package_rows();before=delivery.snapshot(document(lead,member),'ST-001')
        member['acceptance'][0]='changed criterion';lead['delivery_package']['revision']=2
        lead['delivery_package']['contracts']={x['id']:delivery.contract_revision(x) for x in (lead,member)}
        after=delivery.snapshot(document(lead,member),'ST-001')
        self.assertNotEqual(before['contract_sha256'],after['contract_sha256'])
        old_coverage={m['id']:{'verdict':'PASS','contract_sha256':m['contract_sha256'],
                              'acceptance_evidence':{str(i+1):['e'] for i in range(len(m['acceptance']))}}
                      for m in before['members']}
        with self.assertRaises(store.StoreConflict): delivery.validate_coverage(after,old_coverage)

    def test_review_coverage_and_ledger_cover_every_member(self):
        lead,member=package_rows();contract=delivery.snapshot(document(lead,member),'ST-001')
        coverage={m['id']:{'verdict':'PASS','contract_sha256':m['contract_sha256'],
                           'acceptance_evidence':{str(i+1):['CI'] for i in range(len(m['acceptance']))}}
                  for m in contract['members']}
        self.assertEqual(coverage,delivery.validate_coverage(contract,coverage))
        lines=delivery.package_ledger_lines(contract)
        self.assertTrue(any('ST-001' in line and 'ST-002' in line for line in lines))
        self.assertTrue(any(contract['contract_sha256'] in line for line in lines))

    def test_missing_red_or_pending_main_ci_keeps_every_member_unpassed(self):
        for reason in ['missing', 'red', 'pending']:
            with self.subTest(reason=reason):
                lead,member=package_rows(status='ready_to_merge',pr=True)
                self.path.write_text(json.dumps(document(lead,member),indent=2)+'\n',encoding='utf-8')
                contract=delivery.snapshot(document(lead,member),'ST-001')
                write_review_receipt(self.root, contract)
                observed=issue_observations(lead,member)
                before=self.path.read_bytes()
                with mock.patch.object(state,'api',return_value={'merged':True}), \
                     mock.patch.object(state,'live_issues',return_value=observed), \
                     mock.patch.object(state,'source_relation',return_value={'source_sha':A}), \
                     mock.patch.object(state,'merge_proof',side_effect=EvidenceUnknown(reason)):
                    self.assertEqual(6,state.reconcile(self.path,REPO,'main'))
                self.assertEqual(before,self.path.read_bytes())

    def test_merged_package_without_current_member_review_stays_unpassed(self):
        lead,member=package_rows(status='ready_to_merge',pr=True)
        self.path.write_text(json.dumps(document(lead,member),indent=2)+'\n',encoding='utf-8')
        observed=issue_observations(lead,member)
        before=self.path.read_bytes()
        with mock.patch.object(state,'api',return_value={'merged':True}), \
             mock.patch.object(state,'live_issues',return_value=observed), \
             mock.patch.object(state,'source_relation',return_value={'source_sha':A}), \
             mock.patch.object(state,'merge_proof',return_value={'merge_sha':A,'main_sha':B,'main_ci':77,'main_ci_attempt':1}), \
             mock.patch.object(state,'_verify_package_ledger'):
            self.assertEqual(6,state.reconcile(self.path,REPO,'main'))
        self.assertEqual(before,self.path.read_bytes())

    def test_post_review_issue_drift_blocks_terminal_reconcile(self):
        lead,member=package_rows(status='ready_to_merge',pr=True)
        self.path.write_text(json.dumps(document(lead,member),indent=2)+'\n',encoding='utf-8')
        contract=delivery.snapshot(document(lead,member),'ST-001')
        write_review_receipt(self.root, contract)
        drift=issue_observations(lead,member)
        drift['ST-002']['comments']={'77':'post-review-decision'}
        before=self.path.read_bytes()
        with mock.patch.object(state,'api',return_value={'merged':True}), \
             mock.patch.object(state,'live_issues',return_value=drift):
            self.assertEqual(6,state.reconcile(self.path,REPO,'main'))
        self.assertEqual(before,self.path.read_bytes())

    def test_issue_drift_during_terminal_proof_blocks_package_completion(self):
        lead,member=package_rows(status='ready_to_merge',pr=True)
        self.path.write_text(json.dumps(document(lead,member),indent=2)+'\n',encoding='utf-8')
        contract=delivery.snapshot(document(lead,member),'ST-001')
        write_review_receipt(self.root, contract)
        observed=issue_observations(lead,member)
        drift=copy.deepcopy(observed)
        drift['ST-001']['comments']={'88':'decision-arrived-during-proof'}
        proof={'merge_sha':A,'main_sha':B,'main_ci':77,'main_ci_attempt':1}
        before=self.path.read_bytes()
        with mock.patch.object(state,'api',return_value={'merged':True}), \
             mock.patch.object(state,'live_issues',side_effect=[observed,drift]), \
             mock.patch.object(state,'source_relation',return_value={'source_sha':A}), \
             mock.patch.object(state,'merge_proof',return_value=proof), \
             mock.patch.object(state,'_verify_package_ledger'):
            self.assertEqual(6,state.reconcile(self.path,REPO,'main'))
        self.assertEqual(before,self.path.read_bytes())

    def test_one_lifecycle_drift_during_terminal_proof_is_not_overwritten(self):
        lead,member=package_rows(status='ready_to_merge',pr=True)
        self.path.write_text(json.dumps(document(lead,member),indent=2)+'\n',encoding='utf-8')
        contract=delivery.snapshot(document(lead,member),'ST-001')
        write_review_receipt(self.root, contract)
        observed=issue_observations(lead,member)
        proof={'merge_sha':A,'main_sha':B,'main_ci':77,'main_ci_attempt':1}

        def concurrent_lifecycle_change(*_args):
            newer=store.load_document(self.path)
            changed=delivery.unit_rows(newer,'ST-001')
            for item in changed:
                item.update(status='needs_work',passes=False)
            store.commit_document(self.path,newer,
                allowed={item['id']:{'status','passes'} for item in changed},
                expected_rows={item['id'] for item in changed}, delivery_operation='unit')

        with mock.patch.object(state,'api',return_value={'merged':True}), \
             mock.patch.object(state,'live_issues',return_value=observed), \
             mock.patch.object(state,'source_relation',return_value={'source_sha':A}), \
             mock.patch.object(state,'merge_proof',return_value=proof), \
             mock.patch.object(state,'_verify_package_ledger',side_effect=concurrent_lifecycle_change):
            self.assertEqual(6,state.reconcile(self.path,REPO,'main'))
        doc=store.load_document(self.path)
        self.assertEqual({'needs_work'},{item['status'] for item in doc['features']})
        self.assertEqual({False},{item['passes'] for item in doc['features']})

    def test_exact_green_merge_passes_every_member_with_same_completion(self):
        lead,member=package_rows(status='ready_to_merge',pr=True)
        self.path.write_text(json.dumps(document(lead,member),indent=2)+'\n',encoding='utf-8')
        contract=delivery.snapshot(document(lead,member),'ST-001')
        write_review_receipt(self.root, contract)
        observed=issue_observations(lead,member)
        proof={'merge_sha':A,'main_sha':B,'main_ci':77,'main_ci_attempt':1}
        with mock.patch.object(state,'api',return_value={'merged':True}), \
             mock.patch.object(state,'live_issues',return_value=observed), \
             mock.patch.object(state,'source_relation',return_value={'source_sha':A}), \
             mock.patch.object(state,'merge_proof',return_value=proof), \
             mock.patch.object(state,'_verify_package_ledger'):
            self.assertEqual(0,state.reconcile(self.path,REPO,'main'))
        doc=store.load_document(self.path);values={json.dumps(r['delivery_completion'],sort_keys=True) for r in doc['features']}
        self.assertEqual({'passed'},{r['status'] for r in doc['features']})
        self.assertEqual({True},{r['passes'] for r in doc['features']})
        self.assertEqual(1,len(values))


class RuntimeActivationPlanTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name)
        self.repo = self.base / 'repo'
        self.root = self.base / 'installed'
        (self.repo / 'tools/control-plane').mkdir(parents=True)
        self.root.mkdir()
        subprocess.run(['git', 'init'], cwd=self.repo, check=True, capture_output=True)
        subprocess.run(['git', 'config', 'user.email', 'ci@example.test'], cwd=self.repo, check=True)
        subprocess.run(['git', 'config', 'user.name', 'CI'], cwd=self.repo, check=True)

    def tearDown(self):
        self.temp.cleanup()

    def commit(self, body):
        path = self.repo / 'tools/control-plane/consumer.txt'
        path.write_text(body, encoding='utf-8')
        subprocess.run(['git', 'add', 'tools/control-plane/consumer.txt'], cwd=self.repo, check=True)
        subprocess.run(['git', 'commit', '-m', 'consumer'], cwd=self.repo, check=True, capture_output=True)
        return subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=self.repo, check=True,
                              capture_output=True, text=True).stdout.strip()

    def plan(self, base):
        with mock.patch.object(runtime, 'REQUIRED', ('consumer.txt',)):
            return runtime.activation_plan(self.root, self.repo, base)

    def test_activation_manifest_cannot_overwrite_unmodified_runtime_consumers(self):
        expected = {
            'CLAUDE.md', 'README.md', 'run-loop.sh',
            'lib/delivery.py', 'lib/delivery_issues.py', 'lib/delivery_package.py',
            'lib/delivery_runtime.py', 'lib/feature_store.py', 'lib/feature_state.py',
            'lib/runtime_preflight.py', 'lib/action_plan.py', 'lib/policy_audit.py',
            'lib/seal_owner.py', 'lib/evidence_capture.py', 'lib/intake.sh',
            '.claude/agents/startrips-evaluator.md', '.claude/agents/startrips-triage.md',
        }
        self.assertEqual(expected, set(runtime.REQUIRED))
        self.assertTrue({
            'init.sh', 'launch-experience.sh', 'launch-supervisor.sh',
            'loop-supervisor.sh', 'lib/external_execution.py', 'lib/execution.py',
            'lib/intake_guard.py',
        }.isdisjoint(runtime.REQUIRED))

    def test_stale_committed_runtime_is_safe_predecessor(self):
        stale = self.commit('one\nlegacy\nthree\n')
        base = self.commit('one\nbase\nthree\n')
        self.commit('one\nbase\nthree-package\n')
        (self.root / 'consumer.txt').write_text('one\nlegacy\nthree\n', encoding='utf-8')
        plan = self.plan(base)
        self.assertEqual([], plan['conflicts'])
        self.assertEqual('stale-committed-predecessor', plan['compatibility']['consumer.txt'])
        self.assertNotEqual(stale, base)

    def test_live_hot_change_already_in_source_is_safe(self):
        base = self.commit('one\nmiddle\nthree\n')
        self.commit('one-hot\nmiddle\nthree-package\n')
        (self.root / 'consumer.txt').write_text('one-hot\nmiddle\nthree\n', encoding='utf-8')
        plan = self.plan(base)
        self.assertEqual([], plan['conflicts'])
        self.assertEqual('live-hot-change-subsumed-by-source', plan['compatibility']['consumer.txt'])

    def test_exact_reviewed_hot_predecessor_pair_is_safe(self):
        base = self.commit('one\nmiddle\nthree\n')
        self.commit('one-source\nmiddle\nthree-package\n')
        incoming = (self.repo / 'tools/control-plane/consumer.txt').read_bytes()
        current = b'one-live\nmiddle\nthree\n'
        (self.root / 'consumer.txt').write_bytes(current)
        reviewed = {'consumer.txt': {
            runtime.sha(runtime._normalize(current)): runtime.sha(runtime._normalize(incoming))
        }}
        with mock.patch.object(runtime, 'REVIEWED_HOT_PREDECESSORS', reviewed):
            plan = self.plan(base)
        self.assertEqual([], plan['conflicts'])
        self.assertEqual('reviewed-hot-predecessor', plan['compatibility']['consumer.txt'])

    def test_deployed_action_plan_predecessor_is_frozen_to_current_package_source(self):
        predecessor = '93f6dbc6e6cfbff2cf1687aaab6a30348ff8feb9a75387430695f0858f39cf73'
        incoming = runtime.sha(runtime._normalize((ROOT / 'lib/action_plan.py').read_bytes()))
        self.assertEqual(
            incoming,
            runtime.REVIEWED_HOT_PREDECESSORS['lib/action_plan.py'][predecessor],
        )

    def test_reviewed_hot_predecessor_does_not_authorize_source_or_live_drift(self):
        base = self.commit('one\nmiddle\nthree\n')
        self.commit('one-source\nmiddle\nthree-package\n')
        incoming = (self.repo / 'tools/control-plane/consumer.txt').read_bytes()
        current = b'one-live\nmiddle\nthree\n'
        reviewed = {'consumer.txt': {
            runtime.sha(runtime._normalize(current)): runtime.sha(runtime._normalize(incoming))
        }}
        with mock.patch.object(runtime, 'REVIEWED_HOT_PREDECESSORS', reviewed):
            (self.root / 'consumer.txt').write_bytes(b'one-new-live\nmiddle\nthree\n')
            live_drift = self.plan(base)
            self.assertEqual(['consumer.txt'], live_drift['conflicts'])
            (self.root / 'consumer.txt').write_bytes(current)
            self.commit('one-new-source\nmiddle\nthree-package\n')
            source_drift = self.plan(base)
            self.assertEqual(['consumer.txt'], source_drift['conflicts'])

    def test_unreconciled_live_hot_change_stays_conflict(self):
        base = self.commit('one\nmiddle\nthree\n')
        self.commit('one-source\nmiddle\nthree-package\n')
        (self.root / 'consumer.txt').write_text('one-live\nmiddle\nthree\n', encoding='utf-8')
        plan = self.plan(base)
        self.assertEqual(['consumer.txt'], plan['conflicts'])


class RuntimeActivationFailureTests(unittest.TestCase):
    """Synthetic install/rollback failures; never inspect the host's processes."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        # Match activate()'s canonical root, including Windows TEMP short-name
        # aliases/junctions, so injected failures bind the actual installed file.
        self.root = (Path(self.temp.name) / 'installed').resolve()
        self.root.mkdir()
        self.repository = Path(self.temp.name) / 'source'
        self.names = ('consumer-a.txt', 'consumer-b.txt', 'new-consumer.txt')
        self.originals = {'consumer-a.txt': b'old-a\n', 'consumer-b.txt': b'old-b\n',
                          'new-consumer.txt': None}
        self.incoming = {name: ('new-' + name + '\n').encode() for name in self.names}
        for name, body in self.originals.items():
            if body is not None:
                (self.root / name).write_bytes(body)
        self.one = self.root / 'feature_list.json'
        self.one.write_text(json.dumps(document(row('ST-001', 101))), encoding='utf-8')
        self.one_before = self.one.read_bytes()
        self.receipt = self.root / runtime.RECEIPT
        self.receipt.parent.mkdir(parents=True, exist_ok=True)
        self.plan = {'source_sha': A, 'conflicts': [],
                     'files': {name: runtime.sha(body) for name, body in self.incoming.items()},
                     'expected': {name: runtime.sha(body) if body is not None else None
                                  for name, body in self.originals.items()}}
        patches = [
            mock.patch.object(runtime, 'REQUIRED', self.names),
            mock.patch.object(runtime, 'activation_plan', return_value=self.plan),
            mock.patch.object(runtime, 'require_source_ci',
                              return_value={'head_sha': A, 'conclusion': 'success'}),
            mock.patch.object(runtime, 'git', side_effect=lambda repo, cmd, ref:
                              self.incoming[ref.split(':tools/control-plane/', 1)[1]]),
            mock.patch('execution.ensure_idle', return_value={}),
            mock.patch('external_execution.occupancy', return_value={'occupied_slots': 0}),
        ]
        for patcher in patches:
            patcher.start(); self.addCleanup(patcher.stop)

    def activate(self):
        return runtime.activate(self.root, self.repository, B, self.plan['expected'], REPO)

    def assert_predecessors(self):
        for name, body in self.originals.items():
            path = self.root / name
            self.assertEqual(body, path.read_bytes() if path.exists() else None, name)
        self.assertEqual(self.one_before, self.one.read_bytes())

    def assert_stopped_with_recovery(self):
        stop = (self.root / 'AGENT_STOP').read_bytes()
        self.assertTrue(stop.startswith(b'delivery-activation:'))
        directories = list((self.root / '.agent-artifacts/evaluations').glob('delivery-activation-*'))
        self.assertEqual(1, len(directories))
        recovery = directories[0]
        manifest = json.loads((recovery / 'recovery.json').read_bytes())
        self.assertEqual(stop.decode(), manifest['owned_stop'])
        for name, body in self.originals.items():
            self.assertEqual(runtime.sha(body) if body is not None else None,
                             manifest['predecessors'][name])
            if body is not None:
                self.assertEqual(body, (recovery / 'predecessors' / name).read_bytes())
        self.assertEqual(self.one_before, self.one.read_bytes())
        return recovery

    def test_success_releases_owned_stop_only_after_exact_runtime_verified(self):
        result = self.activate()
        self.assertEqual(result, runtime.verify(self.root))
        self.assertFalse((self.root / 'AGENT_STOP').exists())
        self.assertEqual(self.one_before, self.one.read_bytes())

    def test_preflight_failure_releases_only_owned_stop_without_installing(self):
        with mock.patch('execution.ensure_idle', side_effect=EvidenceUnknown('owner active')):
            with self.assertRaisesRegex(EvidenceUnknown, 'owner active'):
                self.activate()
        self.assert_predecessors()
        self.assertFalse((self.root / 'AGENT_STOP').exists())
        self.assertFalse(self.receipt.exists())

    def test_existing_human_stop_is_preserved(self):
        stop = self.root / 'AGENT_STOP'; stop.write_bytes(b'human stop\n')
        with self.assertRaisesRegex(store.StoreConflict, 'Existing owner STOP'):
            self.activate()
        self.assertEqual(b'human stop\n', stop.read_bytes())
        self.assert_predecessors()

    def test_verify_failure_restores_runtime_and_exact_previous_receipt_or_absence(self):
        for previous in (None, b'{"previous":"receipt"}\n'):
            with self.subTest(previous=previous):
                if previous is None:
                    self.receipt.unlink(missing_ok=True)
                else:
                    self.receipt.write_bytes(previous)
                with mock.patch.object(runtime, 'verify', side_effect=store.StoreConflict('verify failed')):
                    with self.assertRaisesRegex(store.StoreConflict, 'verify failed'):
                        self.activate()
                self.assert_predecessors()
                self.assertEqual(previous, self.receipt.read_bytes() if self.receipt.exists() else None)
                self.assertFalse((self.root / 'AGENT_STOP').exists())

    def test_install_and_restore_failure_keeps_stop_and_durable_predecessors(self):
        replace = runtime._replace

        def fail_install_and_restore(path, body):
            if path == self.root / 'consumer-b.txt' and body == self.incoming['consumer-b.txt']:
                self.assertEqual(self.incoming['consumer-a.txt'],
                                 (self.root / 'consumer-a.txt').read_bytes())
                raise OSError('second install failed')
            if path == self.root / 'consumer-a.txt' and body == self.originals['consumer-a.txt']:
                raise PermissionError('predecessor restore locked')
            return replace(path, body)

        with mock.patch.object(runtime, '_replace', side_effect=fail_install_and_restore):
            with self.assertRaisesRegex(store.StoreConflict, 'rollback incomplete; owned STOP retained'):
                self.activate()
        recovery = self.assert_stopped_with_recovery()
        self.assertIn('restore locked', (recovery / 'rollback-errors.json').read_text(encoding='utf-8'))
        self.assertFalse(self.receipt.exists())
        with self.assertRaises(store.StoreConflict):
            runtime.verify(self.root)

    def test_write_that_replaces_then_raises_is_also_rolled_back(self):
        replace = runtime._replace

        def replace_then_fail(path, body):
            replace(path, body)
            if path == self.root / 'consumer-b.txt' and body == self.incoming['consumer-b.txt']:
                raise OSError('post-replace failure')

        with mock.patch.object(runtime, '_replace', side_effect=replace_then_fail):
            with self.assertRaisesRegex(OSError, 'post-replace failure'):
                self.activate()
        self.assert_predecessors()
        self.assertFalse((self.root / 'AGENT_STOP').exists())

    def test_silent_restore_mismatch_keeps_stop(self):
        replace = runtime._replace

        def silently_skip_restore(path, body):
            if path == self.root / 'consumer-b.txt' and body == self.incoming['consumer-b.txt']:
                raise OSError('install failed')
            if path == self.root / 'consumer-a.txt' and body == self.originals['consumer-a.txt']:
                return  # A successful return is not proof that predecessor bytes returned.
            return replace(path, body)

        with mock.patch.object(runtime, '_replace', side_effect=silently_skip_restore):
            with self.assertRaisesRegex(store.StoreConflict, 'predecessor readback mismatch'):
                self.activate()
        self.assert_stopped_with_recovery()

    def test_receipt_restore_failure_keeps_stop_even_after_all_consumers_restored(self):
        previous = b'{"previous":"receipt"}\n'; self.receipt.write_bytes(previous)
        replace = runtime._replace

        def fail_receipt_restore(path, body):
            if path == self.receipt and body == previous:
                raise PermissionError('receipt restore locked')
            return replace(path, body)

        with mock.patch.object(runtime, '_replace', side_effect=fail_receipt_restore), \
                mock.patch.object(runtime, 'verify', side_effect=store.StoreConflict('verify failed')):
            with self.assertRaisesRegex(store.StoreConflict, 'receipt restore locked'):
                self.activate()
        self.assert_predecessors()
        recovery = self.assert_stopped_with_recovery()
        self.assertEqual(previous, (recovery / 'predecessors' / runtime.RECEIPT).read_bytes())
        with self.assertRaises(store.StoreConflict):
            runtime.verify(self.root)

    def test_human_stop_replacing_activation_tag_is_never_cleared(self):
        verify = runtime.verify

        def human_stops(root):
            (root / 'AGENT_STOP').write_bytes(b'human changed stop\n')
            return verify(root)

        with mock.patch.object(runtime, 'verify', side_effect=human_stops):
            self.activate()
        self.assertEqual(b'human changed stop\n', (self.root / 'AGENT_STOP').read_bytes())


class PackageSelectorTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)/'cp'
        shutil.copytree(ROOT,self.root,ignore=shutil.ignore_patterns('__pycache__','tests'))
        lead,member=package_rows();single=row('ST-003',103,lane='backend',priority=3)
        # Use Backend for the package so selector needs no Experience occupancy provider.
        for item in (lead,member): item['lane']='backend'
        lead['delivery_package']['lane']='backend';lead['delivery_package']['contracts']={x['id']:delivery.contract_revision(x) for x in (lead,member)}
        (self.root/'feature_list.json').write_text(json.dumps(document(lead,member,single),indent=2)+'\n',encoding='utf-8')
        write_activation_receipt(self.root)
        if os.name == 'nt':
            git_executable = shutil.which('git')
            git_bash = Path(git_executable).resolve().parents[1] / 'bin' / 'bash.exe' if git_executable else None
            self.bash = str(git_bash) if git_bash and git_bash.is_file() else (shutil.which('bash') or 'bash')
        else:
            self.bash = shutil.which('bash') or 'bash'

    def tearDown(self): self.temp.cleanup()

    def invoke(self,script):
        env=dict(os.environ,PYTHONUTF8='1',PYTHONIOENCODING='utf-8',PYTHONDONTWRITEBYTECODE='1')
        return subprocess.run([self.bash,'-c',script],cwd=self.root,env=env,capture_output=True,text=True,encoding='utf-8',timeout=20)

    def test_selector_counts_package_once_and_member_is_not_claimable(self):
        selected=self.invoke('export STARTRIPS_LANE=backend; ./run-loop.sh --next')
        self.assertEqual(0,selected.returncode,selected.stderr);self.assertEqual('ST-001',selected.stdout.strip())
        member=self.invoke('export STARTRIPS_LANE=backend FEATURE_ALLOW=ST-002; ./run-loop.sh --next')
        self.assertEqual(0,member.returncode,member.stderr);self.assertEqual('',member.stdout.strip())

    def test_missing_runtime_blocks_package_but_not_legacy_single(self):
        (self.root/runtime.RECEIPT).unlink()
        selected=self.invoke('export STARTRIPS_LANE=backend; ./run-loop.sh --next')
        self.assertEqual(0,selected.returncode,selected.stderr);self.assertEqual('ST-003',selected.stdout.strip())


if __name__ == '__main__': unittest.main(verbosity=2)

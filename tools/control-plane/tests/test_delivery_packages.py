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
                before=self.path.read_bytes()
                with mock.patch.object(state,'api',return_value={'merged':True}), \
                     mock.patch.object(state,'source_relation',return_value={'source_sha':A}), \
                     mock.patch.object(state,'merge_proof',side_effect=EvidenceUnknown(reason)):
                    self.assertEqual(6,state.reconcile(self.path,REPO,'main'))
                self.assertEqual(before,self.path.read_bytes())

    def test_merged_package_without_current_member_review_stays_unpassed(self):
        lead,member=package_rows(status='ready_to_merge',pr=True)
        self.path.write_text(json.dumps(document(lead,member),indent=2)+'\n',encoding='utf-8')
        before=self.path.read_bytes()
        with mock.patch.object(state,'api',return_value={'merged':True}), \
             mock.patch.object(state,'source_relation',return_value={'source_sha':A}), \
             mock.patch.object(state,'merge_proof',return_value={'merge_sha':A,'main_sha':B,'main_ci':77,'main_ci_attempt':1}), \
             mock.patch.object(state,'_verify_package_ledger'):
            self.assertEqual(6,state.reconcile(self.path,REPO,'main'))
        self.assertEqual(before,self.path.read_bytes())

    def test_exact_green_merge_passes_every_member_with_same_completion(self):
        lead,member=package_rows(status='ready_to_merge',pr=True)
        self.path.write_text(json.dumps(document(lead,member),indent=2)+'\n',encoding='utf-8')
        contract=delivery.snapshot(document(lead,member),'ST-001')
        write_review_receipt(self.root, contract)
        proof={'merge_sha':A,'main_sha':B,'main_ci':77,'main_ci_attempt':1}
        with mock.patch.object(state,'api',return_value={'merged':True}), \
             mock.patch.object(state,'source_relation',return_value={'source_sha':A}), \
             mock.patch.object(state,'merge_proof',return_value=proof), \
             mock.patch.object(state,'_verify_package_ledger'):
            self.assertEqual(0,state.reconcile(self.path,REPO,'main'))
        doc=store.load_document(self.path);values={json.dumps(r['delivery_completion'],sort_keys=True) for r in doc['features']}
        self.assertEqual({'passed'},{r['status'] for r in doc['features']})
        self.assertEqual({True},{r['passes'] for r in doc['features']})
        self.assertEqual(1,len(values))


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

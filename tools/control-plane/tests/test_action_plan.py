"""Evidence/action, Source review and evidence-capture regressions (CI only)."""
import copy
import json
from pathlib import Path
from unittest import mock
import unittest
import test_control_plane as fixture
import action_plan as plan
import evidence_capture as capture
import github_evidence as gh
import policy_audit


class ActionCases(unittest.TestCase):
    def setUp(self):
        self.row = fixture.feature(status='in_progress', pr_links=['https://github.com/synthetic/project/pull/1'])
        self.pr = {'state': 'open', 'merged': False, 'mergeable': True}
        self.relation = {'sealed': False, 'source_sha': fixture.A, 'final_sha': fixture.A}
        self.review = {'unresolved': 0, 'changes_requested': 0}
        self.ci = {'state': 'failure', 'source_green': True, 'final_green': False}

    def action(self, clear=False, source_verdict=None):
        verdict = source_verdict or ('CLEAR' if clear else 'MISSING')
        return plan.derive(self.row, self.pr, self.relation, self.review, self.ci, verdict)

    def test_empty_review_is_not_approval(self):
        self.assertEqual('WAIT_SOURCE_REVIEW', self.action())

    def test_exact_independent_review_and_source_ci_select_seal(self):
        self.assertEqual('SEAL', self.action(True))

    def test_final_head_different_from_source_selects_handoff(self):
        self.relation.update(sealed=True, final_sha=fixture.B)
        self.ci.update(state='success', final_green=True)
        self.assertEqual('HANDOFF_REVIEW', self.action(True))

    def test_already_handed_off_does_not_seal_again(self):
        self.row['status'] = 'ready_for_eval'; self.relation['sealed'] = True
        self.ci.update(state='success', final_green=True)
        self.assertEqual('WAIT_REVIEW', self.action(True))

    def test_pending_final_ci_is_not_implementation(self):
        self.relation['sealed'] = True; self.ci['state'] = 'pending'
        self.assertEqual('WAIT_FINAL_CI', self.action(True))

    def test_pending_source_ci_waits(self):
        self.ci['state'] = 'pending'
        self.assertEqual('WAIT_SOURCE_CI', self.action())

    def test_missing_source_ci_waits(self):
        self.ci['state'] = 'missing'
        self.assertEqual('WAIT_SOURCE_CI', self.action())

    def test_api_unknown_is_not_code_failure(self):
        self.ci['state'] = 'unknown'
        self.assertEqual('WAIT_EVIDENCE', self.action())

    def test_product_failure_requires_repair(self):
        self.ci['source_green'] = False
        self.assertEqual('REPAIR_CI', self.action(True))

    def test_unresolved_thread_outweighs_old_clear_receipt(self):
        self.review['unresolved'] = 1
        self.assertEqual('REPAIR_REVIEW', self.action(True))

    def test_effective_changes_request_requires_repair(self):
        self.review['changes_requested'] = 1
        self.assertEqual('REPAIR_REVIEW', self.action(True))

    def test_independent_changes_requested_receipt_routes_back_to_owner(self):
        self.assertEqual(
            'REPAIR_REVIEW',
            self.action(source_verdict='CHANGES_REQUESTED'),
        )

    def test_old_base_alone_is_not_rebase(self):
        self.pr['base'] = {'sha': fixture.C}
        self.assertEqual('SEAL', self.action(True))

    def test_actual_merge_conflict_requires_owner_repair(self):
        self.pr['mergeable'] = False
        self.assertEqual('REPAIR_CONFLICT', self.action(True))

    def test_merged_pending_main_ci_does_not_reimplement(self):
        self.pr['merged'] = True
        self.assertEqual('WAIT_MAIN_CI', self.action(True))

    def test_merged_green_main_reconciles(self):
        self.pr['merged'] = True
        self.assertEqual('RECONCILE', plan.derive(self.row, self.pr, merge_clear=True))

    def test_human_gate_never_executes(self):
        self.row['human_gate'] = 'explicit product choice'
        self.assertEqual('OBSERVE', self.action(True))

    def test_terminal_never_executes(self):
        self.row['status'] = 'passed'
        self.assertEqual('OBSERVE', self.action(True))

    def test_unmapped_ready_does_not_reimplement(self):
        self.row.update(status='ready_for_eval', pr_links=[])
        self.assertEqual('OWNERSHIP_RECONCILE', self.action(True))

    def test_closed_pr_requires_owner_disposition(self):
        self.pr['state'] = 'closed'
        self.assertEqual('OWNERSHIP_RECONCILE', self.action(True))


class ReceiptCases(fixture.SyntheticOne):
    def receipt(self, **extra):
        data = {'feature': 'ST-001', 'pr': 1, 'source_sha': fixture.A, 'reviewer_role': 'hourly-review',
                'verdict': 'CLEAR', 'findings': [], 'completed_at': '2026-01-01T00:00:00Z',
                'reviewed_paths': ['src/example.ts'], 'evidence': ['independent exact-Source inspection']}
        data.update(extra)
        path = plan.receipt_path(self.root, 'ST-001', fixture.A)
        path.parent.mkdir(parents=True, exist_ok=True); path.write_text(json.dumps(data), encoding='utf-8')
        return data

    def test_missing_receipt_waits(self):
        self.assertEqual('MISSING', plan.source_review(self.root, 'ST-001', 1, fixture.A))

    def test_exact_receipt_is_clear(self):
        self.receipt(); self.assertEqual('CLEAR', plan.source_review(self.root, 'ST-001', 1, fixture.A))

    def test_new_source_invalidates_old_review(self):
        self.receipt(); self.assertEqual('MISSING', plan.source_review(self.root, 'ST-001', 1, fixture.B))

    def test_builder_cannot_claim_independent_role(self):
        self.receipt(reviewer_role='local-backend')
        with self.assertRaises(gh.EvidenceUnknown):
            plan.source_review(self.root, 'ST-001', 1, fixture.A)

    def test_findings_block_clear(self):
        self.receipt(findings=['unresolved'])
        with self.assertRaises(gh.EvidenceUnknown):
            plan.source_review(self.root, 'ST-001', 1, fixture.A)

    def test_empty_reviewed_file_set_is_not_acceptance(self):
        self.receipt(reviewed_paths=[])
        with self.assertRaises(gh.EvidenceUnknown):
            plan.source_review(self.root, 'ST-001', 1, fixture.A)

    def test_wrong_pr_receipt_rejected(self):
        self.receipt(pr=2)
        with self.assertRaises(gh.EvidenceUnknown):
            plan.source_review(self.root, 'ST-001', 1, fixture.A)

    def test_changes_requested_receipt_is_actionable(self):
        self.receipt(verdict='CHANGES_REQUESTED', findings=['repair the Source'])
        self.assertEqual(
            'CHANGES_REQUESTED',
            plan.source_review(self.root, 'ST-001', 1, fixture.A),
        )

    def test_changes_requested_receipt_requires_findings(self):
        self.receipt(verdict='CHANGES_REQUESTED', findings=[])
        with self.assertRaises(gh.EvidenceUnknown):
            plan.source_review(self.root, 'ST-001', 1, fixture.A)

    def test_owner_cannot_write_maintainer_receipt(self):
        with mock.patch.dict('os.environ', {'STARTRIPS_ROLE': 'local-backend'}):
            with self.assertRaises(fixture.store.StoreConflict):
                plan.record_source_review(self.path, 'ST-001', 'synthetic/project', self.root / 'absent.json')

    def test_handoff_is_idempotent_after_state_transition(self):
        with mock.patch.object(plan, 'plan', return_value={'action': 'WAIT_REVIEW'}):
            self.assertEqual({'changed': False, 'action': 'WAIT_REVIEW'}, plan.handoff(self.path, 'ST-001', 'synthetic/project'))

    def test_no_handoff_without_final_gate(self):
        before = self.path.read_bytes()
        with mock.patch.object(plan, 'plan', return_value={'action': 'WAIT_FINAL_CI'}):
            with self.assertRaises(fixture.store.StoreConflict): plan.handoff(self.path, 'ST-001', 'synthetic/project')
        self.assertEqual(before, self.path.read_bytes())


class EvidenceLogCases(unittest.TestCase):
    def log(self, head=fixture.A, branch='feature', kind='source', footer='EXIT=0'):
        return '\n'.join(['EVIDENCE_HEAD=' + head, 'EVIDENCE_BRANCH=' + branch, 'EVIDENCE_KIND=' + kind, footer])

    def test_source_log_survives_one_valid_ledger_final(self):
        self.assertTrue(capture.check_log(self.log(), fixture.A, fixture.B, 'feature'))

    def test_final_log_must_pin_final(self):
        with self.assertRaises(fixture.store.StoreConflict):
            capture.check_log(self.log(kind='final'), fixture.A, fixture.B, 'feature')

    def test_old_source_log_rejected(self):
        with self.assertRaises(fixture.store.StoreConflict):
            capture.check_log(self.log(head=fixture.C), fixture.A, fixture.B, 'feature')

    def test_wrong_branch_rejected(self):
        with self.assertRaises(fixture.store.StoreConflict):
            capture.check_log(self.log(branch='main'), fixture.A, fixture.B, 'feature')

    def test_inflight_log_rejected(self):
        with self.assertRaises(fixture.store.StoreConflict):
            capture.check_log(self.log(footer='still running'), fixture.A, fixture.B, 'feature')

    def test_earlier_exit_line_cannot_hide_truncation(self):
        with self.assertRaises(fixture.store.StoreConflict):
            capture.check_log(self.log() + '\nnew output after footer', fixture.A, fixture.B, 'feature')

    def test_failed_log_is_not_evidence(self):
        with self.assertRaises(fixture.store.StoreConflict):
            capture.check_log(self.log(footer='EXIT=1'), fixture.A, fixture.B, 'feature')

    def test_duplicate_identity_field_rejected(self):
        with self.assertRaises(fixture.store.StoreConflict):
            capture.check_log('EVIDENCE_HEAD=' + fixture.A + '\n' + self.log(), fixture.A, fixture.B, 'feature')


class DriftCases(unittest.TestCase):
    def test_active_protocol_audit_is_clean(self):
        self.assertEqual([], policy_audit.audit(fixture.ROOT))

    def test_prompt_sha_snapshot_detected(self):
        self.assertTrue(policy_audit.audit_prompts({'worker': 'Read CLAUDE.md then Source ' + fixture.A}))

    def test_role_entrypoint_without_snapshot_is_valid(self):
        self.assertEqual([], policy_audit.audit_prompts({'worker': 'Read CLAUDE.md; keep the existing role and derive current actions.'}))

    def test_fixed_pr_in_recurring_prompt_detected(self):
        self.assertTrue(policy_audit.audit_prompts({'worker': 'Read CLAUDE.md then only PR #123'}))


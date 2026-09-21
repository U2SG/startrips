"""Synthetic regressions for the external execution receipt. Run only in GitHub CI."""
from __future__ import annotations
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'lib'))
import external_execution as external


class ReceiptGenerationBindingTests(unittest.TestCase):
    """A receipt update carries the generation it belongs to, or it is refused.

    The scheduler reads status and provider identity off the receipt to decide
    which logical owner to reuse, block or replace, so a write that does not
    name its generation can point it at the wrong one.
    """

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def owner_args(self):
        worktree = self.root / 'owner'
        worktree.mkdir(exist_ok=True)
        (worktree / '.git').write_text('gitdir: synthetic', encoding='utf-8')
        return SimpleNamespace(root=str(self.root), feature='ST-001', worktree=str(worktree),
                               action='IMPLEMENT', row_token='row-token-1')

    def second_generation(self):
        """Drive generation 1 terminal and prepare generation 2 over it."""
        args = self.owner_args()
        with mock.patch.object(external, 'branch_of', return_value='feat/issue1-st001'):
            first = external.prepare(args)
            external.record(SimpleNamespace(
                root=str(self.root), feature='ST-001', status='idle',
                request_id=first['request_id'], agent_ref='agent-1',
                task_ref='task-1', turn_id='turn-1'))
            second = external.prepare(args)
        self.assertNotEqual(first['request_id'], second['request_id'])
        return first, second

    def test_delayed_previous_generation_update_cannot_overwrite_the_current_receipt(self):
        first, second = self.second_generation()
        before = external.load_receipt(self.root, 'ST-001')
        with self.assertRaises(external.ReceiptError):
            external.record(SimpleNamespace(
                root=str(self.root), feature='ST-001', status='running',
                request_id=first['request_id'], agent_ref='agent-stale',
                task_ref='task-stale', turn_id='turn-stale'))
        current = external.load_receipt(self.root, 'ST-001')
        self.assertEqual(before, current)
        self.assertEqual(second['request_id'], current['request_id'])
        self.assertEqual('prepared', current['status'])
        self.assertIsNone(current['agent_ref'])

    def test_update_without_a_request_id_is_refused_and_changes_nothing(self):
        _, second = self.second_generation()
        before = external.load_receipt(self.root, 'ST-001')
        with self.assertRaises(external.ReceiptError):
            external.record(SimpleNamespace(
                root=str(self.root), feature='ST-001', status='running',
                request_id=None, agent_ref='agent-unbound',
                task_ref=None, turn_id=None))
        current = external.load_receipt(self.root, 'ST-001')
        self.assertEqual(before, current)
        self.assertEqual(second['request_id'], current['request_id'])
        self.assertIsNone(current['agent_ref'])

    def test_the_current_generation_still_records_normally(self):
        _, second = self.second_generation()
        current = external.record(SimpleNamespace(
            root=str(self.root), feature='ST-001', status='running',
            request_id=second['request_id'], agent_ref='agent-2',
            task_ref='task-2', turn_id='turn-2'))
        self.assertEqual('running', current['status'])
        self.assertEqual('agent-2', current['agent_ref'])

    def test_external_occupancy_holds_slot_from_prepare_until_idle(self):
        args = self.owner_args()
        with mock.patch.object(external, 'branch_of', return_value='feat/issue1-st001'):
            receipt = external.prepare(args)
        report = external.occupancy(SimpleNamespace(root=str(self.root)))
        self.assertEqual((1, 1, ['ST-001']),
                         (report['occupied_slots'], report['available_slots'], report['features']))

        external.record(SimpleNamespace(
            root=str(self.root), feature='ST-001', status='running',
            request_id=receipt['request_id'], agent_ref='agent-1',
            task_ref='task-1', turn_id='turn-1'))
        self.assertEqual(1, external.occupancy(SimpleNamespace(root=str(self.root)))['occupied_slots'])

        external.record(SimpleNamespace(
            root=str(self.root), feature='ST-001', status='idle',
            request_id=receipt['request_id'], agent_ref='agent-1',
            task_ref='task-1', turn_id='turn-1'))
        self.assertEqual(0, external.occupancy(SimpleNamespace(root=str(self.root)))['occupied_slots'])

    def test_external_occupancy_fails_closed_when_running_receipt_lacks_agent(self):
        args = self.owner_args()
        with mock.patch.object(external, 'branch_of', return_value='feat/issue1-st001'):
            receipt = external.prepare(args)
        receipt['status'] = 'running'
        receipt['agent_ref'] = None
        external.atomic_write(external.receipt_path(self.root, 'ST-001'), receipt)
        with self.assertRaises(external.ReceiptError):
            external.occupancy(SimpleNamespace(root=str(self.root)))


if __name__ == '__main__':
    unittest.main()

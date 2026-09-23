"""Native process observation. Synthetic plus real Windows probes run in CI only."""
import ctypes
from ctypes import wintypes
import datetime
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest
from unittest import mock
import test_control_plane as fixture  # Preserve the suite's tests-before-lib import order.
import execution


def item(pid, name='bash.exe', ppid=1):
    return {'pid': pid, 'name': name, 'ppid': ppid}


def full(row):
    return {**row, 'command': row['name'] + ' observation-fixture', 'started': 'exact-start'}


class NativeSnapshotTests(unittest.TestCase):
    def reader(self, entries):
        r = mock.Mock(); r.now.return_value = 1000; r.entries.return_value = entries
        r.read.side_effect = lambda row, cutoff: full(row)
        return r

    def test_all_carrier_names_and_required_observer_keep_full_identity(self):
        entries = [item(i + 10, name) for i, name in enumerate(execution.WINDOWS_CARRIERS)]
        entries += [item(2, 'python.exe'), item(3, 'unrelated.exe')]
        reader = self.reader(entries)
        rows = execution.native_windows_snapshot(reader, [2])
        self.assertEqual({2} | {r['pid'] for r in entries[:6]}, {r['pid'] for r in rows})
        self.assertTrue(all(r['command'] and r['started'] and 'ppid' in r for r in rows))
        self.assertTrue(all(call.args[1] == 1000 for call in reader.read.call_args_list))
        self.assertNotIn(3, {call.args[0]['pid'] for call in reader.read.call_args_list})

    def test_missing_observer_is_unknown(self):
        with self.assertRaisesRegex(execution.EvidenceUnknown, 'observer'):
            execution.native_windows_snapshot(self.reader([item(10)]), [2])

    def test_ancestor_remains_best_effort_for_msys(self):
        rows = execution.native_windows_snapshot(self.reader([item(2, 'python.exe')]), [2, 99])
        self.assertEqual([2], [r['pid'] for r in rows])

    def test_access_denied_candidate_cannot_be_dropped(self):
        reader = self.reader([item(2), item(3)])
        reader.read.side_effect = execution.EvidenceUnknown('candidate access denied')
        with self.assertRaisesRegex(execution.EvidenceUnknown, 'access denied'):
            execution.native_windows_snapshot(reader, [2])

    def test_only_proven_exited_candidate_is_omitted(self):
        reader = self.reader([item(2), item(3)])
        reader.read.side_effect = lambda row, cutoff: None if row['pid'] == 3 else full(row)
        self.assertEqual([2], [r['pid'] for r in execution.native_windows_snapshot(reader, [2])])

    def test_duplicate_pid_is_unknown(self):
        with self.assertRaisesRegex(execution.EvidenceUnknown, 'Duplicate'):
            execution.native_windows_snapshot(self.reader([item(2), item(2)]), [2])

    def test_incomplete_or_mismatched_identity_is_unknown(self):
        for key, value in [('command', ''), ('command', None), ('started', ''), ('pid', 99)]:
            with self.subTest(key=key, value=value):
                reader = self.reader([item(2)])
                reader.read.side_effect = lambda row, cutoff: {**full(row), key: value}
                with self.assertRaises(execution.EvidenceUnknown):
                    execution.native_windows_snapshot(reader, [2])

    def test_incomplete_table_is_unknown(self):
        reader = self.reader([]); reader.entries.side_effect = execution.EvidenceUnknown('incomplete')
        with self.assertRaisesRegex(execution.EvidenceUnknown, 'incomplete'):
            execution.native_windows_snapshot(reader, [2])

    def test_timestamp_keeps_cim_precision_and_offset_without_float_rounding(self):
        utc = datetime.timezone.utc
        at = datetime.datetime(2026, 9, 23, 2, 35, 31, 99845, tzinfo=utc)
        delta = at - datetime.datetime(1601, 1, 1, tzinfo=utc)
        ticks = ((delta.days * 86400 + delta.seconds) * 1000000 + delta.microseconds) * 10 + 7
        zone = datetime.timezone(datetime.timedelta(hours=8))
        self.assertEqual('2026-09-23T10:35:31.0998450+08:00', execution.windows_started(ticks, zone))
        self.assertEqual('2026-09-23T02:35:31.0998450+00:00', execution.windows_started(ticks, utc))

    def test_timeout_is_still_bounded_at_25_seconds(self):
        with mock.patch.object(execution.os, 'name', 'nt'), mock.patch.object(
                execution.subprocess, 'run', side_effect=subprocess.TimeoutExpired('native-snapshot', 25)) as run:
            with self.assertRaises(subprocess.TimeoutExpired):
                execution.snapshot()
        self.assertEqual(25, run.call_args.kwargs['timeout'])

    def test_child_failure_or_corrupt_snapshot_never_means_no_owners(self):
        for code, text in [(6, ''), (0, '[]'), (0, '{}'), (0, '[{}]'), (0, 'invalid')]:
            with self.subTest(code=code, text=text), mock.patch.object(execution.os, 'name', 'nt'), mock.patch.object(
                    execution.subprocess, 'run', return_value=subprocess.CompletedProcess([], code, text, '')):
                with self.assertRaises((execution.EvidenceUnknown, ValueError)):
                    execution.snapshot()


class NativeHandleTests(unittest.TestCase):
    def setUp(self):
        self.reader = object.__new__(execution.WindowsProcessReader)
        self.reader.c = ctypes; self.reader.w = wintypes
        self.reader.kernel = mock.Mock(); self.reader.nt = mock.Mock()
        self.reader.kernel.OpenProcess.return_value = 123
        self.reader.kernel.WaitForSingleObject.return_value = 258
        self.reader.kernel.GetProcessTimes.return_value = False

    def test_creation_failure_closes_query_only_handle(self):
        with self.assertRaisesRegex(execution.EvidenceUnknown, 'creation'):
            self.reader.read(item(42), 1000)
        self.reader.kernel.CloseHandle.assert_called_once_with(123)
        self.reader.kernel.OpenProcess.assert_called_once_with(0x101000, False, 42)

    def test_exact_signalled_handle_proves_exit_and_is_closed(self):
        self.reader.kernel.WaitForSingleObject.return_value = 0
        self.assertIsNone(self.reader.read(item(42), 1000))
        self.reader.kernel.CloseHandle.assert_called_once_with(123)
        self.reader.kernel.GetProcessTimes.assert_not_called()

    def test_unknown_liveness_is_not_exit(self):
        self.reader.kernel.WaitForSingleObject.return_value = 0xFFFFFFFF
        with self.assertRaisesRegex(execution.EvidenceUnknown, 'liveness'):
            self.reader.read(item(42), 1000)
        self.reader.kernel.CloseHandle.assert_called_once_with(123)

    def test_pid_birth_reuse_after_snapshot_cannot_adopt_old_parent(self):
        def born(handle, created, *rest):
            created._obj.dwLowDateTime = 1001
            return True
        self.reader.kernel.GetProcessTimes.side_effect = born
        with self.assertRaisesRegex(execution.EvidenceUnknown, 'born/reused'):
            self.reader.read(item(42), 1000)
        self.reader.nt.NtQueryInformationProcess.assert_not_called()
        self.reader.kernel.CloseHandle.assert_called_once_with(123)


@unittest.skipUnless(os.name == 'nt', 'real Windows API compatibility, CI only')
class NativeWindowsSmokeTests(unittest.TestCase):
    def test_own_identity_roundtrip_without_wmi(self):
        own = next(r for r in execution.native_windows_snapshot(required_pids=[os.getpid()])
                   if r['pid'] == os.getpid())
        self.assertEqual(os.getppid(), own['ppid']); self.assertTrue(own['command'])
        result = subprocess.run([sys.executable, '-B', '-X', 'utf8', execution.__file__,
                                 'identity', '.', str(os.getpid())],
                                capture_output=True, text=True, encoding='utf-8', timeout=25)
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertEqual(str(os.getpid()) + '@' + own['started'], result.stdout.strip())

    def test_live_cim_publication_matches_native_creation_identity(self):
        own = next(r for r in execution.native_windows_snapshot(required_pids=[os.getpid()])
                   if r['pid'] == os.getpid())
        # Own-PID compatibility check on clean CI only, not the live snapshot path.
        command = '(Get-CimInstance Win32_Process -Filter "ProcessId=' + str(os.getpid()) + '").CreationDate.ToString("o")'
        result = subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', command],
                                capture_output=True, text=True, encoding='utf-8', timeout=20)
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertEqual(result.stdout.strip(), own['started'])


if __name__ == '__main__':
    unittest.main()

"""Real process-provider and same-owner recovery regressions. GitHub CI only."""
import os
import json
import base64
import shutil
import subprocess
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock
import test_control_plane as fixture
import execution
import runtime_preflight as runtime
import seal_owner as seal_owner
import boundary_restart


def process(pid, ppid=0, name='bash', command='', started=''):
    return {'pid': pid, 'ppid': ppid, 'name': name, 'command': command, 'started': started}


class ProcessClassificationCases(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.gettempdir()).resolve() / 'synthetic-workspace'
        self.base = [process(1, name='python'), process(2, 1, 'bash', str(self.root / 'run-loop.sh')), process(3, 2, 'python')]

    def test_own_loop_ancestry_is_not_a_competitor(self):
        self.assertEqual([], execution.competitors(self.base, self.root, 3))

    def test_other_actual_loop_blocks_duplicate(self):
        rows = self.base + [process(10, command='bash ' + str(self.root / 'run-loop.sh'))]
        self.assertEqual(10, execution.competitors(rows, self.root, 3)[0]['pid'])

    def test_backend_loop_does_not_block_experience_lane(self):
        rows = self.base + [process(10, command='bash ' + str(self.root / 'run-loop.sh')
                                    + ' --carrier-lane=backend')]
        self.assertEqual([], execution.competitors(rows, self.root, 3, lane='experience'))

    def test_same_lane_loop_still_blocks_duplicate(self):
        rows = self.base + [process(10, command='bash ' + str(self.root / 'run-loop.sh')
                                    + ' --carrier-lane=backend')]
        conflict = execution.competitors(rows, self.root, 3, lane='backend')[0]
        self.assertEqual(10, conflict['pid']); self.assertEqual('backend', conflict['lane'])

    def test_worker_marker_in_other_lane_does_not_block(self):
        rows = self.base + [process(10, name='node.exe',
                                    command='node worker STARTRIPS_EXECUTION_OWNER=' + str(self.root)
                                    + ';lane=backend;feature=ST-001;worktree=C:/owners/backend;')]
        self.assertEqual([], execution.competitors(rows, self.root, 3, lane='experience',
                                                   feature='ST-080', worktree='C:/owners/experience'))

    def test_same_feature_blocks_even_when_lane_differs(self):
        rows = self.base + [process(10, name='node.exe',
                                    command='node worker STARTRIPS_EXECUTION_OWNER=' + str(self.root)
                                    + ';lane=backend;feature=ST-080;worktree=C:/owners/backend;')]
        conflict = execution.competitors(rows, self.root, 3, lane='experience',
                                         feature='ST-080', worktree='C:/owners/experience')[0]
        self.assertEqual(10, conflict['pid']); self.assertEqual('ST-080', conflict['feature'])

    def test_same_worktree_blocks_even_when_lane_differs(self):
        shared = str((self.root / 'owner-tree').resolve())
        rows = self.base + [process(10, name='node.exe',
                                    command='node worker STARTRIPS_EXECUTION_OWNER=' + str(self.root)
                                    + ';lane=backend;feature=ST-001;worktree=' + shared + ';')]
        conflict = execution.competitors(rows, self.root, 3, lane='experience',
                                         feature='ST-080', worktree=shared)[0]
        self.assertEqual(10, conflict['pid']); self.assertEqual('backend', conflict['lane'])

    def test_orphan_worker_encoded_scope_preserves_semicolon_worktree(self):
        shared = str((self.root / 'owner;tree with spaces').resolve())
        token = base64.urlsafe_b64encode(shared.encode('utf-8')).decode('ascii').rstrip('=')
        rows = self.base + [process(10, name='node.exe',
                                    command='node worker STARTRIPS_EXECUTION_OWNER=' + str(self.root)
                                    + ';lane=backend;feature=ST-001;worktree64=' + token + '; Evidence JSON')]
        conflict = execution.competitors(rows, self.root, 3, lane='experience',
                                         feature='ST-080', worktree=shared)[0]
        self.assertEqual(shared.replace('\\', '/').lower(), conflict['worktree'])

    def test_encoded_worker_scope_preserves_trailing_path_characters(self):
        shared = str(self.root / 'owner. ')
        token = base64.urlsafe_b64encode(shared.encode('utf-8')).decode('ascii').rstrip('=')
        feature, observed = execution.command_scope(
            'STARTRIPS_EXECUTION_OWNER=' + str(self.root)
            + ';lane=backend;feature=ST-001;worktree64=' + token + '; Evidence JSON')
        self.assertEqual('ST-001', feature)
        self.assertEqual(execution.worktree_key(shared), observed)

    @unittest.skipIf(os.name == 'nt', 'POSIX owner paths are case-sensitive')
    def test_posix_worktree_scope_preserves_case(self):
        self.assertNotEqual(execution.worktree_key('/tmp/Owner'), execution.worktree_key('/tmp/owner'))

    def test_malformed_encoded_worker_scope_fails_closed(self):
        with self.assertRaisesRegex(execution.EvidenceUnknown, 'Malformed encoded owner worktree'):
            execution.command_scope('STARTRIPS_EXECUTION_OWNER=' + str(self.root)
                                    + ';lane=backend;feature=ST-001;worktree64=%%%bad;')

    def test_worktree_marker_preserves_spaces_for_scope_collision(self):
        shared = str((self.root / 'owner tree with spaces').resolve())
        rows = self.base + [process(10, name='node.exe',
                                    command='node worker STARTRIPS_EXECUTION_OWNER=' + str(self.root)
                                    + ';lane=backend;feature=ST-001;worktree=' + shared + '; Evidence JSON')]
        conflict = execution.competitors(rows, self.root, 3, lane='experience',
                                         feature='ST-080', worktree=shared)[0]
        self.assertEqual(shared.replace('\\', '/').lower(), conflict['worktree'])

    def test_scoped_cross_lane_loop_blocks_same_owner_before_worker(self):
        shared = str((self.root / 'owner;tree with spaces').resolve())
        command = ('bash "' + str(self.root / 'run-loop.sh') + '" --carrier-lane=backend '
                   '--carrier-token=backend-token-1 --carrier-feature=ST-080 '
                   '"--carrier-worktree=' + shared + '"')
        rows = self.base + [process(10, command=command)]
        conflict = execution.competitors(rows, self.root, 3, lane='experience',
                                         feature='ST-080', worktree=shared)[0]
        self.assertEqual(('backend', 'ST-080'), (conflict['lane'], conflict['feature']))
        self.assertEqual(shared.replace('\\', '/').lower(), conflict['worktree'])

    def test_scoped_cross_lane_loop_allows_different_owner(self):
        backend = str((self.root / 'backend-owner').resolve())
        experience = str((self.root / 'experience-owner').resolve())
        command = ('bash "' + str(self.root / 'run-loop.sh') + '" --carrier-lane=backend '
                   '--carrier-token=backend-token-1 --carrier-feature=ST-087 '
                   '"--carrier-worktree=' + backend + '"')
        rows = self.base + [process(10, command=command)]
        self.assertEqual([], execution.competitors(rows, self.root, 3, lane='experience',
                                                   feature='ST-080', worktree=experience))

    def test_unknown_lane_in_same_workspace_stays_fail_closed(self):
        rows = self.base + [process(10, command='bash ' + str(self.root / 'run-loop.sh'))]
        conflict = execution.competitors(rows, self.root, 3, lane='experience')[0]
        self.assertEqual(10, conflict['pid']); self.assertEqual('unknown', conflict['lane'])

    def test_matching_direct_carrier_token_exempts_only_that_loop(self):
        rows = self.base + [process(10, command='bash ' + str(self.root / 'run-loop.sh')
                                    + ' --carrier-lane=experience --carrier-token=experience-token-1')]
        with mock.patch.dict(os.environ, {'STARTRIPS_CARRIER_TOKEN': 'experience-token-1'}):
            self.assertEqual([], execution.competitors(rows, self.root, 3, lane='experience'))

    def test_different_carrier_token_does_not_exempt_peer(self):
        rows = self.base + [process(10, command='bash ' + str(self.root / 'run-loop.sh')
                                    + ' --carrier-lane=experience --carrier-token=experience-token-2')]
        with mock.patch.dict(os.environ, {'STARTRIPS_CARRIER_TOKEN': 'experience-token-1'}):
            self.assertEqual(10, execution.competitors(rows, self.root, 3, lane='experience')[0]['pid'])

    def test_orphan_worker_marker_blocks_new_carrier(self):
        rows = self.base + [process(10, name='node.exe', command='node worker STARTRIPS_EXECUTION_OWNER=' + str(self.root) + ';feature=ST-001;')]
        self.assertEqual('worker', execution.competitors(rows, self.root, 3)[0]['kind'])

    def test_unknown_relative_legacy_loop_is_not_treated_as_ended(self):
        rows = self.base + [process(10, command='bash ./run-loop.sh')]
        self.assertEqual('unknown-cwd', execution.competitors(rows, self.root, 3)[0]['state'])

    def test_caller_missing_from_snapshot_is_unknown(self):
        with self.assertRaises(execution.EvidenceUnknown): execution.competitors([], self.root, 3)

    def test_unrelated_process_text_is_not_execution(self):
        rows = self.base + [process(10, name='python.exe', command='python inspector mentions run-loop.sh')]
        self.assertEqual([], execution.competitors(rows, self.root, 3))

    def test_absolute_windows_executable_does_not_prove_relative_script_cwd(self):
        rows = self.base + [process(10, name='bash.exe', command='"C:/Program Files/Git/bin/bash.exe" ./run-loop.sh')]
        self.assertEqual('unknown-cwd', execution.competitors(rows, self.root, 3)[0]['state'])

    def test_common_workspace_prefix_is_not_the_same_workspace(self):
        other = str(self.root) + '-other'
        rows = self.base + [process(10, command='bash "' + other + '/run-loop.sh"')]
        self.assertEqual([], execution.competitors(rows, self.root, 3))

    def test_quoted_workspace_path_with_spaces_remains_observable(self):
        root = self.root / 'workspace with spaces'
        rows = self.base + [process(10, command='bash "' + str(root / 'run-loop.sh') + '"')]
        self.assertEqual('active', execution.competitors(rows, root, 3)[0]['state'])

    def test_other_absolute_workspace_is_not_this_owner(self):
        other = self.root.parent / 'other-workspace'
        rows = self.base + [process(10, command='bash ' + str(other / 'run-loop.sh'))]
        self.assertEqual([], execution.competitors(rows, self.root, 3))

    def severed(self, supervisor_started='sup-start-1'):
        """run-loop whose recorded parent is an MSYS stub that already exited."""
        return [process(1, name='python'), process(2, 999, 'bash', str(self.root / 'run-loop.sh')),
                process(3, 2, 'python'),
                process(20, 19, 'bash', 'bash ' + str(self.root / 'loop-supervisor.sh'),
                        started=supervisor_started)]

    def test_severed_msys_ancestry_reports_our_own_supervisor(self):
        # The failure this guards: ancestry stops at the exited stub, so the
        # supervisor that launched this very check reads as a second execution.
        self.assertEqual(20, execution.competitors(self.severed(), self.root, 3)[0]['pid'])

    def test_published_identity_is_not_a_competitor(self):
        with mock.patch.dict(os.environ, {'STARTRIPS_OWN_PIDS': '20@sup-start-1'}):
            self.assertEqual([], execution.competitors(self.severed(), self.root, 3))

    def test_reused_pid_does_not_inherit_the_published_exemption(self):
        # Windows reuses process ids. The number published at launch may belong to
        # an unrelated execution later, and only the start stamp can tell.
        rows = self.severed(supervisor_started='different-start-2')
        with mock.patch.dict(os.environ, {'STARTRIPS_OWN_PIDS': '20@sup-start-1'}):
            self.assertEqual(20, execution.competitors(rows, self.root, 3)[0]['pid'])

    def test_bare_pid_without_a_stamp_exempts_nothing(self):
        with mock.patch.dict(os.environ, {'STARTRIPS_OWN_PIDS': '20,not-a-pid'}):
            self.assertEqual(20, execution.competitors(self.severed(), self.root, 3)[0]['pid'])

    def test_child_of_a_published_identity_is_still_reported(self):
        # A published supervisor never vouches for what runs under it: a racing or
        # manual start that lands beneath it is a real second execution.
        rows = self.severed() + [process(21, 20, 'bash', 'bash ' + str(self.root / 'run-loop.sh'),
                                         started='child-start-3')]
        with mock.patch.dict(os.environ, {'STARTRIPS_OWN_PIDS': '20@sup-start-1'}):
            self.assertEqual([21], [row['pid'] for row in execution.competitors(rows, self.root, 3)])

    def test_publication_never_short_circuits_an_unreadable_command(self):
        # The UNKNOWN #400 established outranks publication: an exemption is only
        # ever reached once the command line has been read, so a carrier we cannot
        # read stays UNKNOWN even when its number and stamp were published.
        rows = self.base + [process(10, 20, 'bash', None, started='sup-start-1')]
        with mock.patch.dict(os.environ, {'STARTRIPS_OWN_PIDS': '10@sup-start-1'}):
            self.assertEqual('unknown-command', execution.competitors(rows, self.root, 3)[0]['state'])

    def test_unreadable_child_under_a_generic_parent_stays_unknown(self):
        for name, command in [('powershell.exe', 'powershell.exe -NoProfile'),
                              ('node.exe', 'node --stdio editor-server'),
                              ('bash.exe', 'bash ./run-loop.sh')]:
            with self.subTest(parent=command):
                rows = self.base + [process(30, name=name, command=command),
                                    process(31, 30, 'node.exe', None)]
                states = {row['pid']: row['state']
                          for row in execution.competitors(rows, self.root, 3)}
                self.assertEqual('unknown-command', states[31])

    def test_generic_intermediary_cannot_hide_a_workspace_ancestor(self):
        rows = self.base + [
            process(30, name='bash.exe', command='bash ' + str(self.root / 'run-loop.sh')),
            process(31, 30, 'powershell.exe', 'powershell.exe -NoProfile'),
            process(32, 31, 'node.exe', None)]
        states = {row['pid']: row['state']
                  for row in execution.competitors(rows, self.root, 3)}
        self.assertEqual('unknown-command', states[32])

    def test_even_a_foreign_parent_cannot_prove_an_unreadable_child_is_foreign(self):
        other = self.root.parent / 'other-workspace'
        rows = self.base + [process(30, name='bash.exe', command='bash ' + str(other / 'run-loop.sh')),
                            process(31, 30, 'node.exe', None)]
        states = {row['pid']: row['state']
                  for row in execution.competitors(rows, self.root, 3)}
        self.assertEqual('unknown-command', states[31])

    def test_generic_parent_cannot_make_idle_or_resume_succeed(self):
        rows = self.base + [process(30, name='powershell.exe', command='powershell.exe -NoProfile'),
                            process(31, 30, 'node.exe', None)]
        with mock.patch.object(execution, 'snapshot', return_value=rows) as provider, \
                mock.patch.object(execution.os, 'getpid', return_value=3):
            with self.assertRaisesRegex(execution.EvidenceUnknown, 'unknown-command'):
                execution.ensure_idle(self.root)
        self.assertEqual(2, provider.call_count)

    def test_unreadable_orphan_is_still_unknown(self):
        # No readable ancestor, so nothing proves it is somebody else's.
        rows = self.base + [process(31, 999, 'node.exe', None)]
        self.assertEqual('unknown-command', execution.competitors(rows, self.root, 3)[0]['state'])

    def test_unreadable_process_under_our_own_workspace_stays_unknown(self):
        rows = self.base + [process(30, name='bash.exe', command='bash ' + str(self.root / 'run-loop.sh')),
                            process(31, 30, 'node.exe', None)]
        states = {row['pid']: row['state'] for row in execution.competitors(rows, self.root, 3)}
        self.assertEqual('unknown-command', states[31])

    def test_unreadable_process_under_a_worker_marker_stays_unknown(self):
        rows = self.base + [process(30, name='node.exe',
                                    command='node worker STARTRIPS_EXECUTION_OWNER=' + str(self.root) + ';'),
                            process(31, 30, 'node.exe', None)]
        states = {row['pid']: row['state'] for row in execution.competitors(rows, self.root, 3)}
        self.assertEqual('unknown-command', states[31])

    def test_published_pids_never_hide_an_unrelated_execution(self):
        rows = self.base + [process(10, command='bash ' + str(self.root / 'run-loop.sh'),
                                    started='other-start')]
        with mock.patch.dict(os.environ, {'STARTRIPS_OWN_PIDS': '20@sup-start-1'}):
            self.assertEqual(10, execution.competitors(rows, self.root, 3)[0]['pid'])


# The only stand-in on the normal path: `gh`. Every reconcile and intake call
# already degrades to a no-op on an empty answer, and `api rate_limit` is the
# transport probe at the top of each iteration.
STUB_GH = """#!/usr/bin/env bash
printf '[]'
exit 0
"""

# Used only where the subject is the supervisor's own branching, never to stand
# in for a normal start: that one runs the real run-loop.sh below.
PROBE_RUN_LOOP = """#!/usr/bin/env bash
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
printf '%s' "${STARTRIPS_OWN_PIDS:-}" >"$ROOT/own.txt"
if [[ -n "${PROBE_FAKE_STAMP:-}" ]]; then
  export STARTRIPS_OWN_PIDS="${STARTRIPS_OWN_PIDS%%@*}@${PROBE_FAKE_STAMP}"
fi
python3 -B "$ROOT/lib/execution.py" check "$ROOT" >"$ROOT/check.json" 2>"$ROOT/check.err"
rc=$?
echo "$rc" >"$ROOT/check.rc"
cat "$ROOT/check.err"
exit "$rc"
"""

# The same probe, held open until released, so a second launcher meets a live
# chain instead of racing one that already finished.
HOLDING_PROBE = PROBE_RUN_LOOP.replace('exit "$rc"', """for _ in $(seq 1 900); do
  [[ -f "$ROOT/release" ]] && break
  sleep 0.1
done
exit "$rc\"""")

PASSED_ONLY = {'rules': {'terminal_statuses': ['passed', 'blocked']},
               'features': [{'id': 'ST-001', 'status': 'passed', 'passes': True, 'attempts': 0,
                             'priority': 1, 'phase': 'P1-globe', 'dependencies': [], 'human_gate': None,
                             'evidence': [], 'pr_links': [], 'notes': 'done'}]}


def git_bash():
    if os.name == 'nt':
        for candidate in [Path(os.environ.get('ProgramFiles', 'C:/Program Files')) / 'Git/bin/bash.exe',
                          Path('C:/Program Files/Git/usr/bin/bash.exe')]:
            if candidate.exists():
                return str(candidate)
    return shutil.which('bash')


def reported_pids(text):
    """Pids named by a guard result, whether it passed or raised."""
    payload = text.partition('must finish: ')[2].strip()
    if payload:
        return {row['pid'] for row in json.loads(payload)}
    if text.strip().startswith('{'):
        return {row['pid'] for row in json.loads(text)['competing_executions']}
    return set()


@unittest.skipUnless(os.name == 'nt', 'the severed-ancestry regression is specific to MSYS on Windows')
class ChainCase(unittest.TestCase):
    """Real launcher, supervisor and guard processes in an isolated workspace.

    Windows only, and deliberately so: the ancestry break these guard against is
    MSYS emulating fork/exec with fresh processes. The same chain on Linux would
    instead exercise the procfs provider, which raises for any process it may not
    read -- an unrelated, pre-existing limitation that must not decide whether
    this regression passes.
    """

    run_loop = None   # None means the real, distributed run-loop.sh

    def setUp(self):
        self.bash = git_bash()
        if not self.bash:
            self.fail('GitHub CI must supply bash, not skip startup regressions')
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        source = Path(__file__).resolve().parents[1]
        names = ['launch-supervisor.sh', 'loop-supervisor.sh']
        if self.run_loop is None:
            names.append('run-loop.sh')
        for name in names:
            shutil.copy2(source / name, self.root / name)
        if self.run_loop is not None:
            (self.root / 'run-loop.sh').write_text(self.run_loop, encoding='utf-8', newline='\n')
        shutil.copytree(source / 'lib', self.root / 'lib', ignore=shutil.ignore_patterns('__pycache__'))
        (self.root / 'feature_list.json').write_text(json.dumps(PASSED_ONLY, indent=2) + '\n', encoding='utf-8')
        (self.root / 'stub').mkdir()
        (self.root / 'stub' / 'gh').write_text(STUB_GH, encoding='utf-8', newline='\n')
        (self.root / 'stub' / 'gh').chmod(0o755)
        (self.root / 'logs').mkdir()
        self.launched = None

    def tearDown(self):
        (self.root / 'release').touch()
        if self.launched:
            try:
                self.launched.communicate(timeout=90)
            except (subprocess.TimeoutExpired, ValueError):
                self.launched.kill()
            for stream in (self.launched.stdout, self.launched.stderr):
                if stream and not stream.closed:
                    stream.close()
        # A chain of this workspace that outlives its case would be a competing
        # execution for the next one, and deleting the directory first would strand
        # it waiting on a release file that can no longer appear.
        deadline = time.monotonic() + 60
        alias = str(self.root).replace('\\', '/').lower()
        while time.monotonic() < deadline:
            if not [row for row in execution.snapshot()
                    if isinstance(row.get('command'), str)
                    and alias in row['command'].replace('\\', '/').lower()]:
                break
            time.sleep(0.5)
        self.temp.cleanup()

    def environment(self, **extra):
        env = dict(os.environ, LOOP_LOG_DIR=str(self.root / 'logs'), MAX_ITERATIONS='1',
                   PATH=str(self.root / 'stub') + os.pathsep + os.environ['PATH'],
                   PYTHONDONTWRITEBYTECODE='1', PYTHONIOENCODING='utf-8', PYTHONUTF8='1')
        env.pop('STARTRIPS_OWN_PIDS', None)
        env.pop('STARTRIPS_LANE', None)
        env.update(extra)
        return env

    def run_chain(self, timeout=180, **extra):
        result = subprocess.run([self.bash, str(self.root / 'launch-supervisor.sh')], cwd=self.root,
                                env=self.environment(**extra), capture_output=True, text=True, timeout=timeout)
        return result

    def start_chain(self, **extra):
        """Start a chain and return once its guard has provably run."""
        self.launched = subprocess.Popen([self.bash, str(self.root / 'launch-supervisor.sh')], cwd=self.root,
                                         env=self.environment(**extra),
                                         stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        # The launcher handle is not the liveness signal: MSYS implements exec by
        # handing the supervisor to a fresh Windows process. Wait for the chain.
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            if (self.root / 'check.rc').exists():
                return
            time.sleep(0.2)
        self.fail('the chain never reached its guard: '
                  + ' | '.join(self.launched.communicate(timeout=30)))

    def supervisor_log(self):
        return '\n'.join(path.read_text(encoding='utf-8')
                         for path in sorted((self.root / 'logs').glob('supervisor-*.log')))

    def run_log(self):
        return '\n'.join(path.read_text(encoding='utf-8')
                         for path in sorted((self.root / 'logs').glob('run-*.log')))


class RealStartupChainCases(ChainCase):
    """launch-supervisor -> loop-supervisor -> the distributed run-loop.sh -> guard."""

    def test_the_real_run_loop_starts_and_reaches_its_selection_point(self):
        result = self.run_chain()
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        log = self.run_log()
        # Success is not "nothing named us": the guard has to pass and the real
        # run-loop has to get past it, through reconcile and intake, to the point
        # where it judges the queue.
        self.assertIn('"competing_executions": []', log)
        self.assertIn('"actual_write_read_delete": "success"', log)
        self.assertIn('Reconciling merge state (iteration 1)', log)
        self.assertIn('No eligible unfinished feature remains', log)
        self.assertIn('run-loop exited rc=0', self.supervisor_log())


class LiveChainRefusalCases(ChainCase):
    """A second launcher meeting a live chain. The probe only keeps it alive."""

    run_loop = HOLDING_PROBE

    def test_a_second_launch_is_refused_while_our_chain_lives(self):
        self.start_chain()
        second = self.run_chain()
        self.assertEqual(6, second.returncode, second.stdout + second.stderr)
        published = {int(entry.split('@')[0])
                     for entry in (self.root / 'own.txt').read_text(encoding='utf-8').strip().split(',')}
        self.assertTrue(published & reported_pids(second.stderr),
                        'the refusal must name our live chain: ' + second.stderr)


class SupervisorBranchCases(ChainCase):
    """The supervisor's own reaction to a guard verdict, so run-loop is a probe."""

    run_loop = PROBE_RUN_LOOP

    def published(self):
        return {int(entry.split('@')[0])
                for entry in (self.root / 'own.txt').read_text(encoding='utf-8').strip().split(',')}

    def test_an_unprovable_identity_leaves_the_chain_unknown(self):
        # A published number whose stamp no longer matches the supervisor is
        # exactly what a reused pid looks like later. It must not be exempted.
        self.run_chain(PROBE_FAKE_STAMP='not-the-observed-start')
        self.assertEqual('6', (self.root / 'check.rc').read_text().strip())
        output = (self.root / 'check.err').read_text(encoding='utf-8')
        self.assertIn('EXECUTION_UNKNOWN', output)
        self.assertTrue(self.published() & reported_pids(output),
                        'an unverifiable identity must not be exempted: ' + output)

    def test_a_self_block_stops_at_once_instead_of_retrying(self):
        # The original incident, reproduced through the supervisor: the guard names
        # the supervisor that launched this run-loop, and the old code spent twelve
        # hours of transient budget on a verdict that could never change.
        result = self.run_chain(PROBE_FAKE_STAMP='not-the-observed-start')
        log = self.supervisor_log()
        self.assertIn('stopping for a human', log)
        self.assertNotIn('platform failure (retry', log)
        self.assertEqual(8, result.returncode, log)


class StopAndPermissionCases(fixture.SyntheticOne):
    def test_backend_supervisor_stop_does_not_stop_experience(self):
        (self.root / 'SUPERVISOR_STOP').write_text('backend owner stop')
        self.assertEqual([], execution.stopped(self.root, lane='experience'))
        self.assertEqual(['SUPERVISOR_STOP'], execution.stopped(self.root, lane='backend'))

    def test_global_agent_stop_stops_both_lanes(self):
        (self.root / 'AGENT_STOP').write_text('global owner stop')
        self.assertEqual(['AGENT_STOP'], execution.stopped(self.root, lane='experience'))
        self.assertIn('AGENT_STOP', execution.stopped(self.root, lane='backend'))

    def test_inherit_probe_really_writes_and_removes_only_its_file(self):
        before = self.path.read_bytes()
        result = execution.permission_probe(self.root)
        self.assertEqual('success', result['actual_write_read_delete'])
        self.assertEqual(before, self.path.read_bytes())
        self.assertEqual([], list((self.root / '.agent-artifacts').glob('worker-permission-probe-*')))

    def test_actual_permission_denial_is_visible(self):
        with mock.patch.object(execution.tempfile, 'mkstemp', side_effect=PermissionError('synthetic permission denied')):
            with self.assertRaises(PermissionError): execution.permission_probe(self.root)

    def test_stop_cleanup_requires_exact_ownership(self):
        path = self.root / 'AGENT_STOP'; path.write_bytes(b'owner-stop')
        with self.assertRaises(fixture.store.StoreConflict): execution.clear_owned_stop(self.root, 'AGENT_STOP', b'my-repair-stop')
        self.assertEqual(b'owner-stop', path.read_bytes())

    def test_only_matching_boundary_marker_can_be_removed(self):
        path = self.root / 'AGENT_STOP'; path.write_bytes(b'my-exact-boundary-stop')
        self.assertTrue(execution.clear_owned_stop(self.root, 'AGENT_STOP', path.read_bytes()))
        self.assertFalse(path.exists())

    def test_cancellation_is_never_automatically_cleared(self):
        path = self.root / 'CANCEL_SCHEDULED_RESTART'; path.write_bytes(b'cancel')
        with self.assertRaises(fixture.store.StoreConflict): execution.clear_owned_stop(self.root, path.name, b'cancel')
        self.assertEqual(b'cancel', path.read_bytes())

    def test_manual_resume_requires_explicit_local_command(self):
        (self.root / 'AGENT_STOP').write_text('human stop')
        with mock.patch.dict(os.environ, {'STARTRIPS_EXPLICIT_RESUME': ''}):
            with self.assertRaises(fixture.store.StoreConflict): execution.manual_resume(self.root)
        self.assertEqual('human stop', (self.root / 'AGENT_STOP').read_text())

    def test_explicit_resume_preserves_cancellation(self):
        (self.root / 'CANCEL_SCHEDULED_RESTART').write_text('cancel')
        with mock.patch.dict(os.environ, {'STARTRIPS_EXPLICIT_RESUME': '1'}), mock.patch.object(execution, 'ensure_idle'):
            with self.assertRaises(fixture.store.StoreConflict): execution.manual_resume(self.root)
        self.assertTrue((self.root / 'CANCEL_SCHEDULED_RESTART').exists())

    def test_explicit_resume_clears_only_two_requested_stops(self):
        for name in ['AGENT_STOP', 'SUPERVISOR_STOP']: (self.root / name).write_text('human stop')
        before = self.path.read_bytes()
        with mock.patch.dict(os.environ, {'STARTRIPS_EXPLICIT_RESUME': '1'}), \
                mock.patch.object(execution, 'ensure_idle') as provider:
            result = execution.manual_resume(self.root)
        provider.assert_called_once_with(self.root.resolve())
        self.assertEqual({'AGENT_STOP', 'SUPERVISOR_STOP'}, set(result['cleared']))
        self.assertFalse(result['worker_started']); self.assertEqual(before, self.path.read_bytes())

    def test_backend_only_resume_uses_backend_lane_guard(self):
        (self.root / 'SUPERVISOR_STOP').write_text('backend stop')
        with mock.patch.dict(os.environ, {'STARTRIPS_EXPLICIT_RESUME': '1'}), \
                mock.patch.object(execution, 'ensure_idle') as provider:
            result = execution.manual_resume(self.root)
        provider.assert_called_once_with(self.root.resolve(), lane='backend')
        self.assertEqual(['SUPERVISOR_STOP'], result['cleared'])

    def test_global_stop_is_not_cleared_while_any_lane_is_active(self):
        path = self.root / 'AGENT_STOP'; path.write_bytes(b'startrips-network-maintenance-window\n')
        with mock.patch.object(execution, 'ensure_idle', side_effect=execution.EvidenceUnknown('experience active')) as provider:
            with self.assertRaisesRegex(execution.EvidenceUnknown, 'experience active'):
                execution.outage_window(self.root, 'resume')
        provider.assert_called_once_with(self.root.resolve())
        self.assertTrue(path.exists())

    def test_boundary_restart_never_overrides_existing_stop(self):
        (self.root / 'SUPERVISOR_STOP').write_text('stop')
        with mock.patch.object(boundary_restart.subprocess, 'call') as launch:
            self.assertEqual(0, boundary_restart.restart(self.root, 1)); launch.assert_not_called()
        self.assertEqual('stop', (self.root / 'SUPERVISOR_STOP').read_text())

    def test_transient_provider_failure_preserves_state(self):
        before = self.path.read_bytes()
        with mock.patch.object(execution, 'snapshot', side_effect=execution.EvidenceUnknown('provider offline')):
            with self.assertRaises(execution.EvidenceUnknown): execution.ensure_idle(self.root)
        self.assertEqual(before, self.path.read_bytes()); self.assertFalse((self.root / 'AGENT_STOP').exists())


class RealCarrierCases(fixture.WiringTests):
    # The inherited WiringTests also exercise the actual target bash boundary.
    def test_real_process_provider_observes_exit_without_owner_change(self):
        script = self.root / 'run-loop.sh'
        script.write_text('#!/usr/bin/env bash\nprintf "READY\\n"\nread -r release\n', encoding='utf-8', newline='\n')
        original = self.path.read_bytes()
        child = subprocess.Popen([self.bash, str(script)], cwd=self.root, stdin=subprocess.PIPE,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8')
        try:
            self.assertEqual('READY', child.stdout.readline().strip())
            with self.assertRaises(execution.EvidenceUnknown): execution.ensure_idle(self.root)
            child.communicate('finish\n', timeout=10)
            self.assertEqual(0, child.returncode)
            self.assertEqual('ended', execution.ensure_idle(self.root)['old_execution'])
            self.assertEqual(original, self.path.read_bytes())
        finally:
            if child.poll() is None:
                child.terminate(); child.communicate(timeout=10)

    def test_stopped_real_run_loop_never_starts_a_model(self):
        (self.root / 'AGENT_STOP').write_text('human stop')
        before = self.path.read_bytes()
        result = self.invoke('export STARTRIPS_LANE=backend; bash run-loop.sh')
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertIn('STOP', result.stdout); self.assertEqual(before, self.path.read_bytes())
        self.assertFalse((self.root / '.agent-artifacts').exists())

    def test_existing_backend_owner_reserves_slot_during_review(self):
        self.write(fixture.feature('ST-001', status='ready_to_merge', phase='P0-process', passes=True),
                   fixture.feature('ST-002', phase='P0-process'))
        result = self.invoke('export STARTRIPS_LANE=backend; bash run-loop.sh --next')
        self.assertEqual(0, result.returncode, result.stderr); self.assertEqual('', result.stdout.strip())

    @unittest.skipUnless(os.name == 'nt', 'direct Experience carrier regression is Windows/MSYS-specific')
    def test_backend_supervisor_stop_does_not_block_one_shot_experience(self):
        source = Path(__file__).resolve().parents[1]
        shutil.copy2(source / 'launch-experience.sh', self.root / 'launch-experience.sh')
        (self.root / 'SUPERVISOR_STOP').write_text('backend owner stop')
        before = self.path.read_bytes()
        result = self.invoke('export MAX_ITERATIONS=0; bash launch-experience.sh')
        self.assertEqual(3, result.returncode, result.stdout + result.stderr)
        self.assertIn('"lane": "experience"', result.stdout)
        self.assertIn('"stop_markers": []', result.stdout)
        self.assertNotIn('EXECUTION_UNKNOWN', result.stdout + result.stderr)
        self.assertEqual(before, self.path.read_bytes())


class RealWorktreeCases(fixture.SyntheticOne):
    def setUp(self):
        super().setUp()
        self.repo = self.root / 'startrips'; self.repo.mkdir()
        self.git('init', '-b', 'main'); self.git('config', 'user.name', 'Synthetic CI')
        self.git('config', 'user.email', 'ci@example.invalid')
        (self.repo / 'code.txt').write_text('source')
        self.git('add', '.'); self.git('commit', '-m', 'Create synthetic source')
        self.sha = self.git('rev-parse', 'HEAD')
        self.git('checkout', '-b', 'feat/issue1-synthetic')
        self.write(fixture.feature(status='in_progress', phase='P0-process', issue=1,
                                   pr_links=['https://github.com/synthetic/project/pull/1']))

    def git(self, *args):
        result = subprocess.run(['git', '-C', str(self.repo), *args], capture_output=True, text=True, encoding='utf-8', timeout=10)
        self.assertEqual(0, result.returncode, result.stderr); return result.stdout.strip()

    def preflight(self):
        old = Path.cwd()
        try:
            os.chdir(self.root)
            with mock.patch.dict(os.environ, {'STARTRIPS_LANE': 'backend'}), mock.patch.object(runtime, 'api', return_value={
                    'state': 'open', 'merged': False, 'head': {'ref': 'feat/issue1-synthetic', 'sha': self.sha}}):
                return runtime.preflight(self.root, self.repo, 'backend', 'ST-001', 'synthetic/project')
        finally:
            os.chdir(old)

    def test_same_owner_dirty_worktree_is_preserved(self):
        (self.repo / 'code.txt').write_text('uncommitted-owner-work')
        result = self.preflight()
        self.assertTrue(result['dirty']); self.assertEqual(self.repo.resolve(), Path(result['worktree']))
        self.assertEqual('uncommitted-owner-work', (self.repo / 'code.txt').read_text())
        self.assertEqual('RESUME_OWNER', runtime.local_action(self.repo, 1, self.sha))

    def test_unpushed_descendant_resumes_original_owner(self):
        (self.repo / 'code.txt').write_text('new-owner-source')
        self.git('add', '.'); self.git('commit', '-m', 'Continue synthetic owner source')
        head = self.git('rev-parse', 'HEAD')
        self.preflight(); self.assertEqual(head, self.git('rev-parse', 'HEAD'))
        self.assertEqual('RESUME_OWNER', runtime.local_action(self.repo, 1, self.sha))

    def test_ledger_only_pending_work_does_not_trigger_reimplementation(self):
        path = self.repo / 'docs/pr-history/1.md'; path.parent.mkdir(parents=True); path.write_text('pending ledger')
        self.preflight(); self.assertEqual('CONTINUE_PLAN', runtime.local_action(self.repo, 1, self.sha))

    def test_new_worktree_not_created_by_read_only_probe(self):
        before = self.git('worktree', 'list', '--porcelain')
        with self.assertRaises(fixture.store.StoreConflict):
            runtime.prepare_unmapped(self.root, self.repo, fixture.feature('ST-002', issue=2), 'synthetic/project', False, 'backend')
        self.assertEqual(before, self.git('worktree', 'list', '--porcelain'))

    def test_new_owner_prepare_guard_is_lane_scoped(self):
        row = fixture.feature('ST-002', issue=2)
        with mock.patch.object(runtime, 'ensure_idle', side_effect=RuntimeError('guard')) as guard:
            with self.assertRaisesRegex(RuntimeError, 'guard'):
                runtime.prepare_unmapped(self.root, self.repo, row, 'synthetic/project', True, 'experience')
        guard.assert_called_once_with(self.root, lane='experience', feature='ST-002')

    def test_seal_guard_is_lane_and_owner_scoped(self):
        with mock.patch.dict(os.environ, {'STARTRIPS_ROLE': 'experience'}), \
                mock.patch.object(seal_owner, 'ensure_idle', side_effect=RuntimeError('guard')) as guard:
            with self.assertRaisesRegex(RuntimeError, 'guard'):
                seal_owner.seal(self.root, self.repo, 'ST-001', 'synthetic/project')
        guard.assert_called_once_with(self.root.resolve(), lane='experience', feature='ST-001',
                                      worktree=self.repo.resolve())

    def test_wrong_target_lane_is_refused(self):
        old = Path.cwd()
        try:
            os.chdir(self.root)
            with mock.patch.dict(os.environ, {'STARTRIPS_LANE': 'experience'}):
                with self.assertRaises(fixture.store.StoreConflict):
                    runtime.preflight(self.root, self.repo, 'backend', 'ST-001', 'synthetic/project')
        finally: os.chdir(old)



class OutageCases(fixture.SyntheticOne):
    def test_pause_does_not_replace_a_human_stop(self):
        path = self.root / 'AGENT_STOP'; path.write_bytes(b'user-stop')
        self.assertFalse(execution.outage_window(self.root, 'pause')['launch_allowed'])
        self.assertEqual(b'user-stop', path.read_bytes())

    def test_resume_does_not_clear_a_human_stop(self):
        path = self.root / 'AGENT_STOP'; path.write_bytes(b'user-stop')
        with mock.patch.object(execution, 'ensure_idle') as provider:
            self.assertFalse(execution.outage_window(self.root, 'resume')['launch_allowed'])
            provider.assert_not_called()
        self.assertEqual(b'user-stop', path.read_bytes())

    def test_own_window_can_end_without_touching_feature_state(self):
        before = self.path.read_bytes(); execution.outage_window(self.root, 'pause')
        with mock.patch.object(execution, 'ensure_idle'):
            self.assertTrue(execution.outage_window(self.root, 'resume')['launch_allowed'])
        self.assertFalse((self.root / 'AGENT_STOP').exists()); self.assertEqual(before, self.path.read_bytes())

    def test_owner_supervisor_stop_prevents_window_resume(self):
        execution.outage_window(self.root, 'pause'); (self.root / 'SUPERVISOR_STOP').write_text('human')
        self.assertFalse(execution.outage_window(self.root, 'resume')['launch_allowed'])
        self.assertTrue((self.root / 'AGENT_STOP').exists())
        self.assertEqual('human', (self.root / 'SUPERVISOR_STOP').read_text())

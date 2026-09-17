"""Observe real execution carriers. No owner registry, leases or extra lock files."""
from __future__ import annotations
import argparse
import datetime
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from feature_store import StoreConflict, _storage_mutex
from github_evidence import EvidenceUnknown

STOPS = ('AGENT_STOP', 'SUPERVISOR_STOP', 'CANCEL_SCHEDULED_RESTART')


def stopped(root):
    return [name for name in STOPS if (Path(root) / name).exists()]


def snapshot():
    if os.name == 'nt':
        # CreationDate is what separates a live process from a later one that merely
        # reuses its number: Windows documents ProcessId and ParentProcessId as
        # reusable, so neither is an identity on its own.
        command = ('$ErrorActionPreference="Stop"; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); '
                   '@(Get-CimInstance Win32_Process -ErrorAction Stop | Select-Object ProcessId,ParentProcessId,Name,CommandLine,'
                   "@{n='Started';e={if ($_.CreationDate) { $_.CreationDate.ToString('o') } else { '' }}}) | ConvertTo-Json -Compress")
        result = subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', command],
                                capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=25)
        if result.returncode or not result.stdout.strip():
            raise EvidenceUnknown('Execution-provider process observation unavailable')
        rows = json.loads(result.stdout)
        if isinstance(rows, dict):
            rows = [rows]
        return [{'pid': r['ProcessId'], 'ppid': r['ParentProcessId'], 'name': r['Name'],
                 'command': r.get('CommandLine'), 'started': r.get('Started') or ''} for r in rows]
    proc = Path('/proc')
    if not proc.exists():
        raise EvidenceUnknown('No supported process observation provider')
    rows = []
    for directory in proc.iterdir():
        if not directory.name.isdigit():
            continue
        try:
            status = (directory / 'status').read_text()
            # Field 22 of stat, past the parenthesised comm, is the kernel start time.
            started = (directory / 'stat').read_text().rpartition(')')[2].split()[19]
            command = (directory / 'cmdline').read_bytes().replace(b'\0', b' ').decode('utf-8', 'replace')
            ppid = int(re.search(r'^PPid:\s+(\d+)', status, re.M).group(1))
            name = re.search(r'^Name:\s+(.+)', status, re.M).group(1)
            rows.append({'pid': int(directory.name), 'ppid': ppid, 'name': name, 'command': command,
                         'started': started})
        except (FileNotFoundError, ProcessLookupError):
            continue
        except (PermissionError, AttributeError, IndexError) as exc:
            raise EvidenceUnknown('Process identity cannot be inspected') from exc
    return rows


def identity(pids):
    """Bind each pid to the start stamp observed for it right now.

    MSYS emulates fork/exec with fresh Windows processes, so a child's recorded
    ParentProcessId routinely names an already-exited stub: ancestry alone never
    reaches the supervisor that launched a check, which then reads as a second
    execution. The launcher chain therefore publishes what it is, not merely what
    it is numbered, because a pid is reused and proves nothing on its own.

    The caller's own identity is required; ancestors are best effort, because a
    supervisor launched from outside MSYS reports its parent as pid 1.
    """
    observed = {row['pid']: row.get('started') or '' for row in snapshot()}
    known = [(pid, observed[pid]) for pid in dict.fromkeys(pids) if observed.get(pid)]
    if not pids or not known or known[0][0] != pids[0]:
        raise EvidenceUnknown('Own execution identity not observable for ' + json.dumps(pids[:1]))
    return ','.join(str(pid) + '@' + stamp for pid, stamp in known)


def published():
    """Parse STARTRIPS_OWN_PIDS into {pid: start stamp}. A bare pid never counts."""
    result = {}
    for part in os.environ.get('STARTRIPS_OWN_PIDS', '').split(','):
        pid, sep, stamp = part.strip().partition('@')
        if sep and pid.isdigit() and stamp:
            result[int(pid)] = stamp
    return result


def elsewhere(row, by_pid, aliases):
    """Whether a readable ancestor proves this process belongs to another tree.

    Some processes never expose a command line to the provider -- another user's
    session, a protected process -- and treating every one of them as a possible
    carrier of THIS workspace makes the guard unusable on any machine that also
    runs an editor or an agent. Their parentage is still readable, and a parent
    that is plainly somebody else's answers the question. Nothing is relaxed when
    the answer is absent: an orphan, or ancestors equally unreadable, stay UNKNOWN.
    """
    seen, pid = set(), row['ppid']
    while pid and pid not in seen:
        seen.add(pid)
        parent = by_pid.get(pid)
        if parent is None:
            return False
        command = parent.get('command')
        if isinstance(command, str) and command.strip():
            text = command.replace('\\', '/').lower()
            return ('startrips_execution_owner=' not in text
                    and not any(alias.rstrip('/') in text for alias in aliases))
        pid = parent['ppid']
    return False


def competitors(rows, root, self_pid):
    by_pid = {r['pid']: r for r in rows}
    if self_pid not in by_pid:
        raise EvidenceUnknown('Caller absent from process snapshot; ancestry unproven')
    ancestors, pid = set(), self_pid
    while pid and pid not in ancestors:
        ancestors.add(pid)
        pid = by_pid.get(pid, {}).get('ppid', 0)
    canonical = str(Path(root).resolve()).replace('\\', '/').lower()
    # Preserve the spelling handed to the process as well as its real path:
    # native Windows argv can retain an 8.3 spelling that resolve() expands.
    original = str(Path(root).absolute()).replace('\\', '/').lower()
    aliases = {canonical, original}
    mine = published()
    for spelling in tuple(aliases):
        if re.match(r'^[a-z]:/', spelling):
            aliases.add('/' + spelling[0] + spelling[2:])
    found = []
    for row in rows:
        if row['pid'] in ancestors:
            continue
        name = row['name'].lower()
        basename = name[:-4] if name.endswith('.exe') else name
        if basename not in {'bash', 'sh', 'claude', 'codex', 'node', 'nodejs'}:
            continue
        raw_command = row.get('command')
        if not isinstance(raw_command, str) or not raw_command.strip():
            # An unreadable command line is only OUR unknown while this process
            # could still belong to this workspace. A readable ancestor that
            # plainly belongs elsewhere settles that without weakening anything:
            # a broken chain, or ancestors we cannot read either, stay UNKNOWN.
            if elsewhere(row, by_pid, aliases):
                continue
            found.append({'pid': row['pid'], 'ppid': row['ppid'],
                          'kind': 'unknown-carrier', 'state': 'unknown-command'})
            continue
        command = raw_command.replace('\\', '/').lower()
        is_loop = bool(re.search(r'(?:^|[\s"/])(?:run-loop|loop-supervisor)[.]sh(?:[\s"\x00]|$)', command))
        is_child = 'startrips_execution_owner=' in command
        if not is_loop and not is_child:
            continue
        explicit_root = any(re.search(re.escape(alias.rstrip('/')) + r'(?=[/;\s"\x00]|$)', command)
                            for alias in aliases)
        if is_child and not explicit_root:
            continue
        # Inspect the SCRIPT argument, not whether the executable has an absolute
        # path. Windows commonly launches an absolute bash.exe with ./run-loop.sh.
        # Its cwd is then unknown, never evidence that the old execution ended.
        script = re.search(r'(?:^|\s)(?:"([^"]*(?:run-loop|loop-supervisor)[.]sh)"|([^\s"\']*(?:run-loop|loop-supervisor)[.]sh))(?=\s|$)', command)
        argument = next((part for part in script.groups() if part), '') if script else ''
        absolute_script = bool(re.match(r'^(?:[a-z]:/|/)', argument))
        if not explicit_root and absolute_script:
            continue
        # Only here, with the command line, the workspace and the carrier kind all
        # read, may a published identity excuse this row. A reused number cannot:
        # the start stamp must still match. An unreadable command line never
        # reaches this point, so UNKNOWN stays UNKNOWN.
        if row.get('started') and mine.get(row['pid']) == row.get('started'):
            continue
        found.append({'pid': row['pid'], 'ppid': row['ppid'],
                      'kind': 'worker' if is_child else 'loop',
                      'state': 'active' if explicit_root else 'unknown-cwd'})
    return found


def ensure_idle(root):
    rows = competitors(snapshot(), root, os.getpid())
    if any(row['kind'] == 'unknown-carrier' for row in rows):
        # A process created while the provider was enumerating has no command line
        # yet, and any machine that runs node or bash produces those constantly.
        # That is a sampling race, not an unreadable carrier, so look once more
        # before calling it unknown. A genuinely unreadable process stays unreadable.
        rows = competitors(snapshot(), root, os.getpid())
    if rows:
        raise EvidenceUnknown('Existing/unknown execution must finish: ' + json.dumps(rows))
    return {'provider': 'windows-cim' if os.name == 'nt' else 'procfs',
            'competing_executions': [], 'old_execution': 'ended',
            'observed_at': datetime.datetime.now(datetime.timezone.utc).isoformat()}


def permission_probe(root):
    directory = Path(root) / '.agent-artifacts'
    directory.mkdir(exist_ok=True)
    fd, name = tempfile.mkstemp(prefix='worker-permission-probe-', dir=directory)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(b'workspace-write-probe'); stream.flush(); os.fsync(stream.fileno())
        if Path(name).read_bytes() != b'workspace-write-probe':
            raise StoreConflict('Workspace write/read probe mismatch')
    finally:
        Path(name).unlink(missing_ok=True)
    return {'requested': 'inherit', 'actual_write_read_delete': 'success'}


def clear_owned_stop(root, name, expected):
    if name not in STOPS[:2]:
        raise StoreConflict('Cancellation is never cleared automatically')
    root = Path(root)
    with _storage_mutex(root / 'feature_list.json'):
        path = root / name
        if not path.exists():
            return False
        if path.read_bytes() != expected:
            raise StoreConflict('STOP changed ownership; preserve it')
        path.unlink()
        return True


def manual_resume(root):
    if os.environ.get('STARTRIPS_EXPLICIT_RESUME') != '1':
        raise StoreConflict('Clearing human STOP requires explicit local Resume')
    root = Path(root).resolve()
    ensure_idle(root)
    if (root / STOPS[2]).exists():
        raise StoreConflict('CANCEL_SCHEDULED_RESTART remains authoritative')
    before = {name: (root / name).read_bytes() for name in STOPS[:2] if (root / name).exists()}
    with _storage_mutex(root / 'feature_list.json'):
        if (root / STOPS[2]).exists():
            raise StoreConflict('Cancellation arrived before Resume')
        for name, raw in before.items():
            if not (root / name).exists() or (root / name).read_bytes() != raw:
                raise StoreConflict('STOP changed during explicit Resume')
        # This is an audit record of the user's command, not a dispatch/owner file.
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
        audit = root / '.agent-artifacts' / ('manual-resume-' + stamp + '.json')
        with audit.open('x', encoding='utf-8') as stream:
            json.dump({'explicit_resume': True, 'removed': list(before), 'time': stamp}, stream)
        for name in before:
            (root / name).unlink()
    return {'explicit_resume': True, 'cleared': list(before), 'worker_started': False}


def outage_window(root, mode):
    root = Path(root).resolve()
    tag = b'startrips-network-maintenance-window\n'
    path = root / 'AGENT_STOP'
    if mode == 'pause':
        with _storage_mutex(root / 'feature_list.json'):
            if stopped(root): return {'launch_allowed': False, 'reason': 'existing-stop-preserved'}
            try:
                with path.open('xb') as stream: stream.write(tag)
            except FileExistsError:
                return {'launch_allowed': False, 'reason': 'concurrent-stop-preserved'}
        return {'launch_allowed': False, 'reason': 'own-maintenance-boundary-created'}
    if mode != 'resume': raise StoreConflict('Unknown maintenance operation')
    if any((root / name).exists() for name in STOPS[1:]):
        return {'launch_allowed': False, 'reason': 'owner-stop-preserved'}
    if path.exists():
        raw = path.read_bytes()
        legacy = b'placed by the 04:00-05:00 outage window'
        if raw not in {tag, legacy + b'\n', legacy + b'\r\n'}:
            return {'launch_allowed': False, 'reason': 'other-owner-stop-preserved'}
        clear_owned_stop(root, 'AGENT_STOP', raw)
    if stopped(root): return {'launch_allowed': False, 'reason': 'concurrent-stop-preserved'}
    ensure_idle(root)
    return {'launch_allowed': True, 'reason': 'own-boundary-ended-no-competing-execution'}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['check', 'permission', 'resume', 'outage-pause',
                                           'outage-resume', 'identity'])
    parser.add_argument('root', type=Path)
    parser.add_argument('pids', nargs='*', type=int)
    args = parser.parse_args()
    try:
        if args.action == 'identity':
            print(identity(args.pids)); return 0
        if args.action == 'permission': result = permission_probe(args.root)
        elif args.action == 'resume': result = manual_resume(args.root)
        elif args.action.startswith('outage-'): result = outage_window(args.root, args.action.split('-', 1)[1])
        else: result = ensure_idle(args.root)
        result['stop_markers'] = stopped(args.root)
        print(json.dumps(result)); return 0
    except (StoreConflict, EvidenceUnknown, OSError, ValueError, subprocess.TimeoutExpired) as exc:
        print('EXECUTION_UNKNOWN: ' + str(exc), file=sys.stderr); return 6


if __name__ == '__main__':
    raise SystemExit(main())


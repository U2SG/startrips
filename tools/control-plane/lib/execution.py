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
        command = '$ErrorActionPreference="Stop"; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); @(Get-CimInstance Win32_Process -ErrorAction Stop | Select-Object ProcessId,ParentProcessId,Name,CommandLine) | ConvertTo-Json -Compress'
        result = subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', command],
                                capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=25)
        if result.returncode or not result.stdout.strip():
            raise EvidenceUnknown('Execution-provider process observation unavailable')
        rows = json.loads(result.stdout)
        if isinstance(rows, dict):
            rows = [rows]
        return [{'pid': r['ProcessId'], 'ppid': r['ParentProcessId'], 'name': r['Name'],
                 'command': r.get('CommandLine')} for r in rows]
    proc = Path('/proc')
    if not proc.exists():
        raise EvidenceUnknown('No supported process observation provider')
    rows = []
    for directory in proc.iterdir():
        if not directory.name.isdigit():
            continue
        try:
            status = (directory / 'status').read_text()
            command = (directory / 'cmdline').read_bytes().replace(b'\0', b' ').decode('utf-8', 'replace')
            ppid = int(re.search(r'^PPid:\s+(\d+)', status, re.M).group(1))
            name = re.search(r'^Name:\s+(.+)', status, re.M).group(1)
            rows.append({'pid': int(directory.name), 'ppid': ppid, 'name': name, 'command': command})
        except (FileNotFoundError, ProcessLookupError):
            continue
        except (PermissionError, AttributeError) as exc:
            raise EvidenceUnknown('Process identity cannot be inspected') from exc
    return rows


def own_pids():
    """Windows pids the launcher chain published for itself.

    MSYS emulates fork/exec with fresh Windows processes, so a child's recorded
    ParentProcessId can name an already-exited stub. Ancestry alone then never
    reaches the supervisor that launched this check, and it reads as a second
    execution. The launcher chain publishes its real Windows pids instead.
    """
    return {int(part) for part in os.environ.get('STARTRIPS_OWN_PIDS', '').split(',')
            if part.strip().isdigit()}


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
    # A published pid is this execution's own supervisor, and a direct child of
    # one is the fork stub MSYS leaves behind carrying the child's command line.
    published = own_pids()
    for spelling in tuple(aliases):
        if re.match(r'^[a-z]:/', spelling):
            aliases.add('/' + spelling[0] + spelling[2:])
    found = []
    for row in rows:
        if row['pid'] in ancestors or row['pid'] in published or row['ppid'] in published:
            continue
        name = row['name'].lower()
        basename = name[:-4] if name.endswith('.exe') else name
        if basename not in {'bash', 'sh', 'claude', 'codex', 'node', 'nodejs'}:
            continue
        raw_command = row.get('command')
        if not isinstance(raw_command, str) or not raw_command.strip():
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
        found.append({'pid': row['pid'], 'ppid': row['ppid'],
                      'kind': 'worker' if is_child else 'loop',
                      'state': 'active' if explicit_root else 'unknown-cwd'})
    return found


def ensure_idle(root):
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
    parser.add_argument('action', choices=['check', 'permission', 'resume', 'outage-pause', 'outage-resume'])
    parser.add_argument('root', type=Path)
    args = parser.parse_args()
    try:
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


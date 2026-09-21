"""Observe real execution carriers. No owner registry, leases or extra lock files."""
from __future__ import annotations
import argparse
import base64
import binascii
import datetime
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from feature_store import StoreConflict, _storage_mutex
from github_evidence import EvidenceUnknown

STOPS = ('AGENT_STOP', 'SUPERVISOR_STOP', 'CANCEL_SCHEDULED_RESTART')
LANE_CAPACITY = {'backend': 1, 'experience': 2}


def stopped(root, lane=None):
    # AGENT_STOP is the product-owner/global boundary. The other two markers
    # control only the dedicated LOCAL Backend supervisor/restart lifecycle and
    # must never strand the independent Experience lane.
    names = STOPS if lane in {None, 'backend'} else STOPS[:1]
    return [name for name in names if (Path(root) / name).exists()]


def snapshot():
    if os.name == 'nt':
        # CreationDate is what separates a live process from a later one that merely
        # reuses its number: Windows documents ProcessId and ParentProcessId as
        # reusable, so neither is an identity on its own.
        # Query only carrier-like executables plus this observer and its direct
        # parent. Even a property-bounded full Win32_Process enumeration can
        # stall on Windows hosts with a sick/slow process provider; filtering at
        # the provider keeps observation bounded without hiding relevant peers.
        candidate_names = ('bash.exe', 'sh.exe', 'claude.exe', 'codex.exe', 'node.exe', 'nodejs.exe')
        filter_terms = [f"Name='{name}'" for name in candidate_names]
        filter_terms.extend(f'ProcessId={pid}' for pid in {os.getpid(), os.getppid()} if pid > 0)
        process_filter = ' OR '.join(filter_terms)
        command = ('$ErrorActionPreference="Stop"; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); '
                   f'@(Get-CimInstance Win32_Process -Filter "{process_filter}" '
                   '-Property ProcessId,ParentProcessId,Name,CommandLine,CreationDate -ErrorAction Stop | '
                   'Select-Object ProcessId,ParentProcessId,Name,CommandLine,'
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


def command_token(command):
    """Return a bounded invocation token from Windows/MSYS observable argv."""
    if not isinstance(command, str):
        return None
    # MSYS/Win32 CommandLine reconstruction may render an argv item as either
    # `--carrier-token=value` or `--carrier-token value`, with optional quotes.
    # The unique token is invocation identity: every same-token run-loop carrier
    # is our own exec chain, while a separate launch necessarily has another token.
    match = re.search(
        r'(?:^|[\s"\'])--carrier-token(?:=|\s+)["\']?([a-z0-9._:-]{8,128})(?=$|[\s"\';])',
        command, re.I)
    return match.group(1) if match else None


def published_invocation_token(rows, mine):
    """Recover this invocation token only from exact published pid/start identities.

    MSYS can sever both native ancestry and one subprocess environment projection.
    The launcher/run-loop already publishes exact pid+CreationDate identities for
    this invocation. A token observed on one of those exact identities is therefore
    self evidence, not a peer inference. Multiple tokens fail closed.
    """
    tokens = {
        token
        for row in rows
        if mine.get(row.get('pid')) == row.get('started')
        for token in [command_token(row.get('command'))]
        if token
    }
    if len(tokens) > 1:
        raise EvidenceUnknown('Published execution identities disagree on carrier token')
    return next(iter(tokens), None)


def command_lane(command):
    """Return an explicitly observable execution lane, or None.

    Lane is execution-carrier metadata, not a feature owner registry. New loops
    publish `--carrier-lane=<lane>` on their command line; model workers already
    carry `lane=<lane>` inside STARTRIPS_EXECUTION_OWNER evidence. The dedicated
    local launcher is Backend by contract, which lets an already-running legacy
    supervisor be classified during a rolling control-plane upgrade.
    """
    if not isinstance(command, str) or not command.strip():
        return None
    text = command.replace('\\', '/').lower()
    for pattern in (
            r'--carrier-lane(?:=|\s+)(backend|experience)(?=$|[\s";])',
            r'(?:^|[;\s"])lane=(backend|experience)(?=$|[;\s"])',
            r'(?:^|[;\s"])startrips_lane=(backend|experience)(?=$|[;\s"])'):
        match = re.search(pattern, text)
        if match:
            return match.group(1)
    if re.search(r'(?:^|[\s"/])launch-supervisor[.]sh(?:[\s"\x00]|$)', text):
        return 'backend'
    return None


def lineage_lane(row, by_pid):
    """Best-effort lane inherited from a readable carrier ancestor."""
    seen, pid = set(), row.get('ppid', 0)
    while pid and pid not in seen:
        seen.add(pid)
        parent = by_pid.get(pid)
        if parent is None:
            return None
        lane = command_lane(parent.get('command'))
        if lane:
            return lane
        pid = parent.get('ppid', 0)
    return None


def command_is_readonly_probe(command):
    """Read-only run-loop queries are observers, never execution carriers."""
    if not isinstance(command, str) or not command.strip():
        return False
    text = command.replace('\\', '/').lower()
    if not re.search(r'(?:^|[\s"/])run-loop[.]sh(?:[\s"\x00]|$)', text):
        return False
    return bool(re.search(
        r'(?:^|[\s"])--(?:next|next-action|plan|work-prs|ready-prs|pr-review)(?=$|[;\s"])',
        text))


def lineage_is_readonly_probe(row, by_pid):
    """True only when the nearest execution-relevant ancestor is a read-only probe.

    This lets a just-born MSYS child inherit the observer/non-carrier identity of
    --next/--plan without walking through a real carrier token or scoped owner.
    """
    seen, pid = set(), row.get('ppid', 0)
    while pid and pid not in seen:
        seen.add(pid)
        parent = by_pid.get(pid)
        if parent is None:
            return False
        raw = parent.get('command')
        if command_is_readonly_probe(raw):
            return True
        if command_token(raw):
            return False
        if isinstance(raw, str) and raw.strip():
            feature, worktree = command_scope(raw)
            if feature and worktree:
                return False
        pid = parent.get('ppid', 0)
    return False


def lineage_token(row, by_pid):
    """Return the nearest observable carrier token in this ancestry, if any."""
    seen, pid = set(), row.get('ppid', 0)
    while pid and pid not in seen:
        seen.add(pid)
        parent = by_pid.get(pid)
        if parent is None:
            return None
        token = command_token(parent.get('command'))
        if token:
            return token
        pid = parent.get('ppid', 0)
    return None


def lineage_scope(row, by_pid, current_token=None):
    """Inherit a complete owner scope only inside one proven invocation chain.

    MSYS can momentarily expose a descendant with no CommandLine, or reconstruct a
    same-token run-loop argv without the later feature/worktree arguments. A complete
    ancestor scope is still authoritative only while no different carrier token is
    crossed. A different token is a new claim and must remain visible/fail-closed.
    """
    seen, pid, expected_token = set(), row.get('ppid', 0), current_token
    while pid and pid not in seen:
        seen.add(pid)
        parent = by_pid.get(pid)
        if parent is None:
            return None, None, None
        raw = parent.get('command')
        parent_token = command_token(raw)
        if parent_token:
            if expected_token and parent_token != expected_token:
                return None, None, None
            expected_token = expected_token or parent_token
        if isinstance(raw, str) and raw.strip():
            feature, worktree = command_scope(raw)
            scope_marker = bool(re.search(
                r'(?:^|[;\s"])(?:--carrier-)?(?:feature|worktree|worktree64)=', raw, re.I))
            if scope_marker and not (feature and worktree):
                return None, None, None
            if feature and worktree:
                return feature, worktree, expected_token or parent_token
        pid = parent.get('ppid', 0)
    return None, None, None


def invocation_cluster(rows, own_token):
    """Provider-visible pids proven to belong to this exact tokenized invocation.

    MSYS may represent one exec as several Windows processes. Some intermediate
    carriers can have an unreadable CommandLine even while an adjacent carrier
    still exposes our unique token. Seed only from that exact token, then include
    its direct ancestry and descendants; never walk sideways through a shared
    ancestor, so a separate launch remains outside the cluster.
    """
    if not own_token:
        return set()
    by_pid = {row['pid']: row for row in rows}
    seeds = {row['pid'] for row in rows if command_token(row.get('command')) == own_token}
    if not seeds:
        return set()
    ancestors = set()
    for seed in tuple(seeds):
        seen, pid = set(), by_pid.get(seed, {}).get('ppid', 0)
        while pid and pid not in seen:
            seen.add(pid); ancestors.add(pid)
            pid = by_pid.get(pid, {}).get('ppid', 0)
    # Descend only from token-bearing seeds/descendants, never from their
    # ancestors: two independent launches may share a terminal/parent shell.
    descendants = set(seeds)
    changed = True
    while changed:
        changed = False
        for row in rows:
            if row['pid'] not in descendants and row.get('ppid', 0) in descendants:
                descendants.add(row['pid']); changed = True
    return seeds | ancestors | descendants


def command_scope(command):
    """Return exact feature/worktree markers when a model carrier publishes them."""
    if not isinstance(command, str) or not command.strip():
        return None, None
    feature_match = re.search(r'(?:^|[;\s"])(?:--carrier-)?feature=(ST-\d{3,})(?=$|[;\s"])', command, re.I)
    # Exact worktree scope is always base64url, for both run-loop carriers and
    # model workers. Legacy raw worktree markers are recognized only as incomplete
    # scope by competitors() and therefore fail closed across lanes.
    encoded_worktree_match = re.search(
        r'(?:^|[;\s"])(?:--carrier-)?worktree64=([A-Za-z0-9_-]+)(?=;|[\s"]|$)', command, re.I)
    if re.search(r'(?:^|[;\s"])(?:--carrier-)?worktree64=', command, re.I) and not encoded_worktree_match:
        raise EvidenceUnknown('Malformed encoded owner worktree marker')
    feature = feature_match.group(1).upper() if feature_match else None
    worktree = None
    if encoded_worktree_match:
        token = encoded_worktree_match.group(1)
        try:
            worktree = base64.b64decode(token + '=' * (-len(token) % 4),
                                        altchars=b'-_', validate=True).decode('utf-8')
        except (binascii.Error, UnicodeDecodeError, ValueError) as exc:
            raise EvidenceUnknown('Malformed encoded owner worktree marker') from exc
    return feature, worktree_key(worktree)


def worktree_key(path):
    """Comparable worktree identity without changing legal path characters."""
    if path is None:
        return None
    value = str(path).replace('\\', '/')
    return value.casefold() if os.name == 'nt' else value


def normalize_worktree(path):
    if not path:
        return None
    return worktree_key(Path(path).resolve())


def decode_worktree64(token):
    if not token or not re.fullmatch(r'[A-Za-z0-9_-]+', token):
        raise EvidenceUnknown('Malformed encoded owner worktree marker')
    try:
        value = base64.b64decode(token + '=' * (-len(token) % 4),
                                 altchars=b'-_', validate=True).decode('utf-8')
    except (binascii.Error, UnicodeDecodeError, ValueError) as exc:
        raise EvidenceUnknown('Malformed encoded owner worktree marker') from exc
    return worktree_key(value)


def _observed_executions(rows, root, self_pid):
    """Return provider-visible execution carriers after exact self exclusion."""
    by_pid = {r['pid']: r for r in rows}
    if self_pid not in by_pid:
        raise EvidenceUnknown('Caller absent from process snapshot; ancestry unproven')
    ancestors, pid = set(), self_pid
    while pid and pid not in ancestors:
        ancestors.add(pid)
        pid = by_pid.get(pid, {}).get('ppid', 0)
    canonical = str(Path(root).resolve()).replace('\\', '/').lower()
    original = str(Path(root).absolute()).replace('\\', '/').lower()
    aliases = {canonical, original}
    mine = published()
    # MSYS may lose exported environment on one native subprocess carrier even
    # though the parent run-loop argv still carries the exact invocation token.
    # Recover only from the caller's own ancestry; never infer from a peer.
    own_token = (os.environ.get('STARTRIPS_CARRIER_TOKEN')
                 or lineage_token(by_pid[self_pid], by_pid)
                 or published_invocation_token(rows, mine))
    own_cluster = invocation_cluster(rows, own_token)
    for spelling in tuple(aliases):
        if re.match(r'^[a-z]:/', spelling):
            aliases.add('/' + spelling[0] + spelling[2:])

    observed = []
    for row in rows:
        if row['pid'] in ancestors:
            continue
        name = row['name'].lower()
        basename = name[:-4] if name.endswith('.exe') else name
        if basename not in {'bash', 'sh', 'claude', 'codex', 'node', 'nodejs'}:
            continue
        if row.get('started') and mine.get(row['pid']) == row.get('started'):
            continue
        if row['pid'] in own_cluster:
            continue

        raw_command = row.get('command')
        inherited_lane = lineage_lane(row, by_pid)
        if not isinstance(raw_command, str) or not raw_command.strip():
            if lineage_is_readonly_probe(row, by_pid):
                continue
            inherited_feature, inherited_worktree, inherited_token = lineage_scope(row, by_pid)
            if inherited_feature and inherited_worktree:
                observed.append({'pid': row['pid'], 'ppid': row['ppid'],
                                 'kind': 'unknown-carrier', 'state': 'inherited-scope',
                                 'lane': inherited_lane or 'unknown', 'feature': inherited_feature,
                                 'worktree': inherited_worktree, 'token': inherited_token,
                                 'scope_marker': True, 'scope_complete': True})
            else:
                inherited_token = lineage_token(row, by_pid)
                if inherited_token and inherited_lane:
                    observed.append({'pid': row['pid'], 'ppid': row['ppid'],
                                     'kind': 'unknown-carrier', 'state': 'inherited-claim',
                                     'lane': inherited_lane, 'feature': None,
                                     'worktree': None, 'token': inherited_token,
                                     'scope_marker': False, 'scope_complete': False})
                else:
                    observed.append({'pid': row['pid'], 'ppid': row['ppid'],
                                     'kind': 'unknown-carrier', 'state': 'unknown-command',
                                     'lane': inherited_lane or 'unknown', 'feature': None,
                                     'worktree': None, 'token': None,
                                     'scope_marker': False, 'scope_complete': False})
            continue

        command = raw_command.replace('\\', '/').lower()
        is_loop = bool(re.search(r'(?:^|[\s"/])(?:run-loop|loop-supervisor)[.]sh(?:[\s"\x00]|$)', command))
        is_child = 'startrips_execution_owner=' in command
        # The dedicated LOCAL Backend supervisor is a resident scheduler, not a
        # productive owner. Keep it observable so duplicate-launch/self-block
        # guards still see the live supervisor; lane_occupancy alone discounts
        # it and counts the scoped run-loop/model child when one exists.
        is_resident_backend_supervisor = bool(
            re.search(r'(?:^|[\s"/])loop-supervisor[.]sh(?:[\s"\x00]|$)', command)
            and command_lane(raw_command) == 'backend'
            and command_token(raw_command) is None
            and not re.search(r'(?:^|[;\s"])(?:--carrier-)?(?:feature|worktree|worktree64)=', raw_command, re.I)
        )
        if is_loop and command_is_readonly_probe(raw_command):
            continue
        if not is_loop and not is_child:
            continue
        explicit_root = any(re.search(re.escape(alias.rstrip('/')) + r'(?=[/;\s"\x00]|$)', command)
                            for alias in aliases)
        if is_child and not explicit_root:
            continue
        script = re.search(r'(?:^|\s)(?:"([^"]*(?:run-loop|loop-supervisor)[.]sh)"|([^\s"\']*(?:run-loop|loop-supervisor)[.]sh))(?=\s|$)', command)
        argument = next((part for part in script.groups() if part), '') if script else ''
        absolute_script = bool(re.match(r'^(?:[a-z]:/|/)', argument))
        if not explicit_root and absolute_script:
            continue

        carrier_lane = command_lane(raw_command) or inherited_lane
        carrier_token = command_token(raw_command)
        carrier_feature, carrier_worktree = command_scope(raw_command)
        scope_marker = bool(re.search(
            r'(?:^|[;\s"])(?:--carrier-)?(?:feature|worktree|worktree64)=', raw_command, re.I))
        scope_complete = carrier_feature is not None and carrier_worktree is not None
        if not scope_marker and not scope_complete:
            inherited_feature, inherited_worktree, inherited_token = lineage_scope(
                row, by_pid, current_token=carrier_token)
            if inherited_feature and inherited_worktree:
                carrier_feature, carrier_worktree = inherited_feature, inherited_worktree
                carrier_token = carrier_token or inherited_token
                scope_complete = True
        observed.append({
            'pid': row['pid'], 'ppid': row['ppid'],
            'kind': 'worker' if is_child else 'loop',
            'state': 'active' if explicit_root else 'unknown-cwd',
            'lane': carrier_lane or 'unknown',
            'feature': carrier_feature, 'worktree': carrier_worktree,
            'token': carrier_token,
            'scope_marker': scope_marker, 'scope_complete': scope_complete,
            'resident_scheduler': is_resident_backend_supervisor,
        })
    return observed


def _public_record(record, *, state=None):
    # Carrier tokens are non-secret invocation identity already published in
    # argv. Preserve them in failure evidence so a transient pre-scope row can
    # be compared with the launcher's exact token after the process disappears.
    return {
        'pid': record['pid'], 'ppid': record['ppid'], 'kind': record['kind'],
        'state': state or record['state'], 'lane': record['lane'],
        'feature': record.get('feature'), 'worktree': record.get('worktree'),
        'token': record.get('token'),
    }


def lane_occupancy(rows, root, self_pid, lane):
    """Return distinct live owner scopes for one lane without creating a registry."""
    if lane not in LANE_CAPACITY:
        raise ValueError('Execution lane must be backend or experience')
    scoped, claims, unknown, scoped_tokens = {}, {}, [], set()
    for record in _observed_executions(rows, root, self_pid):
        carrier_lane = record['lane']
        # A carrier whose lineage proves a different lane is not part of this
        # lane's capacity, even when its own CommandLine is temporarily unreadable.
        # Unknown lane or unreadable state inside the requested lane stays fail-closed.
        if carrier_lane not in {lane, 'unknown'}:
            continue
        if lane == 'backend' and record.get('resident_scheduler'):
            continue
        if record['state'] == 'unknown-command' or carrier_lane == 'unknown':
            unknown.append(_public_record(record))
            continue
        if record['scope_complete']:
            key = (record['feature'], record['worktree'])
            scoped.setdefault(key, record)
            if record.get('token'):
                scoped_tokens.add(record['token'])
        elif record['token']:
            claims.setdefault(record['token'], record)
        else:
            unknown.append(_public_record(record, state='unknown-scope'))
    if unknown:
        raise EvidenceUnknown('Execution occupancy is unknown: ' + json.dumps(unknown))
    claims = {token: record for token, record in claims.items() if token not in scoped_tokens}
    used = len(scoped) + len(claims)
    return {
        'lane': lane,
        'capacity': LANE_CAPACITY[lane],
        'occupied_slots': used,
        'available_slots': max(0, LANE_CAPACITY[lane] - used),
        'features': sorted({feature for feature, _ in scoped}),
        'worktrees': sorted({worktree for _, worktree in scoped}),
        'claim_count': len(claims),
    }


def observed_lane_occupancy(root, lane):
    """Bounded provider stabilization for process-birth CommandLine races.

    Windows CIM can enumerate a newly-created bash/node process before its
    CommandLine is populated. Give that provider-only observation at most 100 ms
    to become classifiable. Persistent uncertainty still raises/fails closed.
    """
    last = None
    for attempt in range(3):
        try:
            return lane_occupancy(snapshot(), root, os.getpid(), lane)
        except EvidenceUnknown as exc:
            last = exc
            if attempt < 2:
                time.sleep(0.05)
    raise last


def competitors(rows, root, self_pid, lane=None, feature=None, worktree=None, worktree64=None):
    if lane not in {None, 'backend', 'experience'}:
        raise ValueError('Execution lane must be backend, experience or omitted')
    if worktree is not None and worktree64 is not None:
        raise ValueError('Specify owner worktree once')
    wanted_feature = feature.upper() if isinstance(feature, str) and feature else None
    wanted_worktree = decode_worktree64(worktree64) if worktree64 is not None else normalize_worktree(worktree)
    conflicts, same_lane_scoped, same_lane_claims, same_lane_scoped_tokens = [], {}, {}, set()

    for record in _observed_executions(rows, root, self_pid):
        carrier_lane = record['lane']
        if record['state'] == 'unknown-command':
            # An unreadable carrier in a proven different lane is independent.
            # Same-lane or lane-unknown evidence remains fail-closed.
            if lane is not None and carrier_lane not in {lane, 'unknown'}:
                continue
            conflicts.append(_public_record(record))
            continue
        if lane is None or carrier_lane == 'unknown':
            conflicts.append(_public_record(record))
            continue
        same_scope = bool((wanted_feature and record.get('feature') == wanted_feature)
                          or (wanted_worktree and record.get('worktree') == wanted_worktree))
        if carrier_lane != lane:
            if same_scope:
                conflicts.append(_public_record(record))
            elif record['scope_marker'] and not record['scope_complete']:
                conflicts.append(_public_record(record, state='unknown-scope'))
            continue

        if lane == 'backend':
            conflicts.append(_public_record(record))
            continue

        # Experience has two logical owner slots. Distinct fully-scoped owners can
        # coexist; a same-scope owner is always a duplicate. Unscoped claims are
        # serialized so two selectors can never race for the same next feature.
        if same_scope:
            conflicts.append(_public_record(record))
        elif record['scope_complete']:
            same_lane_scoped.setdefault((record['feature'], record['worktree']), record)
            if record.get('token'):
                same_lane_scoped_tokens.add(record['token'])
        elif record['token']:
            same_lane_claims.setdefault(record['token'], record)
        else:
            conflicts.append(_public_record(record, state='unknown-scope'))

    if lane == 'experience':
        same_lane_claims = {
            token: record for token, record in same_lane_claims.items()
            if token not in same_lane_scoped_tokens
        }
        # Only one selector/claim transition runs at once. Once scoped, up to two
        # different Experience owners may execute concurrently.
        conflicts.extend(_public_record(record) for record in same_lane_claims.values())
        if len(same_lane_scoped) >= LANE_CAPACITY['experience']:
            conflicts.extend(_public_record(record) for record in same_lane_scoped.values())

    return conflicts



def ensure_idle(root, lane=None, feature=None, worktree=None, worktree64=None):
    rows = []
    for attempt in range(3):
        rows = competitors(snapshot(), root, os.getpid(), lane=lane, feature=feature,
                           worktree=worktree, worktree64=worktree64)
        if not any(row['kind'] == 'unknown-carrier' for row in rows):
            break
        # A just-created process can lack CommandLine for a few milliseconds.
        # Re-observe only the provider; never retry owner work or weaken a real claim.
        if attempt < 2:
            time.sleep(0.05)
    if rows:
        raise EvidenceUnknown('Existing/unknown execution must finish: ' + json.dumps(rows))
    observed_worktree = decode_worktree64(worktree64) if worktree64 is not None else normalize_worktree(worktree)
    return {'provider': 'windows-cim' if os.name == 'nt' else 'procfs',
            'lane': lane or 'global', 'feature': feature, 'worktree': observed_worktree,
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
    if (root / STOPS[2]).exists():
        raise StoreConflict('CANCEL_SCHEDULED_RESTART remains authoritative')
    before = {name: (root / name).read_bytes() for name in STOPS[:2] if (root / name).exists()}
    # Clearing AGENT_STOP changes the global owner boundary, so that case must
    # prove every lane idle. Stopless / Backend-only Resume stays lane-scoped.
    if 'AGENT_STOP' in before:
        ensure_idle(root)
    else:
        ensure_idle(root, lane='backend')
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
        # This removes the global stop, so every lane must have ended first.
        ensure_idle(root)
        clear_owned_stop(root, 'AGENT_STOP', raw)
    if stopped(root): return {'launch_allowed': False, 'reason': 'concurrent-stop-preserved'}
    ensure_idle(root, lane='backend')
    return {'launch_allowed': True, 'reason': 'own-boundary-ended-no-competing-backend-execution'}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['check', 'occupied', 'permission', 'resume', 'outage-pause',
                                           'outage-resume', 'identity'])
    parser.add_argument('root', type=Path)
    parser.add_argument('pids', nargs='*', type=int)
    parser.add_argument('--lane', choices=['backend', 'experience'])
    parser.add_argument('--feature')
    parser.add_argument('--worktree')
    parser.add_argument('--worktree64')
    args = parser.parse_args()
    try:
        report_lane = args.lane or os.environ.get('STARTRIPS_LANE') or None
        if args.action == 'identity':
            print(identity(args.pids)); return 0
        if args.action == 'permission': result = permission_probe(args.root)
        elif args.action == 'occupied':
            if report_lane not in LANE_CAPACITY:
                raise ValueError('occupied requires an explicit execution lane')
            result = observed_lane_occupancy(args.root, report_lane)
        elif args.action == 'resume': result = manual_resume(args.root)
        elif args.action.startswith('outage-'): result = outage_window(args.root, args.action.split('-', 1)[1])
        else:
            result = ensure_idle(args.root, lane=report_lane, feature=args.feature,
                                 worktree=args.worktree, worktree64=args.worktree64)
        result['stop_markers'] = stopped(args.root, lane=report_lane)
        print(json.dumps(result)); return 0
    except (StoreConflict, EvidenceUnknown, OSError, ValueError, subprocess.TimeoutExpired) as exc:
        print('EXECUTION_UNKNOWN: ' + str(exc), file=sys.stderr); return 6


if __name__ == '__main__':
    raise SystemExit(main())


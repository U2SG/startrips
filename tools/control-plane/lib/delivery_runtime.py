"""Exact-byte activation evidence for package-aware consumers.

This receipt is installation evidence, never ownership or a selector. A package
is disabled on missing/drifted evidence; ordinary single-issue work continues.
Activation uses the existing STOP/storage/provider boundary and never kills or
restarts an owner. Conflicting hot runtime changes must be reconciled in Source.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import uuid
from feature_store import StoreConflict, _storage_mutex
from github_evidence import api, EvidenceUnknown
from ci_observer import write_json
from types import SimpleNamespace

VERSION = 1
RECEIPT = '.agent-artifacts/evaluations/delivery-runtime.json'
# Only files whose submitted Source actually carries package semantics are part
# of the activation manifest.  Launchers/provider observers that merely invoke
# these consumers are deliberately excluded: copying their unchanged Source
# bytes would roll back unrelated live reliability fixes while adding no package
# awareness.  A conflicting hot change to one of THESE files still fails closed
# until the package Source demonstrably subsumes it.
REQUIRED = (
    'CLAUDE.md', 'README.md', 'run-loop.sh',
    'lib/delivery.py', 'lib/delivery_issues.py', 'lib/delivery_package.py',
    'lib/delivery_runtime.py', 'lib/feature_store.py', 'lib/feature_state.py',
    'lib/runtime_preflight.py', 'lib/action_plan.py', 'lib/policy_audit.py',
    'lib/seal_owner.py', 'lib/evidence_capture.py', 'lib/intake.sh',
    '.claude/agents/startrips-evaluator.md', '.claude/agents/startrips-triage.md',
)

# Exact predecessor -> submitted-byte pairs independently visible in Source review.
# This is deliberately narrower than a semantic/fuzzy merge allowance: an entry
# authorizes only one observed live consumer body to be replaced by one exact
# reviewed package-aware body. Any later live drift or Source edit stops matching
# and activation fails closed. These three pairs preserve already-installed
# control-plane fixes whose package-aware convergence required manual conflict
# resolution rather than a byte-identical clean three-way merge.
REVIEWED_HOT_PREDECESSORS = {
    'lib/feature_store.py': {
        '98e1799a87dfdd778b24fbc4bd84989d9f96080442305ebebe8dc22bd87ce275':
        'e81b0082d503d28fefe97fa008741ac0d538bb51f0e3ba1d5853acaa393aff11',
    },
    'lib/feature_state.py': {
        '054c3ac531884661dcc0d95449a2308613270ced1166f6cd3b66209e9268f301':
        'd7fd5a7ad12af3d5bbe919c881514a1a6875cbd26a9d4d7953655843d1e2daff',
    },
    'lib/action_plan.py': {
        '93f6dbc6e6cfbff2cf1687aaab6a30348ff8feb9a75387430695f0858f39cf73':
        '0fd225f644db7aa98e0f2d7ec78c731f0c01e0ffb35dfff8a44dec4a08f93b42',
    },
}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def require_source_ci(repo, source):
    result = api('repos/' + repo + '/actions/workflows/control-plane.yml/runs?head_sha=' + source + '&per_page=100')
    runs = [r for r in result.get('workflow_runs', []) if r.get('head_sha') == source]
    if not runs:
        raise EvidenceUnknown('No exact Source control-plane CI')
    run = max(runs, key=lambda r: (r['id'], r['run_attempt']))
    if run.get('status') != 'completed' or run.get('conclusion') != 'success':
        raise EvidenceUnknown('Exact Source control-plane CI is not SUCCESS')
    return {'run': run['id'], 'attempt': run['run_attempt'], 'head_sha': source,
            'conclusion': 'success'}


def verify(root, *, live=False, repo='U2SG/startrips'):
    root = Path(root).resolve(); path = root / RECEIPT
    if not path.is_file():
        raise StoreConflict('DELIVERY_RUNTIME_NOT_INSTALLED')
    value = json.loads(path.read_bytes())
    if (value.get('schema_version') != VERSION or not value.get('boundary_verified')
            or not re.fullmatch(r'[0-9a-f]{40}', str(value.get('source_sha') or ''))
            or set(value.get('files', {})) != set(REQUIRED)
            or value.get('ci', {}).get('head_sha') != value['source_sha']
            or value.get('ci', {}).get('conclusion') != 'success'):
        raise StoreConflict('Invalid package runtime activation evidence')
    for name in REQUIRED:
        file = (root / name).resolve()
        if not file.is_relative_to(root) or not file.is_file() or sha(file.read_bytes()) != value['files'][name]:
            raise StoreConflict('DELIVERY_RUNTIME_DRIFT: ' + name)
    if live:
        require_source_ci(repo, value['source_sha'])
    return value


def git(repository, *args):
    proc = subprocess.run(['git', '-C', str(repository), *args], capture_output=True, timeout=30)
    if proc.returncode:
        raise EvidenceUnknown('Runtime Source git evidence unavailable: ' + ' '.join(args[:2]))
    return proc.stdout


def _normalize(body):
    return body.replace(b'\r\n', b'\n') if body is not None else None


def _historical_predecessor(repository, base, relative, current):
    """True when the installed consumer is an older committed version of base."""
    if current is None:
        return False
    commits = git(repository, 'log', '--format=%H', base, '--', relative).decode().splitlines()
    wanted = _normalize(current)
    for commit in commits:
        body = subprocess.run(['git', '-C', str(repository), 'show', commit + ':' + relative],
                              capture_output=True, timeout=15)
        if body.returncode == 0 and _normalize(body.stdout) == wanted:
            return True
    return False


def _subsumed_hot_runtime(incoming, old, current):
    """Prove a live hot patch is already included in the submitted Source bytes."""
    if incoming is None or old is None or current is None:
        return False
    with tempfile.TemporaryDirectory() as directory:
        directory = Path(directory)
        local, base, remote = directory / 'incoming', directory / 'base', directory / 'current'
        local.write_bytes(_normalize(incoming)); base.write_bytes(_normalize(old)); remote.write_bytes(_normalize(current))
        merged = subprocess.run(['git', 'merge-file', '-p', str(local), str(base), str(remote)],
                                capture_output=True, timeout=20)
    return merged.returncode == 0 and _normalize(merged.stdout) == _normalize(incoming)


def _reviewed_hot_predecessor(name, incoming, current):
    """Accept only an exact live/body pair explicitly frozen in reviewed Source."""
    if incoming is None or current is None:
        return False
    current_sha = sha(_normalize(current))
    incoming_sha = sha(_normalize(incoming))
    return REVIEWED_HOT_PREDECESSORS.get(name, {}).get(current_sha) == incoming_sha


def activation_plan(root, repository, base):
    root, repository = Path(root).resolve(), Path(repository).resolve()
    if git(repository, 'status', '--porcelain').strip():
        raise StoreConflict('Runtime Source must be a clean submitted commit')
    source = git(repository, 'rev-parse', 'HEAD').decode().strip()
    subprocess.run(['git', '-C', str(repository), 'merge-base', '--is-ancestor', base, source],
                   check=True, capture_output=True, timeout=15)
    result = {'source_sha': source, 'files': {}, 'expected': {}, 'conflicts': [], 'compatibility': {}}
    for name in REQUIRED:
        relative = 'tools/control-plane/' + name
        incoming = git(repository, 'show', source + ':' + relative)
        installed = root / name
        current = installed.read_bytes() if installed.is_file() else None
        old = subprocess.run(['git', '-C', str(repository), 'show', base + ':' + relative],
                             capture_output=True, timeout=15)
        if current is not None and _normalize(current) != _normalize(incoming):
            if old.returncode == 0 and _normalize(current) == _normalize(old.stdout):
                result['compatibility'][name] = 'exact-base'
            elif old.returncode == 0 and _historical_predecessor(repository, base, relative, current):
                result['compatibility'][name] = 'stale-committed-predecessor'
            elif old.returncode == 0 and _subsumed_hot_runtime(incoming, old.stdout, current):
                result['compatibility'][name] = 'live-hot-change-subsumed-by-source'
            elif _reviewed_hot_predecessor(name, incoming, current):
                result['compatibility'][name] = 'reviewed-hot-predecessor'
            else:
                result['conflicts'].append(name)
        elif current is None and old.returncode == 0:
            result['conflicts'].append(name)  # Never silently recreate a missing legacy consumer.
        elif current is not None:
            result['compatibility'][name] = 'already-source'
        else:
            result['compatibility'][name] = 'new-source-consumer'
        result['files'][name] = sha(incoming)
        result['expected'][name] = sha(current) if current is not None else None
    return result


def _replace(path, body):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix='.' + path.name + '.', suffix='.tmp', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(body); stream.flush(); os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def _read_predecessor(path):
    # Only absence is a legitimate empty predecessor; unreadable is UNKNOWN.
    try:
        return path.read_bytes()
    except FileNotFoundError:
        return None


def _restore_predecessors(root, originals):
    """Best-effort rollback followed by a separate, complete exact-byte proof."""
    errors = []
    for name, old in reversed(list(originals.items())):
        path = root / name
        try:
            if _read_predecessor(path) == old:
                continue
            if old is None:
                path.unlink(missing_ok=True)
            else:
                _replace(path, old)
        except OSError as exc:
            # One locked file must not prevent restoration of other consumers.
            errors.append(name + ': ' + str(exc))
    for name, old in originals.items():
        try:
            if _read_predecessor(root / name) != old:
                errors.append(name + ': predecessor readback mismatch')
        except OSError as exc:
            errors.append(name + ': predecessor readback unavailable: ' + str(exc))
    return errors


def activate(root, repository, base, expected, repo):
    # Activation-only imports keep read-only selector/runtime verification usable
    # in legacy/synthetic consumers that intentionally expose only a minimal
    # execution provider surface. Ordinary single-issue work must not depend on
    # activation-only process controls being importable.
    from execution import ensure_idle, clear_owned_stop
    from external_execution import occupancy
    root, repository = Path(root).resolve(), Path(repository).resolve()
    planned = activation_plan(root, repository, base)
    if planned['conflicts']:
        raise StoreConflict('Preserve existing hot runtime changes: ' + ', '.join(planned['conflicts']))
    if planned['expected'] != expected:
        raise StoreConflict('Runtime bytes changed after the activation plan')
    ci = require_source_ci(repo, planned['source_sha'])
    activation_id = uuid.uuid4().hex
    tag = ('delivery-activation:' + activation_id + '\n').encode()
    stop = root / 'AGENT_STOP'
    # Existing human STOP is never cleared or repurposed by this operation.
    try:
        with stop.open('xb') as stream:
            stream.write(tag); stream.flush(); os.fsync(stream.fileno())
    except FileExistsError as exc:
        raise StoreConflict('Existing owner STOP preserved; package activation deferred') from exc
    originals = {}
    # Before the first runtime/receipt mutation a failed preflight may release
    # only its own STOP. Once installation starts, release requires positive proof
    # of either the complete new runtime or the complete predecessor restoration.
    safe_to_resume = True
    recovery = root / '.agent-artifacts/evaluations' / ('delivery-activation-' + activation_id)
    try:
        ensure_idle(root)
        if occupancy(SimpleNamespace(root=str(root)))['occupied_slots']:
            raise StoreConflict('Old external execution has not drained; package activation deferred')
        with _storage_mutex(root / 'feature_list.json'):
            # No model/owner is running and the existing STOP prevents a fresh launch.
            for name in REQUIRED:
                body = _read_predecessor(root / name)
                if (sha(body) if body is not None else None) != expected[name]:
                    raise StoreConflict('Runtime drifted at the safe boundary: ' + name)
                originals[name] = body
            # A failed verify may happen AFTER the new receipt was published.
            # Restore its exact previous bytes (or absence), not just runtime files.
            originals[RECEIPT] = _read_predecessor(root / RECEIPT)
            # Durable predecessor evidence survives even a rollback/process failure.
            # This directory is recovery evidence, never an owner/dispatch registry.
            for name, body in originals.items():
                if body is not None:
                    _replace(recovery / 'predecessors' / name, body)
                    if (recovery / 'predecessors' / name).read_bytes() != body:
                        raise StoreConflict('Activation predecessor backup mismatch: ' + name)
            write_json(recovery / 'recovery.json', {
                'source_sha': planned['source_sha'], 'owned_stop': tag.decode(),
                'predecessors': {name: sha(body) if body is not None else None
                                 for name, body in originals.items()},
            })
            if _read_predecessor(stop) != tag:
                raise StoreConflict('Activation STOP changed ownership; no runtime installed')
            safe_to_resume = False
            try:
                for name in REQUIRED:
                    body = git(repository, 'show', planned['source_sha'] + ':tools/control-plane/' + name)
                    _replace(root / name, body)
                evidence = {'schema_version': VERSION, 'source_sha': planned['source_sha'],
                            'files': planned['files'], 'ci': ci, 'boundary_verified': True}
                write_json(root / RECEIPT, evidence)
                if verify(root) != evidence:
                    raise StoreConflict('Installed activation receipt changed during verification')
                safe_to_resume = True
            except BaseException as failure:
                # Check ALL predecessors, including a write that replaced its file
                # before raising. Returning from rollback is not restoration proof.
                errors = _restore_predecessors(root, originals)
                if errors:
                    try:
                        write_json(recovery / 'rollback-errors.json', {'errors': errors})
                    except OSError:
                        pass  # The owned STOP and pre-write recovery image remain.
                    raise StoreConflict('Activation rollback incomplete; owned STOP retained; '
                                        'recovery=' + str(recovery) + '; ' + '; '.join(errors)) from failure
                safe_to_resume = True
                raise
        return evidence
    finally:
        if safe_to_resume and stop.exists() and stop.read_bytes() == tag:
            clear_owned_stop(root, 'AGENT_STOP', tag)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['verify', 'plan', 'activate'])
    parser.add_argument('root', type=Path)
    parser.add_argument('--repository', type=Path)
    parser.add_argument('--base')
    parser.add_argument('--expected', type=Path)
    parser.add_argument('--repo', default='U2SG/startrips')
    args = parser.parse_args()
    try:
        if args.action == 'verify':
            result = verify(args.root, live=True, repo=args.repo)
        elif not args.repository or not args.base:
            parser.error('--repository and --base are required')
        elif args.action == 'plan':
            result = activation_plan(args.root, args.repository, args.base)
        else:
            if not args.expected:
                parser.error('--expected activation-plan JSON is required')
            request = json.loads(args.expected.read_bytes())
            result = activate(args.root, args.repository, args.base, request['expected'], args.repo)
        print(json.dumps(result)); return 0
    except (StoreConflict, EvidenceUnknown, OSError, ValueError, KeyError, subprocess.SubprocessError) as exc:
        print('DELIVERY_ACTIVATION_UNAVAILABLE: ' + str(exc), file=sys.stderr); return 6


if __name__ == '__main__':
    raise SystemExit(main())

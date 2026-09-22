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
REQUIRED = ('CLAUDE.md', 'README.md', 'run-loop.sh', 'init.sh',
            'launch-experience.sh', 'launch-supervisor.sh', 'loop-supervisor.sh',
            'lib/delivery.py', 'lib/delivery_issues.py', 'lib/delivery_package.py',
            'lib/delivery_runtime.py', 'lib/feature_store.py', 'lib/feature_state.py',
            'lib/runtime_preflight.py', 'lib/action_plan.py', 'lib/policy_audit.py', 'lib/seal_owner.py',
            'lib/external_execution.py', 'lib/execution.py', 'lib/evidence_capture.py',
            'lib/intake.sh', 'lib/intake_guard.py',
            '.claude/agents/startrips-evaluator.md', '.claude/agents/startrips-triage.md')


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


def activation_plan(root, repository, base):
    root, repository = Path(root).resolve(), Path(repository).resolve()
    if git(repository, 'status', '--porcelain').strip():
        raise StoreConflict('Runtime Source must be a clean submitted commit')
    source = git(repository, 'rev-parse', 'HEAD').decode().strip()
    subprocess.run(['git', '-C', str(repository), 'merge-base', '--is-ancestor', base, source],
                   check=True, capture_output=True, timeout=15)
    result = {'source_sha': source, 'files': {}, 'expected': {}, 'conflicts': []}
    for name in REQUIRED:
        relative = 'tools/control-plane/' + name
        incoming = git(repository, 'show', source + ':' + relative)
        installed = root / name
        current = installed.read_bytes() if installed.is_file() else None
        old = subprocess.run(['git', '-C', str(repository), 'show', base + ':' + relative],
                             capture_output=True, timeout=15)
        normalize = lambda b: b.replace(b'\r\n', b'\n') if b is not None else None
        if current is not None and normalize(current) != normalize(incoming):
            if old.returncode or normalize(current) != normalize(old.stdout):
                result['conflicts'].append(name)
        elif current is None and old.returncode == 0:
            result['conflicts'].append(name)  # Never silently recreate a missing legacy consumer.
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
    tag = ('delivery-activation:' + uuid.uuid4().hex + '\n').encode()
    stop = root / 'AGENT_STOP'
    # Existing human STOP is never cleared or repurposed by this operation.
    try:
        with stop.open('xb') as stream:
            stream.write(tag)
    except FileExistsError as exc:
        raise StoreConflict('Existing owner STOP preserved; package activation deferred') from exc
    originals = {}; wrote = []
    try:
        ensure_idle(root)
        if occupancy(SimpleNamespace(root=str(root)))['occupied_slots']:
            raise StoreConflict('Old external execution has not drained; package activation deferred')
        with _storage_mutex(root / 'feature_list.json'):
            # No model/owner is running and the existing STOP prevents a fresh launch.
            for name in REQUIRED:
                path = root / name; body = path.read_bytes() if path.exists() else None
                if (sha(body) if body is not None else None) != expected[name]:
                    raise StoreConflict('Runtime drifted at the safe boundary: ' + name)
                originals[name] = body
            try:
                for name in REQUIRED:
                    body = git(repository, 'show', planned['source_sha'] + ':tools/control-plane/' + name)
                    _replace(root / name, body); wrote.append(name)
                evidence = {'schema_version': VERSION, 'source_sha': planned['source_sha'],
                            'files': planned['files'], 'ci': ci, 'boundary_verified': True}
                write_json(root / RECEIPT, evidence)
                verify(root)
            except BaseException:
                # A caught write failure rolls back. A process crash leaves the
                # exact owned STOP in place and no valid final manifest; packages
                # stay disabled until explicit recovery inspects the partial bytes.
                for name in reversed(wrote):
                    old = originals[name]
                    if old is None:
                        (root / name).unlink(missing_ok=True)
                    else:
                        _replace(root / name, old)
                raise
        return evidence
    finally:
        if stop.exists() and stop.read_bytes() == tag:
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

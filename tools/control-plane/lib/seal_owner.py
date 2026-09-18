"""Deterministic owner-only ledger seal, including interrupted commit/push recovery."""
from __future__ import annotations
import argparse
import hashlib
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from action_plan import plan
from feature_store import StoreConflict, load_document, _storage_mutex
from feature_state import target
from ci_observer import write_json
from execution import ensure_idle, stopped
from github_evidence import api, EvidenceUnknown


def git(worktree, *args):
    result = subprocess.run(['git', '-C', str(worktree), *args], capture_output=True, text=True, encoding='utf-8', timeout=30)
    if result.returncode:
        raise EvidenceUnknown('Owner git step failed: ' + ' '.join(args[:2]))
    return result.stdout.strip()


def ledger_text(row, observed):
    def line(value): return ' '.join(str(value).splitlines()).strip()
    source = observed['source_sha']; number = observed['pr']
    return '\n'.join([
        '# PR #' + str(number) + ' - ' + line(row['title']), '',
        '- **Source head:** `' + source + '`',
        '- **Scope:** ' + line(row.get('description') or row['title']),
        '- **User-visible change:** ' + line(row['title']),
        '- **Review fixes:** Independent Hourly Review cleared this exact CODE Source; resolved thread dispositions remain in the PR review history.',
        '- **Follow-up:** The linked issue retains its product scope; this ledger creates no additional product behavior or authority.',
        '- **Validation:** Exact Source CI ' + str(observed['ci_run']) + ' attempt ' + str(observed['ci_attempt']) +
        ' passed the real product lanes; independent Source review is recorded. This final commit changes only this ledger. Exact final-head CI remains required before HANDOFF_REVIEW.', ''])


def candidate_is_final(worktree, source, relative):
    values = git(worktree, 'rev-list', '--parents', '-n', '1', 'HEAD').split()
    return (len(values) == 2 and values[1] == source
            and git(worktree, 'diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD').splitlines() == [relative])


def validate_node(worktree, number, final=False):
    commands = [['node', 'scripts/pr-history.mjs', 'validate-all']]
    if final:
        base = git(worktree, 'merge-base', 'origin/main', 'HEAD')
        commands.append(['node', 'scripts/pr-history.mjs', 'validate-pr', '--pr', str(number), '--base', base, '--head', 'HEAD'])
    for command in commands:
        result = subprocess.run(command, cwd=worktree, capture_output=True, text=True, encoding='utf-8', timeout=25)
        if result.returncode:
            raise StoreConflict('Ledger validation failed; existing owner work preserved')


def seal(root, worktree, fid, repo):
    role = os.environ.get('STARTRIPS_ROLE')
    if role not in {'local-backend', 'experience'}:
        raise StoreConflict('Only the executing owner may seal; no Maintainer authority granted')
    lane = 'backend' if role == 'local-backend' else 'experience'
    root, worktree = Path(root).resolve(), Path(worktree).resolve()
    if not worktree.is_relative_to(root): raise StoreConflict('Owner worktree outside workspace')
    if stopped(root, lane=lane): raise StoreConflict('Owner STOP preserves the current seal state')
    ensure_idle(root, lane=lane, feature=fid, worktree=worktree)
    observed = plan(root / 'feature_list.json', fid, repo)
    if observed['action'] != 'SEAL':
        return {'changed': False, 'action': observed['action']}
    source, number = observed['source_sha'], observed['pr']
    pr = api('repos/' + repo + '/pulls/' + str(number))
    if pr['head']['sha'] != source or git(worktree, 'branch', '--show-current') != pr['head']['ref']:
        raise StoreConflict('Owner branch/Source changed before seal')
    row = target(load_document(root / 'feature_list.json'), fid)
    relative = 'docs/pr-history/' + str(number) + '.md'
    path = (worktree / relative).resolve()
    if not path.is_relative_to(worktree) or path.relative_to(worktree).as_posix() != relative:
        raise StoreConflict('Ledger resolves outside its exact owner path')
    intent = root / '.agent-artifacts/evaluations' / (fid + '-' + source + '-seal-intent.json')
    with _storage_mutex(root / 'feature_list.json'):
        if intent.exists():
            data = json.loads(intent.read_bytes())
            if any(data.get(k) != v for k, v in {'feature': fid, 'pr': number, 'source_sha': source, 'ledger_path': relative}.items()):
                raise StoreConflict('Seal checkpoint belongs to another identity')
            body = data['body']
            if hashlib.sha256(body.encode('utf-8')).hexdigest() != data['body_sha256']:
                raise StoreConflict('Seal checkpoint was modified')
        else:
            body = ledger_text(row, observed)
            write_json(intent, {'feature': fid, 'pr': number, 'source_sha': source,
                                'ledger_path': relative, 'body': body,
                                'body_sha256': hashlib.sha256(body.encode('utf-8')).hexdigest()})
    head = git(worktree, 'rev-parse', 'HEAD')
    if head == source:
        dirty = git(worktree, 'status', '--porcelain')
        if dirty:
            # A previous interrupted seal may have staged/written exactly this file.
            changes = set(git(worktree, 'diff', '--name-only', 'HEAD').splitlines())
            changes.update(git(worktree, 'ls-files', '--others', '--exclude-standard').splitlines())
            if changes != {relative} or not path.exists() or path.read_text(encoding='utf-8') != body:
                raise StoreConflict('Dirty owner work is not this exact interrupted seal')
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            previous = path.read_bytes() if path.exists() else None
            # A code fix after an earlier seal leaves a tracked old ledger;
            # updating only this PR's ledger is the normal reseal path.
            if previous is not None:
                recorded = git(worktree, 'show', source + ':' + relative)
                if previous.decode('utf-8').strip() != recorded:
                    raise StoreConflict('Existing ledger differs from the committed Source')
            fd, temporary = tempfile.mkstemp(prefix='seal-body-', dir=root / '.agent-artifacts')
            try:
                with os.fdopen(fd, 'w', encoding='utf-8', newline='\n') as stream:
                    stream.write(body); stream.flush(); os.fsync(stream.fileno())
                current = path.read_bytes() if path.exists() else None
                if current != previous: raise StoreConflict('Ledger changed concurrently; preserve it')
                os.replace(temporary, path)
            finally:
                if os.path.exists(temporary): os.unlink(temporary)
        validate_node(worktree, number)
        if stopped(root, lane=lane): raise StoreConflict('STOP arrived; preserve the pending ledger for same-owner recovery')
        git(worktree, 'add', '--', relative)
        git(worktree, 'commit', '-m', 'Record reviewed delivery evidence')
    elif not candidate_is_final(worktree, source, relative):
        raise StoreConflict('Unpublished owner code requires resumption, not another seal')
    if not candidate_is_final(worktree, source, relative) or path.read_text(encoding='utf-8') != body:
        raise StoreConflict('Final commit does not match the exact seal checkpoint')
    if git(worktree, 'status', '--porcelain'):
        raise StoreConflict('Owner changed during seal; do not push unrelated work')
    validate_node(worktree, number, final=True)
    if stopped(root, lane=lane): raise StoreConflict('STOP arrived; existing final commit is retained without push')
    final = git(worktree, 'rev-parse', 'HEAD')
    current = api('repos/' + repo + '/pulls/' + str(number))
    if current['head']['sha'] not in {source, final} or current.get('merged') or current.get('state') != 'open':
        raise EvidenceUnknown('Remote ownership/lifecycle moved before seal push')
    if current['head']['sha'] != final:
        git(worktree, 'push', 'origin', pr['head']['ref'])
    confirmed = api('repos/' + repo + '/pulls/' + str(number))
    if confirmed['head']['sha'] != final:
        raise EvidenceUnknown('Seal push not confirmed; never create a duplicate commit')
    return {'changed': True, 'source_sha': source, 'final_sha': final, 'action': 'WAIT_FINAL_CI'}


def main():
    parser = argparse.ArgumentParser(); parser.add_argument('root', type=Path)
    parser.add_argument('worktree', type=Path); parser.add_argument('feature')
    parser.add_argument('--repo', default='U2SG/startrips'); args = parser.parse_args()
    try:
        print(json.dumps(seal(args.root, args.worktree, args.feature, args.repo))); return 0
    except (StoreConflict, EvidenceUnknown, OSError, ValueError, KeyError, subprocess.TimeoutExpired) as exc:
        print('SEAL_UNAVAILABLE: ' + str(exc), file=sys.stderr); return 6


if __name__ == '__main__':
    raise SystemExit(main())


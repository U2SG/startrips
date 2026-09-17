"""Read-only validation of the selected execution carrier; never claims work."""
from __future__ import annotations
import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from feature_store import load_document, StoreConflict
from feature_state import target, next_action
from github_evidence import api, EvidenceUnknown


def git(path, *args):
    result = subprocess.run(['git', '-C', str(path), *args], capture_output=True,
                            text=True, encoding='utf-8', timeout=10)
    if result.returncode:
        raise EvidenceUnknown('Cannot verify worktree: ' + ' '.join(args))
    return result.stdout.strip()


def recovery_action(owner, requested_owner, old_execution, same_worktree, same_branch):
    # Session state is evidence from the execution provider, not a new owner registry.
    if not owner or owner != requested_owner or not same_worktree or not same_branch:
        return 'OWNERSHIP_CONFLICT'
    if old_execution == 'active':
        return 'OBSERVE_EXISTING_EXECUTION'
    if old_execution == 'ended':
        return 'RESUME_SAME_OWNER'
    return 'WAIT_EXECUTION_EVIDENCE'


def preflight(root, worktree, lane, fid, repo):
    root, worktree = Path(root).resolve(), Path(worktree).resolve()
    if lane not in {'backend', 'experience'} or os.environ.get('STARTRIPS_LANE') != lane:
        raise StoreConflict('Target runtime lane missing/mismatched; no Backend fallback')
    if Path.cwd().resolve() != root:
        raise StoreConflict('Run-loop cwd differs from its authoritative workspace')
    if not worktree.is_relative_to(root):
        raise StoreConflict('Worktree outside this authorized workspace')
    row = target(load_document(root / 'feature_list.json'), fid)
    if next_action(row) not in {'IMPLEMENT', 'EVALUATE'}:
        raise StoreConflict('Selected feature has no executable action')
    if Path(git(worktree, 'rev-parse', '--show-toplevel')).resolve() != worktree:
        raise StoreConflict('Worktree root does not match actual git cwd')
    branch = git(worktree, 'branch', '--show-current')
    if not branch:
        raise StoreConflict('Detached HEAD cannot carry this logical owner')
    prs = row.get('pr_links') or []
    if prs:
        if len(prs) != 1:
            raise StoreConflict('Ambiguous PR ownership')
        match = re.fullmatch(r'https://github\.com/' + re.escape(repo) + r'/pull/(\d+)/?', prs[0])
        if not match:
            raise StoreConflict('Invalid owner PR mapping')
        pr = api('repos/' + repo + '/pulls/' + match.group(1))
        if pr.get('merged') or pr.get('state') != 'open':
            raise StoreConflict('PR lifecycle changed; reconcile before execution')
        wanted = 'refs/heads/' + pr['head']['ref']
        # Git's own worktree inventory is the owner carrier map, not a new registry.
        inventory = git(worktree, 'worktree', 'list', '--porcelain')
        matches = []
        for block in inventory.split('\n\n'):
            fields = dict(line.split(' ', 1) for line in block.splitlines() if ' ' in line)
            if fields.get('branch') == wanted and fields.get('worktree'):
                matches.append(Path(fields['worktree']).resolve())
        if len(matches) != 1 or not matches[0].is_relative_to(root):
            raise StoreConflict('No unique authorized existing owner worktree; do not create a competitor')
        worktree = matches[0]
        branch = git(worktree, 'branch', '--show-current')
        if branch != pr['head']['ref']:
            raise StoreConflict('Owner worktree moved during preflight')
        local = git(worktree, 'rev-parse', 'HEAD')
        if local != pr['head']['sha']:
            # An interrupted owner can legitimately leave commits not pushed yet.
            # Only a proven descendant resumes; divergence/unknown never resets.
            result = subprocess.run(['git', '-C', str(worktree), 'merge-base', '--is-ancestor',
                                     pr['head']['sha'], local], capture_output=True, timeout=10)
            if result.returncode:
                raise StoreConflict('Owner heads diverge or ancestry unknown; preserve work for reconciliation')
    elif row.get('status') != 'pending' or branch != 'main' or git(worktree, 'status', '--porcelain'):
        raise StoreConflict('Unmapped work requires ownership reconciliation, not a competing builder')
    return {'feature': fid, 'lane': lane, 'worktree': str(worktree), 'branch': branch,
            'dirty': bool(git(worktree, 'status', '--porcelain')), 'owner_preserved': True}


def main():
    parser = argparse.ArgumentParser()
    for field in ['root', 'worktree', 'lane', 'feature']:
        parser.add_argument(field)
    parser.add_argument('--repo', default='U2SG/startrips')
    parser.add_argument('--worktree-only', action='store_true')
    args = parser.parse_args()
    try:
        result = preflight(args.root, args.worktree, args.lane, args.feature, args.repo)
        print(result['worktree'] if args.worktree_only else json.dumps(result))
        return 0
    except (StoreConflict, EvidenceUnknown, OSError, ValueError, KeyError, subprocess.TimeoutExpired) as exc:
        print('PREFLIGHT_UNAVAILABLE: ' + str(exc), file=sys.stderr)
        return 6


if __name__ == '__main__':
    raise SystemExit(main())

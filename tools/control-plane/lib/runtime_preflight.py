"""Read-only validation of the selected execution carrier; never claims work."""
from __future__ import annotations
import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from feature_store import load_document, commit_document, StoreConflict
from feature_state import target, next_action, note
from execution import ensure_idle, stopped
import datetime
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


def prepare_unmapped(root, repository, row, repo, prepare, lane):
    fid = row['id']; compact = fid.lower().replace('-', '')
    inventory = git(repository, 'worktree', 'list', '--porcelain')
    candidates = []
    issue_match = re.search(r'(\d+)\s*$', str(row.get('issue')))
    issue = issue_match.group(1) if issue_match else None
    siblings = [item for item in load_document(root / 'feature_list.json')['features'] if str(item.get('issue')) == str(row.get('issue')) and item.get('status') not in {'passed','blocked','cancelled_by_product_decision'}]
    for block in inventory.split('\n\n'):
        fields = dict(line.split(' ', 1) for line in block.splitlines() if ' ' in line)
        path = Path(fields.get('worktree', '')).resolve()
        named = path.name.lower().startswith(compact + '-') or path.name.lower().startswith(fid.lower() + '-')
        branch_owned = bool(issue and len(siblings) == 1 and re.match(r'^refs/heads/(?:feat|fix|chore)/issue' + re.escape(issue) + r'(?:-|/)', fields.get('branch', '')))
        if path.is_relative_to(root) and (named or branch_owned):
            candidates.append(path)
    if len(candidates) > 1:
        raise StoreConflict('More than one existing owner carrier; do not choose a competitor')
    if candidates:
        return candidates[0]
    if row.get('status') != 'pending':
        raise StoreConflict('In-flight owner carrier missing; reconcile, never create a competitor')
    if not prepare:
        raise StoreConflict('NEW_OWNER_WORKTREE_REQUIRED: use authorized worker prepare, not the old checkout')
    if stopped(root, lane=lane): raise StoreConflict('Owner STOP prevents new worktree preparation')
    ensure_idle(root, lane=lane, feature=fid)
    issue = re.search(r'(\d+)\s*$', str(row.get('issue')))
    if not issue:
        raise StoreConflict('New owner requires its actual issue identity')
    # A new logical owner must branch from the exact current GitHub main, but
    # owner creation is not an integration verdict. A red/pending main push CI
    # therefore does not starve unrelated development lanes; exact-main green
    # remains mandatory only for terminal passed/dependency unlock reconciliation.
    main = api('repos/' + repo + '/git/ref/heads/main')['object']['sha']
    fetched = subprocess.run(['git', '-C', str(repository), 'fetch', 'origin', 'main'], capture_output=True, timeout=30)
    if fetched.returncode or git(repository, 'rev-parse', 'origin/main') != main:
        raise EvidenceUnknown('Exact current main changed/unavailable before owner creation')
    suffix = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%d')
    branch = 'feat/issue' + issue.group(1) + '-' + compact + '-' + suffix
    worktree = root / 'worker-worktrees' / (compact + '-' + suffix)
    if worktree.exists():
        raise StoreConflict('Owner destination exists but is not in git inventory')
    document = load_document(root / 'feature_list.json')
    latest = target(document, fid)
    if latest != row:
        raise StoreConflict('Feature changed before owner claim')
    worktree.parent.mkdir(exist_ok=True)
    created = subprocess.run(['git', '-C', str(repository), 'worktree', 'add', '-b', branch, str(worktree), main], capture_output=True, timeout=30)
    if created.returncode:
        raise StoreConflict('Owner branch/worktree creation conflicted; preserve existing git state')
    latest['status'] = 'in_progress'
    note(latest, 'Existing selector authorized owner carrier ' + str(worktree) + ' branch ' + branch + ' from exact current main ' + main)
    commit_document(root / 'feature_list.json', document, allowed={fid: {'status', 'notes'}})
    return worktree


def preflight(root, worktree, lane, fid, repo, prepare=False):
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
    else:
        worktree = prepare_unmapped(root, worktree, row, repo, prepare, lane)
        branch = git(worktree, 'branch', '--show-current')
        if not branch:
            raise StoreConflict('Existing owner is detached; preserve it')
    return {'feature': fid, 'lane': lane, 'worktree': str(worktree), 'branch': branch,
            'dirty': bool(git(worktree, 'status', '--porcelain')), 'owner_preserved': True}


def local_action(worktree, number, remote_head):
    relative = 'docs/pr-history/' + str(number) + '.md'
    changed = set(git(worktree, 'diff', '--name-only', 'HEAD').splitlines())
    changed.update(git(worktree, 'ls-files', '--others', '--exclude-standard').splitlines())
    if git(worktree, 'rev-parse', 'HEAD') != remote_head:
        changed.update(git(worktree, 'diff', '--name-only', remote_head + '..HEAD').splitlines())
    return 'RESUME_OWNER' if changed - {relative} else 'CONTINUE_PLAN'


def main():
    parser = argparse.ArgumentParser()
    for field in ['root', 'worktree', 'lane', 'feature']:
        parser.add_argument(field)
    parser.add_argument('--repo', default='U2SG/startrips')
    parser.add_argument('--worktree-only', action='store_true')
    parser.add_argument('--prepare', action='store_true')
    parser.add_argument('--local-action', action='store_true')
    args = parser.parse_args()
    try:
        if args.prepare: ensure_idle(args.root, lane=args.lane, feature=args.feature)
        result = preflight(args.root, args.worktree, args.lane, args.feature, args.repo, args.prepare)
        if args.local_action:
            row = target(load_document(Path(args.root) / 'feature_list.json'), args.feature)
            urls = row.get('pr_links') or []
            if len(urls) != 1: raise StoreConflict('Local action requires mapped ownership')
            number = int(urls[0].rstrip('/').rsplit('/',1)[1])
            pr = api('repos/' + args.repo + '/pulls/' + str(number))
            print(local_action(result['worktree'], number, pr['head']['sha']))
        else: print(result['worktree'] if args.worktree_only else json.dumps(result))
        return 0
    except (StoreConflict, EvidenceUnknown, OSError, ValueError, KeyError, subprocess.TimeoutExpired) as exc:
        print('PREFLIGHT_UNAVAILABLE: ' + str(exc), file=sys.stderr)
        return 6


if __name__ == '__main__':
    raise SystemExit(main())

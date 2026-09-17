"""State transitions for the existing loop; no feature selection or dispatch."""
from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

from feature_store import StoreConflict, commit_document, load_document
from github_evidence import EvidenceUnknown, api, merge_proof, review_backlog


TERMINAL = {'passed', 'blocked', 'cancelled_by_product_decision'}


def now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def target(doc, fid):
    for row in doc['features']:
        if row['id'] == fid:
            return row
    raise StoreConflict('Feature not found: ' + str(fid))


def note(row, message):
    old = row.get('notes') or ''
    row['notes'] = old + (' | ' if old else '') + now() + ': ' + message


def row_token(row):
    return hashlib.sha256(json.dumps(row, sort_keys=True, ensure_ascii=False,
                                     allow_nan=False).encode('utf-8')).hexdigest()


def validate_evaluation(row, expected_row, repo_path, expected_head):
    if not expected_row or not expected_head or repo_path is None:
        raise StoreConflict('Evaluation writes require pre-evaluation row and Source identity')
    if row_token(row) != expected_row:
        raise StoreConflict('Feature changed during evaluation; stale verdict discarded')
    result = subprocess.run(['git', '-C', str(repo_path), 'rev-parse', 'HEAD'],
                            capture_output=True, text=True, timeout=10)
    if result.returncode or result.stdout.strip() != expected_head:
        raise StoreConflict('Source changed during evaluation; stale verdict discarded')
    # A dirty tree cannot be the exact evaluated Source, even if HEAD is stable.
    result = subprocess.run(['git', '-C', str(repo_path), 'status', '--porcelain'],
                            capture_output=True, text=True, timeout=10)
    if result.returncode or result.stdout.strip():
        raise StoreConflict('Worktree changed or is dirty; evaluation cannot advance state')


def mark_ready(path, fid, evidence, *, expected_row=None, repo_path=None, expected_head=None):
    doc = load_document(path)
    row = target(doc, fid)
    validate_evaluation(row, expected_row, repo_path, expected_head)
    if row.get('status') in TERMINAL:
        raise StoreConflict('Cannot overwrite terminal feature ' + fid)
    if row.get('status') == 'ready_to_merge' and evidence in row.get('evidence', []):
        return {'changed': False}
    row.update(status='ready_to_merge', passes=True, evaluated_at=now())
    if evidence not in row.setdefault('evidence', []):
        row['evidence'].append(evidence)
    return commit_document(path, doc, allowed={fid: {'status', 'passes', 'evaluated_at', 'evidence'}})


def mark_needs_work(path, fid, cap, *, expected_row=None, repo_path=None, expected_head=None):
    doc = load_document(path)
    row = target(doc, fid)
    validate_evaluation(row, expected_row, repo_path, expected_head)
    if row.get('status') in TERMINAL:
        return {'changed': False, 'kept_terminal': row['status']}
    attempts = int(row.get('attempts', 0)) + 1
    row.update(passes=False, attempts=attempts,
               status='blocked' if attempts >= cap else 'needs_work')
    if attempts >= cap:
        note(row, 'Implementation evaluation retry budget exhausted; owner must inspect actual findings.')
    return commit_document(path, doc, allowed={fid: {'status', 'passes', 'attempts', 'notes'}})


def reconcile(path, repo, base):
    snapshot = load_document(path)
    candidates = [f['id'] for f in snapshot['features']
                  if f.get('status') not in TERMINAL and f.get('pr_links')]
    unknown = False
    for fid in candidates:
        doc = load_document(path)
        row = target(doc, fid)
        if row.get('status') in TERMINAL:
            continue
        urls = row.get('pr_links') or []
        if len(urls) != 1:
            print(fid + ': ambiguous PR mapping; left unchanged')
            unknown = True
            continue
        match = re.fullmatch(r'https://github\.com/' + re.escape(repo) + r'/pull/(\d+)/?', urls[0])
        if not match:
            print(fid + ': invalid PR mapping; left unchanged')
            unknown = True
            continue
        number = int(match.group(1))
        try:
            pr = api('repos/' + repo + '/pulls/' + str(number))
            if pr.get('merged'):
                proof = merge_proof(repo, number, base)
                row.update(status='passed', passes=True)
                note(row, 'Exact merge/main-CI reconcile ' + json.dumps(proof, sort_keys=True))
                result = commit_document(path, doc, allowed={fid: {'status', 'passes', 'notes'}})
                print(fid + ': ' + json.dumps(result))
            elif pr.get('state') == 'closed':
                if row.get('status') != 'needs_work':
                    row.update(status='needs_work', passes=False)
                    note(row, 'PR closed without merging; preserve existing owner for disposition.')
                    print(fid + ': ' + json.dumps(commit_document(path, doc, allowed={fid: {'status', 'passes', 'notes'}})))
            elif pr.get('state') == 'open':
                if row.get('status') in {'ready_for_eval', 'ready_to_merge'}:
                    review = review_backlog(repo, number)
                    if pr.get('head', {}).get('sha') != review['head_sha']:
                        raise EvidenceUnknown('Source changed between PR and review observations')
                    if review['unresolved'] or review['changes_requested']:
                        row.update(status='needs_work', passes=False)
                        note(row, 'Effective review blocker on ' + review['head_sha'] + ': ' +
                             str(review['unresolved']) + ' unresolved threads, ' +
                             str(review['changes_requested']) + ' active change requests; no prose acknowledgement required.')
                        print(fid + ': ' + json.dumps(commit_document(path, doc, allowed={fid: {'status', 'passes', 'notes'}})))
                    else:
                        print(fid + ': effective review clear; preserve owner handoff state')
                else:
                    print(fid + ': existing owner continues; no state rewrite')
            else:
                raise EvidenceUnknown('Unknown PR lifecycle')
        except (EvidenceUnknown, StoreConflict) as exc:
            print(fid + ': UNKNOWN/WAIT: ' + str(exc), file=sys.stderr)
            unknown = True
    # No checkout/reset/fetch side effects: a clean tree may still belong to a worker.
    return 6 if unknown else 0


def next_action(row):
    status = row.get('status')
    if status == 'ready_for_eval':
        return 'EVALUATE'
    if status == 'ready_to_merge':
        return 'WAIT_REVIEW'
    if status in TERMINAL or row.get('human_gate'):
        return 'OBSERVE'
    if status in {'pending', 'in_progress', 'needs_work'} and not row.get('passes'):
        return 'IMPLEMENT'
    raise StoreConflict('Unknown actionable state; fail closed')


def fingerprint(path, fid, repo_path):
    doc = load_document(path)
    row = target(doc, fid)
    identity = {k: v for k, v in row.items()
                if k not in {'notes', 'issue_snapshot_at', 'issue_snapshot_comments'}}
    digest = hashlib.sha256(json.dumps(identity, sort_keys=True).encode('utf-8'))
    for args in [['rev-parse', 'HEAD'], ['diff', '--no-ext-diff', '--binary', 'HEAD'],
                 ['ls-files', '--others', '--exclude-standard', '-z']]:
        result = subprocess.run(['git', '-C', str(repo_path), *args],
                                capture_output=True, timeout=20)
        if result.returncode:
            raise EvidenceUnknown('Cannot read worktree progress identity')
        digest.update(result.stdout)
        if args[0] == 'ls-files':
            for item in result.stdout.split(b'\0'):
                if item:
                    file = Path(repo_path) / item.decode('utf-8')
                    stat = file.stat()
                    digest.update(str((stat.st_size, stat.st_mtime_ns)).encode())
                    if file.is_file() and stat.st_size <= 1048576:
                        digest.update(file.read_bytes())
    return digest.hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['ready', 'needs-work', 'reconcile', 'action', 'fingerprint', 'token'])
    parser.add_argument('path', type=Path)
    parser.add_argument('feature', nargs='?')
    parser.add_argument('--repo', default='U2SG/startrips')
    parser.add_argument('--base', default='main')
    parser.add_argument('--repo-path', type=Path)
    parser.add_argument('--evidence')
    parser.add_argument('--expected-row')
    parser.add_argument('--expected-head')
    parser.add_argument('--cap', type=int, default=6)
    args = parser.parse_args()
    try:
        if args.action == 'reconcile':
            return reconcile(args.path, args.repo, args.base)
        if not args.feature:
            parser.error('feature is required')
        if args.action == 'action':
            print(next_action(target(load_document(args.path), args.feature)))
        elif args.action == 'token':
            print(row_token(target(load_document(args.path), args.feature)))
        elif args.action == 'fingerprint':
            if args.repo_path is None:
                parser.error('--repo-path is required')
            print(fingerprint(args.path, args.feature, args.repo_path))
        elif args.action == 'ready':
            if not args.evidence:
                parser.error('--evidence is required')
            print(json.dumps(mark_ready(args.path, args.feature, args.evidence, expected_row=args.expected_row, repo_path=args.repo_path, expected_head=args.expected_head)))
        else:
            if args.cap < 1:
                parser.error('--cap must be positive')
            print(json.dumps(mark_needs_work(args.path, args.feature, args.cap, expected_row=args.expected_row, repo_path=args.repo_path, expected_head=args.expected_head)))
        return 0
    except (StoreConflict, EvidenceUnknown, OSError, ValueError, subprocess.TimeoutExpired) as exc:
        print('CONTROL_PLANE_UNAVAILABLE: ' + str(exc), file=sys.stderr)
        return 6


if __name__ == '__main__':
    raise SystemExit(main())

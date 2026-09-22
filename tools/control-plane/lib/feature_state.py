"""State transitions for the existing loop; no feature selection or dispatch."""
from __future__ import annotations

import argparse
import base64
import datetime
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

from feature_store import StoreConflict, commit_document, load_document
from github_evidence import EvidenceUnknown, api, merge_proof, review_backlog, source_relation
from delivery import (canonical_lead, package_snapshot, unit_pr_links, unit_rows,
                      unit_token, package_ledger_lines, validate_coverage)
from delivery_issues import live_issues, assert_current


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


def validate_evaluation(path, fid, expected_row, repo_path, expected_head):
    if not expected_row or not expected_head or repo_path is None:
        raise StoreConflict('Evaluation writes require pre-evaluation unit and Source identity')
    doc = load_document(path)
    if canonical_lead(doc, fid) != fid:
        raise StoreConflict('Only the canonical package lead may be evaluated')
    if unit_token(doc, fid) != expected_row:
        raise StoreConflict('Delivery unit changed during evaluation; stale verdict discarded')
    result = subprocess.run(['git', '-C', str(repo_path), 'rev-parse', 'HEAD'],
                            capture_output=True, text=True, timeout=10)
    if result.returncode or result.stdout.strip() != expected_head:
        raise StoreConflict('Source changed during evaluation; stale verdict discarded')
    result = subprocess.run(['git', '-C', str(repo_path), 'status', '--porcelain'],
                            capture_output=True, text=True, timeout=10)
    if result.returncode or result.stdout.strip():
        raise StoreConflict('Worktree changed or is dirty; evaluation cannot advance state')


def mark_ready(path, fid, evidence, *, expected_row=None, repo_path=None, expected_head=None):
    validate_evaluation(path, fid, expected_row, repo_path, expected_head)
    doc = load_document(path); rows = unit_rows(doc, fid); package = package_snapshot(doc, fid)
    if any(row.get('status') in TERMINAL for row in rows):
        raise StoreConflict('Cannot partially overwrite terminal delivery unit ' + fid)
    allowed = {}
    for row in rows:
        # Package members are not individually 'passed' by evaluator approval.
        # They remain passes=false until the one exact-main reconcile proves the
        # complete package. Legacy single-issue semantics stay unchanged.
        row.update(status='ready_to_merge', passes=False if package else True, evaluated_at=now())
        if evidence not in row.setdefault('evidence', []):
            row['evidence'].append(evidence)
        allowed[row['id']] = {'status', 'passes', 'evaluated_at', 'evidence'}
    return commit_document(path, doc, allowed=allowed, expected_rows=set(allowed), delivery_operation='unit')


def mark_needs_work(path, fid, cap, *, expected_row=None, repo_path=None, expected_head=None):
    validate_evaluation(path, fid, expected_row, repo_path, expected_head)
    doc = load_document(path); rows = unit_rows(doc, fid)
    if any(row.get('status') in TERMINAL for row in rows):
        return {'changed': False, 'kept_terminal': ','.join(row['id'] for row in rows if row.get('status') in TERMINAL)}
    attempts = max(int(row.get('attempts', 0)) for row in rows) + 1
    allowed = {}
    for row in rows:
        row.update(passes=False, attempts=attempts,
                   status='blocked' if attempts >= cap else 'needs_work')
        if attempts >= cap:
            note(row, 'Delivery-unit evaluation retry budget exhausted; owner must inspect actual findings.')
        allowed[row['id']] = {'status', 'passes', 'attempts', 'notes'}
    return commit_document(path, doc, allowed=allowed, expected_rows=set(allowed), delivery_operation='unit')


def _verify_package_ledger(repo, number, ref, snapshot):
    if not snapshot:
        return
    content = api('repos/' + repo + '/contents/docs/pr-history/' + str(number) + '.md?ref=' + ref)
    if content.get('encoding') != 'base64':
        raise EvidenceUnknown('Package ledger encoding unavailable')
    text = base64.b64decode(content['content']).decode('utf-8')
    for line in package_ledger_lines(snapshot):
        if text.count(line) != 1:
            raise EvidenceUnknown('Package ledger/member coverage mismatch')


def _verify_package_review(root, fid, number, relation, snapshot):
    if not snapshot:
        return
    source = relation.get('source_sha')
    if not isinstance(source, str) or not re.fullmatch(r'[0-9a-f]{40}', source):
        raise EvidenceUnknown('Package Source identity unavailable at merge reconcile')
    receipt = Path(root) / '.agent-artifacts' / 'evaluations' / (fid + '-' + source + '-source-review.json')
    if not receipt.is_file():
        raise EvidenceUnknown('Package merge lacks independent Source review coverage')
    data = json.loads(receipt.read_bytes())
    if (data.get('feature') != fid or data.get('pr') != number or data.get('source_sha') != source
            or data.get('reviewer_role') != 'hourly-review' or data.get('verdict') != 'CLEAR'
            or data.get('findings') not in ([], None) or not data.get('completed_at')):
        raise EvidenceUnknown('Package Source review identity/verdict is not merge-clear')
    if data.get('delivery_package') != snapshot:
        raise EvidenceUnknown('Package Source review scope/revision is stale at merge reconcile')
    try:
        validate_coverage(snapshot, data.get('member_coverage'), require_pass=True)
    except StoreConflict as exc:
        raise EvidenceUnknown(str(exc)) from exc


def _apply_unit_state(path, fid, *, status, passes, message, operation='unit', completion=None):
    doc = load_document(path); rows = unit_rows(doc, fid); allowed = {}
    for row in rows:
        row.update(status=status, passes=passes)
        if completion is not None:
            row['delivery_completion'] = completion
        note(row, message)
        allowed[row['id']] = {'status', 'passes', 'notes'} | ({'delivery_completion'} if completion is not None else set())
    return commit_document(path, doc, allowed=allowed, expected_rows=set(allowed), delivery_operation=operation)


def reconcile(path, repo, base):
    snapshot = load_document(path)
    candidates, seen = [], set(); unknown = False
    for row in snapshot['features']:
        if row.get('status') in TERMINAL or not row.get('pr_links'):
            continue
        try:
            lead = canonical_lead(snapshot, row['id'])
        except StoreConflict as exc:
            print(row['id'] + ': UNKNOWN/WAIT: ' + str(exc), file=sys.stderr); unknown = True; continue
        if lead not in seen:
            seen.add(lead); candidates.append(lead)
    for fid in candidates:
        try:
            doc = load_document(path)
            if canonical_lead(doc, fid) != fid:
                continue
            rows = unit_rows(doc, fid)
            if any(row.get('status') in TERMINAL for row in rows):
                raise StoreConflict('Delivery package has partial terminal state')
            urls = unit_pr_links(doc, fid)
            if len(urls) != 1:
                print(fid + ': ambiguous PR mapping; left unchanged')
                unknown = True; continue
            match = re.fullmatch(r'https://github\.com/' + re.escape(repo) + r'/pull/(\d+)/?', urls[0])
            if not match:
                print(fid + ': invalid PR mapping; left unchanged')
                unknown = True; continue
            number = int(match.group(1))
            pr = api('repos/' + repo + '/pulls/' + str(number))
            package = package_snapshot(doc, fid)
            if pr.get('merged'):
                if package:
                    current_issues = live_issues(doc, fid, repo)
                    assert_current(doc, fid, current_issues)
                    relation = source_relation(repo, number)
                    _verify_package_review(path.parent, fid, number, relation, package)
                proof = merge_proof(repo, number, base)
                _verify_package_ledger(repo, number, proof['main_sha'], package)
                completion = None
                if package:
                    completion = {**proof, 'contract_sha256': package['contract_sha256']}
                result = _apply_unit_state(path, fid, status='passed', passes=True,
                    message='Exact merge/main-CI delivery-unit reconcile ' + json.dumps(proof, sort_keys=True),
                    operation='reconcile' if package else 'unit', completion=completion)
                print(fid + ': ' + json.dumps(result))
            elif pr.get('state') == 'closed':
                if any(row.get('status') != 'needs_work' for row in rows):
                    result = _apply_unit_state(path, fid, status='needs_work', passes=False,
                                              message='PR closed without merging; preserve existing delivery-unit owner for disposition.')
                    print(fid + ': ' + json.dumps(result))
            elif pr.get('state') == 'open':
                if any(row.get('status') in {'ready_for_eval', 'ready_to_merge'} for row in rows):
                    review = review_backlog(repo, number)
                    if pr.get('head', {}).get('sha') != review['head_sha']:
                        raise EvidenceUnknown('Source changed between PR and review observations')
                    if review['unresolved'] or review['changes_requested']:
                        result = _apply_unit_state(path, fid, status='needs_work', passes=False,
                            message='Effective review blocker on ' + review['head_sha'] + ': ' +
                                    str(review['unresolved']) + ' unresolved threads, ' +
                                    str(review['changes_requested']) + ' active change requests; no prose acknowledgement required.')
                        print(fid + ': ' + json.dumps(result))
                    else:
                        print(fid + ': effective review clear; preserve delivery-unit owner handoff state')
                else:
                    print(fid + ': existing delivery-unit owner continues; no state rewrite')
            else:
                raise EvidenceUnknown('Unknown PR lifecycle')
        except (EvidenceUnknown, StoreConflict) as exc:
            print(fid + ': UNKNOWN/WAIT: ' + str(exc), file=sys.stderr); unknown = True
    return 6 if unknown else 0


def next_action(row):
    status = row.get('status')
    if row.get('human_gate') or status in TERMINAL:
        return 'OBSERVE'
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
    if canonical_lead(doc, fid) != fid:
        raise StoreConflict('Only the canonical package lead may be fingerprinted')
    identity = [{k: v for k, v in row.items()
                 if k not in {'notes', 'issue_snapshot_at', 'issue_snapshot_comments'}}
                for row in unit_rows(doc, fid)]
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
        if args.action in {'action', 'token'}:
            document = load_document(args.path)
            if canonical_lead(document, args.feature) != args.feature:
                raise StoreConflict('Package member must use canonical delivery lead')
            if args.action == 'action':
                rows = unit_rows(document, args.feature)
                if len({row.get('status') for row in rows}) != 1 or any(row.get('human_gate') for row in rows):
                    print('OBSERVE')
                else:
                    print(next_action(rows[0]))
            else:
                print(unit_token(document, args.feature))
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

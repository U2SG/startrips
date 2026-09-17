"""Read-only exact GitHub evidence. Unknown never means green or zero findings."""
from __future__ import annotations

import argparse
import base64
import json
import re
import subprocess
import sys
from urllib.parse import urlencode


class EvidenceUnknown(RuntimeError):
    pass


def api(endpoint: str, fields: dict | None = None):
    command = ['gh', 'api', endpoint]
    if fields:
        for key, value in fields.items():
            command += ['-F' if isinstance(value, int) else '-f', key + '=' + str(value)]
    try:
        result = subprocess.run(command, capture_output=True, text=True,
                                encoding='utf-8', timeout=25)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise EvidenceUnknown('GitHub transport unavailable: ' + type(exc).__name__) from exc
    if result.returncode:
        raise EvidenceUnknown('GitHub query failed: ' + endpoint.split('?')[0])
    try:
        data = json.loads(result.stdout)
    except ValueError as exc:
        raise EvidenceUnknown('Invalid GitHub response') from exc
    if isinstance(data, dict) and data.get('errors'):
        raise EvidenceUnknown('GraphQL returned errors; partial data is not acceptance')
    return data


def _repo(repo: str) -> tuple[str, str]:
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repo):
        raise EvidenceUnknown('Invalid repository identity')
    return tuple(repo.split('/', 1))


def review_backlog(repo: str, number: int) -> dict:
    owner, name = _repo(repo)
    identity = None
    collected = {}
    for connection, selection in (
        ('reviewThreads', 'id isResolved isOutdated'),
        ('latestOpinionatedReviews', 'id state author { login }'),
    ):
        nodes, cursor, seen = [], None, set()
        query = ('query($owner:String!,$name:String!,$number:Int!,$cursor:String){'
                 'repository(owner:$owner,name:$name){pullRequest(number:$number){'
                 'headRefOid updatedAt reviewDecision ' + connection +
                 '(first:100,after:$cursor){nodes{' + selection +
                 '}pageInfo{hasNextPage endCursor}}}}}')
        for _ in range(50):
            fields = {'query': query, 'owner': owner, 'name': name, 'number': number}
            if cursor is not None:
                fields['cursor'] = cursor
            data = api('graphql', fields)
            try:
                pr = data['data']['repository']['pullRequest']
                current_identity = (pr['headRefOid'], pr['updatedAt'], pr['reviewDecision'])
                page = pr[connection]
                if not isinstance(page['nodes'], list) or any(n is None for n in page['nodes']):
                    raise ValueError('Incomplete connection')
                if identity is not None and identity != current_identity:
                    raise EvidenceUnknown('PR changed during review pagination; re-read')
                identity = current_identity
                nodes.extend(page['nodes'])
                if not page['pageInfo']['hasNextPage']:
                    break
                cursor = page['pageInfo']['endCursor']
                if not cursor or cursor in seen:
                    raise ValueError('Invalid pagination cursor')
                seen.add(cursor)
            except (KeyError, TypeError, ValueError) as exc:
                raise EvidenceUnknown('Incomplete review evidence') from exc
        else:
            raise EvidenceUnknown('Review pagination limit reached; no clean verdict')
        collected[connection] = nodes
    threads = collected['reviewThreads']
    if any(type(t.get('isResolved')) is not bool for t in threads):
        raise EvidenceUnknown('Missing thread resolution state')
    reviews = collected['latestOpinionatedReviews']
    if any(r.get('state') not in {'APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED', 'PENDING'} for r in reviews):
        raise EvidenceUnknown('Unknown effective review state')
    unresolved = [t['id'] for t in threads if not t['isResolved']]
    changes = [r['id'] for r in reviews if r['state'] == 'CHANGES_REQUESTED']
    change_count = max(len(changes), int(identity[2] == 'CHANGES_REQUESTED'))
    return {'head_sha': identity[0], 'unresolved': len(unresolved),
            'changes_requested': change_count, 'thread_count': len(threads),
            'unresolved_thread_ids': unresolved, 'effective_change_review_ids': changes}


def source_relation(repo: str, number: int) -> dict:
    _repo(repo)
    prefix = 'repos/' + repo + '/'
    pr = api(prefix + 'pulls/' + str(number))
    try:
        head = pr['head']['sha']
        if not re.fullmatch(r'[0-9a-f]{40}', head):
            raise ValueError('Invalid head')
        commit = api(prefix + 'commits/' + head)
        ledger_path = 'docs/pr-history/' + str(number) + '.md'
        files = commit['files']
        if not isinstance(files, list) or not files:
            raise EvidenceUnknown('Incomplete final commit evidence')
        ledger_only = (len(files) == 1 and files[0]['filename'] == ledger_path
                       and files[0]['status'] in {'added', 'modified'})
        if not ledger_only:
            relation = {'source_sha': head, 'final_sha': head, 'sealed': False}
        else:
            parents = commit['parents']
            if len(parents) != 1:
                raise EvidenceUnknown('Final ledger commit must have exactly one parent')
            contents = api(prefix + 'contents/' + ledger_path + '?ref=' + head)
            if contents['encoding'] != 'base64':
                raise EvidenceUnknown('Unsupported ledger encoding')
            text = base64.b64decode(contents['content']).decode('utf-8').replace('\r\n', '\n')
            sources = re.findall(r'^- \*\*Source head:\*\* `([0-9a-f]{40})`[ \t]*$', text, re.M)
            if len(sources) != 1 or sources[0] != parents[0]['sha']:
                raise EvidenceUnknown('Ledger Source must bind the immediate code parent exactly once')
            relation = {'source_sha': sources[0], 'final_sha': head, 'sealed': True}
        if api(prefix + 'pulls/' + str(number))['head']['sha'] != head:
            raise EvidenceUnknown('Head changed during Source/final inspection')
        return relation
    except (KeyError, TypeError, ValueError, UnicodeError) as exc:
        raise EvidenceUnknown('Incomplete Source/final evidence') from exc


def exact_main_run(repo: str, sha: str, branch: str = 'main') -> dict:
    _repo(repo)
    query = urlencode({'head_sha': sha, 'event': 'push', 'branch': branch, 'per_page': 100})
    data = api('repos/' + repo + '/actions/workflows/ci.yml/runs?' + query)
    try:
        runs = [r for r in data['workflow_runs']
                if r['head_sha'] == sha and r['event'] == 'push' and r['head_branch'] == branch]
        if not runs:
            raise EvidenceUnknown('No exact-main push CI evidence')
        # Never select an older successful run over a newer pending/failed one.
        run = max(runs, key=lambda r: (r['id'], r['run_attempt']))
        if run['status'] != 'completed' or run['conclusion'] != 'success':
            raise EvidenceUnknown('Exact-main CI is not SUCCESS: ' + str(run['id']))
        return run
    except (KeyError, TypeError, ValueError) as exc:
        raise EvidenceUnknown('Incomplete exact-main CI evidence') from exc


def merge_proof(repo: str, number: int, branch: str = 'main') -> dict:
    _repo(repo)
    prefix = 'repos/' + repo + '/'
    pr = api(prefix + 'pulls/' + str(number))
    try:
        if not pr['merged'] or pr['base']['ref'] != branch:
            raise EvidenceUnknown('PR is not merged into the required base')
        merge = pr['merge_commit_sha']
        if not isinstance(merge, str) or not re.fullmatch(r'[0-9a-f]{40}', merge):
            raise EvidenceUnknown('Missing exact merge identity')
        main = api(prefix + 'git/ref/heads/' + branch)['object']['sha']
        if merge != main:
            comparison = api(prefix + 'compare/' + merge + '...' + main)
            if comparison.get('status') not in {'ahead', 'identical'}:
                raise EvidenceUnknown('Current main does not contain the exact merge')
        run = exact_main_run(repo, main, branch)
        if api(prefix + 'git/ref/heads/' + branch)['object']['sha'] != main:
            raise EvidenceUnknown('Main advanced during evidence capture; re-read')
        return {'pr': number, 'merge_sha': merge, 'main_sha': main,
                'main_ci': run['id'], 'main_ci_attempt': run['run_attempt']}
    except (KeyError, TypeError, ValueError) as exc:
        raise EvidenceUnknown('Incomplete merge evidence') from exc


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['review', 'merged', 'source'])
    parser.add_argument('--repo', required=True)
    parser.add_argument('--pr', type=int, required=True)
    parser.add_argument('--base', default='main')
    parser.add_argument('--tsv', action='store_true')
    args = parser.parse_args()
    try:
        if args.action == 'review':
            data = review_backlog(args.repo, args.pr)
        elif args.action == 'source':
            data = source_relation(args.repo, args.pr)
        else:
            data = merge_proof(args.repo, args.pr, args.base)
        if args.tsv and args.action == 'review':
            print(str(data['unresolved']) + '\t' + str(data['changes_requested']))
        else:
            print(json.dumps(data))
        return 0
    except EvidenceUnknown as exc:
        print('UNKNOWN: ' + str(exc), file=sys.stderr)
        return 6


if __name__ == '__main__':
    raise SystemExit(main())

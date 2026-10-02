"""Capture/validate exact evidence, without 'any historical SUCCESS' shortcuts."""
from __future__ import annotations
import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from feature_store import StoreConflict, load_document
from feature_state import target
from delivery import canonical_lead, package_snapshot, unit_pr_links, unit_rows, unit_token
from github_evidence import api, source_relation, EvidenceUnknown
from ci_observer import latest_ci
from action_plan import ledger_pending_final


GIT_EXE = r'D:\工具\Git\cmd\git.exe' if os.name == 'nt' else 'git'


def git(path, *args):
    result = subprocess.run([GIT_EXE, '-C', str(path), *args], capture_output=True, text=True, encoding='utf-8', timeout=15)
    if result.returncode: raise EvidenceUnknown('Cannot verify evidence worktree')
    return result.stdout.strip()


def capture(root, worktree, fid, number, repo, snapshot=None):
    root, worktree = Path(root).resolve(), Path(worktree).resolve()
    document = load_document(root / 'feature_list.json')
    if canonical_lead(document, fid) != fid:
        raise StoreConflict('Evidence must target canonical delivery lead')
    row = target(document, fid); expected_unit = unit_token(document, fid)
    if unit_pr_links(document, fid) != ['https://github.com/' + repo + '/pull/' + str(number)]:
        raise StoreConflict('Evidence PR is not this delivery-unit owner')
    head, branch = git(worktree, 'rev-parse', 'HEAD'), git(worktree, 'branch', '--show-current')
    if git(worktree, 'status', '--porcelain'):
        raise StoreConflict('Dirty worktree cannot stamp committed evidence')

    if snapshot is None:
        pr = api('repos/' + repo + '/pulls/' + str(number))
        if pr['head']['sha'] != head or pr['head']['ref'] != branch:
            raise StoreConflict('Local/remote evidence identities differ')
        relation = source_relation(repo, number)
        if relation['final_sha'] != head:
            raise StoreConflict('Source/final identity changed during evidence capture')
        missing = not relation['sealed'] and ledger_pending_final(repo, number, head)
        ci = latest_ci(repo, head, missing_ledger=missing)
        kind = 'final' if relation['sealed'] else 'source'
        green = ci['final_green'] if kind == 'final' else ci['source_green']
        if ci['state'] in {'missing', 'pending'}:
            raise EvidenceUnknown('CI has no terminal evidence yet')
        run = ci['run']
        jobs = [{'id': j['id'], 'name': j['name'], 'status': j['status'], 'conclusion': j['conclusion']}
                for j in sorted(ci['jobs'], key=lambda j: j['name'])]
        confirmed = api('repos/' + repo + '/pulls/' + str(number))
        if (confirmed['head']['sha'] != head or confirmed['head']['ref'] != branch
                or confirmed.get('state') != pr.get('state') or confirmed.get('merged') != pr.get('merged')):
            raise StoreConflict('Remote owner identity changed during evidence capture')
    else:
        required = ('row_token', 'pr', 'source_sha', 'final_sha', 'pr_head_ref', 'sealed',
                    'source_review_clear', 'ci_state', 'source_green', 'final_green',
                    'ci_run', 'ci_attempt', 'ci_url', 'ci_jobs')
        if any(key not in snapshot for key in required):
            raise StoreConflict('Handoff snapshot is incomplete')
        if snapshot['row_token'] != expected_unit or snapshot['pr'] != number:
            raise StoreConflict('Handoff snapshot does not belong to this delivery unit')
        if (snapshot['final_sha'] != head or snapshot['pr_head_ref'] != branch
                or not snapshot['sealed'] or not snapshot['source_review_clear']
                or snapshot['ci_state'] != 'success' or not snapshot['final_green']):
            raise StoreConflict('Handoff snapshot is not an exact green final')
        if not isinstance(snapshot['ci_run'], int) or not isinstance(snapshot['ci_attempt'], int):
            raise StoreConflict('Handoff snapshot CI identity is invalid')
        if not isinstance(snapshot['ci_url'], str) or not snapshot['ci_url']:
            raise StoreConflict('Handoff snapshot CI URL is invalid')
        raw_jobs = snapshot['ci_jobs']
        if not isinstance(raw_jobs, list) or not raw_jobs:
            raise StoreConflict('Handoff snapshot CI jobs are missing')
        jobs = []
        for item in raw_jobs:
            if (not isinstance(item, dict)
                    or set(item) != {'id', 'name', 'status', 'conclusion'}):
                raise StoreConflict('Handoff snapshot CI jobs are invalid')
            jobs.append({key: item[key] for key in ('id', 'name', 'status', 'conclusion')})
        jobs.sort(key=lambda item: item['name'])
        relation = {'source_sha': snapshot['source_sha'], 'final_sha': snapshot['final_sha'], 'sealed': True}
        kind = 'final'; green = True
        run = {'id': snapshot['ci_run'], 'run_attempt': snapshot['ci_attempt'],
               'html_url': snapshot['ci_url']}
        ci = {'source_green': snapshot['source_green'], 'final_green': snapshot['final_green']}

    if git(worktree, 'rev-parse', 'HEAD') != head or git(worktree, 'status', '--porcelain'):
        raise StoreConflict('Source changed during evidence capture')
    code = 0 if green else 1
    text = '\n'.join(['EVIDENCE_HEAD=' + head, 'EVIDENCE_BRANCH=' + branch,
                      'EVIDENCE_KIND=' + kind, 'SOURCE_HEAD=' + relation['source_sha'],
                      'DELIVERY_CONTRACT=' + ((package_snapshot(document, fid) or {}).get('contract_sha256') or 'single'),
                      'CI_RUN=' + str(run['id']), 'CI_ATTEMPT=' + str(run['run_attempt']),
                      'CI_URL=' + run['html_url'], 'SOURCE_PRODUCT_LANES_GREEN=' + str(int(ci['source_green'])),
                      'FINAL_CI_GREEN=' + str(int(ci['final_green'])), json.dumps(jobs, sort_keys=True), 'EXIT=' + str(code), ''])
    directory = root / '.agent-artifacts' / fid.lower(); directory.mkdir(parents=True, exist_ok=True)
    path = directory / ('ci-%s-%s-%s-%s.log' % (number, head, run['id'], run['run_attempt']))
    if unit_token(load_document(root / 'feature_list.json'), fid) != expected_unit:
        raise StoreConflict('Delivery unit changed during evidence capture')
    if path.exists():
        if path.read_text(encoding='utf-8') != text:
            raise StoreConflict('Existing evidence identity has different contents')
    else:
        with path.open('x', encoding='utf-8', newline='\n') as stream:
            stream.write(text)
    return {'path': str(path.relative_to(root)).replace('\\', '/'), 'exit': code, 'kind': kind,
            'head': head, 'source_sha': relation['source_sha'],
            'ci_run': run['id'], 'ci_attempt': run['run_attempt']}

def check_log(text, source, final, branch):
    lines = text.splitlines()
    values = {}
    for line in lines:
        if re.match(r'^(EVIDENCE_HEAD|EVIDENCE_BRANCH|EVIDENCE_KIND|EXIT)=', line):
            key, value = line.split('=', 1)
            if key in values: raise StoreConflict('Duplicate evidence field: ' + key)
            values[key] = value
    if not lines or lines[-1] != 'EXIT=0': raise StoreConflict('Evidence incomplete or unsuccessful')
    if values.get('EVIDENCE_HEAD') not in {source, final}: raise StoreConflict('Stale Source evidence')
    if values.get('EVIDENCE_BRANCH') != branch: raise StoreConflict('Evidence belongs to another branch')
    if values.get('EVIDENCE_KIND') == 'final' and values['EVIDENCE_HEAD'] != final:
        raise StoreConflict('Source CI cannot impersonate final CI')
    return True


def check(root, worktree, fid, repo):
    root = Path(root).resolve(); document = load_document(root / 'feature_list.json')
    if canonical_lead(document, fid) != fid:
        raise StoreConflict('Evidence check must target canonical delivery lead')
    rows = unit_rows(document, fid); row = rows[0]
    urls = unit_pr_links(document, fid)
    if len(urls) != 1 or not re.fullmatch('https://github\\.com/' + re.escape(repo) + r'/pull/\d+', urls[0]):
        raise StoreConflict('Evidence requires one exact owner PR')
    number = int(urls[0].rsplit('/', 1)[1]); relation = source_relation(repo, number)
    branch = git(worktree, 'branch', '--show-current'); head = git(worktree, 'rev-parse', 'HEAD')
    if head != relation['final_sha']: raise StoreConflict('Worktree does not match submitted final head')
    evidence_sets = {tuple(member.get('evidence') or []) for member in rows}
    if len(evidence_sets) != 1:
        raise StoreConflict('Delivery member evidence lists drifted')
    checked = []
    for name in row.get('evidence') or []:
        if not name.endswith('.log'): continue
        path = (root / name).resolve()
        if not path.is_relative_to(root): raise StoreConflict('Evidence outside workspace')
        text = path.read_text(encoding='utf-8')
        check_log(text, relation['source_sha'], relation['final_sha'], branch); checked.append(name)
    if not checked: raise StoreConflict('No currently listed, head-stamped logs; historical folders are not acceptance')
    return {'checked': checked, 'head': head, 'source': relation['source_sha']}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['capture', 'check']); parser.add_argument('root', type=Path)
    parser.add_argument('worktree', type=Path); parser.add_argument('feature'); parser.add_argument('--pr', type=int)
    parser.add_argument('--repo', default='U2SG/startrips'); args = parser.parse_args()
    try:
        if args.action == 'capture':
            if not args.pr: parser.error('--pr required')
            result = capture(args.root, args.worktree, args.feature, args.pr, args.repo)
        else: result = check(args.root, args.worktree, args.feature, args.repo)
        print(json.dumps(result)); return result.get('exit', 0)
    except (StoreConflict, EvidenceUnknown, OSError, ValueError, KeyError, subprocess.TimeoutExpired) as exc:
        print('EVIDENCE_UNKNOWN: ' + str(exc), file=sys.stderr); return 6


if __name__ == '__main__':
    raise SystemExit(main())


"""Exact-head CI and append-only failure evidence; not another work queue."""
from __future__ import annotations
import argparse
import datetime
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from urllib.parse import urlencode
from feature_store import _storage_mutex, StoreConflict
from github_evidence import api, _repo, EvidenceUnknown

DIMENSIONS = ('lane', 'assertion', 'fixture', 'viewport', 'dpr', 'stage')
PARSER_VERSION = 4
INFRA = ('failed to resolve action download info', 'service unavailable',
         'failed to download action', 'the runner has lost communication')


def pages(endpoint, key=None):
    result = []
    for page in range(1, 51):
        data = api(endpoint + ('&' if '?' in endpoint else '?') + 'per_page=100&page=' + str(page))
        batch = data.get(key) if key else data
        if not isinstance(batch, list):
            raise EvidenceUnknown('Incomplete paginated CI evidence')
        result.extend(batch)
        if len(batch) < 100:
            return result
    raise EvidenceUnknown('CI pagination limit; no acceptance')


def effective_jobs(jobs):
    latest = {}
    for job in jobs:
        if not isinstance(job.get('name'), str) or not isinstance(job.get('id'), int):
            raise EvidenceUnknown('Missing job identity')
        if job['name'] not in latest or job['id'] > latest[job['name']]['id']:
            latest[job['name']] = job
    return list(latest.values())


def classify(run, jobs, missing_ledger=False):
    effective = effective_jobs(jobs)
    names = {j['name'] for j in effective}
    required = {'ledger', 'core', 'verify'}
    missing = required - names
    if missing:
        # GitHub does not instantiate deferred `needs` jobs (notably verify) until
        # their prerequisites finish. A still-running workflow with a missing
        # required job is pending evidence, not an UNKNOWN gate.
        if run.get('status') != 'completed':
            return {'state': 'pending', 'source_green': False, 'final_green': False, 'failures': []}
        raise EvidenceUnknown('Required ci jobs absent: ' + ','.join(sorted(missing)))
    if any(j.get('status') != 'completed' for j in effective) or run.get('status') != 'completed':
        return {'state': 'pending', 'source_green': False, 'final_green': False, 'failures': []}
    if run.get('conclusion') not in {'success', 'failure'}:
        return {'state': 'unknown', 'source_green': False, 'final_green': False, 'failures': []}
    failures = [j for j in effective if j.get('conclusion') != 'success']
    product = [j for j in effective if j['name'] not in {'ledger', 'verify'}]
    product_green = bool(product) and all(j.get('conclusion') == 'success' for j in product)
    ledger = next(j for j in effective if j['name'] == 'ledger')
    failed_steps = [step.get('name') for step in ledger.get('steps', []) if step.get('conclusion') == 'failure']
    expected_ledger_gap = missing_ledger and failed_steps == ['Validate current PR ledger']
    source_green = product_green and (not failures or (expected_ledger_gap and all(j['name'] in {'ledger', 'verify'} for j in failures)))
    final_green = not failures and run.get('conclusion') == 'success'
    return {'state': 'success' if final_green else 'failure', 'source_green': source_green,
            'final_green': final_green, 'failures': failures}


def latest_ci(repo, sha, *, missing_ledger=False, event='pull_request', branch=None):
    _repo(repo)
    if not re.fullmatch('[0-9a-f]{40}', sha):
        raise EvidenceUnknown('Invalid CI Source identity')
    query = {'head_sha': sha, 'event': event, 'per_page': 100}
    if branch:
        query['branch'] = branch
    data = api('repos/' + repo + '/actions/workflows/ci.yml/runs?' + urlencode(query))
    if not isinstance(data.get('workflow_runs'), list):
        raise EvidenceUnknown('CI runs unavailable')
    runs = [r for r in data['workflow_runs'] if r.get('head_sha') == sha and r.get('event') == event
            and (branch is None or r.get('head_branch') == branch)]
    if not runs:
        return {'state': 'missing', 'source_green': False, 'final_green': False, 'failures': [], 'run': None, 'jobs': []}
    run = max(runs, key=lambda r: (r['id'], r['run_attempt']))
    jobs = pages('repos/' + repo + '/actions/runs/' + str(run['id']) + '/jobs?filter=all', 'jobs')
    jobs = [j for j in jobs if j.get('run_id') == run['id'] and j.get('head_sha') == sha]
    fresh = api('repos/' + repo + '/actions/runs/' + str(run['id']))
    if any(fresh.get(k) != run.get(k) for k in ('id', 'head_sha', 'run_attempt', 'status', 'conclusion')):
        raise EvidenceUnknown('Run changed during CI capture')
    result = classify(run, jobs, missing_ledger)
    result.update(run=run, jobs=effective_jobs(jobs))
    return result


def normalize_failure(job, text):
    clean = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', text)
    lines = [re.sub(r'^\d{4}-\d\d-\d\dT\S+\s*', '', line).strip() for line in clean.splitlines()]
    # Match runtime diagnostics, not workflow command echoes such as curl --fail
    # or JavaScript source excerpts containing throw new Error(...).
    runtime = re.compile(r'^(?:[\w.]+(?:Error|Exception)|Error|Exception)(?:\s+\[[^\]]+\])?:', re.I)
    playwright_timeout = re.compile(r'^(?:locator|page|frame|elementhandle)\.[\w.]+:\s*Timeout\b', re.I)
    errors = [line for line in lines if runtime.search(line) or playwright_timeout.search(line)]
    if not errors:
        errors = [line for line in lines if re.match(r'^(?:FAIL(?:\s|:)|Assertion failed(?:\s|:)|✗\s)', line, re.I)]
    if not errors:
        errors = [line for line in lines if re.match(r'^(?:##\[error\]|The runner has lost communication|Failed to resolve action download info|Failed to download action|Service Unavailable)', line, re.I)]
    primary = errors[0] if errors else 'unclassified-job-failure'
    # Playwright reports the actionable selector on the next `waiting for` line.
    # Fold it into the primary assertion so two distinct locator timeouts in the
    # same browser lane do not collapse into one generic timeout/exit-code family.
    if playwright_timeout.search(primary):
        wait_line = next((line for line in lines if re.match(r'^-\s+waiting for\s+', line, re.I)), '')
        if wait_line:
            primary = f'{primary} {wait_line}'
    context = '\n'.join([primary, *errors[1:]]) if errors else primary
    assertion = re.sub(r'\b[0-9a-f]{7,40}\b', '<sha>', primary)
    assertion = re.sub(r'https?://\S+', '<url>', assertion)
    assertion = re.sub(r'(?i)(bearer\s+)[^\s]+', r'\1<redacted>', assertion)
    assertion = re.sub(r'(?i)((?:token|secret|api[_-]?key|password)[\s:=]+)[^\s,;]+', r'\1<redacted>', assertion)
    assertion = re.sub(r'(?i)\b\d+(?:\.\d+)?\s*(?:ms|sec(?:onds?)?|s)\b', '<duration>', assertion)
    # Measurements vary between occurrences of one assertion; viewport and DPR
    # remain explicit dimensions, never inferred from zoom or incidental numbers.
    assertion = re.sub(r'(?<![\w])\d+(?:\.\d+)?(?![\w])', '<number>', assertion)[:600]
    def field(pattern, default='unknown'):
        match = re.search(pattern, context, re.I)
        return match.group(1)[:120] if match else default
    explicit_fixture = field(r'(?:fixtureId|fixture)["\s:=]+([\w.-]+)')
    failed_fixtures = re.findall(r'(?:\]\s+|;\s*)([\w.-]+)\s+@[\d.]+x\s*:', context)
    if explicit_fixture.lower() in {'unknown', 'not', 'none', 'null', 'true', 'false', 'rendered'}:
        explicit_fixture = '|'.join(dict.fromkeys(failed_fixtures))[:120] or 'unknown'
    stage = next((s['name'] for s in job.get('steps', []) if s.get('conclusion') == 'failure'), 'unknown')
    dims = {'lane': job['name'], 'assertion': assertion,
            'fixture': explicit_fixture,
            'viewport': field(r'viewport["\s:=]+(\d{3,4}\s*[x×]\s*\d{3,4})'),
            'dpr': field(r'(?:DPR|devicePixelRatio)["\s:=]+([1-9](?:\.\d+)?)'), 'stage': stage}
    fingerprint = hashlib.sha256(json.dumps(dims, sort_keys=True).encode()).hexdigest()
    diagnostic = primary.lower()
    lane = job['name'].lower()
    infrastructure = any(needle in diagnostic for needle in INFRA) and not re.search(r'assertionerror|assertion failed|\[qa[-_]', diagnostic)
    # Family routing is derived only from the current primary assertion and the
    # exact failing lane. Never let stale text elsewhere in a long browser log
    # relabel an unrelated current failure.
    if re.search(r'journey.?rail|rail.*hidden', diagnostic):
        family = 'journey-rail-visibility'
    elif 'city-label' in lane or re.search(r'hong kong|inland.control', diagnostic):
        family = 'city-label-anchoring'
    else:
        family = fingerprint[:16]
    return {'parser_version': PARSER_VERSION, 'fingerprint': fingerprint, **dims, 'family': family, 'infrastructure': infrastructure}


def write_json(path, data):
    path = Path(path); path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix='.' + path.name, dir=path.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8', newline='\n') as stream:
            json.dump(data, stream, ensure_ascii=False, indent=2); stream.write('\n'); stream.flush(); os.fsync(stream.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name): os.unlink(name)


def observe_failures(root, repo, ci):
    root = Path(root); run = ci.get('run')
    if not run:
        return []
    history = root / '.agent-artifacts/ci-failures'
    records = []
    for job in ci['failures']:
        if job['name'] in {'ledger', 'verify'}:
            continue  # verified pre-ledger state, not a flaky failure
        result = subprocess.run(['gh', 'api', 'repos/' + repo + '/actions/jobs/' + str(job['id']) + '/logs'],
                                capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=25)
        if result.returncode or len(result.stdout) > 8 * 1024 * 1024:
            raise EvidenceUnknown('Failed-job evidence unavailable or too large')
        record = normalize_failure(job, result.stdout)
        record.update(repo=repo, run_id=run['id'], attempt=job.get('run_attempt', run['run_attempt']), job_id=job['id'],
                      sha=run['head_sha'], job_url=job.get('html_url'), observed_at=datetime.datetime.now(datetime.timezone.utc).isoformat())
        path = history / ('failure-%s-%s-%s-v%s.json' % (run['id'], record['attempt'], job['id'], PARSER_VERSION))
        with _storage_mutex(root / 'feature_list.json'):
            old = []
            if history.exists():
                for item in history.glob('failure-*.json'):
                    data = json.loads(item.read_bytes())
                    if data.get('repo') != repo:
                        continue
                    same_exact_fingerprint = data.get('fingerprint') == record['fingerprint']
                    same_current_family = (
                        data.get('parser_version') == record['parser_version']
                        and data.get('family') == record['family']
                    )
                    if same_exact_fingerprint or same_current_family:
                        old.append(data)
            identities = {(r['run_id'], r['attempt'], r['job_id']) for r in old}
            identities.add((record['run_id'], record['attempt'], record['job_id']))
            record['family_occurrences'] = len(identities)
            record['root_cause_required'] = len(identities) >= 2 or record['family'] == 'journey-rail-visibility'
            if not path.exists(): write_json(path, record)
        records.append(record)
    return records


def rerun_eligibility(run, failures):
    if run.get('status') != 'completed' or run.get('conclusion') != 'failure':
        return False, 'run-not-failed-terminal'
    if run.get('run_attempt', 0) != 1:
        return False, 'one-targeted-rerun-budget-exhausted'
    if not failures or any(not f['infrastructure'] or f['root_cause_required'] for f in failures):
        return False, 'root-cause-or-unknown-failure-no-rerun'
    return True, 'one-established-infrastructure-retry'


def rerun_once(root, repo, ci, records, *, number=None, feature=None, lane=None):
    allowed, reason = rerun_eligibility(ci['run'], records)
    if not allowed: return {'requested': False, 'reason': reason}
    run = ci['run']; root = Path(root)
    from feature_store import load_document
    from feature_state import target
    from execution import stopped
    if lane not in {'backend', 'experience'}:
        raise StoreConflict('Targeted rerun requires exact execution lane')
    if stopped(root, lane=lane): return {'requested': False, 'reason': 'owner-stop'}
    if not number or not feature: raise StoreConflict('Targeted rerun requires exact owner feature/PR')
    row = target(load_document(root / 'feature_list.json'), feature)
    if row.get('human_gate') or row.get('pr_links') != ['https://github.com/' + repo + '/pull/' + str(number)]:
        raise StoreConflict('Rerun is not bound to this owner PR')
    # Durable request evidence prevents replay after uncertain POST responses.
    receipt = root / '.agent-artifacts/ci-failures' / ('rerun-%s-%s.json' % (run['id'], run['run_attempt']))
    with _storage_mutex(root / 'feature_list.json'):
        if receipt.exists(): return {'requested': False, 'reason': 'already-attempted-or-uncertain'}
        fresh = api('repos/' + repo + '/actions/runs/' + str(run['id']))
        if any(fresh.get(k) != run.get(k) for k in ('head_sha', 'run_attempt', 'status', 'conclusion')):
            raise EvidenceUnknown('Run changed before targeted rerun')
        pr = api('repos/' + repo + '/pulls/' + str(number))
        if pr.get('state') != 'open' or pr.get('merged') or pr['head']['sha'] != run['head_sha']:
            raise EvidenceUnknown('Owner PR changed before rerun')
        write_json(receipt, {'state': 'request-prepared-no-replay', 'run': run['id'], 'attempt': run['run_attempt'], 'sha': run['head_sha']})
    selected = records[0]['job_id']
    result = subprocess.run(['gh', 'api', 'repos/' + repo + '/actions/jobs/' + str(selected) + '/rerun', '--method', 'POST'],
                            capture_output=True, text=True, encoding='utf-8', timeout=25)
    status = 'accepted' if result.returncode == 0 else 'uncertain-or-rejected-no-replay'
    with _storage_mutex(root / 'feature_list.json'):
        write_json(receipt, {'state': status, 'run': run['id'], 'attempt': run['run_attempt'], 'sha': run['head_sha'], 'job': selected})
    return {'requested': result.returncode == 0, 'reason': status, 'job': selected}


def backfill_attempt(root, repo, run_id, attempt):
    if run_id < 1 or attempt < 1: raise StoreConflict('Positive exact run/attempt required')
    prefix = 'repos/' + repo + '/actions/runs/' + str(run_id)
    observed = api(prefix + '/attempts/' + str(attempt))
    if observed.get('id') != run_id or observed.get('run_attempt') != attempt or observed.get('status') != 'completed':
        raise EvidenceUnknown('Historical attempt identity is not completed/exact')
    jobs = pages(prefix + '/attempts/' + str(attempt) + '/jobs', 'jobs')
    if any(job.get('run_id') != run_id or job.get('head_sha') != observed.get('head_sha') or job.get('run_attempt') != attempt for job in jobs):
        raise EvidenceUnknown('Historical jobs do not bind the requested attempt')
    failures = [job for job in effective_jobs(jobs) if job.get('conclusion') == 'failure']
    records = observe_failures(root, repo, {'run': observed, 'failures': failures})
    return {'run': run_id, 'attempt': attempt, 'sha': observed['head_sha'], 'failures': records,
            'historical_only': True, 'rerun_requested': False}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, required=True); parser.add_argument('--repo', required=True)
    parser.add_argument('--feature'); parser.add_argument('--pr', type=int)
    parser.add_argument('--sha'); parser.add_argument('--rerun', action='store_true')
    parser.add_argument('--history-run', type=int); parser.add_argument('--history-attempt', type=int)
    args = parser.parse_args()
    try:
        if args.history_run:
            if args.rerun or not args.history_attempt: parser.error('History needs an exact attempt and cannot rerun')
            print(json.dumps(backfill_attempt(args.root, args.repo, args.history_run, args.history_attempt))); return 0
        if not args.sha: parser.error('--sha required for current CI')
        ci = latest_ci(args.repo, args.sha)
        records = observe_failures(args.root, args.repo, ci)
        result = {'state': ci['state'], 'run': ci['run']['id'] if ci['run'] else None, 'failures': records}
        if args.rerun:
            role = os.environ.get('STARTRIPS_ROLE')
            if role not in {'local-backend', 'experience'}:
                raise StoreConflict('Only an executing owner may request its bounded CI retry')
            lane = 'backend' if role == 'local-backend' else 'experience'
            result['rerun'] = rerun_once(args.root, args.repo, ci, records, number=args.pr, feature=args.feature, lane=lane) if ci['run'] else {'requested': False}
        print(json.dumps(result)); return 0
    except (StoreConflict, EvidenceUnknown, OSError, ValueError, KeyError, subprocess.TimeoutExpired) as exc:
        print('CI_UNKNOWN: ' + str(exc), file=sys.stderr); return 6


if __name__ == '__main__':
    raise SystemExit(main())


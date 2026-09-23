"""Derive the selected feature's action from evidence, without another queue/status."""
from __future__ import annotations
import argparse
import base64
import datetime
import json
import os
import re
import sys
from pathlib import Path
from urllib.parse import urlencode
from feature_store import StoreConflict, load_document, commit_document
from feature_state import target, row_token, TERMINAL
from github_evidence import api, source_relation, review_backlog, merge_proof, EvidenceUnknown
from ci_observer import latest_ci, observe_failures, write_json, pages
from delivery import (blockers as delivery_blockers, canonical_lead, grouped,
                      package_snapshot, review_snapshot, unit_pr_links, unit_rows, unit_token,
                      validate_coverage)
from delivery_issues import assert_current as assert_issue_current, live_issues


def receipt_path(root, fid, sha):
    if not re.fullmatch(r'ST-\d{3,}', fid) or not re.fullmatch(r'[0-9a-f]{40}', sha):
        raise StoreConflict('Invalid source review identity')
    return Path(root) / '.agent-artifacts/evaluations' / (fid + '-' + sha + '-source-review.json')


def source_review(root, fid, pr, sha, delivery=None):
    path = receipt_path(root, fid, sha)
    if not path.exists():
        return 'MISSING'
    data = json.loads(path.read_bytes())
    if (data.get('feature') != fid or data.get('pr') != pr or data.get('source_sha') != sha
            or data.get('reviewer_role') != 'hourly-review' or not data.get('completed_at')
            or not isinstance(data.get('reviewed_paths'), list) or not data['reviewed_paths']
            or not isinstance(data.get('evidence'), list) or not data['evidence']
            or not isinstance(data.get('findings'), list)):
        raise EvidenceUnknown('Source review receipt identity/evidence invalid')
    verdict = data.get('verdict')
    if delivery is not None:
        if data.get('delivery_package') != delivery:
            raise EvidenceUnknown('Source review delivery scope/revision is stale')
        try:
            coverage = validate_coverage(delivery, data.get('member_coverage'), require_pass=(verdict == 'CLEAR'))
            if verdict == 'CHANGES_REQUESTED' and not any(item.get('verdict') == 'CHANGES_REQUESTED' for item in coverage.values()):
                raise StoreConflict('Package CHANGES_REQUESTED must identify at least one affected member')
        except StoreConflict as exc:
            raise EvidenceUnknown(str(exc)) from exc
    elif data.get('delivery_package') not in (None, {}):
        raise EvidenceUnknown('Single-feature review unexpectedly carries delivery scope')
    if verdict == 'CLEAR':
        if data['findings']:
            raise EvidenceUnknown('CLEAR Source review carries findings')
        return 'CLEAR'
    if verdict == 'CHANGES_REQUESTED':
        if not data['findings']:
            raise EvidenceUnknown('CHANGES_REQUESTED Source review has no findings')
        return 'CHANGES_REQUESTED'
    raise EvidenceUnknown('Unknown Source review verdict')


def has_ledger(repo, number, sha):
    data = api('repos/' + repo + '/contents/docs/pr-history?ref=' + sha)
    if not isinstance(data, list) or len(data) >= 1000:
        raise EvidenceUnknown('Ledger directory observation incomplete')
    return any(item.get('path') == 'docs/pr-history/' + str(number) + '.md' for item in data)


def ledger_pending_final(repo, number, source):
    own = 'docs/pr-history/' + str(number) + '.md'
    files = pages('repos/' + repo + '/pulls/' + str(number) + '/files')
    if len(files) >= 3000: raise EvidenceUnknown('PR file listing may be truncated')
    for item in files:
        for path in [item.get('filename', ''), item.get('previous_filename', '')]:
            if path == 'docs/pr-history.md' or (re.fullmatch(r'docs/pr-history/\d+[.]md', path) and path != own):
                return False
    if not has_ledger(repo, number, source):
        return True
    content = api('repos/' + repo + '/contents/' + own + '?ref=' + source)
    if content.get('encoding') != 'base64': raise EvidenceUnknown('Ledger encoding unavailable')
    text = base64.b64decode(content['content']).decode('utf-8').replace('\r\n', '\n')
    for field in ['Source head', 'Scope', 'User-visible change', 'Review fixes', 'Follow-up', 'Validation']:
        matches = re.findall(r'^- \*\*' + re.escape(field) + r':\*\* ([^\n]+)$', text, re.M)
        if len(matches) != 1 or not matches[0].strip(): return False
    old = re.findall(r'^- \*\*Source head:\*\* `([0-9a-f]{40})`[ \t]*$', text, re.M)
    if len(old) != 1 or old[0] == source or '\ufffd' in text:
        return False
    relation = api('repos/' + repo + '/compare/' + old[0] + '...' + source)
    return relation.get('status') == 'ahead'


def derive(row, pr=None, relation=None, review=None, ci=None, source_verdict='MISSING', merge_clear=False):
    if row.get('status') in TERMINAL or row.get('human_gate'):
        return 'OBSERVE'
    if not row.get('pr_links'):
        return 'OWNERSHIP_RECONCILE' if row.get('status') in {'ready_for_eval','ready_to_merge'} else 'IMPLEMENT'
    if pr is None:
        return 'WAIT_EVIDENCE'
    if pr.get('merged'):
        return 'RECONCILE' if merge_clear else 'WAIT_MAIN_CI'
    if pr.get('state') != 'open':
        return 'OWNERSHIP_RECONCILE'
    if review is None or relation is None or ci is None:
        return 'WAIT_EVIDENCE'
    if review['unresolved'] or review['changes_requested']:
        return 'REPAIR_REVIEW'
    if pr.get('mergeable') is False:
        return 'REPAIR_CONFLICT'
    if source_verdict == 'CHANGES_REQUESTED':
        return 'REPAIR_REVIEW'
    if ci['state'] == 'unknown':
        return 'WAIT_EVIDENCE'
    if ci['state'] in {'pending', 'missing'}:
        return 'WAIT_FINAL_CI' if relation['sealed'] else 'WAIT_SOURCE_CI'
    if not (ci['final_green'] if relation['sealed'] else ci['source_green']):
        return 'REPAIR_CI'
    if source_verdict != 'CLEAR':
        return 'WAIT_SOURCE_REVIEW'
    if not relation['sealed']:
        return 'SEAL'
    if row.get('status') == 'needs_work':
        # `needs_work` is an explicit owner-repair disposition. It may be written
        # after a product/security clarification without changing the already
        # sealed PR head, so a SHA-only historical CLEAR must never promote that
        # old final directly to handoff. The owner must first produce a Source
        # that represents the current accepted contract; normal Source/CI/review
        # gates will then apply to that new head.
        return 'IMPLEMENT'
    if row.get('status') in {'ready_for_eval', 'ready_to_merge'}:
        return 'WAIT_REVIEW'
    return 'HANDOFF_REVIEW'



def failure_family_owner(path, fid, repo, records):
    """Return the unique nonterminal ONE feature whose mapped issue proves ownership.

    Ownership is evidence-derived, never inferred from lane/name similarity. An
    exact non-infrastructure CI fingerprint (full or 16-char prefix) present in an
    active feature's GitHub issue body/comments proves the mapping even on the
    first observed occurrence. The selected feature yields only when every product
    failure in the exact run maps to the same external owner; mixed or unowned
    failures stay with the selected feature. Ambiguity is UNKNOWN.
    """
    def record_tokens(record):
        tokens = set()
        fingerprint = record.get('fingerprint')
        family = record.get('family')
        if isinstance(fingerprint, str) and re.fullmatch(r'[0-9a-f]{64}', fingerprint):
            tokens.update({fingerprint, fingerprint[:16]})
        if isinstance(family, str) and re.fullmatch(r'[0-9a-f]{16,64}', family):
            tokens.add(family)
        return tokens

    product_records = [record for record in records if not record.get('infrastructure')]
    if not product_records:
        return None

    def mapped_issue(value):
        match = re.search(r'(\d+)\s*$', str(value or ''))
        return int(match.group(1)) if match else None

    active_states = {'pending', 'in_progress', 'needs_work', 'ready_for_eval', 'ready_to_merge'}
    candidates = set()
    by_issue = {}
    owner_doc = load_document(path)
    for candidate in owner_doc['features']:
        if candidate.get('status') not in active_states or candidate.get('human_gate'):
            continue
        number = mapped_issue(candidate.get('issue'))
        if not number:
            continue
        try:
            owner_id = canonical_lead(owner_doc, candidate['id'])
        except StoreConflict as exc:
            raise EvidenceUnknown(str(exc)) from exc
        candidates.add((owner_id, number))
        by_issue.setdefault(number, set()).add(owner_id)

    def collapse_matches(values):
        by_owner = {}
        for feature, number, hit in values:
            if not hit:
                continue
            value = by_owner.setdefault(feature, {'feature': feature, 'issues': set(), 'matched_tokens': set()})
            value['issues'].add(number); value['matched_tokens'].update(hit)
        return [{'feature': value['feature'], 'issue': min(value['issues']),
                 'matched_tokens': sorted(value['matched_tokens'])} for value in by_owner.values()]

    def indexed_matches(tokens):
        matched = {}
        for token in sorted(tokens, key=lambda value: (len(value), value)):
            query = urlencode({'q': f'repo:{repo} is:issue {token} in:title,body,comments', 'per_page': 100})
            data = api('search/issues?' + query)
            items = data.get('items') if isinstance(data, dict) else None
            if (not isinstance(items, list) or data.get('incomplete_results') is True
                    or data.get('total_count', 0) > len(items)):
                return None
            for issue in items:
                number = issue.get('number') if isinstance(issue, dict) else None
                for feature in by_issue.get(number, set()):
                    matched.setdefault((feature, number), set()).add(token)
        return collapse_matches((feature, number, hit) for (feature, number), hit in matched.items())

    def exhaustive_matches(tokens):
        values = []
        for feature, number in sorted(candidates):
            issue = api('repos/' + repo + '/issues/' + str(number))
            comments = pages('repos/' + repo + '/issues/' + str(number) + '/comments')
            if not isinstance(issue, dict) or not isinstance(comments, list):
                raise EvidenceUnknown('Failure-family owner issue evidence incomplete')
            text = '\n'.join(
                [str(issue.get('title') or ''), str(issue.get('body') or '')]
                + [str(comment.get('body') or '') for comment in comments]
            ).lower()
            values.append((feature, number, sorted(token for token in tokens if token.lower() in text)))
        return collapse_matches(values)

    routed = []
    for record in product_records:
        tokens = record_tokens(record)
        if not tokens:
            return None
        matches = indexed_matches(tokens)
        if matches is None or not matches:
            matches = exhaustive_matches(tokens)
        if len(matches) > 1:
            raise EvidenceUnknown(
                'Ambiguous failure-family ownership: '
                + ','.join(sorted(match['feature'] for match in matches)))
        if not matches:
            return None
        routed.append(matches[0])

    owners = {match['feature'] for match in routed}
    if len(owners) != 1 or fid in owners:
        return None
    owner = routed[0]
    return {
        'feature': owner['feature'],
        'issue': owner['issue'],
        'matched_tokens': sorted({token for match in routed for token in match['matched_tokens']}),
    }


def family_history_shas(root, repo, records):
    """Head SHAs on which recurring failure families were already observed."""
    history = Path(root) / '.agent-artifacts/ci-failures'
    families = {record['family'] for record in records
                if record.get('root_cause_required') and record.get('family')}
    seen = {}
    if not families or not history.exists():
        return seen
    for item in history.glob('failure-*.json'):
        try:
            data = json.loads(item.read_bytes())
        except (ValueError, OSError):
            continue
        if data.get('repo') != repo or data.get('family') not in families:
            continue
        sha = data.get('sha')
        if isinstance(sha, str) and re.fullmatch(r'[0-9a-f]{40}', sha):
            seen.setdefault(data['family'], set()).add(sha)
    return seen


def plan(path, fid, repo, *, record_failures=False):
    path = Path(path); root = path.parent; doc = load_document(path)
    if canonical_lead(doc, fid) != fid:
        raise StoreConflict('Package member must be planned through canonical lead')
    rows = unit_rows(doc, fid); row = rows[0]; package = review_snapshot(doc, fid)
    statuses = {member.get('status') for member in rows}; pass_values = {bool(member.get('passes')) for member in rows}
    if package and (len(statuses) != 1 or len(pass_values) != 1):
        raise StoreConflict('Delivery package lifecycle drift')
    gated = [(member['id'], member.get('human_gate')) for member in rows if member.get('human_gate')]
    if gated:
        unit_row = dict(row, human_gate='; '.join(mid + ': ' + str(gate) for mid, gate in gated))
    else:
        unit_row = row
    token = unit_token(doc, fid)
    result = {'feature': fid, 'row_token': token, 'action': derive(unit_row),
              'source_sha': None, 'final_sha': None}
    if package:
        # A package review/owner cannot silently outlive changed member issue scope.
        # The registered observation is frozen in ONE; new content must be
        # explicitly acknowledged/revised before any next action is trusted.
        current_issues = live_issues(doc, fid, repo)
        assert_issue_current(doc, fid, current_issues)
        result['delivery_package'] = package
        result['members'] = [item['id'] for item in package['members']]
        result['issue_observation'] = current_issues
    urls = unit_pr_links(doc, fid)
    if unit_row.get('status') in TERMINAL or gated or not urls:
        return result
    if len(urls) != 1:
        raise StoreConflict('Ambiguous PR ownership')
    match = re.fullmatch('https://github\\.com/' + re.escape(repo) + '/pull/(\\d+)/?', urls[0])
    if not match:
        raise StoreConflict('Invalid PR ownership')
    number = int(match.group(1)); prefix = 'repos/' + repo + '/pulls/' + str(number)
    pr = api(prefix)
    if pr.get('merged'):
        try:
            proof = merge_proof(repo, number)
            result.update(action='RECONCILE', merge=proof, pr=number)
        except EvidenceUnknown as exc:
            result.update(action='WAIT_MAIN_CI', reason=str(exc), pr=number)
        return result
    if pr.get('state') != 'open':
        result.update(action='OWNERSHIP_RECONCILE', pr=number); return result
    relation = source_relation(repo, number)
    review = review_backlog(repo, number)
    if pr['head']['sha'] != relation['final_sha'] or review['head_sha'] != relation['final_sha']:
        raise EvidenceUnknown('Head moved across evidence reads')
    missing = not relation['sealed'] and ledger_pending_final(repo, number, relation['source_sha'])
    ci = latest_ci(repo, relation['final_sha'], missing_ledger=missing)
    source_verdict = source_review(root, fid, number, relation['source_sha'], package)
    result.update(action=derive(unit_row, pr, relation, review, ci, source_verdict), pr=number, **relation,
                  source_review_clear=(source_verdict == 'CLEAR'), source_review_verdict=source_verdict,
                  ci_state=ci['state'], source_green=ci['source_green'],
                  final_green=ci['final_green'], ci_run=ci['run']['id'] if ci['run'] else None,
                  ci_attempt=ci['run']['run_attempt'] if ci['run'] else None,
                  review=review, source_review_receipt=str(receipt_path(root, fid, relation['source_sha'])))
    if result['action'] == 'REPAIR_CI' and record_failures:
        records = observe_failures(root, repo, ci)
        result['failure_evidence'] = records
        owner = failure_family_owner(path, fid, repo, records)
        if owner:
            result['action'] = 'REPAIR_CI_FAMILY'
            result['failure_family_owner'] = owner
        elif any(r['root_cause_required'] for r in records):
            history = family_history_shas(root, repo, records)
            commits = api(prefix + '/commits')
            own = {commit['sha'] for commit in commits
                   if isinstance(commit, dict) and commit.get('sha')}
            # A full first page means the PR's own history may be truncated, so
            # a sha absent from `own` cannot prove the family is external.
            truncated = not isinstance(commits, list) or len(commits) >= 30
            external = [] if truncated else sorted(
                family for family, shas in history.items() if shas - own)
            if external:
                result['action'] = 'WAIT_CI_FAMILY_TRIAGE'
                result['failure_family_unowned'] = external
            else:
                result['action'] = 'REPAIR_CI_FAMILY'
    final = api(prefix)
    if final['head']['sha'] != pr['head']['sha'] or final['state'] != pr['state'] or final.get('merged') != pr.get('merged'):
        raise EvidenceUnknown('PR lifecycle changed during planning')
    confirmed = load_document(path)
    if canonical_lead(confirmed, fid) != fid or unit_token(confirmed, fid) != result['row_token']:
        raise StoreConflict('Delivery unit changed during planning')
    return result


def handoff(path, fid, repo):
    observed = plan(path, fid, repo)
    if observed['action'] == 'WAIT_REVIEW': return {'changed': False, 'action': 'WAIT_REVIEW'}
    if observed['action'] != 'HANDOFF_REVIEW':
        raise StoreConflict('Handoff not eligible: ' + observed['action'])
    path = Path(path); doc = load_document(path)
    if canonical_lead(doc, fid) != fid or unit_token(doc, fid) != observed['row_token']:
        raise StoreConflict('Delivery unit changed before handoff')
    from runtime_preflight import preflight
    from evidence_capture import capture
    owner = preflight(path.parent, path.parent / 'startrips', os.environ.get('STARTRIPS_LANE'), fid, repo)
    captured = capture(path.parent, owner['worktree'], fid, observed['pr'], repo)
    if captured['exit'] != 0 or captured['kind'] != 'final':
        raise StoreConflict('Final CI capture did not pass')
    identity_fields = {'head': 'final_sha', 'source_sha': 'source_sha',
                       'ci_run': 'ci_run', 'ci_attempt': 'ci_attempt'}
    if any(captured.get(left) != observed.get(right) for left, right in identity_fields.items()):
        raise StoreConflict('Captured handoff evidence changed identity; discard the mixed snapshot')
    confirmed = plan(path, fid, repo)
    keys = ('pr', 'source_sha', 'final_sha', 'ci_run', 'ci_attempt', 'row_token', 'delivery_package')
    if confirmed.get('action') != 'HANDOFF_REVIEW' or any(confirmed.get(k) != observed.get(k) for k in keys):
        raise StoreConflict('Handoff gate changed after capture; re-read Source review, package scope and CI')

    relative = '.agent-artifacts/evaluations/' + fid + '-' + observed['final_sha'] + '-handoff.json'
    output = path.parent / relative
    if not output.exists():
        write_json(output, {'feature': fid, 'pr': observed['pr'], 'source_sha': observed['source_sha'],
                            'final_sha': observed['final_sha'], 'ci_run': observed['ci_run'],
                            'ci_attempt': observed['ci_attempt'], 'kind': 'HANDOFF_REVIEW',
                            'delivery_package': observed.get('delivery_package')})
    doc = load_document(path)
    if unit_token(doc, fid) != observed['row_token']:
        raise StoreConflict('Delivery unit changed before state handoff')
    allowed = {}
    for row in unit_rows(doc, fid):
        row.update(status='ready_for_eval', passes=False)
        if captured['path'] not in row.setdefault('evidence', []): row['evidence'].append(captured['path'])
        if relative not in row.setdefault('evidence', []): row['evidence'].append(relative)
        allowed[row['id']] = {'status', 'passes', 'evidence'}
    result = commit_document(path, doc, allowed=allowed, expected_rows=set(allowed), delivery_operation='unit')
    return {**result, 'action': 'HANDOFF_REVIEW', 'final_sha': observed['final_sha']}


def record_source_review(path, fid, repo, review_file):
    if os.environ.get('STARTRIPS_ROLE') != 'hourly-review':
        raise StoreConflict('Only the independent Hourly Review role records Source review')
    data = json.loads(Path(review_file).read_bytes())
    root = Path(path).parent; doc = load_document(path)
    if canonical_lead(doc, fid) != fid:
        raise StoreConflict('Independent review must target the canonical package lead')
    package = review_snapshot(doc, fid); rows = unit_rows(doc, fid)
    number = data.get('pr'); sha = data.get('source_sha')
    expected_url = 'https://github.com/' + repo + '/pull/' + str(number)
    if any(row.get('pr_links') != [expected_url] for row in rows):
        raise StoreConflict('Review is not bound to every delivery-unit member')
    if data.get('feature') != fid or data.get('verdict') not in {'CLEAR', 'CHANGES_REQUESTED'}:
        raise StoreConflict('Invalid independent review result')
    if package is not None:
        if data.get('delivery_package') != package:
            raise StoreConflict('Review package scope/revision does not match current ONE')
        coverage = data.get('member_coverage')
        validate_coverage(package, coverage, require_pass=(data.get('verdict') == 'CLEAR'))
        if data.get('verdict') == 'CHANGES_REQUESTED' and not any(item.get('verdict') == 'CHANGES_REQUESTED' for item in coverage.values()):
            raise StoreConflict('Package CHANGES_REQUESTED must identify at least one affected member')
    elif data.get('delivery_package') not in (None, {}):
        raise StoreConflict('Single-feature review cannot claim a delivery package')
    relation = source_relation(repo, number)
    if relation['source_sha'] != sha:
        raise EvidenceUnknown('Review Source changed')
    from ci_observer import pages
    paths = {item['filename'] for item in pages('repos/' + repo + '/pulls/' + str(number) + '/files')}
    if len(paths) >= 3000: raise EvidenceUnknown('Changed-file API limit reached')
    paths.discard('docs/pr-history/' + str(number) + '.md')
    if not paths or not paths <= set(data.get('reviewed_paths') or []):
        raise StoreConflict('Independent review did not cover the complete changed-file set')
    if not data.get('evidence') or not isinstance(data.get('findings'), list):
        raise StoreConflict('Review evidence/findings missing')
    if data['verdict'] == 'CLEAR' and data['findings']:
        raise StoreConflict('CLEAR cannot carry unresolved findings')
    if data['verdict'] == 'CHANGES_REQUESTED' and not data['findings']:
        raise StoreConflict('CHANGES_REQUESTED must carry actionable findings')
    confirmed = load_document(path)
    if unit_token(confirmed, fid) != unit_token(doc, fid):
        raise StoreConflict('Delivery-unit scope changed during independent review')
    if source_relation(repo, number)['source_sha'] != sha:
        raise EvidenceUnknown('Source changed while recording independent review')
    data.update(reviewer_role='hourly-review', completed_at=datetime.datetime.now(datetime.timezone.utc).isoformat())
    output = receipt_path(root, fid, sha)
    write_json(output, data)
    return {'action': 'SOURCE_REVIEW_RECORDED', 'source_sha': sha, 'receipt': str(output), 'verdict': data['verdict']}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('path', type=Path); parser.add_argument('feature')
    parser.add_argument('--repo', default='U2SG/startrips'); parser.add_argument('--action-only', action='store_true')
    parser.add_argument('--record-failures', action='store_true'); parser.add_argument('--handoff', action='store_true')
    parser.add_argument('--record-review', type=Path)
    args = parser.parse_args()
    try:
        if args.record_review: result = record_source_review(args.path, args.feature, args.repo, args.record_review)
        else: result = handoff(args.path, args.feature, args.repo) if args.handoff else plan(args.path, args.feature, args.repo, record_failures=args.record_failures)
        print(result['action'] if args.action_only else json.dumps(result)); return 0
    except (StoreConflict, EvidenceUnknown, OSError, ValueError, KeyError) as exc:
        print('ACTION_UNKNOWN: ' + str(exc), file=sys.stderr); return 6


if __name__ == '__main__':
    raise SystemExit(main())


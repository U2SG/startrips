"""Content-based issue windows for delivery packages, not updatedAt-based approval.

The owner classifies new discussion after reading it. Unread content blocks the
next action; unrelated discussion can be acknowledged without changing the
material contract or invalidating an otherwise-current independent review.
"""
from __future__ import annotations
from delivery import digest, members, rows, require_lead
from feature_store import StoreConflict, load_document, commit_document
from github_evidence import api, EvidenceUnknown
from ci_observer import pages


def content_hash(text):
    return digest(' '.join(str(text or '').split()))


def live_issues(doc, fid, repo):
    index = rows(doc); result = {}
    for member in members(doc, fid):
        issue = index[member].get('issue')
        if type(issue) is not int or issue < 1:
            raise StoreConflict('Package member needs an explicit numeric issue: ' + member)
        prefix = 'repos/' + repo + '/issues/' + str(issue)
        data = api(prefix)
        comments = pages(prefix + '/comments')
        fresh = api(prefix)
        if (data.get('number') != issue or fresh.get('number') != issue
                or not isinstance(comments, list)
                or len(comments) != fresh.get('comments')
                or data.get('comments') != fresh.get('comments')
                or content_hash(data.get('body')) != content_hash(fresh.get('body'))):
            raise EvidenceUnknown('Issue changed during content observation: ' + str(issue))
        observed = {str(c['id']): content_hash(c.get('body')) for c in comments}
        if len(observed) != len(comments):
            raise EvidenceUnknown('Duplicate/incomplete issue comment page')
        result[member] = {'issue': issue, 'body_sha256': content_hash(fresh.get('body')),
                          'comments': observed, 'updated_at': fresh.get('updated_at'),
                          'comment_count': int(fresh.get('comments') or 0)}
    return result


def assert_current(doc, fid, observed):
    index = rows(doc)
    if set(observed) != set(members(doc, fid)):
        raise EvidenceUnknown('Incomplete member issue observation')
    for member, value in observed.items():
        if index[member].get('delivery_issue_observation') != value:
            raise EvidenceUnknown('Unread delivery issue decisions for ' + member)


def classify(observed, decisions):
    """Every issue is read; explicit decision ids, not every comment, are material."""
    if not isinstance(decisions, dict) or set(decisions) != set(observed):
        raise StoreConflict('Classify the latest decisions of every member issue')
    result = {}
    for member, value in observed.items():
        selected = decisions[member]
        if (not isinstance(selected, list) or any(not isinstance(i, str) for i in selected)
                or len(set(selected)) != len(selected)
                or not set(selected) <= set(value['comments'])):
            raise StoreConflict('Decision ids must name exact observed comments: ' + member)
        result[member] = {'body_sha256': value['body_sha256'],
                          'comments': {i: value['comments'][i] for i in sorted(selected)}}
    return result


def acknowledge(path, fid, repo, expected, decisions):
    doc = load_document(path); require_lead(doc, fid)
    observed = live_issues(doc, fid, repo)
    if observed != expected:
        raise StoreConflict('Issue content changed after the owner read it')
    material = classify(observed, decisions); index = rows(doc)
    for member, value in observed.items():
        if index[member].get('delivery_decisions') != material[member]:
            raise StoreConflict('Material decision changed: explicitly revise the package before continuing')
        index[member]['delivery_issue_observation'] = value
        index[member]['issue_snapshot_at'] = value.get('updated_at')
        index[member]['issue_snapshot_comments'] = value.get('comment_count')
    return commit_document(path, doc,
        allowed={m: {'delivery_issue_observation','issue_snapshot_at','issue_snapshot_comments'} for m in observed},
        expected_rows=set(observed))



def main():
    import argparse, json, sys
    from pathlib import Path
    parser=argparse.ArgumentParser();sub=parser.add_subparsers(dest='op',required=True)
    o=sub.add_parser('observe');o.add_argument('path',type=Path);o.add_argument('lead');o.add_argument('--repo',default='U2SG/startrips')
    a=sub.add_parser('acknowledge');a.add_argument('path',type=Path);a.add_argument('lead');a.add_argument('--expected',type=Path,required=True);a.add_argument('--decisions',type=Path,required=True);a.add_argument('--repo',default='U2SG/startrips')
    args=parser.parse_args()
    try:
        doc=load_document(args.path);require_lead(doc,args.lead)
        if args.op=='observe': result=live_issues(doc,args.lead,args.repo)
        else:
            expected=json.loads(args.expected.read_bytes());decisions=json.loads(args.decisions.read_bytes())
            result=acknowledge(args.path,args.lead,args.repo,expected,decisions)
        print(json.dumps(result,ensure_ascii=False));return 0
    except (StoreConflict,EvidenceUnknown,OSError,ValueError,KeyError) as exc:
        print('DELIVERY_ISSUE_UNAVAILABLE: '+str(exc),file=sys.stderr);return 6


if __name__=='__main__': raise SystemExit(main())

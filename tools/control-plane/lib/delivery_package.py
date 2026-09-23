"""Guarded registration/revision helpers for coherent delivery packages."""
from __future__ import annotations
import argparse, datetime as dt, json, re, subprocess, sys
from pathlib import Path
from delivery import (VERSION, MATERIAL, complete_dependency, contract_revision, feature_lane, members, require_lead,
                      rows, snapshot, execution_token, dependency_read_set)
from delivery_issues import live_issues, classify
from feature_store import StoreConflict, load_document, commit_document
from delivery_runtime import verify as verify_runtime


def _ownership_conflicts(repository, repo, unit):
    tokens=[]; issue_numbers=[]
    for row in unit:
        issue=row.get('issue')
        if type(issue) is int and issue > 0:
            issue_numbers.append(issue); tokens.append('issue'+str(issue))
        tokens.append(row['id'].lower().replace('-',''))
    wt=subprocess.run(['git','-C',str(repository),'worktree','list','--porcelain'],capture_output=True,text=True,encoding='utf-8',timeout=15)
    if wt.returncode: raise StoreConflict('Worktree ownership evidence unavailable')
    bad=[]
    for block in wt.stdout.split('\n\n'):
        low=block.lower()
        if any(t and t in low for t in tokens): bad.append('worktree:'+block.replace('\n',' | '))
    pr=subprocess.run(['gh','pr','list','--repo',repo,'--state','open','--limit','100','--json',
                       'number,headRefName,body,closingIssuesReferences'],
                      capture_output=True,text=True,encoding='utf-8',timeout=20)
    if pr.returncode: raise StoreConflict('Open PR ownership evidence unavailable')
    issue_url_prefix='https://github.com/'+repo.lower()+'/issues/'
    for item in json.loads(pr.stdout or '[]'):
        branch=str(item.get('headRefName') or '').lower(); body=str(item.get('body') or '').lower()
        linked={ref.get('number') for ref in (item.get('closingIssuesReferences') or []) if type(ref.get('number')) is int}
        owned = any(t and t in branch for t in tokens)
        for issue in issue_numbers:
            if issue in linked:
                owned=True; break
            if re.search(r'(?<![0-9a-z_])#'+re.escape(str(issue))+r'(?!\d)', body):
                owned=True; break
            if re.search(re.escape(issue_url_prefix+str(issue))+r'(?!\d)', body):
                owned=True; break
        if owned: bad.append('open-pr:#'+str(item['number']))
    return bad


def _fresh(row):
    return (row.get('status')=='pending' and not row.get('passes') and int(row.get('attempts',0))==0
            and not row.get('pr_links') and not row.get('evidence') and not row.get('human_gate')
            and not row.get('delivery_package') and not row.get('delivery_lead'))


def register(path, lead, member_ids, lane, root, repository, repo):
    verify_runtime(root, live=True, repo=repo)
    if lane not in {'backend','experience'}: raise StoreConflict('Invalid delivery lane')
    ids=list(dict.fromkeys([lead,*member_ids]));
    if len(ids)<2 or ids[0]!=lead: raise StoreConflict('Package requires one lead plus member(s)')
    doc=load_document(path); index=rows(doc)
    if any(i not in index for i in ids): raise StoreConflict('Package references missing ST')
    if index[lead].get('delivery_package'):
        current=members(doc,lead)
        if current==ids and index[lead]['delivery_package'].get('lane')==lane:
            return {'changed':False,'lead':lead,'members':ids,'lane':lane,'idempotent':True}
        raise StoreConflict('Lead already registered with different membership')
    unit=[index[i] for i in ids]
    if any(not _fresh(r) for r in unit): raise StoreConflict('Every package member must be fresh pending/unclaimed')
    for row in unit:
        current_lane = feature_lane(row)
        if current_lane not in {lane, 'undecided'}:
            raise StoreConflict('Package cannot silently change canonical lane: ' + row['id'])
    conflicts=_ownership_conflicts(repository,repo,unit)
    if conflicts: raise StoreConflict('Package member already owned: '+'; '.join(conflicts))
    # Fetch a coherent current issue window before mutating ONE. All current comments
    # are conservatively frozen as scope decisions; later content requires explicit revise.
    probe=json.loads(json.dumps(doc)); pi=rows(probe)
    for i in ids: pi[i]['lane']=lane; pi[i]['delivery_lead']=lead
    pi[lead].pop('delivery_lead',None)
    pi[lead]['delivery_package']={'schema_version':VERSION,'revision':1,'lane':lane,'members':ids,'contracts':{}}
    # live_issues resolves package membership through the same strict schema, so
    # the read-only probe itself must already carry a self-consistent contract.
    pi[lead]['delivery_package']['contracts']={i:contract_revision(pi[i]) for i in ids}
    observed=live_issues(probe,lead,repo); decisions=classify(observed,{i:list(observed[i]['comments']) for i in ids})
    for i in ids:
        index[i]['lane']=lane; index[i]['delivery_issue_observation']=observed[i]; index[i]['delivery_decisions']=decisions[i]; index[i]['issue_snapshot_at']=observed[i].get('updated_at'); index[i]['issue_snapshot_comments']=observed[i].get('comment_count')
        if i!=lead: index[i]['delivery_lead']=lead
    package={'schema_version':VERSION,'revision':1,'lane':lane,'members':ids,'contracts':{i:contract_revision(index[i]) for i in ids},'registered_at':dt.datetime.now(dt.timezone.utc).isoformat()}
    index[lead]['delivery_package']=package
    # Validate preserved edges, cycles and external prerequisites through the final projection.
    read=dependency_read_set(doc,lead); own=set(ids)
    for i in ids:
        for dep in index[i].get('dependencies') or []:
            if dep not in own and not complete_dependency(doc, dep): raise StoreConflict('Unsatisfied external dependency '+dep)
    allowed={i:{'lane','delivery_issue_observation','delivery_decisions','issue_snapshot_at','issue_snapshot_comments'} for i in ids}; allowed[lead].add('delivery_package')
    for i in ids:
        if i!=lead: allowed[i].add('delivery_lead')
    return commit_document(path,doc,allowed=allowed,expected_rows=set(read)|set(ids),delivery_operation='register')


def revise(path, fid, repo, *, patches=None, decision_ids=None):
    doc=load_document(path); require_lead(doc,fid); index=rows(doc); ids=members(doc,fid)
    patches = patches or {}
    if set(patches) - set(ids): raise StoreConflict('Scope patch names a non-member')
    mutable = {'description','acceptance','dependencies','human_gate','verification_commands','evidence_required'}
    for member, changes in patches.items():
        if not isinstance(changes, dict) or set(changes) - mutable:
            raise StoreConflict('Package scope patch contains unsupported fields: '+member)
        for key, value in changes.items(): index[member][key]=value
    observed=live_issues(doc,fid,repo)
    chosen = decision_ids if decision_ids is not None else {i:list(observed[i]['comments']) for i in ids}
    decisions=classify(observed,chosen)
    for i in ids:
        index[i]['delivery_issue_observation']=observed[i]; index[i]['delivery_decisions']=decisions[i]; index[i]['issue_snapshot_at']=observed[i].get('updated_at'); index[i]['issue_snapshot_comments']=observed[i].get('comment_count')
    package=index[fid]['delivery_package']; package['revision']+=1
    package['contracts']={i:contract_revision(index[i]) for i in ids}; package['revised_at']=dt.datetime.now(dt.timezone.utc).isoformat()
    # Validate the final graph/lane after the scope change before one atomic commit.
    dependency_read_set(doc,fid)
    if any(feature_lane(index[i]) != package['lane'] for i in ids): raise StoreConflict('Scope revision changed package lane')
    allowed={i:{'delivery_issue_observation','delivery_decisions','issue_snapshot_at','issue_snapshot_comments'} | set(patches.get(i, {})) for i in ids};allowed[fid].add('delivery_package')
    return commit_document(path,doc,allowed=allowed,expected_rows=dependency_read_set(doc,fid),delivery_operation='revise')


def link_pr(path,fid,url):
    if not re.fullmatch(r'https://github\.com/[^/]+/[^/]+/pull/\d+/?',url): raise StoreConflict('Invalid PR URL')
    doc=load_document(path); require_lead(doc,fid); index=rows(doc); ids=members(doc,fid)
    for i in ids:
        if index[i].get('pr_links') not in ([],[url]): raise StoreConflict('Member already maps another PR: '+i)
        index[i]['pr_links']=[url]
    return commit_document(path,doc,allowed={i:{'pr_links'} for i in ids},expected_rows=set(ids),delivery_operation='unit')


def main():
    p=argparse.ArgumentParser(); sub=p.add_subparsers(dest='op',required=True)
    r=sub.add_parser('register');r.add_argument('path',type=Path);r.add_argument('lead');r.add_argument('members',nargs='+');r.add_argument('--lane',required=True);r.add_argument('--root',type=Path,required=True);r.add_argument('--repository',type=Path,required=True);r.add_argument('--repo',default='U2SG/startrips')
    q=sub.add_parser('revise');q.add_argument('path',type=Path);q.add_argument('lead');q.add_argument('--repo',default='U2SG/startrips');q.add_argument('--scope-json',type=Path);q.add_argument('--decisions-json',type=Path)
    l=sub.add_parser('link-pr');l.add_argument('path',type=Path);l.add_argument('lead');l.add_argument('url')
    s=sub.add_parser('show');s.add_argument('path',type=Path);s.add_argument('lead')
    a=p.parse_args()
    try:
        if a.op=='register': out=register(a.path,a.lead,a.members,a.lane,a.root,a.repository,a.repo)
        elif a.op=='revise': out=revise(a.path,a.lead,a.repo, patches=(json.loads(a.scope_json.read_bytes()) if a.scope_json else None), decision_ids=(json.loads(a.decisions_json.read_bytes()) if a.decisions_json else None))
        elif a.op=='link-pr': out=link_pr(a.path,a.lead,a.url)
        else:
            d=load_document(a.path);require_lead(d,a.lead);out={'delivery':snapshot(d,a.lead),'execution_token':execution_token(d,a.lead)}
        print(json.dumps(out,ensure_ascii=False));return 0
    except (StoreConflict,OSError,ValueError,KeyError,subprocess.SubprocessError) as e:
        print('DELIVERY_PACKAGE_UNAVAILABLE: '+str(e),file=sys.stderr);return 6
if __name__=='__main__': raise SystemExit(main())

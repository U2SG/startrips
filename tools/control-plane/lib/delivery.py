"""Delivery-unit contract shared by the existing selector and state consumers.

This module neither selects work nor owns a queue. Original ST rows retain their
requirements and history; only their lead can acquire the existing owner carrier.
"""
from __future__ import annotations
import copy
import hashlib
import json
import re
from feature_store import StoreConflict

VERSION = 1
MATERIAL = {'id', 'issue', 'phase', 'lane', 'description', 'acceptance',
            'dependencies', 'human_gate', 'verification_commands',
            'evidence_required', 'delivery_decisions'}
RELATION = {'delivery_package', 'delivery_lead'}
TERMINAL = {'passed', 'blocked', 'cancelled_by_product_decision'}


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
                                    allow_nan=False).encode('utf-8')).hexdigest()


def acceptance_revision(row):
    return digest(row.get('acceptance') or [])


def contract_revision(row):
    contract = {key: copy.deepcopy(row.get(key)) for key in sorted(MATERIAL)}
    return {'acceptance_sha256': acceptance_revision(row),
            'scope_sha256': digest(contract)}


ALWAYS_BACKEND = {'P0-process', 'P3-repo'}
BACKEND_IF_SERVER_SIDE = {'P1-sharing', 'P2-server', 'P2-upload'}
EXPERIENCE = {'P1-globe', 'P2-globe', 'P1-mobile', 'P2-mobile', 'P2-playback'}
PATH = re.compile(r'(?:server|src|sql|deploy|scripts|docs|\.github)/[A-Za-z0-9_./-]+')
SERVER_PREFIXES = ('server/', 'sql/', 'deploy/', '.github/')

def feature_lane(f):
    # An explicit placement outranks the derivation below, and is the only way
    # to place what the derivation leaves UNDECIDED. The three phases graded on
    # paths are graded on the paths the feature's OWN acceptance names, and an
    # issue written in prose names none: ST-087, ST-088 and ST-089 each open
    # with 'Server-only foundation for #NNN' and were still undecided, because
    # zero server paths is not positive evidence of a server lane.
    #
    # Only a human writes this field. Intake's amend cannot: `lane` is outside
    # its allowed_keys, so a re-triage that rewrites acceptance can never move a
    # feature between lanes behind the owner's back. An unrecognised value is
    # undecided rather than a guess, so a typo parks the feature instead of
    # handing it to the wrong loop.
    declared = f.get('lane')
    if declared is not None:
        return declared if declared in ('backend', 'experience') else 'undecided'
    phase = f.get('phase')
    if phase in EXPERIENCE:
        return 'experience'
    if phase in ALWAYS_BACKEND:
        return 'backend'
    if phase not in BACKEND_IF_SERVER_SIDE:
        return 'undecided'
    text = ' '.join(f.get('acceptance') or []) + ' ' + (f.get('description') or '')
    paths = set(PATH.findall(text))
    server = sum(1 for q in paths if q.startswith(SERVER_PREFIXES))
    client = sum(1 for q in paths if q.startswith('src/'))
    if server == 0 or client > server:
        return 'undecided'
    return 'backend'


def rows(doc):
    return {row['id']: row for row in doc['features']}


def grouped(row):
    return bool(row.get('delivery_package') or row.get('delivery_lead'))


def lead_id(doc, fid):
    index = rows(doc)
    if fid not in index:
        raise StoreConflict('Delivery member missing: ' + fid)
    return index[fid].get('delivery_lead') or fid


def members(doc, fid):
    index = rows(doc); lead = lead_id(doc, fid)
    if lead not in index:
        raise StoreConflict('Delivery lead missing: ' + lead)
    definition = index[lead].get('delivery_package')
    if not definition:
        if index[fid].get('delivery_lead'):
            raise StoreConflict('Delivery member has no registered lead')
        return [fid]
    ids = definition.get('members') if isinstance(definition, dict) else None
    if (not isinstance(ids, list) or len(ids) < 2
            or any(not isinstance(item, str) for item in ids)
            or len(ids) != len(set(ids)) or lead not in ids
            or definition.get('schema_version') != VERSION
            or type(definition.get('revision')) is not int or definition['revision'] < 1
            or definition.get('lane') not in {'backend', 'experience'}
            or not isinstance(definition.get('contracts'), dict)
            or set(definition['contracts']) != set(ids)):
        raise StoreConflict('Invalid delivery membership/version/lane/contracts')
    if index[lead].get('delivery_lead'):
        raise StoreConflict('A delivery lead cannot also be a member of another lead')
    for member in ids:
        if member not in index:
            raise StoreConflict('Delivery member missing: ' + member)
        row = index[member]
        if member != lead and (row.get('delivery_lead') != lead or row.get('delivery_package')):
            raise StoreConflict('Conflicting delivery membership: ' + member)
        if feature_lane(row) != definition['lane']:
            raise StoreConflict('Delivery lane changed/undecided: ' + member)
        if definition['contracts'].get(member) != contract_revision(row):
            raise StoreConflict('Delivery acceptance/scope revision stale: ' + member)
    for other in index.values():
        package = other.get('delivery_package')
        if other['id'] != lead and package:
            if not isinstance(package, dict) or not isinstance(package.get('members'), list):
                raise StoreConflict('Malformed peer delivery package')
            if set(ids).intersection(package['members']):
                raise StoreConflict('Member belongs to two delivery packages')
        if other.get('delivery_lead') == lead and other['id'] not in ids:
            raise StoreConflict('Orphan delivery backlink: ' + other['id'])
    return list(ids)


def require_lead(doc, fid):
    lead = lead_id(doc, fid)
    members(doc, fid)
    if lead != fid:
        raise StoreConflict('DELIVERY_MEMBER_NOT_EXECUTABLE: ' + fid + ' belongs to ' + lead)
    return rows(doc)[fid]


def dependency_read_set(doc, fid):
    """All members and transitive dependencies, including dependency packages.

    Original edges are never deleted. The raw and collapsed graphs must both be
    acyclic: A -> outside X -> member B cannot be hidden inside one package.
    """
    index = rows(doc); read = set(); visiting = set()
    def visit(node):
        if node in visiting:
            raise StoreConflict('Dependency cycle at ' + node)
        if node in read:
            return
        if node not in index:
            raise StoreConflict('Missing dependency: ' + node)
        visiting.add(node)
        deps = index[node].get('dependencies') or []
        if not isinstance(deps, list) or any(not isinstance(d, str) for d in deps):
            raise StoreConflict('Malformed dependencies: ' + node)
        for dep in deps:
            visit(dep)
        visiting.remove(node); read.add(node)
    for node in members(doc, fid):
        visit(node)
    # Pull in all siblings of any dependency package, then prove the collapsed
    # graph. A satisfied dependency must not be a forged half-completed package.
    while True:
        previous = set(read)
        for node in list(read):
            for sibling in members(doc, node):
                visit(sibling)
        if previous == read:
            break
    graph = {}
    for node in read:
        canonical = lead_id(doc, node)
        graph.setdefault(canonical, set())
        for dep in index[node].get('dependencies') or []:
            owner = lead_id(doc, dep)
            if owner != canonical:
                graph[canonical].add(owner)
    seen, stack = set(), set()
    def unit_visit(node):
        if node in stack:
            raise StoreConflict('Collapsed delivery dependency cycle at ' + node)
        if node in seen:
            return
        stack.add(node)
        for dep in graph.get(node, ()):
            unit_visit(dep)
        stack.remove(node); seen.add(node)
    unit_visit(lead_id(doc, fid))
    return read


def external_dependencies(doc, fid):
    index = rows(doc); own = set(members(doc, fid))
    dependency_read_set(doc, fid)
    return sorted({dep for member in own for dep in index[member].get('dependencies', []) if dep not in own})


def implementation_order(doc, fid):
    index = rows(doc); ids = members(doc, fid); own = set(ids); seen = set(); order = []
    dependency_read_set(doc, fid)
    def visit(node):
        if node in seen:
            return
        for dep in index[node].get('dependencies') or []:
            if dep in own:
                visit(dep)
        seen.add(node); order.append(node)
    for member in ids:
        visit(member)
    return order


def complete_dependency(doc, fid):
    index = rows(doc)
    if fid not in index or index[fid].get('status') != 'passed':
        return False
    if not grouped(index[fid]):
        return True
    ids = members(doc, fid); proof = index[fid].get('delivery_completion')
    return bool(proof and all(index[n].get('status') == 'passed'
                             and index[n].get('delivery_completion') == proof for n in ids))


def blockers(doc, fid):
    index = rows(doc); ids = members(doc, fid); reasons = []
    for member in ids:
        row = index[member]
        if row.get('human_gate'):
            reasons.append({'member': member, 'human_gate': row['human_gate']})
        if row.get('status') in {'blocked', 'cancelled_by_product_decision'}:
            reasons.append({'member': member, 'status': row['status']})
    for dep in external_dependencies(doc, fid):
        if not complete_dependency(doc, dep):
            reasons.append({'dependency': dep, 'status': index[dep].get('status')})
    return reasons


def snapshot(doc, fid):
    lead = lead_id(doc, fid); index = rows(doc)
    if not grouped(index[fid]):
        return None
    ids = members(doc, fid); definition = index[lead]['delivery_package']
    contracts = []
    for member in ids:
        row = index[member]
        contract = {key: copy.deepcopy(row.get(key)) for key in sorted(MATERIAL)}
        if not isinstance(contract.get('acceptance'), list) or not contract['acceptance']:
            raise StoreConflict('Delivery member needs its complete acceptance: ' + member)
        if any(not isinstance(item, str) or not item.strip() for item in contract['acceptance']):
            raise StoreConflict('Malformed acceptance: ' + member)
        contracts.append({**contract, 'contract_sha256': digest(contract)})
    value = {'schema_version': VERSION, 'lead': lead, 'lane': definition['lane'],
             'revision': definition['revision'], 'members': contracts,
             'implementation_order': implementation_order(doc, fid),
             'external_dependencies': external_dependencies(doc, fid)}
    value['contract_sha256'] = digest(value)
    return value


def execution_token(doc, fid):
    index = rows(doc)
    if not grouped(index[fid]):
        return digest(index[fid])
    return digest({key: index[key] for key in sorted(dependency_read_set(doc, fid))})


def effective_priority(doc, fid):
    index = rows(doc)
    return min(index[member]['priority'] for member in members(doc, fid))


def validate_coverage(contract, evidence, *, require_pass=True):
    if not isinstance(evidence, dict) or set(evidence) != {m['id'] for m in contract['members']}:
        raise StoreConflict('Source review must cover exactly every delivery member')
    for member in contract['members']:
        item = evidence[member['id']]
        if (not isinstance(item, dict) or item.get('verdict') not in {'PASS','CHANGES_REQUESTED'}
                or item.get('contract_sha256') != member['contract_sha256']):
            raise StoreConflict('Member acceptance version/verdict mismatch: ' + member['id'])
        if require_pass and item.get('verdict') != 'PASS':
            raise StoreConflict('CLEAR Source review requires PASS for member: ' + member['id'])
        criteria = item.get('acceptance_evidence')
        expected = {str(i + 1) for i in range(len(member['acceptance']))}
        if not isinstance(criteria, dict) or set(criteria) != expected:
            raise StoreConflict('Every acceptance criterion needs evidence: ' + member['id'])
        for values in criteria.values():
            if not isinstance(values, list) or not values or any(not isinstance(v, str) or not v.strip() for v in values):
                raise StoreConflict('Empty member acceptance evidence: ' + member['id'])
    return evidence



# Canonical delivery-unit API. Keep these wrappers here rather than in the
# registration CLI so selectors/review/state consumers share one schema.
def canonical_lead(doc, fid):
    return lead_id(doc, fid)


def unit_rows(doc, fid):
    index = rows(doc)
    return [index[mid] for mid in members(doc, fid)]


def unit_token(doc, fid):
    return execution_token(doc, fid)


def package_snapshot(doc, fid):
    return snapshot(doc, fid)


def review_snapshot(doc, fid):
    return snapshot(doc, fid)


def unit_pr_links(doc, fid):
    values = {tuple(row.get('pr_links') or []) for row in unit_rows(doc, fid)}
    if len(values) != 1:
        raise StoreConflict('Delivery-unit PR mapping drift')
    return list(next(iter(values)))


def unit_human_gates(doc, fid):
    return {row['id']: row.get('human_gate') for row in unit_rows(doc, fid) if row.get('human_gate')}


def external_dependencies_satisfied(doc, fid):
    return all(complete_dependency(doc, dep) for dep in external_dependencies(doc, fid))


def package_ledger_lines(contract):
    if not contract:
        return []
    members_text = ', '.join(item['id'] + ' (#' + str(item.get('issue')) + ')' for item in contract['members'])
    return [
        '- **Delivery package:** `' + contract['lead'] + '@' + str(contract['revision']) + '` ' + members_text,
        '- **Delivery contract:** `' + contract['contract_sha256'] + '`',
    ]

def transaction_read_set(before, after, changes, operation=None):
    """Called inside feature_store; ordinary writers cannot split a package.

    Package lifecycle mutations are whole-unit transactions. Ordinary note / issue
    snapshot bookkeeping remains row-scoped, while product-scope changes require an
    explicit revision so review identity cannot silently drift.
    """
    old, new = rows(before), rows(after); read = set(); touched_units = {}
    if operation not in {None, 'register', 'revise', 'claim', 'unit', 'reconcile'}:
        raise StoreConflict('Unknown delivery transaction operation')
    lifecycle = {'status', 'passes', 'pr_links', 'attempts', 'evidence', 'evaluated_at',
                 'delivery_owner', 'delivery_completion'}
    for fid, delta in changes.items():
        if RELATION.intersection(delta) and operation not in {'register', 'revise'}:
            raise StoreConflict('Delivery grouping requires its canonical scoped transaction')
        for doc, index in ((before, old), (after, new)):
            if fid in index and grouped(index[fid]):
                read.update(dependency_read_set(doc, fid))
        if fid not in old or not grouped(old[fid]):
            continue
        if MATERIAL.intersection(delta) and operation != 'revise':
            raise StoreConflict('Delivery scope must be explicitly revised, not silently amended')
        if lifecycle.intersection(delta) and operation not in {'claim', 'unit', 'reconcile'}:
            raise StoreConflict('Delivery lifecycle requires a whole-unit transaction')
        if (delta.get('status') == 'passed' or delta.get('passes') is True) and operation != 'reconcile':
            raise StoreConflict('Delivery completion requires complete exact-main reconciliation')
        if 'delivery_owner' in delta and operation != 'claim':
            raise StoreConflict('Delivery owner preparation requires the canonical claim')
        if 'delivery_completion' in delta and operation != 'reconcile':
            raise StoreConflict('Delivery completion proof requires reconciliation')
        if lifecycle.intersection(delta):
            lead = lead_id(after, fid); touched_units.setdefault(lead, set()).add(fid)
    for lead, touched in touched_units.items():
        ids = set(members(after, lead))
        if touched != ids:
            raise StoreConflict('Cannot partially mutate delivery lifecycle: ' + lead)
        statuses = {new[m].get('status') for m in ids}; passes = {bool(new[m].get('passes')) for m in ids}
        prs = {tuple(new[m].get('pr_links') or []) for m in ids}
        if len(statuses) != 1 or len(passes) != 1 or len(prs) != 1:
            raise StoreConflict('Delivery package lifecycle/PR drift: ' + lead)
        if operation == 'claim':
            owners = {json.dumps(new[m].get('delivery_owner'), sort_keys=True) for m in ids}
            if len(owners) != 1 or any(new[m].get('delivery_owner') is None for m in ids):
                raise StoreConflict('Delivery package needs one identical owner identity')
            if statuses != {'in_progress'}:
                raise StoreConflict('Delivery claim must mark every member in_progress')
    if operation == 'reconcile':
        for lead in touched_units:
            ids = members(after, lead); proof = new[lead].get('delivery_completion')
            if (not proof or proof.get('contract_sha256') != snapshot(after, lead)['contract_sha256']
                    or not all(new[m].get('status') == 'passed' and new[m].get('passes') is True
                               and new[m].get('delivery_completion') == proof for m in ids)):
                raise StoreConflict('Cannot commit half a completed delivery package')
    return read

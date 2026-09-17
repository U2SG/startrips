"""Shared parsing and placement helpers for the intake step.

Extracted so the new-issue path and the update-tracking path use ONE marker
parser and ONE priority-placement rule. Two copies of either would drift, and
the drift would show up as a wrong queue position or a silently dropped triage
verdict rather than as an error.

Imported by the python heredocs in `lib/intake.sh`, which put this directory on
`sys.path` first. Not executable on its own.
"""

import json
import re

INVALID = 'triage output invalid'


class InvalidOutput(Exception):
    """The triage session did not produce one usable JSON object."""

    def __init__(self, detail):
        super().__init__(detail)
        self.detail = detail
        self.reason = INVALID + ' (' + detail + ')'


def load_marker(log_path):
    """Return the JSON object between the LAST <<<INTAKE and its INTAKE>>>.

    The last block wins: a session that quotes the format before answering
    would otherwise have its example parsed as the verdict. `\\r` is stripped
    because this runs on Windows and a CR inside a JSON string survives
    json.loads and then lands in a feature field or an issue comment.
    """
    raw = open(log_path, encoding='utf-8', errors='replace').read().replace('\r', '')
    i = raw.rfind('<<<INTAKE')
    j = raw.find('INTAKE>>>', i + 9) if i >= 0 else -1
    if i < 0 or j < 0:
        raise InvalidOutput('no <<<INTAKE ... INTAKE>>> block')
    try:
        obj = json.loads(raw[i + 9:j].strip())
    except Exception as exc:
        raise InvalidOutput(str(exc))
    if not isinstance(obj, dict):
        raise InvalidOutput('not a JSON object')
    return obj


def issue_number(value):
    """A feature's `issue` is an int, a full issue URL or None."""
    if value is None:
        return None
    m = re.search(r'(\d+)\s*$', str(value))
    return int(m.group(1)) if m else None


def is_auto_intake(feature):
    """Only an auto-intake feature may be rewritten by the harness.

    ST-000..ST-020 are the owner's curated contract: their notes do not start
    with `auto-intake`, and nothing in this file may edit them.
    """
    return (feature.get('notes') or '').startswith('auto-intake')


def place_priority(features, anchor, position):
    """anchor +/- 0.5, nudged 0.01 at a time TOWARD the anchor on a collision.

    Nudging toward the anchor is what keeps the requested before/after relation
    true after every nudge. Returns None when 49 nudges found no free slot.
    """
    taken = {float(f['priority']) for f in features}
    base = float(anchor['priority'])
    if position == 'before':
        prio, nudge = round(base - 0.5, 4), 0.01
    else:
        prio, nudge = round(base + 0.5, 4), -0.01
    guard = 0
    while prio in taken and guard < 49:
        prio = round(prio + nudge, 4)
        guard += 1
    return None if prio in taken else prio


def next_feature_id(ids):
    nums = [int(m.group(1)) for m in (re.match(r'ST-(\d+)$', fid) for fid in ids) if m]
    return 'ST-%03d' % (max(nums) + 1)


def moved(feature, state):
    """Has the issue moved past what the feature recorded?

    `updatedAt` alone is not enough (a comment edit bumps it, and so does a
    label change), and the comment count alone is not enough (an edited body
    adds no comment), so both are compared and both are stored.
    """
    snap = feature.get('issue_snapshot_at')
    snap_c = feature.get('issue_snapshot_comments')
    if snap is None or snap_c is None:
        return None  # no snapshot yet: backfill, do not diff
    return str(state['updatedAt']) > str(snap) or int(state['comments']) > int(snap_c)


def assert_only_changed(before, after, fid, allowed):
    """Every feature except `fid` byte-identical, and `fid` changed only within
    `allowed`.

    The append path can assert "nothing existing moved at all"; the update paths
    cannot, so they assert the next best checkable thing instead of asserting it
    in a comment. Raises SystemExit on a violation, because writing the file
    after a failed invariant is worse than stopping the iteration.
    """
    b = {f['id']: f for f in before}
    a = {f['id']: f for f in after}
    if set(b) != set(a):
        raise SystemExit('intake would have added or removed a feature; refusing to write')
    for k in b:
        if k == fid:
            continue
        if json.dumps(b[k], ensure_ascii=False, sort_keys=True) != \
           json.dumps(a[k], ensure_ascii=False, sort_keys=True):
            raise SystemExit('intake would have modified ' + k + '; refusing to write')
    changed = {key for key in set(b[fid]) | set(a[fid])
               if b[fid].get(key, '\0missing') != a[fid].get(key, '\0missing')}
    illegal = changed - set(allowed)
    if illegal:
        raise SystemExit('intake would have changed ' + fid + ' fields '
                         + ', '.join(sorted(illegal)) + '; refusing to write')

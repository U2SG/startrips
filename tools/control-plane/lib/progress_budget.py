"""Bound model replays across supervisor lifetimes using execution evidence only."""
from __future__ import annotations
import argparse
import hashlib
import json
import re
import sys
from pathlib import Path
from feature_store import StoreConflict, _storage_mutex
from ci_observer import write_json


def identity(fingerprint, context):
    # Ignore observation timestamps and prose; only a changed execution input can
    # unlock another model attempt after the same no-progress input exhausted it.
    keys = ('action', 'pr', 'source_sha', 'final_sha', 'ci_run', 'ci_attempt', 'ci_state', 'review')
    evidence = {key: context.get(key) for key in keys}
    return hashlib.sha256(json.dumps([fingerprint, evidence], sort_keys=True).encode()).hexdigest()


def update(root, fid, before, context, cap, after=None):
    if not re.fullmatch(r'ST-\d{3,}', fid) or cap < 1:
        raise StoreConflict('Invalid owner progress budget')
    key = identity(before, context)
    root = Path(root)
    path = root / '.agent-artifacts/evaluations' / (fid + '-execution-progress.json')
    with _storage_mutex(root / 'feature_list.json'):
        previous = json.loads(path.read_bytes()) if path.exists() else {}
        count = previous.get('consecutive_no_progress', 0) if previous.get('input_identity') == key else 0
        if not isinstance(count, int) or count < 0:
            raise StoreConflict('Execution progress evidence invalid')
        if after is not None:
            count = count + 1 if before == after else 0
            record = {'feature': fid, 'input_identity': key, 'consecutive_no_progress': count,
                      'kind': 'execution-progress-evidence', 'owner_unchanged': True}
            if record != previous: write_json(path, record)
        return {'feature': fid, 'allowed': count < cap, 'consecutive_no_progress': count,
                'cap': cap, 'next': 'CONTINUE' if count < cap else 'WAIT_PROGRESS',
                'owner_unchanged': True, 'observer_enabled': True}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('root', type=Path); parser.add_argument('feature'); parser.add_argument('before')
    parser.add_argument('--context', required=True); parser.add_argument('--cap', type=int, default=3)
    parser.add_argument('--after'); args = parser.parse_args()
    try:
        result = update(args.root, args.feature, args.before, json.loads(args.context), args.cap, args.after)
        print(json.dumps(result)); return 0 if result['allowed'] else 7
    except (StoreConflict, OSError, ValueError, TypeError) as exc:
        print('PROGRESS_UNKNOWN: ' + str(exc), file=sys.stderr); return 6


if __name__ == '__main__':
    raise SystemExit(main())

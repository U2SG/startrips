"""Bind model-produced intake results to their pre-execution feature snapshot."""
from __future__ import annotations
import datetime
import re
import sys
from feature_state import row_token
from feature_store import StoreConflict


AMEND_DEFERRED_EXIT = 10  # Internal intake result, never a supervisor exit code.


class AmendSnapshotChanged(StoreConflict):
    """A readable current row no longer matches the exact pre-model identity."""


def require_amend_snapshot_or_defer(row, expected_token, updated_at, comments):
    """Report known row drift separately; missing/unknown evidence still fails."""
    try:
        require_amend_snapshot(row, expected_token, updated_at, comments)
    except AmendSnapshotChanged as exc:
        print('INTAKE_AMEND_DEFERRED: ' + str(exc), file=sys.stderr)
        raise SystemExit(AMEND_DEFERRED_EXIT) from None


def require_amend_snapshot(row, expected_token, updated_at, comments):
    if not isinstance(expected_token, str) or not re.fullmatch(r'[0-9a-f]{64}', expected_token):
        raise StoreConflict('Intake pre-model snapshot identity unavailable')
    if row_token(row) != expected_token:
        raise AmendSnapshotChanged('Intake row changed during model execution; discard stale result')
    old = row.get('issue_snapshot_at')
    if old and updated_at:
        try:
            previous = datetime.datetime.fromisoformat(old.replace('Z', '+00:00'))
            observed = datetime.datetime.fromisoformat(updated_at.replace('Z', '+00:00'))
            if observed < previous:
                raise StoreConflict('Intake issue snapshot regressed; re-read the issue')
        except (ValueError, TypeError) as exc:
            raise StoreConflict('Intake snapshot time unavailable') from exc
    old_count = row.get('issue_snapshot_comments')
    if updated_at == old and old_count is not None and str(comments).isdigit() and int(comments) < old_count:
        raise StoreConflict('Intake comment snapshot regressed at the same issue revision')

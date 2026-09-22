"""Byte-preserving transactions for ONE, not a scheduler or ownership registry.

Use load_document, mutate explicitly allowed fields, then commit_document.
Concurrent changes to a target row fail closed; unrelated updates survive.
All writers must use this boundary. An already-running legacy writer cannot
be made cooperative by replacing its script on disk.
"""
from __future__ import annotations

import copy
import hashlib
import json
import os
import platform
import re
import sys
import tempfile
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any


class StoreConflict(RuntimeError):
    pass


class Document(dict):
    def __init__(self, path: Path, raw: bytes):
        super().__init__(json.loads(raw))
        self.path = path.resolve()
        self.original = copy.deepcopy(dict(self))
        self.sha256 = hashlib.sha256(raw).hexdigest()


def load_document(path: str | Path) -> Document:
    path = Path(path).resolve()
    try:
        raw = path.read_bytes()
        _spans(raw.decode('utf-8'))
        doc = Document(path, raw)
        _rows(doc)
        return doc
    except (UnicodeError, ValueError, IndexError, TypeError, KeyError) as exc:
        raise StoreConflict('ONE is unreadable/incomplete; no clean state may be inferred') from exc


def _rows(doc: dict) -> dict[str, dict]:
    rows = doc.get('features')
    if not isinstance(rows, list):
        raise StoreConflict('ONE features must be a list')
    result = {}
    for row in rows:
        fid = row.get('id') if isinstance(row, dict) else None
        if not isinstance(fid, str) or not re.fullmatch(r'ST-\d{3,}', fid) or fid in result:
            raise StoreConflict('Invalid or duplicate feature id')
        result[fid] = row
    return result


@contextmanager
def _storage_mutex(path: Path, timeout: float = 10.0):
    # This is a storage write mutex only: no feature owner, lease or dispatch data.
    # OS locks are released on process exit, without stale-lock deletion logic.
    if os.name != 'nt' and 'microsoft' in platform.release().lower() and str(path).startswith('/mnt/'):
        raise StoreConflict('Use native Windows Python for ONE writes on Windows-mounted paths')
    directory = path.parent / '.agent-artifacts'
    directory.mkdir(exist_ok=True)
    with (directory / 'one-storage-write.mutex').open('a+b') as lock:
        lock.seek(0, os.SEEK_END)
        if lock.tell() == 0:
            lock.write(b'0')
            lock.flush()
        deadline = time.monotonic() + timeout
        while True:
            lock.seek(0)
            try:
                if os.name == 'nt':
                    import msvcrt
                    msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except (OSError, BlockingIOError):
                if time.monotonic() >= deadline:
                    raise StoreConflict('ONE writer busy/unavailable; retry after a fresh read')
                time.sleep(0.05)
        try:
            yield
        finally:
            lock.seek(0)
            if os.name == 'nt':
                msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(lock.fileno(), fcntl.LOCK_UN)


class Span:
    def __init__(self, start: int, end: int, children: Any = None):
        self.start, self.end, self.children = start, end, children


def _spans(text: str) -> Span:
    decoder = json.JSONDecoder()

    def skip(i: int) -> int:
        while i < len(text) and text[i] in ' \t\r\n':
            i += 1
        return i

    def read(i: int) -> Span:
        i = skip(i)
        start = i
        if text[i] == '{':
            children = {}
            i = skip(i + 1)
            if text[i] == '}':
                return Span(start, i + 1, children)
            while True:
                key, i = decoder.raw_decode(text, i)
                if not isinstance(key, str) or key in children:
                    raise StoreConflict('Invalid or duplicate JSON property')
                i = skip(i)
                if text[i] != ':':
                    raise StoreConflict('Invalid JSON object')
                value = read(i + 1)
                children[key] = value
                i = skip(value.end)
                if text[i] == '}':
                    return Span(start, i + 1, children)
                if text[i] != ',':
                    raise StoreConflict('Invalid JSON object separator')
                i = skip(i + 1)
        if text[i] == '[':
            children = []
            i = skip(i + 1)
            if text[i] == ']':
                return Span(start, i + 1, children)
            while True:
                value = read(i)
                children.append(value)
                i = skip(value.end)
                if text[i] == ']':
                    return Span(start, i + 1, children)
                if text[i] != ',':
                    raise StoreConflict('Invalid JSON array separator')
                i = skip(i + 1)
        _, end = decoder.raw_decode(text, i)
        return Span(start, end)

    root = read(1 if text.startswith('\ufeff') else 0)
    if skip(root.end) != len(text):
        raise StoreConflict('Unexpected bytes after ONE document')
    return root


def _dump(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, allow_nan=False)


def commit_document(path: str | Path, doc: Document, *,
                    allowed: dict[str, set[str]], allow_append: bool = False,
                    expected_rows: set[str] | None = None,
                    delivery_operation: str | None = None) -> dict:
    path = Path(path).resolve()
    if not isinstance(doc, Document) or path != doc.path:
        raise StoreConflict('Use load_document on this exact ONE before writing')
    before, after = _rows(doc.original), _rows(doc)
    old_ids, new_ids = list(before), list(after)
    if new_ids[:len(old_ids)] != old_ids or len(new_ids) < len(old_ids):
        raise StoreConflict('Feature deletion/reordering is not permitted')
    added = new_ids[len(old_ids):]
    if added and not allow_append:
        raise StoreConflict('Feature append was not authorized')
    metadata = {k: v for k, v in doc.original.items() if k != 'features'}
    if {k: v for k, v in doc.items() if k != 'features'} != metadata:
        raise StoreConflict('Top-level rules/metadata are outside this transaction')
    changes = {}
    for fid in old_ids:
        if set(before[fid]) - set(after[fid]):
            raise StoreConflict('Property deletion is not permitted')
        delta = {k: v for k, v in after[fid].items()
                 if k not in before[fid] or v != before[fid][k]}
        if set(delta) - set(allowed.get(fid, set())):
            raise StoreConflict('Unapproved fields for ' + fid + ': ' + ','.join(sorted(delta)))
        if delta:
            changes[fid] = delta
    from delivery import transaction_read_set, grouped, rows as delivery_rows
    package_read_set = transaction_read_set(doc.original, doc, changes, delivery_operation)
    with _storage_mutex(path):
        raw = path.read_bytes()
        current = json.loads(raw)
        current_rows = _rows(current)
        if {k: v for k, v in current.items() if k != 'features'} != metadata:
            raise StoreConflict('ONE rules changed since observation; re-read')
        for fid in set(changes) | set(expected_rows or ()) | package_read_set:
            if fid not in before or current_rows.get(fid) != before[fid]:
                raise StoreConflict(fid + ' changed since observation; re-read, do not overwrite')
        if added:
            if any(fid in current_rows for fid in added):
                raise StoreConflict('Concurrent intake allocated the same feature id')
            priorities = {f.get('priority') for f in current_rows.values()}
            if any(after[fid].get('priority') in priorities for fid in added):
                raise StoreConflict('Concurrent intake occupied the requested priority')
        # Revalidate the actual merged projection, not only the caller's old ONE.
        # A concurrent package registration or appended duplicate cannot hide in
        # an unrelated row while this scoped transaction commits.
        projected = copy.deepcopy(current)
        for row in projected['features']:
            row.update(changes.get(row['id'], {}))
        projected['features'].extend(copy.deepcopy(after[fid]) for fid in added)
        transaction_read_set(current, projected, changes, delivery_operation)
        grouped_issues = {str(row.get('issue')) for row in current_rows.values()
                          if grouped(row) and row.get('status') != 'passed'}
        if any(str(after[fid].get('issue')) in grouped_issues for fid in added):
            raise StoreConflict('Intake cannot duplicate an unfinished delivery member issue')
        if not changes and not added:
            return {'changed': False, 'sha256': hashlib.sha256(raw).hexdigest()}
        text = raw.decode('utf-8')
        root = _spans(text)
        array = root.children['features']
        spans = {row['id']: span for row, span in zip(current['features'], array.children)}
        patches = []
        newline = '\r\n' if '\r\n' in text else '\n'
        for fid, delta in changes.items():
            span = spans[fid]
            insert = []
            for key, value in delta.items():
                old = span.children.get(key)
                if old is not None:
                    patches.append((old.start, old.end, _dump(value)))
                else:
                    insert.append(_dump(key) + ': ' + _dump(value))
            if insert:
                pos = max((s.end for s in span.children.values()), default=span.start + 1)
                prefix = ',' if span.children else ''
                patches.append((pos, pos, prefix + newline + '      ' +
                                (',' + newline + '      ').join(insert)))
        if added:
            pos = array.children[-1].end if array.children else array.start + 1
            parts = [json.dumps(after[fid], ensure_ascii=False, indent=2, allow_nan=False)
                     .replace('\n', newline + '    ') for fid in added]
            prefix = ',' if array.children else ''
            patches.append((pos, pos, prefix + newline + '    ' +
                            (',' + newline + '    ').join(parts)))
        for start, end, value in sorted(patches, key=lambda p: (p[0], p[1]), reverse=True):
            text = text[:start] + value + text[end:]
        output = text.encode('utf-8')
        expected = copy.deepcopy(current)
        for row in expected['features']:
            row.update(changes.get(row['id'], {}))
        expected['features'].extend(copy.deepcopy(after[fid]) for fid in added)
        if json.loads(output) != expected:
            raise StoreConflict('Surgical JSON validation failed; nothing written')
        mode = path.stat().st_mode
        keep_temp = False
        fd, name = tempfile.mkstemp(prefix='.' + path.name + '.', suffix='.tmp', dir=path.parent)
        temp = Path(name)
        try:
            with os.fdopen(fd, 'wb') as stream:
                stream.write(output)
                stream.flush()
                os.fsync(stream.fileno())
            os.chmod(temp, mode)
            if path.read_bytes() != raw:
                raise StoreConflict('Legacy writer changed ONE during transaction; retry fresh')
            try:
                os.replace(temp, path)
            except PermissionError:
                # Windows readers may deny FILE_SHARE_DELETE and block atomic replace.
                # The bytes are already validated against the scoped transaction;
                # preserve the recovery copy and write in place rather than weakening
                # the expected-row/read-set guards.
                keep_temp = True
                with path.open('r+b') as stream:
                    stream.seek(0)
                    stream.truncate()
                    stream.write(output)
                    stream.flush()
                    os.fsync(stream.fileno())
                sys.stderr.write('feature_store: atomic replace blocked; wrote ONE in place, '
                                 'recovery copy at ' + str(temp) + '\n')
        finally:
            if not keep_temp and temp.exists():
                temp.unlink()
        return {'changed': True, 'features': list(changes) + added,
                'sha256': hashlib.sha256(output).hexdigest()}


if __name__ == '__main__':
    # Read-only CLI. Writes require explicit field-scoped API use.
    path = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parents[1] / 'feature_list.json'
    doc = load_document(path)
    print(json.dumps({'sha256': doc.sha256, 'features': len(doc['features'])}))

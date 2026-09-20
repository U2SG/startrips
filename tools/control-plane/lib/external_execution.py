#!/usr/bin/env python3
"""Evidence-only receipts for externally executed Experience owners.

ONE remains the sole feature/owner authority. These receipts only remember the
Codexless provider identity needed to re-check an already-authorized owner with
agent_show on a later scheduler run. A receipt never makes a feature eligible,
never locks a feature, and never substitutes for a fresh selector/action plan.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
from pathlib import Path
import subprocess
import tempfile
import uuid

SCHEMA_VERSION = 1
PROVIDER = "codexless"
ACTIVE_STATUSES = {"prepared", "running", "awaitingApproval"}


class ReceiptError(RuntimeError):
    pass


def now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def artifact_dir(root: Path) -> Path:
    return root / ".agent-artifacts" / "external-execution"


def receipt_path(root: Path, feature: str) -> Path:
    return artifact_dir(root) / f"{feature}.json"


def atomic_write(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2, sort_keys=True)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(tmp, path)
    finally:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass


def load_receipt(root: Path, feature: str) -> dict:
    path = receipt_path(root, feature)
    if not path.exists():
        raise ReceiptError(f"receipt missing for {feature}")
    value = json.loads(path.read_text(encoding="utf-8"))
    if value.get("schema_version") != SCHEMA_VERSION or value.get("provider") != PROVIDER:
        raise ReceiptError(f"unsupported receipt for {feature}")
    if value.get("feature") != feature:
        raise ReceiptError(f"receipt feature mismatch for {feature}")
    return value


def branch_of(worktree: Path) -> str:
    proc = subprocess.run(
        ["git", "rev-parse", "--abbrev-ref", "HEAD"],
        cwd=worktree,
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    branch = proc.stdout.strip()
    if not branch or branch == "HEAD":
        raise ReceiptError("external Experience owner must have a named branch")
    return branch


def prepare(args: argparse.Namespace) -> dict:
    root = Path(args.root).resolve()
    worktree = Path(args.worktree).resolve()
    if not (root / "feature_list.json").exists():
        raise ReceiptError("feature_list.json missing")
    if not (worktree / ".git").exists() and not (worktree / ".git").is_file():
        raise ReceiptError("worktree is not a git worktree")
    branch = branch_of(worktree)
    owner_key = f"startrips-experience-{args.feature.lower()}-owner"
    path = receipt_path(root, args.feature)
    existing = load_receipt(root, args.feature) if path.exists() else None
    if existing and existing.get("status") in ACTIVE_STATUSES:
        same = (existing.get("worktree") == str(worktree).replace("\\", "/")
                and existing.get("branch") == branch
                and existing.get("action") == args.action
                and existing.get("row_token") == args.row_token)
        if not same:
            raise ReceiptError("active external Experience execution does not match prepared owner/action")
        return existing
    generation = int((existing or {}).get("generation") or 0) + 1
    request_id = f"{owner_key}-g{generation}-{uuid.uuid4().hex[:10]}"
    value = {
        "schema_version": SCHEMA_VERSION, "provider": PROVIDER, "feature": args.feature,
        "owner_key": owner_key, "generation": generation,
        "worktree": str(worktree).replace("\\", "/"), "branch": branch,
        "action": args.action, "row_token": args.row_token, "request_id": request_id,
        "status": "prepared", "agent_ref": None, "task_ref": None, "turn_id": None,
        "prepared_at": now(), "observed_at": None,
    }
    atomic_write(path, value)
    return value


def record(args: argparse.Namespace) -> dict:
    root = Path(args.root).resolve()
    value = load_receipt(root, args.feature)
    if args.request_id and value.get("request_id") != args.request_id:
        raise ReceiptError("request_id mismatch")
    if args.agent_ref:
        old = value.get("agent_ref")
        if old and old != args.agent_ref:
            raise ReceiptError("agent_ref mismatch")
        value["agent_ref"] = args.agent_ref
    if args.task_ref:
        value["task_ref"] = args.task_ref
    if args.turn_id:
        value["turn_id"] = args.turn_id
    if args.status in {"running", "awaitingApproval"} and not value.get("agent_ref"):
        raise ReceiptError(f"{args.status} external execution requires a provider agent_ref")
    value["status"] = args.status
    value["observed_at"] = now()
    atomic_write(receipt_path(root, args.feature), value)
    return value


def show(args: argparse.Namespace):
    root = Path(args.root).resolve()
    if args.feature:
        return load_receipt(root, args.feature)
    out = []
    for path in sorted(artifact_dir(root).glob("ST-*.json")) if artifact_dir(root).exists() else []:
        try:
            out.append(json.loads(path.read_text(encoding="utf-8")))
        except Exception:
            out.append({"path": str(path), "status": "invalid"})
    return out


def main() -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("prepare")
    p.add_argument("root")
    p.add_argument("feature")
    p.add_argument("worktree")
    p.add_argument("action")
    p.add_argument("row_token")
    p.set_defaults(fn=prepare)

    p = sub.add_parser("record")
    p.add_argument("root")
    p.add_argument("feature")
    p.add_argument("status")
    p.add_argument("--request-id")
    p.add_argument("--agent-ref")
    p.add_argument("--task-ref")
    p.add_argument("--turn-id")
    p.set_defaults(fn=record)

    p = sub.add_parser("show")
    p.add_argument("root")
    p.add_argument("feature", nargs="?")
    p.set_defaults(fn=show)

    args = parser.parse_args()
    try:
        result = args.fn(args)
    except (ReceiptError, OSError, subprocess.CalledProcessError, json.JSONDecodeError) as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False))
        return 6
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

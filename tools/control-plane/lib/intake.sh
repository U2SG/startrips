#!/usr/bin/env bash
# Issue intake for the Startrips loop workspace.
#
# One implementation, two callers: `run-loop.sh` runs `intake_new_issues` at the
# start of every iteration (right after `reconcile_merge_state`, i.e. BEFORE
# `next_feature`, so an intake decision can take effect in the same iteration),
# and `./init.sh intake [issue] [--dry-run]` is the manual entry point.
#
# The queue file is the authority on what work exists; GitHub is the authority
# on what the product wants. Intake is the bridge, in two halves that share one
# per-iteration session budget:
#
#   intake_new_issues        an open issue nobody has queued becomes either a
#                            queued feature at a justified position, or a
#                            recorded skip with a public reason;
#   intake_reconcile_issues  an issue ALREADY mapped to a feature, whose GitHub
#                            state moved past the recorded snapshot, is handled
#                            by the status of that feature: backfill, amend,
#                            curated note, builder window, reopen follow-up or
#                            plain snapshot bookkeeping.
#
# `intake_new_issues` runs FIRST and spends the shared budget first, because
# CLAUDE.md promises that a P0/P1 regression triaged in an iteration is the one
# that iteration builds; an amend deferred by one iteration costs far less than
# breaking that promise.
#
# Sourced, not executed: it expects `ROOT` (workspace root) and optionally
# `GH_REPO` from the caller and defines fallbacks for everything else.

INTAKE_ROOT="${ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
INTAKE_GH_REPO="${GH_REPO:-${STARTRIPS_GH_REPO:-U2SG/startrips}}"
INTAKE_FEATURES="$INTAKE_ROOT/feature_list.json"
INTAKE_PROGRESS="$INTAKE_ROOT/claude-progress.md"
INTAKE_DIR="$INTAKE_ROOT/.agent-artifacts/intake"
INTAKE_SKIPPED="$INTAKE_DIR/skipped.json"
INTAKE_DECISIONS="$INTAKE_DIR/decisions.log"
INTAKE_DRY_RUN="${INTAKE_DRY_RUN:-0}"
INTAKE_LAST_LOG=""
INTAKE_LAST_RESULT=""

# Windows-native python3 encodes stdout with the console codepage, which turns
# any non-ASCII the triage session quoted from the product (Chinese UI copy, an
# em dash) into mojibake — and that string is what gets posted to the issue.
# Every file read/write below already names utf-8 explicitly; this covers the
# stdout side the shell reads back.
export PYTHONIOENCODING=utf-8

# The loop defines these before sourcing; `init.sh` does not. Same nesting guard
# and same quota semantics either way — a quota hit during triage exits 5
# exactly like a builder or evaluator run, so the supervisor treats it as a
# quota stop rather than a harness failure.
if ! declare -F claude_run >/dev/null 2>&1; then
  claude_run() {
    env -u CLAUDECODE -u CLAUDE_CODE_CHILD_SESSION claude "$@"
  }
fi
if ! declare -F quota_stop >/dev/null 2>&1; then
  quota_stop() {
    local log="$1" who="$2" line
    line="$(grep -m1 -iE "hit your (weekly|session|usage) limit" "$log" 2>/dev/null || true)"
    [[ -z "$line" ]] || {
      echo "Claude quota exhausted during the $who run: ${line}"
      echo "Feature state left untouched; re-run after the reset."
      exit 5
    }
  }
fi
if ! declare -F transient_stop >/dev/null 2>&1; then
  transient_stop() {
    local log="$1" who="$2" line
    line="$(grep -m1 -E '^API Error: (Unable to connect|5[0-9]{2}|Connection error|Request timed out)' "$log" 2>/dev/null || true)"
    [[ -z "$line" ]] || { echo "Platform failure during the $who run: ${line}"; exit 6; }
  }
fi

intake_init_dirs() {
  mkdir -p "$INTAKE_DIR"
  [[ -f "$INTAKE_SKIPPED" ]] || echo '{}' > "$INTAKE_SKIPPED"
  [[ -f "$INTAKE_DECISIONS" ]] || : > "$INTAKE_DECISIONS"
}

intake_now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# Every decision lands here, so a human can audit placements without replaying
# the sessions. A dry run prints but does not append.
intake_record_decision() {
  local line="$*"
  echo "[intake] $line"
  [[ "$INTAKE_DRY_RUN" == "1" ]] && return 0
  printf '%s\t%s\n' "$(intake_now)" "$line" >> "$INTAKE_DECISIONS"
  return 0
}

# Outward-facing, non-idempotent, and therefore guarded HERE rather than only at
# the call site: no future call path can post from a dry run by accident.
intake_comment_issue() {
  local num="$1" body="$2"
  if [[ "$INTAKE_DRY_RUN" == "1" ]]; then
    echo "[intake] DRY-RUN would comment on #$num:"
    printf '%s\n' "$body" | sed 's/^/    | /'
    return 0
  fi
  intake_record_decision "issue=$num routine-comment-suppressed (exception-only conversation policy)"
  return 0
}

intake_field() {
  python3 -c 'import json,sys; print(json.load(open(sys.argv[1],encoding="utf-8")).get(sys.argv[2],""))' \
    "$1" "$2" | tr -d '\r'
}

# Read-only duplicate suppression for the expensive model turn. This is process
# evidence only: it creates no queue/owner claim/lock and never authorizes a write.
intake_triage_peer_active() {
  local num="$1"
  if command -v powershell.exe >/dev/null 2>&1; then
    powershell.exe -NoProfile -NonInteractive -Command "\$n='$num'; \$rows=Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { \$_.Name -ieq 'claude.exe' -and \$_.CommandLine -match '--agent startrips-triage' -and \$_.CommandLine -match ('issue #' + [regex]::Escape(\$n) + '(?:\D|$)') }; if (\$rows) { exit 0 } else { exit 1 }" >/dev/null 2>&1
    return $?
  fi
  python3 - "$num" <<'PY'
import os, re, subprocess, sys
num = sys.argv[1]
try:
    text = subprocess.run(['ps', '-eo', 'pid=,args='], capture_output=True, text=True, timeout=5, check=True).stdout
except Exception:
    raise SystemExit(1)
needle = re.compile(r'issue #' + re.escape(num) + r'(?:\D|$)')
for line in text.splitlines():
    pid, _, args = line.strip().partition(" ")
    if pid.isdigit() and int(pid) != os.getpid() and "--agent startrips-triage" in args and needle.search(args):
        raise SystemExit(0)
raise SystemExit(1)
PY
}

# Open issues that no feature already references and that intake has not already
# skipped, [P0]/[P1]-titled first then oldest first, capped by rules.intake.max_per_iteration. Issues
# carrying rules.intake.skip_label are never candidates.
#
# `issue` is heterogeneous in this queue — an int (ST-000), a full issue URL
# (ST-001..ST-005) or null — so membership is decided on trailing digits.
intake_candidates() {
  intake_init_dirs
  local issues="$INTAKE_DIR/open-issues-${BASHPID}.json" response
  if ! response="$(gh issue list --repo "$INTAKE_GH_REPO" --state open --limit 100 \
      --json number,title,labels,createdAt,author)"; then
    echo "[intake] candidate evidence UNKNOWN; discovery failed" >&2
    return 6
  fi
  [[ -n "$response" ]] || { echo "[intake] candidate response missing" >&2; return 6; }
  printf '%s' "$response" | tr -d '\r' > "$issues"
python3 - "$INTAKE_FEATURES" "$INTAKE_SKIPPED" "$issues" <<'PY'
import json, os, re, sys
feat_p, skip_p, iss_p = sys.argv[1:4]
from pathlib import Path
sys.path.insert(0, str(Path(feat_p).parent / 'lib'))
from feature_store import load_document
d = load_document(feat_p)
intake = (d.get('rules') or {}).get('intake') or {}
cap = int(intake.get('max_per_iteration', 3))
skip_label = intake.get('skip_label', 'no-loop')

queued = set()
for f in d['features']:
    v = f.get('issue')
    if v is None:
        continue
    m = re.search(r'(\d+)\s*$', str(v))
    if m:
        queued.add(int(m.group(1)))

try:
    skipped = {int(k) for k in json.load(open(skip_p, encoding='utf-8')).keys()}
except Exception:
    skipped = set()

issues = json.load(open(iss_p, encoding='utf-8'))
# A P0/P1-titled regression is triaged before anything else, then oldest first.
# The manual promises that a P0/P1 regression triaged this iteration is the one
# it builds; with a budget of three sessions, a plain oldest-first order let
# older explorations spend the budget while a [P1] waited behind them.
def severity(it):
    m = re.match(r'\s*\[P([01])\]', it.get('title') or '')
    return int(m.group(1)) if m else 2

out = []
for it in sorted(issues, key=lambda x: (severity(x), x.get('createdAt') or '', x['number'])):
    if os.environ.get('INTAKE_URGENT_ONLY') == '1' and severity(it) > 1:
        continue
    n = int(it['number'])
    if n in queued or n in skipped:
        continue
    if skip_label in {l.get('name') for l in (it.get('labels') or [])}:
        continue
    out.append(n)
for n in out[:cap]:
    print(n)
PY
}

# Used by the manual entry point to refuse a pointless session on an issue the
# queue already knows about.
intake_known_state() {
python3 - "$INTAKE_FEATURES" "$INTAKE_SKIPPED" "$1" <<'PY'
import json, re, sys
feat_p, skip_p, num = sys.argv[1], sys.argv[2], int(sys.argv[3])
from pathlib import Path
sys.path.insert(0, str(Path(feat_p).parent / 'lib'))
from feature_store import load_document
d = load_document(feat_p)
for f in d['features']:
    v = f.get('issue')
    if v is None:
        continue
    m = re.search(r'(\d+)\s*$', str(v))
    if m and int(m.group(1)) == num:
        print('already queued as ' + f['id'] + ' (' + f.get('status', '?') + ')')
        raise SystemExit(0)
try:
    s = json.load(open(skip_p, encoding='utf-8'))
except Exception:
    s = {}
if str(num) in s:
    print('already skipped: ' + str(s[str(num)]))
PY
}

# One headless session, whatever the mode. `slug` keeps an amend or follow-up
# log from overwriting the new-issue log for the same issue.
intake_triage() {
  local num="$1" prompt="${2:-}" slug="${3:-}"
  local ro="You are read-only — never comment on, create, close or edit anything on GitHub, and never write files. Your final message must be exactly one JSON object between the markers <<<INTAKE and INTAKE>>> with nothing after the closing marker."
  [[ -n "$prompt" ]] || prompt="Triage issue #$num in $INTAKE_GH_REPO for the Startrips loop queue. Follow your agent instructions exactly: verify the claimed gap against the real code in startrips/ before believing the title, then decide skip versus a queued feature and choose the phase and anchor with the placement rules. $ro"
  INTAKE_LAST_LOG="$INTAKE_DIR/issue-$num${slug:+-$slug}-triage-${BASHPID}.log"
  : > "$INTAKE_LAST_LOG"
  local triage_rc=0
  # Triage needs only the custom agent built-ins (Read/Grep/Glob/Bash). Loading
  # user/global MCP servers here adds unrelated startup processes and has caused
  # successful provider sessions to terminate with an empty output log. Keep this
  # narrow, and preserve the real Claude exit code instead of hiding it behind tee.
  set +e
  (
    cd "$INTAKE_ROOT" || exit 1
    claude_run --setting-sources project --strict-mcp-config --agent startrips-triage --dangerously-skip-permissions --model sonnet \
      --output-format text \
      -p "$prompt" \
      2>&1
  ) | tee "$INTAKE_LAST_LOG"
  triage_rc=${PIPESTATUS[0]}
  set -e
  quota_stop "$INTAKE_LAST_LOG" "triage"
  # An API failure leaves no marker block; without this it would be recorded
  # as `triage output invalid` and the issue skipped until a human clears it
  # (#244 and #245 on 2026-09-06). Exit 6 like the builder does instead.
  transient_stop "$INTAKE_LAST_LOG" "triage"
  if [[ "$triage_rc" != "0" ]]; then
    echo "[intake] triage process failed rc=$triage_rc for issue #$num; state unchanged" >&2
    return 6
  fi
}

# Parse, validate and apply in a single pass, because the placement rules can
# only be checked against the queue the feature would join. Writes
# feature_list.json / skipped.json itself (state first, comment second), and
# leaves a result file the caller builds the issue comment from.
#
# Three optional inputs make this same path serve the reopen follow-up
# (`intake_followup`) without a second copy of it:
#   INTAKE_FORCE_ANCHOR   overrides placement.anchor and forces `after`
#   INTAKE_FORCE_DEP      is added to `dependencies` if the agent omitted it
#   INTAKE_NOTES_PREFIX   is inserted after `auto-intake ` in `notes`
#   INTAKE_NO_SKIP_FILE=1 keeps a skip/invalid verdict OUT of skipped.json,
#                         which is keyed by issue number: writing it there for
#                         an issue that is already mapped to a feature would
#                         suppress nothing today and exclude the issue from
#                         new-issue intake forever if the feature ever went away
intake_apply() {
  local num="$1" log="$2"
  INTAKE_LAST_RESULT="$INTAKE_DIR/result-$num.json"
python3 - "$INTAKE_FEATURES" "$INTAKE_SKIPPED" "$log" "$num" "$INTAKE_LAST_RESULT" "$INTAKE_DRY_RUN" "$INTAKE_ROOT/lib" <<'PY'
import copy, datetime, json, os, sys

feat_p, skip_p, log_p, num_s, res_p, dry_s, libdir = sys.argv[1:8]
sys.path.insert(0, libdir)
from feature_store import load_document, commit_document
from intake_json import INVALID, InvalidOutput, load_marker, next_feature_id, place_priority

num = int(num_s)
dry = dry_s == '1'
force_anchor = os.environ.get('INTAKE_FORCE_ANCHOR', '').strip()
force_dep = os.environ.get('INTAKE_FORCE_DEP', '').strip()
notes_prefix = os.environ.get('INTAKE_NOTES_PREFIX', '').strip()
no_skip_file = os.environ.get('INTAKE_NO_SKIP_FILE', '') == '1'
issue_updated = os.environ.get('INTAKE_ISSUE_UPDATED_AT', '').strip()
issue_comments = os.environ.get('INTAKE_ISSUE_COMMENTS', '').strip()

def emit(**kw):
    json.dump(kw, open(res_p, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
    print('DECISION=' + kw.get('decision', '?'))
    if kw.get('reason'):
        print('REASON=' + kw['reason'])

def record_skip(reason):
    if dry or no_skip_file:
        return
    try:
        s = json.load(open(skip_p, encoding='utf-8'))
    except Exception:
        s = {}
    s[str(num)] = reason
    open(skip_p, 'w', encoding='utf-8').write(
        json.dumps(s, ensure_ascii=False, indent=2) + '\n')

try:
    obj = load_marker(log_p)
except InvalidOutput as exc:
    record_skip(INVALID)
    emit(decision='invalid', reason=exc.reason, issue=num)
    raise SystemExit(0)

if obj.get('skip') is True:
    reason = str(obj.get('reason') or '').strip()
    if not reason:
        record_skip(INVALID)
        emit(decision='invalid', reason=INVALID + ' (skip without a reason)', issue=num)
        raise SystemExit(0)
    record_skip(reason)
    emit(decision='skip', reason=reason, issue=num)
    raise SystemExit(0)

d = load_document(feat_p)
before = json.dumps(d['features'], ensure_ascii=False, sort_keys=True)
ids = {f['id'] for f in d['features']}
by_id = {f['id']: f for f in d['features']}

problems = []
for key in ('phase', 'title', 'description'):
    if not isinstance(obj.get(key), str) or not obj[key].strip():
        problems.append('missing ' + key)
for key in ('dependencies', 'acceptance', 'verification_commands', 'evidence_required'):
    if not isinstance(obj.get(key), list):
        problems.append('missing ' + key)
if isinstance(obj.get('acceptance'), list) and len(obj['acceptance']) < 3:
    problems.append('acceptance needs at least 3 checkable items')

placement = obj.get('placement')
if not isinstance(placement, dict):
    problems.append('missing placement')
    placement = {}
else:
    if not str(placement.get('rationale') or '').strip():
        problems.append('placement needs a rationale')

if force_anchor:
    # The follow-up of a reopened issue is placed by the loop, not by the
    # session: it goes after the feature that already shipped for that issue.
    placement = dict(placement)
    placement['anchor'] = force_anchor
    placement['position'] = 'after'
    if not str(placement.get('rationale') or '').strip():
        placement['rationale'] = 'follow-up of ' + force_anchor + ' after issue #' + str(num) + ' moved again'
        problems = [p for p in problems if p != 'placement needs a rationale']
    problems = [p for p in problems if p != 'missing placement']

if placement.get('anchor') not in ids:
    problems.append('unknown placement anchor: ' + str(placement.get('anchor')))
if placement.get('position') not in ('before', 'after'):
    problems.append('placement position must be before or after')

deps = list(obj.get('dependencies') or [])
if force_dep and force_dep not in deps:
    deps.append(force_dep)
for dep in deps:
    if dep not in ids:
        problems.append('unknown dependency: ' + str(dep))

if problems:
    record_skip(INVALID)
    emit(decision='invalid', reason=INVALID + ': ' + '; '.join(problems), issue=num)
    raise SystemExit(0)

from intake_json import issue_number
family = [f for f in d['features'] if issue_number(f.get('issue')) == num]
if (not force_anchor and family) or (force_anchor and any(
        f.get('status') in {'pending', 'in_progress', 'needs_work', 'ready_for_eval', 'ready_to_merge'}
        or f.get('reopen_handled_at') for f in family)):
    emit(decision='skip', reason='Already queued or reopen handled by another execution', issue=num)
    raise SystemExit(0)

new_id = next_feature_id(ids)
anchor = by_id[placement['anchor']]
prio = place_priority(d['features'], anchor, placement['position'])
if prio is None:
    record_skip(INVALID)
    emit(decision='invalid',
         reason=INVALID + ': no free priority slot near ' + anchor['id'], issue=num)
    raise SystemExit(0)

stamp = datetime.datetime.now(datetime.timezone.utc).isoformat()
feature = {
    'id': new_id,
    'phase': obj['phase'].strip(),
    'priority': prio,
    'target': 'startrips',
    'issue': num,
    'title': obj['title'].strip(),
    'description': obj['description'].strip(),
    'dependencies': deps,
    'acceptance': list(obj['acceptance']),
    'verification_commands': list(obj['verification_commands']),
    'evidence_required': list(obj['evidence_required']),
    'human_gate': obj.get('human_gate') or None,
    'status': 'pending',
    'passes': False,
    'attempts': 0,
    'evidence': [],
    'pr_links': [],
    'issue_snapshot_at': issue_updated or None,
    'issue_snapshot_comments': int(issue_comments) if issue_comments.isdigit() else None,
    'notes': 'auto-intake ' + (notes_prefix + ' ' if notes_prefix else '') + stamp
             + ': ' + placement['rationale'].strip(),
}

if not dry:
    d['features'].append(copy.deepcopy(feature))
    # Turns "never modify an existing feature" into something checkable rather
    # than something asserted in a comment. The amend path has its own,
    # narrower version of this guard.
    if json.dumps(d['features'][:-1], ensure_ascii=False, sort_keys=True) != before:
        raise SystemExit('intake would have modified an existing feature; refusing to write')
    commit_document(feat_p, d, allowed={}, allow_append=True, expected_rows=set(ids))

emit(decision='feature', issue=num, id=new_id, priority=prio, phase=feature['phase'],
     title=feature['title'], anchor=anchor['id'], position=placement['position'],
     rationale=placement['rationale'].strip(),
     human_gate=feature['human_gate'] or '',
     acceptance_head=' / '.join(feature['acceptance'][:2]),
     dependencies=', '.join(feature['dependencies']),
     dry_run=dry)
print('ID=' + new_id)
print('PRIORITY=' + repr(prio))
print('PLACED=' + placement['position'] + ' ' + anchor['id'])
PY
}

# Triage exactly one issue and apply the outcome.
# The loop's own comment is a move too: it bumps the issue's updatedAt and its
# comment count, so a snapshot taken BEFORE posting makes the very next
# reconcile spend an amend session on activity the loop caused itself. Every
# path that posts about a queued feature re-reads the issue afterwards and
# advances that feature's snapshot past its own comment.
intake_resnapshot() {
  local fid="$1" num="$2" st upd cnt
  st="$(intake_issue_state "$num" || true)"
  [[ -n "$st" ]] || return 0
  upd="$(intake_state_field "$st" updatedAt)"
  cnt="$(intake_state_field "$st" comments)"
  intake_touch_feature "$fid" "$upd" "$cnt"
  return 0
}

intake_issue() {
  local num="$1" decision reason fid phase anchor position rationale acc gate prio
  intake_init_dirs
  local st upd="" cnt=""
  # The snapshot the created feature carries has to come from the same reader
  # the later comparison uses, or the very next reconcile sees a phantom move.
  st="$(intake_issue_state "$num" || true)"
  if [[ -n "$st" ]]; then
    upd="$(intake_state_field "$st" updatedAt)"
    cnt="$(intake_state_field "$st" comments)"
  fi
  if [[ "$INTAKE_DRY_RUN" == "1" ]]; then
    echo "=== Intake (dry run): $INTAKE_GH_REPO#$num ==="
  else
    echo "=== Intake: $INTAKE_GH_REPO#$num ==="
  fi

  if intake_triage_peer_active "$num"; then
    intake_record_decision "issue=$num triage-active; deferred to existing invocation"
    return 0
  fi
  intake_triage "$num" || return $?
  [[ -s "$INTAKE_LAST_LOG" ]] || { intake_record_decision "issue=$num triage-log-empty"; return 1; }
  INTAKE_ISSUE_UPDATED_AT="$upd" INTAKE_ISSUE_COMMENTS="$cnt" intake_apply "$num" "$INTAKE_LAST_LOG" || { intake_record_decision "issue=$num transaction-deferred; no stale result consumed"; return 6; }
  [[ -f "$INTAKE_LAST_RESULT" ]] || { intake_record_decision "issue=$num result-missing"; return 1; }

  decision="$(intake_field "$INTAKE_LAST_RESULT" decision)"
  reason="$(intake_field "$INTAKE_LAST_RESULT" reason)"
  case "$decision" in
    skip)
      intake_record_decision "issue=$num decision=skip reason=$reason"
      intake_comment_issue "$num" "The Startrips agentic loop will not pick this issue up: $reason

Recorded in the loop's intake skip list; clearing that entry has it re-triaged. This is a queueing note from the loop harness, not a maintainer decision about the issue itself."
      [[ "$INTAKE_DRY_RUN" == "1" ]] || printf '\n### %s — intake skipped #%s\n- Reason: %s\n' \
        "$(intake_now)" "$num" "$reason" >> "$INTAKE_PROGRESS"
      ;;
    invalid)
      # Deliberately silent on GitHub: a malformed triage turn is a harness
      # failure, not a product verdict, so it must not speak for the product.
      intake_record_decision "issue=$num decision=invalid reason=$reason"
      [[ "$INTAKE_DRY_RUN" == "1" ]] || printf '\n### %s — intake could not triage #%s\n- %s\n- Harness failure, not a product verdict: delete the entry from `.agent-artifacts/intake/skipped.json` to retry.\n' \
        "$(intake_now)" "$num" "$reason" >> "$INTAKE_PROGRESS"
      ;;
    feature)
      fid="$(intake_field "$INTAKE_LAST_RESULT" id)"
      phase="$(intake_field "$INTAKE_LAST_RESULT" phase)"
      anchor="$(intake_field "$INTAKE_LAST_RESULT" anchor)"
      position="$(intake_field "$INTAKE_LAST_RESULT" position)"
      rationale="$(intake_field "$INTAKE_LAST_RESULT" rationale)"
      acc="$(intake_field "$INTAKE_LAST_RESULT" acceptance_head)"
      gate="$(intake_field "$INTAKE_LAST_RESULT" human_gate)"
      prio="$(intake_field "$INTAKE_LAST_RESULT" priority)"
      intake_record_decision "issue=$num decision=feature id=$fid priority=$prio placed=$position $anchor phase=$phase gate=${gate:-none}"
      intake_comment_issue "$num" "Queued in the Startrips loop as $fid ($phase, placed $position $anchor: $rationale). Acceptance: $acc"
      intake_resnapshot "$fid" "$num"
      [[ "$INTAKE_DRY_RUN" == "1" ]] || printf '\n### %s — intake queued #%s as %s\n- Phase %s, priority %s, placed %s %s.\n- Rationale: %s\n- Human gate: %s\n' \
        "$(intake_now)" "$num" "$fid" "$phase" "$prio" \
        "$position" "$anchor" "$rationale" "${gate:-none}" >> "$INTAKE_PROGRESS"
      ;;
    *)
      intake_record_decision "issue=$num decision=unknown"
      return 1
      ;;
  esac
  return 0
}

# The per-iteration entry point. Call it as a plain statement, never inside
# `$(...)` or a pipeline: `quota_stop` exits 5 and that has to reach the loop.
intake_new_issues() {
  # Reset per ITERATION, not per source: run-loop.sh sources this file once and
  # runs every iteration in the same shell, so a file-scope value would carry
  # a spent budget into iteration 2..N. The reconcile pass that follows in the
  # same iteration shares what is left of this fresh budget.
  INTAKE_BUDGET=""
  local n count=0 discovered
  local -a cands=()
  command -v gh >/dev/null 2>&1 || { echo "[intake] gh not available; evidence UNKNOWN" >&2; return 6; }
  intake_init_dirs
  # Read the candidate list into an array first: a triage session started inside
  # a loop that reads from a process substitution would share that descriptor.
  discovered="$(intake_candidates)" || return 6
  mapfile -t cands <<< "$discovered"
  for n in "${cands[@]}"; do
    n="$(printf %s "$n" | tr -d '\r')"
    [[ -n "$n" ]] || continue
    # New issues spend the shared per-iteration budget FIRST: CLAUDE.md promises
    # that a P0/P1 regression triaged this iteration is the one it builds.
    intake_budget_take || { echo "[intake] session budget spent; #$n waits for the next iteration"; break; }
    intake_issue "$n" || echo "[intake] issue #$n could not be triaged; left for the next iteration"
    count=$((count + 1))
  done
  [[ "$count" -gt 0 ]] || echo "[intake] no new open issues to triage"
  return 0
}

# ---------------------------------------------------------------------------
# Issue update tracking (owner decision 2026-09-04)
#
# A feature is a snapshot of an issue taken once, and issues keep moving. Every
# feature created or backfilled here carries `issue_snapshot_at` (the issue's
# `updatedAt`) and `issue_snapshot_comments` (its comment count) as MUTABLE
# fields, and `intake_reconcile_issues` decides what a move means from the
# STATUS of the mapped feature:
#
#   no snapshot yet      -> backfill from the live issue, no triage, no comment.
#                           ST-000..ST-020 are the owner's curated contract and
#                           are never re-triaged just to gain a snapshot.
#   pending, auto-intake -> amend re-triage; the session may rewrite acceptance,
#                           dependencies, human_gate, description and placement.
#   pending, curated     -> never rewritten: a decisions.log line, a note on the
#                           feature and a "Needs owner attention" entry in
#                           claude-progress.md. Nothing is posted.
#   in flight            -> NOT touched here, including the snapshot. The builder
#                           reads the window [issue_snapshot_at, now] at the
#                           start of its round and advances the snapshot itself
#                           once it has consumed it. Advancing it here would
#                           empty the window before the builder ever read it,
#                           and would silently drop a whole iteration's comments
#                           whenever that feature is not the one selected.
#   passed, issue open   -> one follow-up feature after it, via the normal triage
#                           path, at most once per reopen (`reopen_handled_at`).
#   anything else        -> snapshot bookkeeping only.
#
# The snapshot is advanced on `unchanged` and on the curated-note path too: an
# `updatedAt` bump from a label or a title edit would otherwise re-trigger the
# same decision every iteration forever and burn the whole session budget.
# ---------------------------------------------------------------------------

intake_cap() {
  python3 -c 'import json,sys; d=json.load(open(sys.argv[1],encoding="utf-8")); print(int(((d.get("rules") or {}).get("intake") or {}).get("max_per_iteration",3)))' \
    "$INTAKE_FEATURES" | tr -d '\r'
}

# One budget for the whole iteration, shared by new-issue triage and by the
# amend/follow-up re-triages, so a busy issue thread cannot spawn an unbounded
# number of sessions. Both callers live in the same shell process.
INTAKE_BUDGET=""
# The `|| echo 3` matters under `set -e`: a failing substitution in an assignment aborts.
intake_budget_init() { [[ -n "$INTAKE_BUDGET" ]] || INTAKE_BUDGET="$(intake_cap || echo 3)"; }
intake_budget_take() {
  intake_budget_init
  [[ "${INTAKE_BUDGET:-0}" -gt 0 ]] || return 1
  INTAKE_BUDGET=$((INTAKE_BUDGET - 1))
  return 0
}

# The live GitHub state of one issue, as one compact JSON line. This is the ONLY
# place that state is read, so the backfill and every later comparison count the
# same things the same way; two readers would manufacture a phantom amend on the
# first run.
intake_issue_state() {
  gh issue view "$1" --repo "$INTAKE_GH_REPO" \
    --json number,state,updatedAt,comments,labels \
    --jq '{number: .number, state: .state, updatedAt: .updatedAt, comments: (.comments | length), labels: [.labels[].name]}' \
    2>/dev/null | tr -d '\r'
}

intake_mapped_issue_numbers() {
python3 - "$INTAKE_FEATURES" "$INTAKE_ROOT/lib" <<'PY'
import json, sys
feat_p, libdir = sys.argv[1:3]
sys.path.insert(0, libdir)
from feature_store import load_document, commit_document
from intake_json import issue_number
d = load_document(feat_p)
seen = []
for f in d['features']:
    n = issue_number(f.get('issue'))
    if n is not None and n not in seen:
        seen.append(n)
for n in seen:
    print(n)
PY
}

# JSONL, one line per mapped issue. Prints the path it wrote.
intake_fetch_issue_states() {
  local out="$INTAKE_DIR/mapped-issues-${BASHPID}.jsonl"
  local raw="$INTAKE_DIR/all-issues-${BASHPID}.jsonl"
  local -a mapped=()
  mapfile -t mapped < <(intake_mapped_issue_numbers)
  if [[ "${#mapped[@]}" == "0" ]]; then
    : > "$out"
    printf '%s' "$out"
    return 0
  fi
  # One paginated REST snapshot replaces one gh issue view process per mapped
  # issue. The REST issue object already carries comment count, updated_at and
  # labels, so this preserves the same comparison semantics without holding a
  # pre-scope lane claim across dozens of sequential network round-trips.
  if ! gh api --paginate "repos/$INTAKE_GH_REPO/issues?state=all&per_page=100" \
      --jq '.[] | select(.pull_request == null) | {number,state,updated_at,comments,labels:[.labels[].name]} | @json' \
      > "$raw"; then
    echo "[intake] mapped issue state evidence UNKNOWN; batch fetch failed" >&2
    return 6
  fi
python3 - "$INTAKE_FEATURES" "$raw" "$out" "$INTAKE_ROOT/lib" <<'PY'
import json, sys
feat_p, raw_p, out_p, libdir = sys.argv[1:5]
sys.path.insert(0, libdir)
from feature_store import load_document
from intake_json import issue_number
doc = load_document(feat_p)
mapped = []
for feature in doc["features"]:
    number = issue_number(feature.get("issue"))
    if number is not None and number not in mapped:
        mapped.append(number)
states = {}
for line in open(raw_p, encoding="utf-8"):
    line = line.strip()
    if not line:
        continue
    item = json.loads(line)
    number = int(item["number"])
    states[number] = {
        "number": number,
        "state": str(item.get("state") or "").upper(),
        "updatedAt": item.get("updated_at") or "",
        "comments": int(item.get("comments") or 0),
        "labels": list(item.get("labels") or []),
    }
missing = [number for number in mapped if number not in states]
if missing:
    print("[intake] mapped issue state evidence incomplete: " + ",".join(map(str, missing)), file=sys.stderr)
    raise SystemExit(6)
with open(out_p, "w", encoding="utf-8", newline="\n") as stream:
    for number in mapped:
        stream.write(json.dumps(states[number], ensure_ascii=False, separators=(",", ":")) + "\n")
PY
  local rc=$?
  rm -f "$raw"
  [[ "$rc" == "0" ]] || return "$rc"
  printf '%s' "$out"
}

# The plan, as TSV: id, issue, action, state, updatedAt, comments, snapshot_at,
# snapshot_comments, detail. Deciding and acting are separate steps so that
# `intake-check --dry-run` prints exactly what the real run would do.
intake_plan() {
python3 - "$INTAKE_FEATURES" "$1" "$INTAKE_ROOT/lib" <<'PY'
import json, sys
feat_p, states_p, libdir = sys.argv[1:4]
sys.path.insert(0, libdir)
from feature_store import load_document, commit_document
from intake_json import is_auto_intake, issue_number, moved

d = load_document(feat_p)
skip_label = ((d.get('rules') or {}).get('intake') or {}).get('skip_label', 'no-loop')

states = {}
for line in open(states_p, encoding='utf-8'):
    line = line.strip()
    if not line:
        continue
    try:
        s = json.loads(line)
    except Exception:
        continue
    states[int(s['number'])] = s

IN_FLIGHT = {'in_progress', 'needs_work', 'ready_for_eval'}
# `blocked` and `cancelled_by_product_decision` are terminal; `ready_to_merge` is
# not, it is waiting on a human.
UNFINISHED = {'pending', 'in_progress', 'needs_work', 'ready_for_eval', 'ready_to_merge'}

# Several features can map to ONE issue: #200 carries ST-001..ST-005. A reopen is
# a property of the issue, so the follow-up decision is made once per issue, not
# once per row - otherwise the first of the five to merge triggers a follow-up for
# work the other four already cover, and a genuine reopen after all five passed
# would queue five follow-ups and post five comments.
by_issue = {}
for f in d['features']:
    n = issue_number(f.get('issue'))
    if n is not None:
        by_issue.setdefault(n, []).append(f)

def followup_owner(num):
    # The one feature allowed to trigger a follow-up for this issue, or None.
    fam = by_issue.get(num) or []
    if any(g.get('status') in UNFINISHED for g in fam):
        return None                      # somebody is still working the issue
    if any(g.get('reopen_handled_at') for g in fam):
        return None                      # this reopen already produced one
    passed = [g for g in fam if g.get('status') == 'passed']
    if not passed:
        return None
    return sorted(passed, key=lambda g: float(g['priority']))[0]['id']

for f in d['features']:
    num = issue_number(f.get('issue'))
    if num is None:
        continue
    st = states.get(num)
    if st is None:
        action, detail = 'unknown', 'gh returned no state for this issue'
        upd = cnt = state = ''
    else:
        state, upd, cnt = st['state'], st['updatedAt'], str(st['comments'])
        status = f.get('status')
        mv = moved(f, st)
        if skip_label in (st.get('labels') or []):
            action, detail = 'no-loop', 'labelled ' + skip_label + '; intake suppressed for this issue'
        elif mv is None:
            action, detail = 'backfill', 'no snapshot recorded yet'
        elif not mv:
            action, detail = 'untouched', 'issue has not moved since the snapshot'
        elif status == 'pending' and is_auto_intake(f):
            action, detail = 'amend', 'auto-intake entry still pending; re-triage in amend mode'
        elif status == 'pending':
            action, detail = 'curated-note', 'curated entry: record the update, never rewrite it'
        elif status in IN_FLIGHT:
            action, detail = 'builder-window', 'in flight (' + str(status) + '); the builder reads the comments and advances the snapshot'
        elif status == 'passed' and state == 'OPEN' and not f.get('reopen_handled_at'):
            if followup_owner(num) == f['id']:
                action, detail = 'follow-up', 'passed feature whose issue is open and moved again'
            else:
                action, detail = 'bookkeeping', 'issue open and moved, but another feature on it is unfinished or already carries the reopen; snapshot only'
        elif status == 'blocked':
            action, detail = 'blocked-note', 'blocked entry whose issue moved: most likely the owner answering the question that blocked it'
        else:
            action, detail = 'bookkeeping', 'status ' + str(status) + '; advance the snapshot only'
    snapc = f.get('issue_snapshot_comments')
    # A '-' rather than '': tab is IFS whitespace, so bash `read` collapses a
    # run of tabs into one delimiter and every field after an empty one shifts.
    row = [
        f['id'], str(num), action, state, upd, cnt,
        str(f.get('issue_snapshot_at') or ''),
        str(snapc) if snapc is not None else '',
        detail,
    ]
    print('	'.join(x if x != '' else '-' for x in row))
PY
}

# Snapshot bookkeeping, optionally with a note and the reopen marker. Every
# write goes through the narrow guard in intake_json.assert_only_changed.
intake_touch_feature() {
  local fid="$1" upd="$2" cnt="$3" note="${4:-}" reopen="${5:-}"
  if [[ "$INTAKE_DRY_RUN" == "1" ]]; then
    echo "[intake] DRY-RUN would set $fid issue_snapshot_at=$upd issue_snapshot_comments=$cnt${note:+ (+note)}${reopen:+ (+reopen_handled_at)}"
    return 0
  fi
python3 - "$INTAKE_FEATURES" "$fid" "$upd" "$cnt" "$note" "$reopen" "$INTAKE_ROOT/lib" <<'PY'
import copy, datetime, json, os, sys
feat_p, fid, upd, cnt, note, reopen, libdir = sys.argv[1:8]
sys.path.insert(0, libdir)
from feature_store import load_document, commit_document
from intake_json import assert_only_changed

d = load_document(feat_p)
before = copy.deepcopy(d['features'])
stamp = datetime.datetime.now(datetime.timezone.utc).isoformat()
for f in d['features']:
    if f['id'] != fid:
        continue
    expected_token = os.environ.get('INTAKE_EXPECTED_ROW', '')
    if expected_token:
        from intake_guard import require_amend_snapshot
        require_amend_snapshot(f, expected_token, upd, cnt)
    if f.get('status') in {'in_progress', 'needs_work', 'ready_for_eval'}:
        print('SKIP=builder-owns-issue-window')
        raise SystemExit(0)
    if upd and f.get('issue_snapshot_at') and upd < f['issue_snapshot_at']:
        raise SystemExit('stale issue snapshot; retry fresh')
    f['issue_snapshot_at'] = upd or None
    f['issue_snapshot_comments'] = int(cnt) if str(cnt).isdigit() else None
    if note:
        existing = (f.get('notes') or '').strip()
        f['notes'] = (existing + ' | ' if existing else '') + stamp + ': ' + note
    if reopen:
        f['reopen_handled_at'] = stamp
    break
else:
    raise SystemExit('feature not found: ' + fid)

assert_only_changed(before, d['features'], fid,
                    ('issue_snapshot_at', 'issue_snapshot_comments', 'notes', 'reopen_handled_at'))
commit_document(feat_p, d, allowed={fid: {'issue_snapshot_at', 'issue_snapshot_comments', 'notes', 'reopen_handled_at'}})
PY
}

# A curated entry is never rewritten by the harness, so the human has to be able
# to see that its issue moved without reading decisions.log. One heading per
# reconcile run, however many entries need it: #200 alone maps to five features,
# and five headings in one iteration is noise a human stops reading.
INTAKE_ATTENTION_HEADING=0
intake_owner_attention() {
  local fid="$1" num="$2" text="$3"
  if [[ "$INTAKE_DRY_RUN" == "1" ]]; then
    echo "[intake] DRY-RUN would add a Needs owner attention line for $fid (#$num)"
    return 0
  fi
  if [[ "$INTAKE_ATTENTION_HEADING" == "0" ]]; then
    printf '\n### Needs owner attention\n' >> "$INTAKE_PROGRESS"
    INTAKE_ATTENTION_HEADING=1
  fi
  printf -- '- %s: %s maps to issue #%s, which has changed since the queue entry was written. %s\n' \
    "$(intake_now)" "$fid" "$num" "$text" >> "$INTAKE_PROGRESS"
  return 0
}

# Amend re-triage of ONE auto-intake pending feature.
intake_apply_amend() {
  local num="$1" fid="$2" log="$3"
  INTAKE_LAST_RESULT="$INTAKE_DIR/amend-$fid.json"
python3 - "$INTAKE_FEATURES" "$log" "$num" "$fid" "$INTAKE_LAST_RESULT" "$INTAKE_DRY_RUN" "$INTAKE_ROOT/lib" <<'PY'
import copy, datetime, json, os, sys
feat_p, log_p, num_s, fid, res_p, dry_s, libdir = sys.argv[1:8]
sys.path.insert(0, libdir)
from feature_store import load_document, commit_document
from intake_json import (INVALID, InvalidOutput, assert_only_changed, is_auto_intake,
                         load_marker, place_priority)

num = int(num_s)
dry = dry_s == '1'
upd = os.environ.get('INTAKE_ISSUE_UPDATED_AT', '').strip()
cnt = os.environ.get('INTAKE_ISSUE_COMMENTS', '').strip()

def emit(**kw):
    json.dump(kw, open(res_p, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
    print('DECISION=' + kw.get('decision', '?'))
    if kw.get('reason'):
        print('REASON=' + kw['reason'])

try:
    obj = load_marker(log_p)
except InvalidOutput as exc:
    # No skipped.json entry: that file is keyed by issue number and this issue is
    # already mapped to a feature. A malformed amend turn changes nothing.
    emit(decision='invalid', reason=exc.reason, issue=num, id=fid)
    raise SystemExit(0)

# The same immutable row was shown to the model before it ran. Re-loading a
# newer row here does not authorize applying an older model result to it.
d = load_document(feat_p)
from intake_guard import require_amend_snapshot
from feature_state import target as feature_target
require_amend_snapshot(feature_target(d, fid), os.environ.get('INTAKE_EXPECTED_ROW'), upd, cnt)

if obj.get('unchanged') is True:
    emit(decision='unchanged', issue=num, id=fid,
         reason=str(obj.get('reason') or 'not material').strip())
    raise SystemExit(0)

if obj.get('skip') is True:
    # The loop does not cancel queued work on a session's word: CLAUDE.md forbids
    # deleting a feature or weakening its acceptance. Record it, let the owner act.
    emit(decision='moot', issue=num, id=fid,
         reason=str(obj.get('reason') or 'issue reported as moot').strip())
    raise SystemExit(0)

amend = obj.get('amend')
if not isinstance(amend, dict):
    emit(decision='invalid', reason=INVALID + ' (no amend, unchanged or skip verdict)',
         issue=num, id=fid)
    raise SystemExit(0)

before = copy.deepcopy(d['features'])
ids = {f['id'] for f in d['features']}
by_id = {f['id']: f for f in d['features']}
target = by_id.get(fid)

problems = []
if target is None:
    problems.append('feature ' + fid + ' no longer exists')
elif target.get('status') != 'pending':
    problems.append('feature ' + fid + ' is ' + str(target.get('status')) + ', not pending')
elif not is_auto_intake(target):
    problems.append('feature ' + fid + ' is curated (notes do not start with auto-intake)')

rationale = str(amend.get('rationale') or '').strip()
if not rationale:
    problems.append('amend needs a rationale')

allowed_keys = {'description', 'dependencies', 'acceptance', 'human_gate', 'placement', 'rationale'}
unknown = set(amend) - allowed_keys
if unknown:
    problems.append('amend may not change ' + ', '.join(sorted(unknown)))

if 'acceptance' in amend:
    acc = amend['acceptance']
    if not isinstance(acc, list) or len(acc) < 3 or not all(
            isinstance(x, str) and x.strip() for x in acc):
        problems.append('amended acceptance needs at least 3 non-empty checkable items')
if 'dependencies' in amend:
    deps = amend['dependencies']
    if not isinstance(deps, list):
        problems.append('amended dependencies must be a list')
    else:
        for dep in deps:
            if dep not in ids:
                problems.append('unknown dependency: ' + str(dep))
            if dep == fid:
                problems.append('a feature cannot depend on itself')
if 'description' in amend and not (
        isinstance(amend['description'], str) and amend['description'].strip()):
    problems.append('amended description must be a non-empty string')
if 'human_gate' in amend and amend['human_gate'] is not None and not (
        isinstance(amend['human_gate'], str) and amend['human_gate'].strip()):
    problems.append('amended human_gate must be a non-empty string or null')

placement = amend.get('placement')
if placement is not None:
    if not isinstance(placement, dict):
        problems.append('amended placement must be an object')
    else:
        if placement.get('anchor') not in ids:
            problems.append('unknown placement anchor: ' + str(placement.get('anchor')))
        if placement.get('position') not in ('before', 'after'):
            problems.append('placement position must be before or after')
        if placement.get('anchor') == fid:
            problems.append('a feature cannot be placed relative to itself')

if problems:
    emit(decision='invalid', reason=INVALID + ': ' + '; '.join(problems), issue=num, id=fid)
    raise SystemExit(0)

changed = []
if 'description' in amend:
    target['description'] = amend['description'].strip()
    changed.append('description')
if 'dependencies' in amend:
    target['dependencies'] = list(amend['dependencies'])
    changed.append('dependencies')
if 'acceptance' in amend:
    target['acceptance'] = list(amend['acceptance'])
    changed.append('acceptance')
if 'human_gate' in amend:
    target['human_gate'] = amend['human_gate'] or None
    changed.append('human_gate')
new_prio = None
if placement is not None:
    others = [f for f in d['features'] if f['id'] != fid]
    new_prio = place_priority(others, by_id[placement['anchor']], placement['position'])
    if new_prio is None:
        emit(decision='invalid',
             reason=INVALID + ': no free priority slot near ' + placement['anchor'],
             issue=num, id=fid)
        raise SystemExit(0)
    target['priority'] = new_prio
    changed.append('priority')

stamp = datetime.datetime.now(datetime.timezone.utc).isoformat()
existing = (target.get('notes') or '').strip()
target['notes'] = (existing + ' | ' if existing else '') + stamp \
    + ': auto-intake amend after issue #' + str(num) + ' changed (' \
    + ', '.join(changed) + '): ' + rationale
target['issue_snapshot_at'] = upd or target.get('issue_snapshot_at')
target['issue_snapshot_comments'] = int(cnt) if cnt.isdigit() else target.get('issue_snapshot_comments')

assert_only_changed(before, d['features'], fid,
                    ('description', 'dependencies', 'acceptance', 'human_gate', 'priority',
                     'notes', 'issue_snapshot_at', 'issue_snapshot_comments'))
if not dry:
    commit_document(feat_p, d, allowed={fid: {'description', 'dependencies', 'acceptance', 'human_gate', 'priority', 'notes', 'issue_snapshot_at', 'issue_snapshot_comments'}}, expected_rows=set(ids))

emit(decision='amend', issue=num, id=fid, reason=rationale,
     changed=', '.join(changed),
     priority=(new_prio if new_prio is not None else target['priority']),
     acceptance_head=' / '.join(target['acceptance'][:2]),
     human_gate=target.get('human_gate') or '',
     dry_run=dry)
print('AMENDED=' + ', '.join(changed))
PY
}

# Dump the feature an amend session has to reason about. Read-only input, so it
# goes to the artifacts directory instead of being pasted into the prompt.
intake_dump_feature() {
python3 - "$INTAKE_FEATURES" "$1" "$INTAKE_DIR" "$INTAKE_ROOT/lib" <<'PY'
import json, os, sys, tempfile
from pathlib import Path
feat_p, fid, directory, libdir = sys.argv[1:5]
sys.path.insert(0, libdir)
from feature_store import load_document
from feature_state import target, row_token
row = target(load_document(feat_p), fid)
fd, out = tempfile.mkstemp(prefix='feature-' + fid + '-', suffix='.json', dir=directory)
with os.fdopen(fd, 'w', encoding='utf-8') as stream:
    json.dump(row, stream, ensure_ascii=False, indent=2)
# Path and token originate from the SAME snapshot, before model execution.
print(out + '\t' + row_token(row))
PY
}

intake_amend() {
  local num="$1" fid="$2" upd="$3" cnt="$4" dump prompt decision reason changed snapshot expected_row
  intake_budget_take || {
    intake_record_decision "issue=$num feature=$fid amend deferred: per-iteration session budget spent"
    return 0
  }
  snapshot="$(intake_dump_feature "$fid" | tr -d '\r')" || return 6
  IFS=$'\t' read -r dump expected_row <<< "$snapshot"
  [[ -n "$dump" && -n "$expected_row" ]] || return 6
  prompt="Amend mode for the Startrips loop queue. Feature $fid is still pending and was created by intake from issue #$num in $INTAKE_GH_REPO, which has moved since it was triaged. Read your agent instructions (the Amend mode section), the current feature object at $dump, and the whole issue: gh issue view $num --repo $INTAKE_GH_REPO --comments. Decide whether the change is material to the queued work, then return one JSON object: {\"unchanged\": true, \"reason\": \"...\"} when it is not, {\"skip\": true, \"reason\": \"...\"} when the issue is now moot, or {\"amend\": {\"rationale\": \"...\", plus only the fields that must change: description, dependencies, acceptance, human_gate, placement}}. Keep every acceptance item a checkable fact and never widen the scope beyond what the issue asks. You are read-only: never comment on, create, close or edit anything on GitHub, and never write files. Your final message must be exactly one JSON object between the markers <<<INTAKE and INTAKE>>> with nothing after the closing marker."
  intake_triage "$num" "$prompt" "amend-$fid" || return $?
  [[ -s "$INTAKE_LAST_LOG" ]] || {
    intake_record_decision "issue=$num feature=$fid amend-log-empty"
    return 0
  }
  INTAKE_EXPECTED_ROW="$expected_row" INTAKE_ISSUE_UPDATED_AT="$upd" INTAKE_ISSUE_COMMENTS="$cnt" \
    intake_apply_amend "$num" "$fid" "$INTAKE_LAST_LOG" || { intake_record_decision "issue=$num amend-transaction-deferred"; return 6; }
  [[ -f "$INTAKE_LAST_RESULT" ]] || {
    intake_record_decision "issue=$num feature=$fid amend-result-missing"
    return 0
  }
  decision="$(intake_field "$INTAKE_LAST_RESULT" decision)"
  reason="$(intake_field "$INTAKE_LAST_RESULT" reason)"
  changed="$(intake_field "$INTAKE_LAST_RESULT" changed)"
  case "$decision" in
    amend)
      intake_record_decision "issue=$num feature=$fid decision=amend changed=$changed reason=$reason"
      intake_comment_issue "$num" "The Startrips loop amended its queued entry $fid after this update: $reason (changed: $changed). The entry is still pending; nothing has been implemented yet."
      # No prose comment was posted; preserve the actually consumed issue window.
      [[ "$INTAKE_DRY_RUN" == "1" ]] || printf '\n### %s - intake amended %s from #%s\n- Changed: %s\n- Rationale: %s\n' \
        "$(intake_now)" "$fid" "$num" "$changed" "$reason" >> "$INTAKE_PROGRESS"
      ;;
    unchanged)
      # The snapshot still advances, otherwise a label edit re-triages forever.
      intake_record_decision "issue=$num feature=$fid decision=unchanged reason=$reason"
      INTAKE_EXPECTED_ROW="$expected_row" intake_touch_feature "$fid" "$upd" "$cnt"
      ;;
    moot)
      intake_record_decision "issue=$num feature=$fid decision=moot reason=$reason"
      INTAKE_EXPECTED_ROW="$expected_row" intake_touch_feature "$fid" "$upd" "$cnt" \
        "intake amend session reported the issue as moot: $reason (queue entry left in place for the owner)"
      intake_owner_attention "$fid" "$num" \
        "The amend session reports the issue is now moot: $reason The queue entry was left pending; cancelling it is the owner's call."
      ;;
    invalid)
      # Harness failure, not a product verdict: nothing is posted and the
      # snapshot is NOT advanced, so the next iteration retries.
      intake_record_decision "issue=$num feature=$fid decision=invalid reason=$reason"
      ;;
    *)
      intake_record_decision "issue=$num feature=$fid decision=unknown"
      ;;
  esac
  return 0
}

# Every feature mapping one issue number. A reopen is handled once per ISSUE, so
# the marker has to land on all of them, not only on the one that triggered it.
intake_features_for_issue() {
python3 - "$INTAKE_FEATURES" "$1" "$INTAKE_ROOT/lib" <<'PY'
import json, sys
feat_p, num_s, libdir = sys.argv[1:4]
sys.path.insert(0, libdir)
from feature_store import load_document, commit_document
from intake_json import issue_number
num = int(num_s)
d = load_document(feat_p)
for f in d['features']:
    if issue_number(f.get('issue')) == num:
        print(f['id'])
PY
}

# The reopen marker goes on every feature mapping this issue, so no sibling can
# trigger a second follow-up for the same reopen next iteration.
intake_mark_reopen_family() {
  local num="$1" fid="$2" upd="$3" cnt="$4" note="$5" other
  local -a fam=()
  mapfile -t fam < <(intake_features_for_issue "$num")
  for other in "${fam[@]}"; do
    other="$(printf '%s' "$other" | tr -d '\r')"
    [[ -n "$other" ]] || continue
    if [[ "$other" == "$fid" ]]; then
      intake_touch_feature "$other" "$upd" "$cnt" "$note" "1"
    else
      intake_touch_feature "$other" "$upd" "$cnt" \
        "issue #$num moved again while open; the reopen was handled on $fid" "1"
    fi
  done
  return 0
}

# A passed feature's issue moved again while open: queue ONE follow-up after it.
intake_followup() {
  local num="$1" fid="$2" upd="$3" cnt="$4" prompt decision reason newid prio st
  intake_budget_take || {
    intake_record_decision "issue=$num feature=$fid follow-up deferred: per-iteration session budget spent"
    return 0
  }
  prompt="Follow-up mode for the Startrips loop queue. Issue #$num in $INTAKE_GH_REPO is open again, or moved again while open, after feature $fid shipped for it and merged. Read your agent instructions, then read the whole issue: gh issue view $num --repo $INTAKE_GH_REPO --comments, and check what $fid actually landed on main (git -C startrips log and the merged PR). Triage ONLY the residual gap that is still open, exactly as you would a new issue: either a skip with a reason, or a full feature whose acceptance covers just that residual gap. The loop places it after $fid and adds $fid as a dependency, so you do not need to set the placement yourself. You are read-only: never comment on, create, close or edit anything on GitHub, and never write files. Your final message must be exactly one JSON object between the markers <<<INTAKE and INTAKE>>> with nothing after the closing marker."
  intake_triage "$num" "$prompt" "followup-$fid" || return $?
  [[ -s "$INTAKE_LAST_LOG" ]] || {
    intake_record_decision "issue=$num feature=$fid followup-log-empty"
    return 0
  }
  INTAKE_FORCE_ANCHOR="$fid" INTAKE_FORCE_DEP="$fid" \
    INTAKE_NOTES_PREFIX="follow-up of $fid (issue reopened)" \
    INTAKE_NO_SKIP_FILE=1 \
    INTAKE_ISSUE_UPDATED_AT="$upd" INTAKE_ISSUE_COMMENTS="$cnt" \
    intake_apply "$num" "$INTAKE_LAST_LOG" || { intake_record_decision "issue=$num followup-transaction-deferred"; return 6; }
  [[ -f "$INTAKE_LAST_RESULT" ]] || {
    intake_record_decision "issue=$num feature=$fid followup-result-missing"
    return 0
  }
  decision="$(intake_field "$INTAKE_LAST_RESULT" decision)"
  reason="$(intake_field "$INTAKE_LAST_RESULT" reason)"
  case "$decision" in
    feature)
      newid="$(intake_field "$INTAKE_LAST_RESULT" id)"
      prio="$(intake_field "$INTAKE_LAST_RESULT" priority)"
      intake_record_decision "issue=$num decision=follow-up id=$newid after=$fid priority=$prio"
      intake_comment_issue "$num" "This issue moved again after $fid merged, so the Startrips loop queued a follow-up entry $newid, placed after $fid and depending on it. Only the residual gap is in its acceptance."
      # Re-read AFTER the comment so the whole family, the new follow-up
      # included, is stamped past the loop's own post.
      st="$(intake_issue_state "$num" || true)"
      if [[ -n "$st" ]]; then
        upd="$(intake_state_field "$st" updatedAt)"
        cnt="$(intake_state_field "$st" comments)"
      fi
      intake_mark_reopen_family "$num" "$fid" "$upd" "$cnt" \
        "issue #$num moved again while open; follow-up $newid queued"
      [[ "$INTAKE_DRY_RUN" == "1" ]] || printf '\n### %s - intake queued follow-up %s for #%s (after %s)\n- Reason: reopened or updated after %s merged.\n' \
        "$(intake_now)" "$newid" "$num" "$fid" "$fid" >> "$INTAKE_PROGRESS"
      ;;
    skip)
      # `reopen_handled_at` is the once-per-reopen marker; skipped.json is
      # deliberately not written for an issue that is already mapped.
      intake_record_decision "issue=$num feature=$fid decision=follow-up-skip reason=$reason"
      intake_mark_reopen_family "$num" "$fid" "$upd" "$cnt" \
        "issue #$num moved again while open; triage found no residual gap: $reason"
      ;;
    invalid)
      intake_record_decision "issue=$num feature=$fid decision=follow-up-invalid reason=$reason"
      ;;
    *)
      intake_record_decision "issue=$num feature=$fid decision=unknown"
      ;;
  esac
  return 0
}

# The second per-iteration entry point, after `intake_new_issues`. Same rule as
# that one: call it as a plain statement, never in `$(...)` or a pipeline, so a
# quota stop inside a triage session reaches the loop.
intake_reconcile_issues() {
  command -v gh >/dev/null 2>&1 || { echo "[intake] gh not available; skipping issue reconcile"; return 0; }
  # Per RUN, not per process: the loop sources this file once and then runs up to
  # MAX_ITERATIONS iterations in the same shell, and a later iteration's bullets
  # would otherwise land far below iteration 1's heading.
  INTAKE_ATTENTION_HEADING=0
  intake_init_dirs
  local states row fid num action state upd cnt snap snapc detail quiet=0
  local -a rows=()
  states="$(intake_fetch_issue_states)"
  # Read the whole plan first: a triage session started inside a loop that reads
  # from a process substitution would share that file descriptor with it.
  mapfile -t rows < <(intake_plan "$states")
  for row in "${rows[@]}"; do
    IFS=$'\t' read -r fid num action state upd cnt snap snapc detail <<< "$row"
    [[ -n "${fid:-}" && -n "${action:-}" ]] || continue
    case "$action" in
      backfill)
        intake_record_decision "issue=$num feature=$fid backfill snapshot=$upd comments=$cnt (curated entries are never re-triaged for a snapshot)"
        intake_touch_feature "$fid" "$upd" "$cnt"
        ;;
      amend)
        intake_amend "$num" "$fid" "$upd" "$cnt"
        ;;
      curated-note)
        intake_record_decision "issue=$num feature=$fid curated-update snapshot=$snap->$upd comments=$snapc->$cnt (recorded, never rewritten)"
        intake_touch_feature "$fid" "$upd" "$cnt" \
          "issue #$num changed after this entry was written (updatedAt $snap -> $upd, comments $snapc -> $cnt); the harness does not rewrite a curated entry"
        intake_owner_attention "$fid" "$num" \
          "Read gh issue view $num --comments and decide whether the entry's acceptance still matches; the harness recorded the change and rewrote nothing."
        ;;
      builder-window)
        # Deliberately no snapshot write: the builder's window is
        # [issue_snapshot_at, now] and the builder advances it once it has read
        # the comments, so no round's comments can be skipped.
        intake_record_decision "issue=$num feature=$fid builder-window snapshot=$snap comments=$snapc->$cnt (left for the builder to read and advance)"
        ;;
      follow-up)
        intake_followup "$num" "$fid" "$upd" "$cnt"
        ;;
      blocked-note)
        # A builder blocks a feature and posts ONE question on the issue when a
        # comment contradicts the acceptance. The answer arrives as issue
        # activity, and only a human can unblock the feature, so it has to be
        # visible rather than swallowed by the snapshot write.
        intake_record_decision "issue=$num feature=$fid blocked-update snapshot=$snap->$upd comments=$snapc->$cnt (owner reply likely; only a human unblocks)"
        intake_touch_feature "$fid" "$upd" "$cnt"           "issue #$num moved while this entry is blocked; read the new comments and unblock or cancel it"
        intake_owner_attention "$fid" "$num"           "The entry is blocked and its issue has new activity, probably the answer the builder asked for; only a human can unblock it."
        ;;
      bookkeeping)
        intake_record_decision "issue=$num feature=$fid bookkeeping snapshot=$snap->$upd comments=$snapc->$cnt"
        intake_touch_feature "$fid" "$upd" "$cnt"
        ;;
      no-loop)
        intake_record_decision "issue=$num feature=$fid suppressed by label"
        ;;
      unknown)
        intake_record_decision "issue=$num feature=$fid state-unavailable (left for the next iteration)"
        ;;
      untouched)
        quiet=$((quiet + 1))
        ;;
    esac
  done
  echo "[intake] reconcile: ${#rows[@]} mapped issue(s), $quiet unchanged"
  return 0
}

# `./init.sh intake-check [--dry-run]`: what the reconcile would do, or does it.
intake_check() {
  local arg row fid num action state upd cnt snap snapc detail states acted=0
  for arg in "$@"; do
    case "$arg" in
      --dry-run) INTAKE_DRY_RUN=1 ;;
      *) echo "usage: ./init.sh intake-check [--dry-run]" >&2; return 1 ;;
    esac
  done
  command -v gh >/dev/null 2>&1 || { echo "[intake] gh not available"; return 1; }
  intake_init_dirs
  if [[ "$INTAKE_DRY_RUN" != "1" ]]; then
    intake_reconcile_issues
    return 0
  fi
  states="$(intake_fetch_issue_states)"
  printf '%-8s %-6s %-15s %-22s %-11s %s\n' FEATURE ISSUE ACTION ISSUE_UPDATED COMMENTS DETAIL
  local -a rows=()
  mapfile -t rows < <(intake_plan "$states")
  for row in "${rows[@]}"; do
    IFS=$'\t' read -r fid num action state upd cnt snap snapc detail <<< "$row"
    [[ -n "${fid:-}" ]] || continue
    printf '%-8s %-6s %-15s %-22s %-11s %s\n' \
      "$fid" "#$num" "$action" "$upd" "$cnt/$snapc" "$detail"
    [[ "$action" == "untouched" ]] || acted=$((acted + 1))
  done
  echo
  echo "[intake] dry run: ${#rows[@]} mapped issue(s), $acted would be acted on; session budget $(intake_cap) per iteration"
  echo "[intake] nothing was written and nothing was posted"
  return 0
}

# One field out of a compact issue-state line (see intake_issue_state).
intake_state_field() {
  printf '%s' "$1" | python3 -c 'import json,sys; print(json.load(sys.stdin).get(sys.argv[1],""))' "$2" | tr -d '\r'
}

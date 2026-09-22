"""Static drift checks for active control entrypoints, not archived progress."""
from __future__ import annotations
import argparse
import ast
import json
import re
import sys
from pathlib import Path

SHELLS = ('run-loop.sh', 'launch-supervisor.sh', 'loop-supervisor.sh', 'wake-if-work.sh',
          'scheduled-restart.sh', 'restart-at-boundary.sh', 'lib/intake.sh', 'init.sh')


def audit_prompts(prompts):
    problems = []
    for name, prompt in prompts.items():
        if re.search(r'\b[0-9a-f]{40}\b', prompt): problems.append(name + ': fixed SHA in a recurring prompt')
        if re.search(r'(?:PR\s*#?\d{2,}|#\d{2,}\s*/\s*ST-)', prompt): problems.append(name + ': fixed PR workflow snapshot')
        if 'CLAUDE.md' not in prompt: problems.append(name + ': missing canonical protocol entrypoint')
    return problems


def audit(root):
    root = Path(root); problems = []
    for path in sorted((root / 'lib').glob('*.py')):
        if path.name.startswith('test_'): continue
        try: ast.parse(path.read_text(encoding='utf-8-sig'))
        except (SyntaxError, UnicodeError) as exc: problems.append(path.name + ': ' + str(exc))
    texts = {}
    for name in SHELLS:
        path = root / name
        if not path.exists(): problems.append('missing ' + name); continue
        texts[name] = path.read_text(encoding='utf-8-sig')
        if re.search(r'^\s*(?:git\b[^\n]*(?:reset\b[^\n]*--hard|stash\b|clean\b))', texts[name], re.M):
            problems.append(name + ': destructive git path')
    loop = texts.get('run-loop.sh', '')
    if '${STARTRIPS_LANE:-backend}' in loop: problems.append('Generic lane silently defaults to Backend')
    if 'lib/action_plan.py' not in loop or 'lib/execution.py' not in loop: problems.append('Execution/evidence planner not wired')
    for needle in ["open(p,'w'", "open(feat_p, 'w'", '|| echo 0']:
        if needle in loop or needle in texts.get('lib/intake.sh', ''): problems.append('Unsafe writer/unknown fallback: ' + needle)
    for name in ['scheduled-restart.sh', 'restart-at-boundary.sh']:
        if re.search(r'rm\s+-f[^\n]*(?:AGENT_STOP|SUPERVISOR_STOP)', texts.get(name, '')):
            problems.append(name + ': unconditional STOP removal')
    if 'group_by(.name)' in texts.get('init.sh', ''): problems.append('Historical-success CI shortcut still active')
    manual = (root / 'CLAUDE.md').read_text(encoding='utf-8-sig')
    for needle in ['When `main` advances under an open PR: rebase', '**Every top-level review thread must be answered**']:
        if needle in manual: problems.append('Conflicting live policy: ' + needle)
    if 'Source review receipt' not in manual: problems.append('Source-review receipt contract missing')
    if '## Coherent delivery packages' not in manual:
        problems.append('Delivery-package contract missing')
    for required in ['delivery.py','delivery_package.py','delivery_runtime.py','delivery_issues.py']:
        if not (root / 'lib' / required).is_file(): problems.append('missing lib/' + required)
    if 'verify_delivery_runtime' not in loop or "f.get('delivery_lead')" not in loop:
        problems.append('Package selector/runtime gate not wired')
    if 'package-window' not in texts.get('lib/intake.sh', ''):
        problems.append('Package issue-snapshot guard not wired')
    if any(line.strip() == '# STAGED_PLACEHOLDER' for path in (root / 'lib').glob('*.py') if not path.name.startswith('test_') for line in path.read_text(encoding='utf-8-sig').splitlines()):
        problems.append('Incomplete staged runtime module')
    return problems


def main():
    parser = argparse.ArgumentParser(); parser.add_argument('root', type=Path)
    parser.add_argument('--prompts', type=Path); args = parser.parse_args()
    try:
        problems = audit(args.root)
        if args.prompts: problems += audit_prompts(json.loads(args.prompts.read_bytes()))
        print(json.dumps({'ok': not problems, 'problems': problems})); return 1 if problems else 0
    except (OSError, ValueError) as exc:
        print('POLICY_UNKNOWN: ' + str(exc), file=sys.stderr); return 6


if __name__ == '__main__':
    raise SystemExit(main())


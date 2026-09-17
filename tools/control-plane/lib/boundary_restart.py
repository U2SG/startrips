"""Manual safe drain through the pre-existing STOP contract; never kills a worker."""
import subprocess
import sys
import time
import uuid
from pathlib import Path
from execution import stopped, ensure_idle, clear_owned_stop
from github_evidence import EvidenceUnknown


def restart(root, seconds):
    root = Path(root).resolve()
    if stopped(root):
        print('Existing owner STOP preserved'); return 0
    tag = ('boundary-restart:' + str(uuid.uuid4()) + '\n').encode('ascii')
    try:
        with (root / 'AGENT_STOP').open('xb') as stream: stream.write(tag)
    except FileExistsError:
        return 0
    deadline = time.monotonic() + seconds
    try:
        while time.monotonic() < deadline:
            if any((root / n).exists() for n in ['SUPERVISOR_STOP', 'CANCEL_SCHEDULED_RESTART']):
                return 0
            try:
                ensure_idle(root); break
            except EvidenceUnknown:
                time.sleep(min(10, max(0, deadline - time.monotonic())))
        else:
            print('Boundary not confirmed; scheduled observers remain enabled'); return 6
        clear_owned_stop(root, 'AGENT_STOP', tag)
        if stopped(root): return 0
        return subprocess.call(['bash', str(root / 'launch-supervisor.sh')], cwd=root)
    finally:
        path = root / 'AGENT_STOP'
        if path.exists() and path.read_bytes() == tag:
            clear_owned_stop(root, 'AGENT_STOP', tag)


if __name__ == '__main__':
    seconds = int(sys.argv[2])
    if seconds < 1: raise SystemExit(64)
    raise SystemExit(restart(sys.argv[1], seconds))


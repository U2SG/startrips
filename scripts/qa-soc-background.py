"""CI emulator: real native queued audio and new downloads while the screen is locked."""
import io
import json
import re
import struct
import subprocess
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

root = Path('artifacts/soc-android')
root.mkdir(parents=True, exist_ok=True)
requests = []
audio = io.BytesIO()
with wave.open(audio, 'wb') as stream:
    stream.setnchannels(1)
    stream.setsampwidth(2)
    stream.setframerate(16000)
    stream.writeframes(struct.pack('<h', 400) * 32000)  # 2 seconds per phrase


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        requests.append({'path': self.path, 'time': time.monotonic()})
        time.sleep(0.15)  # Simulate synthesis/download, rather than an already complete book.
        self.send_response(200)
        self.send_header('Content-Type', 'audio/wav')
        self.send_header('Content-Length', str(len(audio.getvalue())))
        self.end_headers()
        self.wfile.write(audio.getvalue())

    def log_message(self, *args):
        pass


def adb(*args):
    return subprocess.run(['adb', *args], check=True, capture_output=True, timeout=60).stdout.decode('utf-8', errors='replace')


def playback_logs():
    # Restrict the busy emulator's system log to the actual playback probe.
    return adb('logcat', '-d', '-b', 'main', '-s', 'ReactNativeJS:I')


def diagnostics():
    # JS can block inside a synchronous native call. Preserve the Android side
    # as well, so a missing JS event does not hide a service crash or ANR.
    for name, args in {
        'crash': ('logcat', '-d', '-b', 'crash', '-t', '400'),
        'system': ('logcat', '-d', '-b', 'system', '-t', '1500'),
        'native': ('logcat', '-d', '-b', 'main', '-t', '1500'),
        'anr': ('shell', 'dumpsys', 'activity', 'lastanr'),
        'sessions': ('shell', 'dumpsys', 'media_session'),
        'audio': ('shell', 'dumpsys', 'audio'),
    }.items():
        try:
            result = subprocess.run(['adb', *args], capture_output=True, timeout=15)
            (root / f'background-{name}.txt').write_bytes(result.stdout + result.stderr)
        except subprocess.TimeoutExpired as error:
            (root / f'background-{name}.txt').write_bytes((error.stdout or b'') + b'\nDiagnostic timed out')
    if not (root / 'background.json').exists():
        try:
            adb('root'); adb('wait-for-device')
            pid = adb('shell', 'pidof', 'com.socratopia.mobile').strip()
            if pid.isdigit():
                adb('shell', 'kill', '-3', pid)
                time.sleep(2)
            subprocess.run(['adb', 'pull', '/data/anr', str(root / 'native-traces')], capture_output=True, timeout=20)
        except (subprocess.SubprocessError, OSError):
            pass


server = ThreadingHTTPServer(('0.0.0.0', 18991), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
try:
    adb('reverse', 'tcp:18991', 'tcp:18991')
    (root / 'background-port.txt').write_text(adb('reverse', '--list'), encoding='utf-8')
    adb('shell', 'am', 'force-stop', 'com.socratopia.mobile')
    adb('logcat', '-c')
    adb('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP')
    adb('shell', 'wm', 'dismiss-keyguard')
    adb('shell', 'am', 'start', '-W', '-n', 'com.socratopia.mobile/.MainActivity')
    deadline = time.monotonic() + 45
    while 'SOC_BOOK_QA' not in playback_logs():
        assert time.monotonic() < deadline, 'CI audio fixture did not start'
        time.sleep(1)
    # Lock while generation is still in progress. No UI interaction until assertions finish.
    locked = time.monotonic()
    adb('shell', 'input', 'keyevent', 'KEYCODE_SLEEP')
    time.sleep(30)
    power = adb('shell', 'dumpsys', 'power')
    assert 'mWakefulness=Asleep' in power, power
    logs = playback_logs()
    states = [json.loads(value) for value in re.findall(r'SOC_BOOK_QA\s+(\{[^\n]+\})', logs)]
    advanced = [s for s in states if s.get('key') and int(s['key'].split('/')[1]) >= 2 and int(s['key'].split('/')[2]) >= 4 and s.get('playing')]
    assert advanced, 'Native playback failed to cross more than twelve short phrases while locked'
    assert any(r['time'] > locked + 20 for r in requests), 'Audio was not replenished while locked'
    assert len(requests) < 36, 'Prefetch must stay bounded, rather than downloading the whole book'
    (root / 'background.json').write_text(json.dumps({'states': states, 'requests': requests, 'lockedSeconds': 30}, indent=2), encoding='utf-8')
    (root / 'power.txt').write_text(power, encoding='utf-8')
finally:
    (root / 'background-logcat.txt').write_text(playback_logs(), encoding='utf-8')
    (root / 'background-requests.json').write_text(json.dumps(requests, indent=2), encoding='utf-8')
    diagnostics()
    adb('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP')
    adb('shell', 'wm', 'dismiss-keyguard')
    adb('shell', 'uiautomator', 'dump', '/sdcard/soc-background.xml')
    (root / 'background-ui.xml').write_text(adb('shell', 'cat', '/sdcard/soc-background.xml'), encoding='utf-8')
    server.shutdown()

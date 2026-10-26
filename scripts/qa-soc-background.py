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


server = ThreadingHTTPServer(('0.0.0.0', 18991), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
try:
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
    adb('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP')
    adb('shell', 'wm', 'dismiss-keyguard')
    server.shutdown()

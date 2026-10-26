"""CI-only smoke check of the installed, standalone Android release."""
import os
import hashlib
import json
from pathlib import Path
import subprocess
import time
import urllib.request
import xml.etree.ElementTree as ET

artifacts = Path("artifacts/soc-android")
artifacts.mkdir(parents=True, exist_ok=True)
package = "com.socratopia.mobile"


def adb(*args, binary=False):
    result = subprocess.run(["adb", *args], check=True, capture_output=True, timeout=60)
    return result.stdout if binary else result.stdout.decode("utf-8", errors="replace")


try:
    apk = Path(os.environ['RUNNER_TEMP']) / 'Soc-android-1.0.7.apk'
    # Exercise real published releases, rather than calling a fresh install an upgrade.
    adb('root'); adb('wait-for-device')
    upgrades = []
    for version, digest in [
        ('1.0.4', '1256635795a5e0dac730aa5c9cbe0bda1802abe6d84769b6b348ce0cc64d8595'),
        ('1.0.6', 'ac935c70015db34d376df281e099af7cab2f8b22433d40c5646f3be508df4ad7'),
    ]:
        previous = Path(os.environ['RUNNER_TEMP']) / f'Soc-android-{version}.apk'
        with urllib.request.urlopen(os.environ['EXPO_PUBLIC_STARTRIPS_ORIGIN'].rstrip('/') + f'/soc/downloads/Soc-android-{version}.apk', timeout=180) as response:
            previous.write_bytes(response.read())
        assert hashlib.sha256(previous.read_bytes()).hexdigest() == digest
        subprocess.run(['adb', 'uninstall', package], capture_output=True, timeout=60)
        adb('install', str(previous))
        directory = f'/data/user/0/{package}/files'
        owner = adb('shell', 'stat', '-c', '%u:%g', f'/data/user/0/{package}').strip()
        adb('shell', 'mkdir', '-p', directory); adb('shell', 'chown', owner, directory)
        marker = artifacts / 'upgrade-marker.txt'; marker.write_text('preserve-local-progress', encoding='utf-8')
        adb('push', str(marker), directory + '/soc-upgrade-marker')
        result = adb('install', '-r', str(apk))
        assert 'Success' in result
        assert adb('shell', 'cat', directory + '/soc-upgrade-marker').strip() == 'preserve-local-progress'
        upgrades.append({'from': version, 'to': '1.0.7', 'dataPreserved': True})
    (artifacts / 'upgrades.json').write_text(json.dumps(upgrades, indent=2), encoding='utf-8')
    adb("logcat", "-c")
    adb("shell", "am", "start", "-W", "-n", package + "/.MainActivity")
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        adb("shell", "uiautomator", "dump", "/sdcard/soc-ui.xml")
        xml = adb("shell", "cat", "/sdcard/soc-ui.xml")
        nodes = list(ET.fromstring(xml).iter("node"))
        labels = {node.get("content-desc") for node in nodes}
        if {"邮箱", "密码", "服务器地址"} <= labels:
            break
        time.sleep(2)
    else:
        raise AssertionError("The release did not leave the splash and show the login form")
    server = next(node for node in nodes if node.get("content-desc") == "服务器地址")
    assert server.get("text") == os.environ["EXPO_PUBLIC_STARTRIPS_ORIGIN"], "APK must point to the deployed server"
    assert adb("shell", "pidof", package).strip(), "The release process must still be running"
    (artifacts / "login.xml").write_text(xml, encoding="utf-8")
    (artifacts / "login.png").write_bytes(adb("exec-out", "screencap", "-p", binary=True))
finally:
    (artifacts / "logcat.txt").write_text(adb("logcat", "-d"), encoding="utf-8")

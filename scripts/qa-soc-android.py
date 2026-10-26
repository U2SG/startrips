"""CI-only smoke check of the installed, standalone Android release."""
import os
from pathlib import Path
import subprocess
import time
import xml.etree.ElementTree as ET

artifacts = Path("artifacts/soc-android")
artifacts.mkdir(parents=True, exist_ok=True)
package = "com.socratopia.mobile"


def adb(*args, binary=False):
    result = subprocess.run(["adb", *args], check=True, capture_output=True, timeout=60)
    return result.stdout if binary else result.stdout.decode("utf-8", errors="replace")


try:
    adb("install", "-r", str(Path(os.environ["RUNNER_TEMP"]) / "Soc-android-1.0.5.apk"))
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

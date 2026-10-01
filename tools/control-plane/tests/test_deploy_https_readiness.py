"""Exercise deploy readiness using transient and permanent transport responses."""
import ast
import json
import os
from pathlib import Path
import shlex
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[3]


def readiness_shell() -> str:
    # Load the pure shell generator without importing SSH deployment dependencies.
    tree = ast.parse((ROOT / "scripts/deploy-main.py").read_text(encoding="utf-8"))
    function = next(node for node in tree.body if isinstance(node, ast.FunctionDef)
                    and node.name == "web_https_readiness_shell")
    namespace = {"shlex": shlex}
    exec(compile(ast.Module(body=[function], type_ignores=[]), "deploy-readiness", "exec"), namespace)
    return namespace["web_https_readiness_shell"]("127.0.0.1")


class DeployHttpsReadinessTests(unittest.TestCase):
    def run_scenario(self, scenario: str):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            curl = folder / "curl"
            curl.write_text("""#!/usr/bin/env python3
import json, os, pathlib, sys
folder = pathlib.Path(os.environ['PROBE_STATE_DIR'])
counter = folder / 'count'
number = int(counter.read_text()) + 1 if counter.exists() else 1
counter.write_text(str(number))
with (folder / 'calls').open('a') as log:
    log.write(json.dumps(sys.argv[1:]) + '\\n')
scenario = os.environ['PROBE_SCENARIO']
if scenario == 'tls-permanent' or (scenario == 'tls-transient' and number <= 2):
    sys.exit(35)
if sys.argv[-1].endswith('/api/health'):
    if scenario == 'api-transient' and number == 2:
        sys.exit(22)
    print('{"status":"starting"}' if scenario == 'wrong-body' else '{"status":"ok"}')
""", encoding="utf-8")
            curl.chmod(0o755)
            for name in ["sleep", "sudo"]:
                stub = folder / name
                stub.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
                stub.chmod(0o755)
            environment = {**os.environ, "PATH": str(folder) + os.pathsep + os.environ["PATH"],
                           "PROBE_STATE_DIR": directory, "PROBE_SCENARIO": scenario}
            result = subprocess.run(["bash", "-c", "set -euo pipefail\n" + readiness_shell()
                                     + "\nwait_for_web_https\necho READY"],
                                    env=environment, capture_output=True, text=True, timeout=10)
            calls = [json.loads(line) for line in (folder / "calls").read_text().splitlines()]
            for arguments in calls:
                self.assertNotIn("-k", arguments)
                self.assertNotIn("--insecure", arguments)
                self.assertIn("-fsS", arguments)
                self.assertEqual(arguments[arguments.index("--max-time") + 1], "5")
                self.assertEqual(arguments[arguments.index("--resolve") + 1], "127.0.0.1:443:127.0.0.1")
            return result, calls

    def test_initial_tls_handshakes_can_fail_before_readiness(self):
        result, calls = self.run_scenario("tls-transient")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("READY", result.stdout)
        self.assertEqual(len(calls), 4)

    def test_temporary_api_http_error_requires_a_later_healthy_response(self):
        result, calls = self.run_scenario("api-transient")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(calls), 4)

    def test_permanent_tls_failure_is_bounded_and_fails(self):
        result, calls = self.run_scenario("tls-permanent")
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("READY", result.stdout)
        self.assertEqual(len(calls), 12)

    def test_http_success_with_wrong_health_body_cannot_pass(self):
        result, calls = self.run_scenario("wrong-body")
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("READY", result.stdout)
        self.assertEqual(len(calls), 24)

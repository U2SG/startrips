#!/usr/bin/env python3
"""Deploy the latest CI-passed main commit to the Startrips Compose host."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import re
import shlex
import ssl
import subprocess
import sys
import tempfile
import time
import urllib.request
from datetime import UTC, datetime
from pathlib import Path

try:
    import paramiko
except ImportError as error:  # pragma: no cover - environment preflight
    raise SystemExit("paramiko is required: python -m pip install --user paramiko") from error


REPO_ROOT = Path(__file__).resolve().parents[1]
SERVER_PATTERN = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$")
USERNAME_PATTERN = re.compile(r"^[A-Za-z0-9_-]+$")
DEFAULT_HOST_KEY_SHA256 = {
    "106.53.130.142": {
        "SHA256:ASKilDdCbOHFxpfb7T5lWOJg358tt77UyNn8Gd767+w",
        "SHA256:AOTiPhYXcxMwPmabusI6owbJgCQsiZUXj7ZFl6sWFoI",
        "SHA256:N8tdV09hQMWz9SZFXTRS1ZxRaZLrsjpbDDZI+uBScv8",
        "SHA256:Y/G6MgO/9iy775BQYT2/zSQ6x0vHw7+BM3zUYeluBYI",
    }
}


class PinnedHostKeyPolicy(paramiko.MissingHostKeyPolicy):
    def __init__(self, allowed_fingerprints: set[str]) -> None:
        self.allowed_fingerprints = allowed_fingerprints

    def missing_host_key(
        self,
        client: paramiko.SSHClient,
        hostname: str,
        key: paramiko.PKey,
    ) -> None:
        del client
        fingerprint = "SHA256:" + base64.b64encode(
            hashlib.sha256(key.asbytes()).digest()
        ).decode("ascii").rstrip("=")
        if fingerprint not in self.allowed_fingerprints:
            raise paramiko.SSHException(
                f"SSH host key mismatch for {hostname}: received {fingerprint}"
            )


def run_local(
    arguments: list[str],
    *,
    capture: bool = False,
    timeout_seconds: int = 120,
) -> str:
    result = subprocess.run(
        arguments,
        cwd=REPO_ROOT,
        check=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=capture,
        timeout=timeout_seconds,
    )
    return result.stdout.strip() if capture else ""


def wait_for_ci(commit: str, timeout_seconds: int) -> str:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        output = run_local(
            [
                "gh",
                "run",
                "list",
                "--branch",
                "main",
                "--limit",
                "20",
                "--json",
                "headSha,status,conclusion,url",
            ],
            capture=True,
            timeout_seconds=min(60, max(1, int(deadline - time.monotonic()))),
        )
        runs = json.loads(output)
        run = next((candidate for candidate in runs if candidate["headSha"] == commit), None)
        if run is None:
            print("CI run has not appeared yet; waiting 10 seconds...")
        elif run["status"] != "completed":
            print(f"CI is {run['status']}; waiting 10 seconds...")
        elif run["conclusion"] == "success":
            return str(run["url"])
        else:
            raise RuntimeError(
                f"CI did not pass: conclusion={run['conclusion']} url={run['url']}"
            )
        time.sleep(10)
    raise TimeoutError(f"CI did not pass within {timeout_seconds} seconds")


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def remote_command(
    client: paramiko.SSHClient,
    command: str,
    *,
    stream: bool = True,
    timeout_seconds: int,
) -> str:
    transport = client.get_transport()
    if transport is None:
        raise RuntimeError("SSH transport is unavailable")
    channel = transport.open_session()
    channel.exec_command("bash -lc " + shlex.quote(command))
    chunks: list[str] = []
    deadline = time.monotonic() + timeout_seconds

    while True:
        if time.monotonic() >= deadline:
            channel.close()
            raise TimeoutError(f"Remote command exceeded {timeout_seconds} seconds")
        while channel.recv_ready():
            text = channel.recv(65536).decode("utf-8", "replace")
            chunks.append(text)
            if stream:
                print(text, end="", flush=True)
        while channel.recv_stderr_ready():
            text = channel.recv_stderr(65536).decode("utf-8", "replace")
            chunks.append(text)
            if stream:
                print(text, end="", file=sys.stderr, flush=True)
        if channel.exit_status_ready() and not channel.recv_ready() and not channel.recv_stderr_ready():
            break
        time.sleep(0.1)

    exit_code = channel.recv_exit_status()
    output = "".join(chunks).strip()
    if exit_code != 0:
        raise RuntimeError(f"Remote command failed with exit code {exit_code}")
    return output


def public_check(server: str) -> bool:
    context = ssl.create_default_context()
    try:
        for path in ("/", "/api/health"):
            with urllib.request.urlopen(
                f"https://{server}{path}", timeout=30, context=context
            ) as response:
                body = response.read()
                if response.status != 200:
                    raise RuntimeError(
                        f"Public check failed for {path}: HTTP {response.status}"
                    )
                if path == "/api/health" and json.loads(body) != {"status": "ok"}:
                    raise RuntimeError(f"Unexpected health response: {body!r}")
                print(f"Public HTTPS {path}: 200")
    except (OSError, RuntimeError, ValueError) as error:
        print(f"PUBLIC PATH WARNING: {error}", file=sys.stderr)
        return False
    return True


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Pull main, require passing CI, and deploy it to Startrips."
    )
    parser.add_argument("--key", required=True, type=Path, help="SSH private-key path")
    parser.add_argument("--server", default="106.53.130.142", help="SSH/HTTPS host")
    parser.add_argument("--user", default="ubuntu", help="SSH username")
    parser.add_argument(
        "--host-key-sha256",
        action="append",
        default=[],
        help="Allowed SSH host-key fingerprint; required for a non-default server",
    )
    parser.add_argument(
        "--ci-timeout-seconds",
        type=int,
        default=1500,
        help="Maximum wait for GitHub Actions (default: 1500)",
    )
    parser.add_argument(
        "--remote-timeout-seconds",
        type=int,
        default=3600,
        help="Maximum remote deployment duration (default: 3600)",
    )
    return parser.parse_args()


def main() -> int:
    arguments = parse_arguments()
    key_path = arguments.key.expanduser().resolve()
    if not key_path.is_file():
        raise FileNotFoundError(f"SSH key does not exist: {key_path}")
    if not SERVER_PATTERN.fullmatch(arguments.server):
        raise ValueError("--server may contain only letters, digits, dots, and hyphens")
    if not USERNAME_PATTERN.fullmatch(arguments.user):
        raise ValueError("--user may contain only letters, digits, underscores, and hyphens")
    if arguments.ci_timeout_seconds <= 0 or arguments.remote_timeout_seconds <= 0:
        raise ValueError("Timeouts must be positive")
    allowed_host_keys = set(DEFAULT_HOST_KEY_SHA256.get(arguments.server, set()))
    allowed_host_keys.update(
        fingerprint
        if fingerprint.startswith("SHA256:")
        else f"SHA256:{fingerprint}"
        for fingerprint in arguments.host_key_sha256
    )
    if not allowed_host_keys:
        raise ValueError("A non-default server requires --host-key-sha256")

    print("1/7 Updating local main...")
    if run_local(["git", "status", "--porcelain"], capture=True):
        print("Local changes detected; the deployment archive will still use the exact main commit.")
    run_local(["git", "switch", "main"])
    run_local(["git", "pull", "--ff-only", "origin", "main"])
    commit = run_local(["git", "rev-parse", "HEAD"], capture=True)
    origin_main = run_local(["git", "rev-parse", "origin/main"], capture=True)
    if commit != origin_main:
        raise RuntimeError("Local main does not exactly match origin/main")
    short_commit = commit[:7]

    print("2/7 Waiting for the exact commit's CI gate...")
    ci_url = wait_for_ci(commit, arguments.ci_timeout_seconds)
    print(f"CI passed: {ci_url}")

    timestamp = datetime.now(UTC).strftime("%Y%m%d%H%M%S")
    release_name = f"main-{timestamp}-{short_commit}"
    release_path = f"/opt/startrips/releases/{release_name}"
    backup_path = f"/opt/startrips/backups/pre-{release_name}.sql.gz"
    remote_archive = f"/tmp/{release_name}.tar.gz"
    rollback_api = f"startrips-api:rollback-pre-{release_name}"
    rollback_web = f"startrips-web:rollback-pre-{release_name}"

    with tempfile.TemporaryDirectory(prefix="startrips-deploy-") as temporary_directory:
        archive_path = Path(temporary_directory) / f"{release_name}.tar.gz"
        run_local(
            ["git", "archive", "--format=tar.gz", "--output", str(archive_path), commit]
        )
        archive_sha = file_sha256(archive_path)

        print(f"3/7 Connecting to {arguments.user}@{arguments.server}...")
        client = paramiko.SSHClient()
        client.set_missing_host_key_policy(PinnedHostKeyPolicy(allowed_host_keys))
        client.connect(
            hostname=arguments.server,
            username=arguments.user,
            key_filename=str(key_path),
            look_for_keys=False,
            allow_agent=False,
            timeout=20,
            banner_timeout=20,
            auth_timeout=20,
        )

        try:
            preflight = f"""
set -euo pipefail
sudo -n true
test ! -e {shlex.quote(release_path)}
df -h /
sudo docker inspect startrips-api-1 startrips-web-1 --format 'BASELINE={{{{.Name}}}} IMAGE={{{{.Image}}}} STARTED={{{{.State.StartedAt}}}} RESTARTS={{{{.RestartCount}}}}'
"""
            remote_command(client, preflight, timeout_seconds=60)

            print("4/7 Uploading the immutable release archive...")
            sftp = client.open_sftp()
            try:
                sftp.get_channel().settimeout(60)
                upload_deadline = time.monotonic() + min(
                    600, arguments.remote_timeout_seconds
                )

                def enforce_upload_deadline(transferred: int, total: int) -> None:
                    del transferred, total
                    if time.monotonic() >= upload_deadline:
                        raise TimeoutError("Release upload exceeded its deadline")

                sftp.put(
                    str(archive_path),
                    remote_archive,
                    callback=enforce_upload_deadline,
                )
            finally:
                sftp.close()
            remote_sha = remote_command(
                client,
                f"sha256sum {shlex.quote(remote_archive)} | cut -d ' ' -f1",
                stream=False,
                timeout_seconds=60,
            )
            if remote_sha != archive_sha:
                raise RuntimeError("Uploaded archive checksum does not match the local archive")

            print("5/7 Locking deployment, backing up data, and building...")
            deploy = f"""
set -euo pipefail
exec 9>/tmp/startrips-deploy.lock
if ! flock -n 9; then
  echo "Another Startrips deployment is already running" >&2
  exit 75
fi
available_kb=$(df -Pk / | awk 'NR == 2 {{print $4}}')
if [ "$available_kb" -lt 5242880 ]; then
  echo "At least 5 GiB of free disk space is required" >&2
  exit 1
fi
old_current=$(readlink -f /opt/startrips/current)
old_api=$(sudo docker inspect startrips-api-1 --format '{{{{.Image}}}}')
old_web=$(sudo docker inspect startrips-web-1 --format '{{{{.Image}}}}')
rollback_needed=0
rollback_release() {{
  exit_code=$?
  trap - EXIT
  rollback_failed=0
  if [ "$exit_code" -ne 0 ]; then
    set +e
    sudo docker image tag "$old_api" startrips-api:latest || rollback_failed=1
    sudo docker image tag "$old_web" startrips-web:latest || rollback_failed=1
  fi
  if [ "$rollback_needed" -eq 1 ] && [ "$exit_code" -ne 0 ]; then
    echo "Activation failed; restoring the previous API, Web, and current symlink" >&2
    cd "$old_current" || rollback_failed=1
    sudo docker compose --env-file .env.deploy -f deploy/compose.yaml up -d --no-deps --force-recreate api || rollback_failed=1
    rollback_health=unknown
    for rollback_attempt in $(seq 1 24); do
      rollback_health=$(sudo docker inspect startrips-api-1 --format '{{{{.State.Health.Status}}}}' 2>/dev/null)
      [ "$rollback_health" = healthy ] && break
      sleep 5
    done
    [ "$rollback_health" = healthy ] || rollback_failed=1
    sudo docker compose --env-file .env.deploy -f deploy/compose.yaml up -d --no-deps --force-recreate web || rollback_failed=1
    sudo ln -sfn "$old_current" /opt/startrips/current || rollback_failed=1
    [ "$(sudo docker inspect startrips-api-1 --format '{{{{.Image}}}}' 2>/dev/null)" = "$old_api" ] || rollback_failed=1
    [ "$(sudo docker inspect startrips-web-1 --format '{{{{.Image}}}}' 2>/dev/null)" = "$old_web" ] || rollback_failed=1
    [ "$(sudo docker inspect startrips-web-1 --format '{{{{.State.Status}}}}' 2>/dev/null)" = running ] || rollback_failed=1
    [ "$(readlink -f /opt/startrips/current)" = "$old_current" ] || rollback_failed=1
    if [ "$rollback_failed" -eq 0 ]; then
      echo "ROLLBACK CONFIRMED. Database migrations remain applied; backup: {backup_path}" >&2
    else
      echo "ROLLBACK FAILED; manual recovery is required. Database backup: {backup_path}" >&2
    fi
  fi
  exit "$exit_code"
}}
trap rollback_release EXIT
sudo install -d -m 755 {shlex.quote(release_path)}
sudo tar -xzf {shlex.quote(remote_archive)} -C {shlex.quote(release_path)}
sudo cp /opt/startrips/current/.env.deploy {shlex.quote(release_path)}/.env.deploy
sudo chown -R root:root {shlex.quote(release_path)}
sudo chmod 600 {shlex.quote(release_path)}/.env.deploy
sudo install -d -m 700 /opt/startrips/backups
sudo bash -o pipefail -c 'docker exec startrips-postgres-1 pg_dump -U startrips -d startrips | gzip > {backup_path}'
sudo test -s {shlex.quote(backup_path)}
sudo gzip -t {shlex.quote(backup_path)}
sudo docker image tag "$old_api" {shlex.quote(rollback_api)}
sudo docker image tag "$old_web" {shlex.quote(rollback_web)}
cd {shlex.quote(release_path)}
sudo docker compose --env-file .env.deploy -f deploy/compose.yaml build api migrate web
echo "6/7 Applying migrations and activating API/Web..."
sudo docker compose --env-file .env.deploy -f deploy/compose.yaml up --no-deps --force-recreate --abort-on-container-exit --exit-code-from migrate migrate
rollback_needed=1
sudo docker compose --env-file .env.deploy -f deploy/compose.yaml up -d --no-deps --force-recreate api
for attempt in $(seq 1 24); do
  health=$(sudo docker inspect startrips-api-1 --format '{{{{.State.Health.Status}}}}')
  if [ "$health" = healthy ]; then break; fi
  if [ "$health" = unhealthy ] || [ "$health" = exited ] || [ "$attempt" = 24 ]; then
    sudo docker logs --tail 200 startrips-api-1
    exit 1
  fi
  sleep 5
done
sudo docker compose --env-file .env.deploy -f deploy/compose.yaml up -d --no-deps --force-recreate web
sudo ln -sfn {shlex.quote(release_path)} /opt/startrips/current
echo "7/7 Verifying containers, migrations, logs, and server-local HTTPS..."
test "$(readlink -f /opt/startrips/current)" = {shlex.quote(release_path)}
sudo docker inspect startrips-api-1 --format 'API ID={{{{.Id}}}} IMAGE={{{{.Image}}}} STARTED={{{{.State.StartedAt}}}} STATUS={{{{.State.Status}}}} HEALTH={{{{.State.Health.Status}}}} RESTARTS={{{{.RestartCount}}}}'
sudo docker inspect startrips-web-1 --format 'WEB ID={{{{.Id}}}} IMAGE={{{{.Image}}}} STARTED={{{{.State.StartedAt}}}} STATUS={{{{.State.Status}}}} RESTARTS={{{{.RestartCount}}}}'
test "$(sudo docker inspect startrips-api-1 --format '{{{{.State.Health.Status}}}}')" = healthy
test "$(sudo docker inspect startrips-api-1 --format '{{{{.RestartCount}}}}')" = 0
test "$(sudo docker inspect startrips-web-1 --format '{{{{.State.Status}}}}')" = running
test "$(sudo docker inspect startrips-web-1 --format '{{{{.RestartCount}}}}')" = 0
test "$(sudo docker inspect startrips-migrate-1 --format '{{{{.State.ExitCode}}}}')" = 0
curl -fsS --max-time 30 --resolve {arguments.server}:443:127.0.0.1 https://{arguments.server}/ >/dev/null
health_body=$(curl -fsS --max-time 30 --resolve {arguments.server}:443:127.0.0.1 https://{arguments.server}/api/health)
test "$health_body" = '{{"status":"ok"}}'
sudo docker logs --since 10m --tail 120 startrips-api-1
sudo docker logs --since 10m --tail 80 startrips-web-1
rollback_needed=0
trap - EXIT

set +e
current_release=$(readlink -f /opt/startrips/current)
sudo find /opt/startrips/releases -mindepth 1 -maxdepth 1 -type d -name 'main-??????????????-???????' -printf '%T@ %p\n' \
  | sort -nr | awk 'NR > 5 {{print $2}}' \
  | while read -r stale_release; do
      if [ "$stale_release" != "$current_release" ]; then sudo rm -rf -- "$stale_release"; fi
    done
sudo find /opt/startrips/backups -mindepth 1 -maxdepth 1 -type f -name 'pre-main-??????????????-???????.sql.gz' -printf '%T@ %p\n' \
  | sort -nr | awk 'NR > 5 {{print $2}}' | xargs -r sudo rm -f --
sudo docker images --format '{{{{.Repository}}}}:{{{{.Tag}}}}' \
  | grep -E '^startrips-api:rollback-pre-main-[0-9]{{14}}-[0-9a-f]{{7}}$' \
  | sort -r | tail -n +6 | xargs -r sudo docker image rm
sudo docker images --format '{{{{.Repository}}}}:{{{{.Tag}}}}' \
  | grep -E '^startrips-web:rollback-pre-main-[0-9]{{14}}-[0-9a-f]{{7}}$' \
  | sort -r | tail -n +6 | xargs -r sudo docker image rm
true
"""
            remote_command(
                client,
                deploy,
                timeout_seconds=arguments.remote_timeout_seconds,
            )
            print("Public-path verification...")
            public_check(arguments.server)
        finally:
            try:
                sftp = client.open_sftp()
                try:
                    sftp.get_channel().settimeout(30)
                    sftp.remove(remote_archive)
                finally:
                    sftp.close()
            except (OSError, paramiko.SSHException):
                pass
            client.close()

    print(f"Deployed commit {commit} to {release_path}")
    print(f"Database backup: {backup_path}")
    print(f"Rollback images: {rollback_api}, {rollback_web}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (
        OSError,
        RuntimeError,
        TimeoutError,
        ValueError,
        paramiko.SSHException,
        subprocess.CalledProcessError,
        subprocess.TimeoutExpired,
    ) as error:
        print(f"DEPLOY FAILED: {error}", file=sys.stderr)
        raise SystemExit(1) from error

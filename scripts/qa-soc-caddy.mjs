import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

if (!process.env.CI) throw new Error('Run this check in GitHub CI');
const directory = path.resolve('artifacts/soc-caddy');
await fs.mkdir(directory, { recursive: true });
const source = await fs.readFile('deploy/Caddyfile', 'utf8');
const start = source.indexOf('\tlog {');
const end = source.lastIndexOf('\n}');
assert.ok(start >= 0 && end > start, 'The production logging policy must be present');
const globalHeaders = source.match(/\n\theader \{[\s\S]*?\n\t\}/)?.[0];
const restrictedHeaders = source.match(/\n\t@restrictMedia[^\n]*\n\theader @restrictMedia[^\n]*/)?.[0];
const socHeaders = source.match(/\n\t\theader Permissions-Policy[^\n]*/)?.[0];
assert.ok(globalHeaders && restrictedHeaders && socHeaders, 'Production media permission policies must be present');
const token = 'ci-soc-session-sentinel';
const secrets = [token, 'ci-reset-sentinel', 'ci-query-sentinel', 'ci-referer-sentinel', 'ci-cookie-sentinel', 'ci-bearer-sentinel'];
const fixture = path.join(directory, 'Caddyfile');
await fs.writeFile(fixture, `:8080 {\n header Set-Auth-Token "${token}"\n${globalHeaders}\n${restrictedHeaders}\n handle /soc/* {\n${socHeaders}\n respond "soc"\n }\n handle {\n respond "ok"\n }\n${source.slice(start, end)}\n}\n`, 'utf8');
const container = `soc-log-qa-${process.pid}`;
const docker = (args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const logs = () => {
  const result = spawnSync('docker', ['logs', container], { encoding: 'utf8' });
  return `${result.stdout || ''}${result.stderr || ''}`;
};
let started = false;
try {
  docker(['run', '-d', '--name', container, '-p', '127.0.0.1::8080', '-v', `${fixture}:/etc/caddy/Caddyfile:ro`, 'caddy:2.11.4-alpine']);
  started = true;
  const address = docker(['port', container, '8080/tcp']).split('\n')[0];
  let response;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      response = await fetch(`http://${address}/api/auth/reset-password/ci-reset-sentinel?token=ci-query-sentinel`, {
        headers: { Referer: `http://${address}/reset-password?token=ci-referer-sentinel`, Cookie: 'session=ci-cookie-sentinel', Authorization: 'Bearer ci-bearer-sentinel' },
        signal: AbortSignal.timeout(2000),
      });
      break;
    } catch { await delay(100); }
  }
  assert.ok(response, 'Caddy must serve the fixture');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('set-auth-token'), token, 'Logging must not remove the app credential from its response');
  assert.equal(response.headers.get('permissions-policy'), 'camera=(), microphone=(), geolocation=()');
  await response.text();
  const socResponse = await fetch(`http://${address}/soc/`, { signal: AbortSignal.timeout(2000) });
  assert.equal(socResponse.status, 200);
  assert.equal(socResponse.headers.get('permissions-policy'), 'camera=(), microphone=(self), geolocation=()', 'The global headers must preserve Soc microphone access');
  await socResponse.text();
  let entries = [];
  for (let attempt = 0; attempt < 20 && entries.length === 0; attempt++) {
    await delay(100);
    entries = logs().split('\n').flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } })
      .filter((entry) => entry.logger?.startsWith('http.log.access'));
  }
  assert.ok(entries.length > 0, 'An actual access log must be observed');
  const logged = JSON.stringify(entries);
  for (const secret of secrets) assert.equal(logged.includes(secret), false, 'Access logs must exclude credentials');
  await fs.writeFile(path.join(directory, 'result.json'), JSON.stringify({ responseTokenPreserved: true, microphoneScopedToSoc: true, accessLogCredentialsAbsent: true, accessLogEntries: entries.length }), 'utf8');
} finally {
  if (started) {
    await fs.writeFile(path.join(directory, 'caddy.log'), logs(), 'utf8');
    docker(['rm', '-f', container]);
  }
}

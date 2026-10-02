import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Only the shell glue is executed, against disposable command doubles. This
// never installs packages; real installation/render validation stays in CI.
const script = fileURLToPath(new URL("./ci-ensure-ffmpeg.sh", import.meta.url));
const supported = process.platform === "linux"
  && /VERSION_CODENAME=noble/.test(fs.readFileSync("/etc/os-release", "utf8"));

function fixture(t, { installed = false, missingProbe = false, fail = "", root = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "startrips-ffmpeg-shell-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  for (const command of ["cat", "chmod", "mktemp", "rm", "sed", "uname", "timeout", "env"]) {
    fs.symlinkSync(`/usr/bin/${command}`, path.join(bin, command));
  }
  const executable = (name, source) => fs.writeFileSync(path.join(bin, name),
    `#!${process.execPath}\n${source}\n`, { mode: 0o755 });
  executable("id", `console.log(${root ? "0" : "1001"});`);
  executable("sudo", `const {spawnSync}=require('node:child_process'); const a=process.argv.slice(2); if(a.shift()!=='-n')process.exit(91); const r=spawnSync(a.shift(),a,{stdio:'inherit',env:process.env}); process.exit(r.status??92);`);
  executable("apt-get", `
const fs=require('node:fs'), path=require('node:path');
const args=process.argv.slice(2);
const stage=args.includes('update')?'update':'install';
const source=args.find(x=>x.startsWith('Dir::Etc::sourcelist='))?.split('=').slice(1).join('=');
if(!source || !args.includes('Dir::Etc::sourceparts=-'))process.exit(93);
const text=fs.readFileSync(source,'utf8');
fs.appendFileSync(process.env.FIXTURE_LOG,JSON.stringify({stage,args,source,text})+'\\n');
if(process.env.FIXTURE_FAIL===stage)process.exit(23);
if(stage==='install')for(const name of ['ffmpeg','ffprobe'])fs.writeFileSync(path.join(process.env.FIXTURE_BIN,name),'#!'+process.execPath+'\\nconsole.log('+JSON.stringify(name+' version fixture')+');\\n',{mode:0o755});
`);
  if (installed || missingProbe) executable("ffmpeg", 'console.log("ffmpeg version fixture");');
  if (installed) executable("ffprobe", 'console.log("ffprobe version fixture");');
  const log = path.join(dir, "calls.jsonl");
  const result = spawnSync("/bin/bash", [script], {
    encoding: "utf8", timeout: 15_000,
    env: { ...process.env, PATH: bin, FIXTURE_BIN: bin, FIXTURE_LOG: log, FIXTURE_FAIL: fail },
  });
  const calls = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse) : [];
  return { ...result, calls };
}

test("existing FFmpeg and ffprobe need no network or package-manager call", { skip: !supported }, (t) => {
  const result = fixture(t, { installed: true });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, []);
});

test("missing tools use official HTTPS sources for both bounded APT stages", { skip: !supported }, (t) => {
  const result = fixture(t);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls.map(x => x.stage), ["update", "install"]);
  for (const call of result.calls) {
    assert.match(call.text, /https:\/\/archive\.ubuntu\.com\/ubuntu/);
    assert.match(call.text, /https:\/\/security\.ubuntu\.com\/ubuntu/);
    assert.match(call.text, /signed-by=\/usr\/share\/keyrings\/ubuntu-archive-keyring\.gpg/);
    assert.ok(call.args.includes("APT::Update::Error-Mode=any"));
    assert.equal(fs.existsSync(call.source), false, "disposable source must be cleaned up");
  }
  assert.match(result.stdout, /ffmpeg version fixture/);
  assert.match(result.stdout, /ffprobe version fixture/);
});

test("a missing ffprobe still triggers complete setup for root runners", { skip: !supported }, (t) => {
  const result = fixture(t, { missingProbe: true, root: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.calls.length, 2);
});

for (const stage of ["update", "install"]) test(`APT ${stage} failure fails closed without retry`, { skip: !supported }, (t) => {
  const result = fixture(t, { fail: stage });
  assert.equal(result.status, 23, result.stderr);
  assert.deepEqual(result.calls.map(x => x.stage), stage === "update" ? ["update"] : ["update", "install"]);
  assert.match(result.stderr, /FFmpeg infrastructure setup failed/);
  for (const call of result.calls) assert.equal(fs.existsSync(call.source), false);
});

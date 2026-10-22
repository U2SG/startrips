import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Only the shell glue is executed, against disposable command doubles. This
// never downloads or installs anything; real installation/render validation
// stays in CI.
const script = fileURLToPath(new URL("./ci-ensure-ffmpeg.sh", import.meta.url));
const workflows = fileURLToPath(new URL("../.github/workflows/", import.meta.url));
const source = fs.readFileSync(script, "utf8");
const pinned = (name) => new RegExp(`^${name}=(\\S+)\\r?$`, "m").exec(source)?.[1];
const RELEASE = pinned("FFMPEG_RELEASE");
const ASSET = pinned("FFMPEG_ASSET");
const SHA256 = pinned("FFMPEG_SHA256");
const supported = process.platform === "linux"
  && /VERSION_CODENAME=noble/.test(fs.readFileSync("/etc/os-release", "utf8"));

function fixture(t, { installed = false, missingProbe = false, fail = "", root = false, static: mode = "ok", cached = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "startrips-ffmpeg-shell-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, "bin");
  const runnerTemp = path.join(dir, "runner-temp");
  const cacheDir = path.join(dir, ".cache", "startrips-ffmpeg");
  const githubPath = path.join(dir, "github-path");
  fs.mkdirSync(bin);
  fs.mkdirSync(runnerTemp);
  fs.writeFileSync(githubPath, "");
  for (const command of ["cat", "chmod", "mktemp", "rm", "sed", "uname", "timeout", "env", "mkdir", "mv", "xz"]) {
    fs.symlinkSync(`/usr/bin/${command}`, path.join(bin, command));
  }
  const executable = (name, body) => fs.writeFileSync(path.join(bin, name),
    `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
  const log = `const fs=require('node:fs'); const record=(x)=>fs.appendFileSync(process.env.FIXTURE_LOG,JSON.stringify(x)+'\\n');`;
  executable("id", `console.log(${root ? "0" : "1001"});`);
  executable("sudo", `const {spawnSync}=require('node:child_process'); const a=process.argv.slice(2); if(a.shift()!=='-n')process.exit(91); const r=spawnSync(a.shift(),a,{stdio:'inherit',env:process.env}); process.exit(r.status??92);`);
  executable("curl", `${log}
const args=process.argv.slice(2);
record({stage:'download',args});
if(process.env.FIXTURE_STATIC==='download-fail')process.exit(22);
fs.copyFileSync(process.env.FIXTURE_ARCHIVE,args[args.indexOf('--output')+1]);`);
  executable("sha256sum", `${log}
const [hash,file]=fs.readFileSync(0,'utf8').trim().split(/\\s+/);
record({stage:'verify',args:process.argv.slice(2),hash,file});
process.exit(fs.existsSync(file) && process.env.FIXTURE_STATIC!=='verify-fail' ? 0 : 1);`);
  executable("tar", `${log}
const args=process.argv.slice(2);
record({stage:'extract',args});
process.exit(require('node:child_process').spawnSync('/usr/bin/tar',args,{stdio:'inherit'}).status??94);`);
  executable("apt-get", `${log}
const path=require('node:path');
const args=process.argv.slice(2);
const stage=args.includes('update')?'update':'install';
const source=args.find(x=>x.startsWith('Dir::Etc::sourcelist='))?.split('=').slice(1).join('=');
if(!source || !args.includes('Dir::Etc::sourceparts=-'))process.exit(93);
const text=fs.readFileSync(source,'utf8');
record({stage,args,source,text});
if(process.env.FIXTURE_FAIL===stage)process.exit(23);
if(stage==='install')for(const name of ['ffmpeg','ffprobe'])fs.writeFileSync(path.join(process.env.FIXTURE_BIN,name),'#!'+process.execPath+'\\nconsole.log('+JSON.stringify(name+' version fixture')+');\\n',{mode:0o755});
`);
  if (installed || missingProbe) executable("ffmpeg", 'console.log("ffmpeg version fixture");');
  if (installed) executable("ffprobe", 'console.log("ffprobe version fixture");');

  // A real tar.xz shaped like the pinned release asset (top dir + bin/).
  const archive = path.join(dir, "asset.tar.xz");
  const assetBin = path.join(dir, "asset", ASSET, "bin");
  fs.mkdirSync(assetBin, { recursive: true });
  for (const name of mode === "partial" ? ["ffmpeg"] : ["ffmpeg", "ffprobe"]) {
    fs.writeFileSync(path.join(assetBin, name),
      `#!${process.execPath}\nconsole.log(${JSON.stringify(`${name} version static fixture`)});\n`, { mode: 0o755 });
  }
  assert.equal(spawnSync("/usr/bin/tar", ["-cJf", archive, "-C", path.join(dir, "asset"), ASSET]).status, 0);
  if (cached) {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.copyFileSync(archive, path.join(cacheDir, `${ASSET}.tar.xz`));
  }

  const callLog = path.join(dir, "calls.jsonl");
  const result = spawnSync("/bin/bash", [script], {
    encoding: "utf8", timeout: 15_000,
    env: {
      ...process.env, PATH: bin, HOME: dir, RUNNER_TEMP: runnerTemp, GITHUB_PATH: githubPath,
      FIXTURE_BIN: bin, FIXTURE_LOG: callLog, FIXTURE_FAIL: fail, FIXTURE_STATIC: mode, FIXTURE_ARCHIVE: archive,
    },
  });
  const calls = fs.existsSync(callLog) ? fs.readFileSync(callLog, "utf8").trim().split("\n").map(JSON.parse) : [];
  const githubPaths = fs.readFileSync(githubPath, "utf8").split("\n").filter(Boolean);
  return { ...result, calls, cacheDir, runnerTemp, githubPaths, leftovers: fs.readdirSync(runnerTemp) };
}

const apt = (calls) => calls.filter(x => x.stage === "update" || x.stage === "install");

test("the static build is pinned to an immutable release, SHA-256 and bounded download", () => {
  assert.match(RELEASE, /^autobuild-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}$/, "pin a dated release, never latest");
  assert.match(ASSET, /-linux64-gpl-/);
  assert.match(SHA256, /^[0-9a-f]{64}$/);
  assert.ok(source.includes('FFMPEG_URL="https://github.com/BtbN/FFmpeg-Builds/releases/download/$FFMPEG_RELEASE/$FFMPEG_ASSET.tar.xz"'));
  assert.ok(source.includes('FFMPEG_CACHE_DIR="$HOME/.cache/startrips-ffmpeg"'));
  assert.match(source, /curl --fail [^\n]*--connect-timeout 15 --max-time 60/);
  assert.ok(source.indexOf('verify_archive "$partial"') < source.indexOf("tar -xJf"), "verify before extraction");
  assert.match(source, /::error::FFmpeg infrastructure setup failed \(not a render assertion\)/);
});

test("every workflow step running the script restores the pinned archive cache first", () => {
  let runs = 0;
  for (const file of fs.readdirSync(workflows).filter(x => x.endsWith(".yml"))) {
    const lines = fs.readFileSync(path.join(workflows, file), "utf8").split(/\r?\n/);
    lines.forEach((line, index) => {
      if (!/run: bash scripts\/ci-ensure-ffmpeg\.sh\s*$/.test(line)) return;
      runs += 1;
      let at = index - 1;
      while (at >= 0 && !/^\s+steps:\s*$/.test(lines[at]) && !/uses: actions\/cache@v\d+/.test(lines[at])) at -= 1;
      assert.ok(at >= 0 && /uses: actions\/cache@v\d+/.test(lines[at]), `${file}:${index + 1} lacks a preceding cache step`);
      const step = lines.slice(at, at + 4).join("\n");
      assert.match(step, /path: ~\/\.cache\/startrips-ffmpeg\s*$/m, `${file}:${index + 1}`);
      const key = /key: (\S+)/.exec(step)?.[1] ?? "";
      assert.ok(key.includes(ASSET) && key.includes(SHA256), `${file}:${index + 1} cache key must pin asset + sha`);
    });
  }
  assert.ok(runs >= 2, "expected the CI and story-autoplay workflows to run the script");
});

test("existing FFmpeg and ffprobe need no network or package-manager call", { skip: !supported }, (t) => {
  const result = fixture(t, { installed: true });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, []);
});

test("a cache miss downloads the pinned asset, verifies it, then extracts onto PATH", { skip: !supported }, (t) => {
  const result = fixture(t);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls.map(x => x.stage), ["download", "verify", "extract"]);
  const [download, verify] = result.calls;
  assert.equal(download.args.at(-1), `https://github.com/BtbN/FFmpeg-Builds/releases/download/${RELEASE}/${ASSET}.tar.xz`);
  assert.ok(download.args.includes("--fail") && download.args.includes("--max-time"));
  assert.equal(verify.hash, SHA256);
  assert.ok(verify.args.includes("--check"));
  assert.ok(fs.existsSync(path.join(result.cacheDir, `${ASSET}.tar.xz`)), "verified archive is stored for actions/cache");
  assert.equal(result.githubPaths.length, 1);
  assert.ok(fs.existsSync(path.join(result.githubPaths[0], "ffprobe")));
  assert.match(result.stdout, /ffmpeg version static fixture/);
  assert.match(result.stdout, /ffprobe version static fixture/);
});

test("a cache hit re-verifies the archive and makes no download", { skip: !supported }, (t) => {
  const result = fixture(t, { cached: true });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls.map(x => x.stage), ["verify", "extract"]);
  assert.equal(result.githubPaths.length, 1);
});

for (const mode of ["download-fail", "verify-fail", "partial"]) test(`static ${mode} leaves nothing behind and falls back to bounded APT`, { skip: !supported }, (t) => {
  const result = fixture(t, { static: mode });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!result.calls.some(x => x.stage === "extract") || mode === "partial", "never extract an unverified archive");
  assert.deepEqual(apt(result.calls).map(x => x.stage), ["update", "install"]);
  assert.deepEqual(result.githubPaths, [], "no static directory may reach PATH");
  assert.deepEqual(result.leftovers, [], "partial downloads and extractions are removed");
  if (mode !== "partial") assert.equal(fs.existsSync(path.join(result.cacheDir, `${ASSET}.tar.xz`)), false);
  assert.match(result.stderr, /::warning::Pinned static FFmpeg unavailable/);
  assert.match(result.stdout, /ffprobe version fixture/);
});

test("the APT fallback uses official HTTPS sources for both bounded stages", { skip: !supported }, (t) => {
  const result = fixture(t, { static: "download-fail" });
  assert.equal(result.status, 0, result.stderr);
  for (const call of apt(result.calls)) {
    assert.match(call.text, /https:\/\/archive\.ubuntu\.com\/ubuntu/);
    assert.match(call.text, /https:\/\/security\.ubuntu\.com\/ubuntu/);
    assert.match(call.text, /signed-by=\/usr\/share\/keyrings\/ubuntu-archive-keyring\.gpg/);
    assert.ok(call.args.includes("APT::Update::Error-Mode=any"));
    assert.equal(fs.existsSync(call.source), false, "disposable source must be cleaned up");
  }
});

test("a missing ffprobe still triggers complete setup for root runners", { skip: !supported }, (t) => {
  const result = fixture(t, { missingProbe: true, root: true, static: "download-fail" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(apt(result.calls).length, 2);
});

for (const stage of ["update", "install"]) test(`APT ${stage} failure fails closed without retry`, { skip: !supported }, (t) => {
  const result = fixture(t, { fail: stage, static: "download-fail" });
  assert.equal(result.status, 23, result.stderr);
  assert.deepEqual(result.calls.filter(x => x.stage === "download").length, 1);
  assert.deepEqual(apt(result.calls).map(x => x.stage), stage === "update" ? ["update"] : ["update", "install"]);
  assert.match(result.stderr, /FFmpeg infrastructure setup failed/);
  for (const call of apt(result.calls)) assert.equal(fs.existsSync(call.source), false);
});

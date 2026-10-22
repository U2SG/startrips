import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Only the shell glue is executed, against disposable command doubles. This
// never downloads or installs anything; real font installation stays in CI.
const script = fileURLToPath(new URL("./ci-ensure-cjk-font.sh", import.meta.url));
const workflows = fileURLToPath(new URL("../.github/workflows/", import.meta.url));
const source = fs.readFileSync(script, "utf8");
const pinned = (name) => new RegExp(`^${name}=(\\S+)\\r?$`, "m").exec(source)?.[1];
const RELEASE = pinned("CJK_FONT_RELEASE");
const ASSET = pinned("CJK_FONT_ASSET");
const SHA256 = pinned("CJK_FONT_SHA256");
const supported = process.platform === "linux"
  && /VERSION_CODENAME=noble/.test(fs.readFileSync("/etc/os-release", "utf8"));
const FONTS = ["NotoSansSC-Regular.otf", "NotoSansSC-Medium.otf", "NotoSansSC-Bold.otf", "LICENSE"];

function fixture(t, { installed = false, fail = "", root = false, pinned: mode = "ok", cached = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "startrips-cjk-font-shell-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, "bin");
  const runnerTemp = path.join(dir, "runner-temp");
  const cacheDir = path.join(dir, ".cache", "startrips-cjk-font");
  const fontsRoot = path.join(dir, ".local", "share", "fonts");
  const fontDir = path.join(fontsRoot, "startrips-noto-sc");
  const marker = path.join(dir, "apt-installed");
  fs.mkdirSync(bin);
  fs.mkdirSync(runnerTemp);
  for (const command of ["cat", "chmod", "mktemp", "rm", "sed", "timeout", "env", "mkdir", "mv", "dirname"]) {
    fs.symlinkSync(`/usr/bin/${command}`, path.join(bin, command));
  }
  const executable = (name, body) => fs.writeFileSync(path.join(bin, name),
    `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
  const log = `const fs=require('node:fs'); const path=require('node:path'); const record=(x)=>fs.appendFileSync(process.env.FIXTURE_LOG,JSON.stringify(x)+'\\n');`;
  executable("id", `console.log(${root ? "0" : "1001"});`);
  executable("sudo", `const {spawnSync}=require('node:child_process'); const a=process.argv.slice(2); if(a.shift()!=='-n')process.exit(91); const r=spawnSync(a.shift(),a,{stdio:'inherit',env:process.env}); process.exit(r.status??92);`);
  executable("curl", `${log}
const args=process.argv.slice(2);
record({stage:'download',args});
if(process.env.FIXTURE_PINNED==='download-fail')process.exit(22);
fs.copyFileSync(process.env.FIXTURE_ARCHIVE,args[args.indexOf('--output')+1]);`);
  executable("sha256sum", `${log}
const [hash,file]=fs.readFileSync(0,'utf8').trim().split(/\\s+/);
record({stage:'verify',args:process.argv.slice(2),hash,file});
process.exit(fs.existsSync(file) && process.env.FIXTURE_PINNED!=='verify-fail' ? 0 : 1);`);
  executable("unzip", `${log}
const args=process.argv.slice(2);
record({stage:'extract',args});
// unzip double: the archive is a JSON member map; extract the named members
// into -d, failing like unzip (11) when a named member is missing.
const members=JSON.parse(fs.readFileSync(args.find(x=>x.endsWith('.zip')),'utf8'));
const dest=args[args.indexOf('-d')+1];
const wanted=args.filter(x=>!x.startsWith('-') && !x.endsWith('.zip') && x!==dest);
for(const name of wanted){ if(!(name in members))process.exit(11); fs.writeFileSync(path.join(dest,name),members[name]); }`);
  executable("fc-cache", `${log} record({stage:'fc-cache',args:process.argv.slice(2)});`);
  // fontconfig double: a zh font exists if preinstalled, APT ran, or the
  // pinned Regular OTF is in the final directory.
  executable("fc-list", `${log}
const ok=process.env.FIXTURE_INSTALLED==='1' || fs.existsSync(process.env.FIXTURE_MARKER)
  || (process.env.FIXTURE_PINNED!=='unreadable' && fs.existsSync(path.join(process.env.FIXTURE_FONT_DIR,'NotoSansSC-Regular.otf')));
if(ok)console.log('Noto Sans SC');`);
  executable("apt-get", `${log}
const args=process.argv.slice(2);
const stage=args.includes('update')?'update':'install';
const source=args.find(x=>x.startsWith('Dir::Etc::sourcelist='))?.split('=').slice(1).join('=');
if(!source || !args.includes('Dir::Etc::sourceparts=-'))process.exit(93);
const text=fs.readFileSync(source,'utf8');
record({stage,args,source,text});
if(process.env.FIXTURE_FAIL===stage)process.exit(23);
if(stage==='install')fs.writeFileSync(process.env.FIXTURE_MARKER,'');
`);

  // Stand-in for the pinned release asset (flat OTFs + LICENSE).
  const archive = path.join(dir, "asset.zip");
  const members = Object.fromEntries([...FONTS, "NotoSansSC-Thin.otf"]
    .filter(name => !(mode === "partial" && name === "NotoSansSC-Bold.otf")).map(name => [name, name]));
  fs.writeFileSync(archive, JSON.stringify(members));
  if (cached) {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.copyFileSync(archive, path.join(cacheDir, `${ASSET}.zip`));
  }

  const callLog = path.join(dir, "calls.jsonl");
  const result = spawnSync("/bin/bash", [script], {
    encoding: "utf8", timeout: 15_000,
    env: {
      ...process.env, PATH: bin, HOME: dir, RUNNER_TEMP: runnerTemp,
      FIXTURE_LOG: callLog, FIXTURE_FAIL: fail, FIXTURE_PINNED: mode, FIXTURE_ARCHIVE: archive,
      FIXTURE_INSTALLED: installed ? "1" : "0", FIXTURE_MARKER: marker, FIXTURE_FONT_DIR: fontDir,
    },
  });
  const calls = fs.existsSync(callLog) ? fs.readFileSync(callLog, "utf8").trim().split("\n").map(JSON.parse) : [];
  const stages = calls.filter(x => x.stage !== "fc-list");
  const fonts = fs.existsSync(fontsRoot) ? fs.readdirSync(fontsRoot) : [];
  return { ...result, calls: stages, cacheDir, fontDir, fonts, leftovers: fs.readdirSync(runnerTemp) };
}

const apt = (calls) => calls.filter(x => x.stage === "update" || x.stage === "install");

test("the font asset is pinned to an immutable GitHub release, SHA-256 and bounded download", () => {
  assert.equal(RELEASE, "Sans2.004", "pin a tagged release, never latest");
  assert.equal(ASSET, "18_NotoSansSC");
  assert.match(SHA256, /^[0-9a-f]{64}$/);
  assert.ok(source.includes('CJK_FONT_URL="https://github.com/notofonts/noto-cjk/releases/download/$CJK_FONT_RELEASE/$CJK_FONT_ASSET.zip"'));
  assert.ok(source.includes('CJK_FONT_CACHE_DIR="$HOME/.cache/startrips-cjk-font"'));
  assert.ok(source.includes('CJK_FONT_DIR="$HOME/.local/share/fonts/startrips-noto-sc"'));
  assert.match(source, /curl --fail [^\n]*--connect-timeout 15 --max-time 90/);
  assert.ok(source.indexOf('verify_archive "$partial"') < source.indexOf("unzip "), "verify before extraction");
  assert.ok(source.indexOf('verify_archive "$archive"') < source.indexOf("unzip "), "re-verify cache hits before extraction");
  assert.match(source, /fc-list :lang=zh/);
  assert.match(source, /::error::CJK font infrastructure setup failed \(not a render assertion\)/);
});

test("the APT fallback stays bounded on signed official sources without global rewrites", () => {
  assert.match(source, /timeout --kill-after=5s 60s [^\n]* update/);
  assert.match(source, /timeout --kill-after=5s 120s [^\n]* install --no-install-recommends -y fonts-noto-cjk/);
  assert.match(source, /Acquire::http::Timeout=20/);
  assert.match(source, /https:\/\/archive\.ubuntu\.com\/ubuntu noble main universe/);
  assert.match(source, /https:\/\/security\.ubuntu\.com\/ubuntu noble-security main universe/);
  assert.match(source, /signed-by=\/usr\/share\/keyrings\/ubuntu-archive-keyring\.gpg/);
  assert.match(source, /Dir::Etc::sourcelist=\$apt_sources/);
  assert.match(source, /Dir::Etc::sourceparts=-/);
  assert.match(source, /APT::Update::Error-Mode=any/);
  assert.doesNotMatch(source, /trusted=yes|--allow-unauthenticated|AllowInsecureRepositories/);
});

test("every workflow step running the script restores the pinned archive cache first, bounded", () => {
  let runs = 0;
  for (const file of fs.readdirSync(workflows).filter(x => x.endsWith(".yml"))) {
    const text = fs.readFileSync(path.join(workflows, file), "utf8");
    assert.doesNotMatch(text, /apt-get install[^\n]*fonts-noto-cjk/, `${file} must use scripts/ci-ensure-cjk-font.sh`);
    const lines = text.split(/\r?\n/);
    lines.forEach((line, index) => {
      if (!/run: bash scripts\/ci-ensure-cjk-font\.sh\s*$/.test(line)) return;
      runs += 1;
      assert.match(lines[index - 1], /^\s+timeout-minutes: 5\s*$/, `${file}:${index + 1} needs its own step timeout`);
      let at = index - 1;
      while (at >= 0 && !/^\s+steps:\s*$/.test(lines[at]) && !/uses: actions\/cache@v\d+/.test(lines[at])) at -= 1;
      assert.ok(at >= 0 && /uses: actions\/cache@v\d+/.test(lines[at]), `${file}:${index + 1} lacks a preceding cache step`);
      const step = lines.slice(at, at + 4).join("\n");
      assert.match(step, /path: ~\/\.cache\/startrips-cjk-font\s*$/m, `${file}:${index + 1}`);
      const key = /key: (\S+)/.exec(step)?.[1] ?? "";
      assert.ok(key.includes(ASSET) && key.includes(SHA256), `${file}:${index + 1} cache key must pin asset + sha`);
    });
  }
  assert.ok(runs >= 1, "expected the keepsake-render job to run the script");
});

test("an existing CJK font needs no network or package-manager call", { skip: !supported }, (t) => {
  const result = fixture(t, { installed: true });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, []);
});

test("a cache miss downloads the pinned asset, verifies it, then installs only the needed fonts", { skip: !supported }, (t) => {
  const result = fixture(t);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls.map(x => x.stage), ["download", "verify", "extract", "fc-cache"]);
  const [download, verify] = result.calls;
  assert.equal(download.args.at(-1), `https://github.com/notofonts/noto-cjk/releases/download/${RELEASE}/${ASSET}.zip`);
  assert.equal(verify.hash, SHA256);
  assert.ok(verify.args.includes("--check"));
  assert.ok(fs.existsSync(path.join(result.cacheDir, `${ASSET}.zip`)), "verified archive is stored for actions/cache");
  assert.deepEqual(fs.readdirSync(result.fontDir).sort(), [...FONTS].sort());
  assert.deepEqual(result.fonts, ["startrips-noto-sc"], "no staging directory is left beside the fonts");
  assert.match(result.stdout, /Noto Sans SC/);
});

test("a cache hit re-verifies the archive and makes no download", { skip: !supported }, (t) => {
  const result = fixture(t, { cached: true });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls.map(x => x.stage), ["verify", "extract", "fc-cache"]);
});

for (const mode of ["download-fail", "verify-fail", "partial", "unreadable"]) test(`pinned ${mode} leaves no font behind and falls back to bounded APT`, { skip: !supported }, (t) => {
  const result = fixture(t, { pinned: mode });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!result.calls.some(x => x.stage === "extract") || ["partial", "unreadable"].includes(mode), "never extract an unverified archive");
  assert.deepEqual(apt(result.calls).map(x => x.stage), ["update", "install"]);
  assert.deepEqual(result.fonts, [], "no half-extracted font directory may remain");
  assert.deepEqual(result.leftovers, [], "partial downloads are removed");
  if (!["partial", "unreadable"].includes(mode)) assert.equal(fs.existsSync(path.join(result.cacheDir, `${ASSET}.zip`)), false);
  assert.match(result.stderr, /::warning::Pinned Noto Sans SC unavailable/);
});

test("the APT fallback uses official HTTPS sources and cleans up its source list", { skip: !supported }, (t) => {
  const result = fixture(t, { pinned: "download-fail", root: true });
  assert.equal(result.status, 0, result.stderr);
  for (const call of apt(result.calls)) {
    assert.match(call.text, /https:\/\/archive\.ubuntu\.com\/ubuntu/);
    assert.ok(call.args.includes("APT::Update::Error-Mode=any"));
    assert.equal(fs.existsSync(call.source), false, "disposable source must be cleaned up");
  }
});

for (const stage of ["update", "install"]) test(`APT ${stage} failure fails closed without retry`, { skip: !supported }, (t) => {
  const result = fixture(t, { fail: stage, pinned: "download-fail" });
  assert.equal(result.status, 23, result.stderr);
  assert.equal(result.calls.filter(x => x.stage === "download").length, 1);
  assert.deepEqual(apt(result.calls).map(x => x.stage), stage === "update" ? ["update"] : ["update", "install"]);
  assert.match(result.stderr, /CJK font infrastructure setup failed/);
});

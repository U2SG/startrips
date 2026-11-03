import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

export const WEB_SHARDS = ["auth-media", "story-media", "labels-recovery", "reveal-share", "shell-composer", "globe-context", "route-home-share", "route-candidates"];
export function browserMatrix(scope, root = process.cwd()) {
  const matrix = JSON.parse(fs.readFileSync(`${root}/.github/browser-matrix.json`, "utf8"));
  if (matrix.include.length !== WEB_SHARDS.length || WEB_SHARDS.some((name) => matrix.include.filter((row) => row.name === name).length !== 1)) {
    throw new Error("Incomplete browser matrix");
  }
  return { include: matrix.include.filter((row) => scope.shards.includes(row.name)) };
}
const documentation = (file) => /^(docs\/.*\.md|README(?:\.zh-CN)?\.md|CONTEXT\.md|CONTRIBUTING\.md)$/.test(file)
  || /^mobile\/ios\/.*\.md$/.test(file);
const native = (file) => file.startsWith("mobile/ios/") && !documentation(file);

// Unknown paths and changes to the classifier/workflow itself keep the original
// Web protection. Narrowing is allowed only for an entirely understood PR diff.
export function classifyPaths(files, { iosExists = true } = {}) {
  if (!files?.length) return { mode: "full", native: iosExists, web: true, shards: WEB_SHARDS };
  const product = files.filter((file) => !documentation(file));
  if (!product.length) return { mode: "docs", native: false, web: false, shards: [] };
  const ios = product.some(native);
  const shared = product.filter((file) => !native(file));
  if (!shared.length) return { mode: "ios", native: true, web: false, shards: [] };
  // This component is consumed by the bundled Atlas and the browser shell.
  // All other shared changes stay on the full matrix until their consumers are mapped.
  if (ios && shared.every((file) => /^src\/journey\/JourneyTimeline\.(tsx|test\.tsx?)$/.test(file))) {
    return { mode: "mixed", native: true, web: true, shards: ["shell-composer"] };
  }
  const affectsNative = ios || shared.some((file) => /^(src\/(?!auth\/|preview\/)|public\/|\.github\/|scripts\/ci-|package\.json$|pnpm-lock\.yaml$|tsconfig\.json$)/.test(file));
  return { mode: "full", native: iosExists && affectsNative, web: true, shards: WEB_SHARDS };
}

export function changedPaths({ eventName, baseSha, headSha, beforeSha, root = process.cwd() }) {
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const base = eventName === "pull_request" ? baseSha : beforeSha;
  if (![base, headSha].every((sha) => /^[a-f0-9]{40}$/i.test(sha) && !/^0+$/.test(sha))) return null;
  if (!["pull_request", "push"].includes(eventName)) return null;
  try {
    const start = eventName === "pull_request" ? git("merge-base", base, headSha) : base;
    // Both sides of a rename are visible; never turn a shared deletion into iOS-only.
    return git("-c", "core.quotepath=false", "diff", "--no-renames", "--name-only", "-z", start, headSha)
      .split("\0").filter(Boolean);
  } catch { return null; }
}

export function readScope(env = process.env, root = process.cwd()) {
  return classifyPaths(changedPaths({ eventName: env.GITHUB_EVENT_NAME, baseSha: env.PR_BASE_SHA,
    headSha: env.PR_HEAD_SHA || env.GITHUB_SHA, beforeSha: env.PUSH_BEFORE_SHA, root }),
  { iosExists: fs.existsSync(`${root}/mobile/ios/Startrips.xcodeproj/project.pbxproj`) });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const scope = readScope();
  const outputs = { mode: scope.mode, native: String(scope.native), web: String(scope.web),
    // Empty matrices may be rejected before a skipped job condition is applied.
    // An unselected job gets one inert row; its job-level gate prevents a runner.
    matrix: JSON.stringify(scope.web ? browserMatrix(scope) : { include: [{ name: "not-applicable", suites: "", commands: "" }] }) };
  for (const [key, value] of Object.entries(outputs)) {
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  }
  console.log(JSON.stringify(scope));
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `\nCI scope: ${scope.mode}; native=${scope.native}; Web=${scope.shards.join(", ") || "skipped"}.\n`);
}

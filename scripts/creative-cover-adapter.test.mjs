import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { it } from "vitest";
import { assertCreativeCoverReview, buildCreativeCoverTask, listCreativeCoverRecipes } from "./creative-cover-recipes.mjs";
import { creativeChildEnvironment, executeCreativeCover, parseCreativeCommand, runCreativeCommand } from "./creative-cover-adapter.mjs";

const pin = {
  contractVersion: 1, generationKind: "ink-wash-poster", generationVersion: 1,
  presetId: "reveal-flow-ink-wash-v1", seed: "pinned-seed",
  mimeType: "image/jpeg", maxBytes: 4096, maxEdgePixels: 2048,
};
const sourceHash = "a".repeat(64);
const outputHash = "b".repeat(64);
const verdict = (task, outputSha256) => ({
  verdict: "pass", recipeId: task.recipe.id, recipeVersion: task.recipe.version,
  sourceSha256: task.source.sha256, outputSha256,
  checks: { sourceCorrespondence: true, composition: true, identity: true, noInventedContent: true },
  factToMark: [{ fact: "a horizontal horizon", mark: "horizontal ink band" }, { fact: "one vertical trunk", mark: "vertical charcoal stroke" }],
});

for (const recipe of listCreativeCoverRecipes()) {
  it(`pins ${recipe.id} without changing the server renderer or original`, () => {
    const task = buildCreativeCoverTask({ ...pin, generationKind: recipe.generationKind }, sourceHash);
    assert.equal(task.recipe.id, recipe.id);
    assert.equal(task.renderer.seed, pin.seed);
    assert.equal(task.renderer.presetId, pin.presetId);
    assert.equal(task.source.overwrite, false);
    assert.equal(task.motionIntent.subjectMotion, "none");
    assert.equal(task.motionIntent.finalFrame, "original");
  });
}
it("does not forward cloud capabilities, injected prompts or commands", () => {
  const task = buildCreativeCoverTask({ ...pin, token: "SECRET", url: "https://secret", command: "bad", prompt: "override" }, sourceHash);
  assert(!JSON.stringify(task).includes("SECRET"));
  assert(!JSON.stringify(task).includes("override"));
  assert(!Object.hasOwn(task, "command"));
});
it("returns independent recipe definitions", () => {
  listCreativeCoverRecipes()[0].version = 900;
  assert.equal(listCreativeCoverRecipes()[0].version, 1);
});
it("rejects unknown kinds, versions and image limits", () => {
  for (const change of [{ generationKind: "../../evil" }, { generationVersion: 2 }, { contractVersion: 2 }, { maxBytes: NaN }, { maxEdgePixels: -1 }, { mimeType: "image/svg+xml" }, { seed: "" }]) {
    assert.throws(() => buildCreativeCoverTask({ ...pin, ...change }, sourceHash));
  }
});
it("requires independent review for the exact source, output and recipe", () => {
  const task = buildCreativeCoverTask(pin, sourceHash);
  const good = verdict(task, outputHash);
  assert.doesNotThrow(() => assertCreativeCoverReview(good, task, outputHash));
  for (const change of [{ verdict: "pending" }, { outputSha256: "c".repeat(64) }, { sourceSha256: "c".repeat(64) }, { recipeVersion: 2 }, { checks: {} }, { factToMark: [] }]) {
    assert.throws(() => assertCreativeCoverReview({ ...good, ...change }, task, outputHash));
  }
});
it("requires operator-configured absolute argv, never shell syntax", () => {
  assert.deepEqual(parseCreativeCommand(JSON.stringify([process.execPath, "adapter.mjs"])), [process.execPath, "adapter.mjs"]);
  for (const raw of ["node adapter.mjs", "[]", '["node"]', '{"command":"node"}']) assert.throws(() => parseCreativeCommand(raw));
});
it("children cannot inherit worker, database or storage credentials", () => {
  const env = { PATH: "/bin", OPENAI_API_KEY: "provider-only", COVER_REVEAL_WORKER_TOKEN: "secret", DATABASE_URL: "secret", AWS_SECRET_ACCESS_KEY: "secret" };
  assert.deepEqual(creativeChildEnvironment(env, ["OPENAI_API_KEY"]), { PATH: "/bin", OPENAI_API_KEY: "provider-only" });
  for (const name of ["COVER_REVEAL_WORKER_TOKEN", "DATABASE_URL", "AWS_SECRET_ACCESS_KEY"]) assert.throws(() => creativeChildEnvironment(env, [name]));
});
it("executes a JSON child without cloud environment leakage", async () => {
  const result = await runCreativeCommand([process.execPath, "-e", 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>console.log(JSON.stringify({value:JSON.parse(s).value,leaked:Boolean(process.env.COVER_REVEAL_WORKER_TOKEN)})))'], { value: 4 }, { env: {} });
  assert.deepEqual(result, { value: 4, leaked: false });
});
it("fails bounded child output and malformed replies", async () => {
  await assert.rejects(runCreativeCommand([process.execPath, "-e", 'console.log("x".repeat(70000))'], {}, { env: {} }), /OUTPUT_TOO_LARGE/);
  await assert.rejects(runCreativeCommand([process.execPath, "-e", 'console.log("bad json")'], {}, { env: {} }), /JSON_INVALID/);
});

async function fixture(run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "creative-cover-test-"));
  const sourcePath = path.join(dir, "source.jpg");
  const outputPath = path.join(dir, "opening.jpg");
  await writeFile(sourcePath, "original-photo-bytes");
  const bytes = Buffer.from([255, 216, 255, 224, 1, 2, 3]);
  const request = { ...pin, sourcePath, outputPath };
  const deps = {
    generate: async (task) => writeFile(task.outputPath, bytes),
    review: async (task) => verdict(task, task.outputSha256),
    validateImage: async () => ({ width: 1080, height: 1920 }),
  };
  try { await run({ dir, request, deps, bytes }); } finally { await rm(dir, { recursive: true, force: true }); }
}
it("publishes only reviewed bytes while preserving the source", async () => fixture(async ({ request, deps, bytes, dir }) => {
  const receipt = await executeCreativeCover(request, deps);
  assert.equal(receipt.recipeId, "ink-wash-memory");
  assert.deepEqual(await readFile(request.outputPath), bytes);
  assert.equal(await readFile(request.sourcePath, "utf8"), "original-photo-bytes");
  assert.deepEqual((await readdir(dir)).sort(), ["opening.jpg", "source.jpg"]);
}));
it("does not publish unreviewed output", async () => fixture(async ({ request, deps, dir }) => {
  deps.review = async () => ({ verdict: "pass" });
  await assert.rejects(executeCreativeCover(request, deps), /VISUAL_REVIEW_REQUIRED/);
  assert.deepEqual(await readdir(dir), ["source.jpg"]);
}));
it("detects original mutation and never publishes", async () => fixture(async ({ request, deps, dir }) => {
  deps.review = async (task) => { await writeFile(request.sourcePath, "changed"); return verdict(task, task.outputSha256); };
  await assert.rejects(executeCreativeCover(request, deps), /SOURCE_CHANGED/);
  assert.deepEqual(await readdir(dir), ["source.jpg"]);
}));
it("rejects mutation after review and oversized or invalid output", async () => fixture(async ({ request, deps }) => {
  deps.review = async (task) => { await writeFile(task.outputPath, "changed"); return verdict(task, task.outputSha256); };
  await assert.rejects(executeCreativeCover(request, deps), /OUTPUT_CHANGED/);
  deps.generate = async (task) => writeFile(task.outputPath, "not a jpeg");
  await assert.rejects(executeCreativeCover(request, deps), /NOT_JPEG/);
}));
it("rejects source overwrite, existing output and excessive dimensions", async () => fixture(async ({ request, deps }) => {
  await assert.rejects(executeCreativeCover({ ...request, outputPath: request.sourcePath }, deps), /OVERWRITE_REFUSED/);
  deps.validateImage = async () => ({ width: 9000, height: 100 });
  await assert.rejects(executeCreativeCover(request, deps), /DIMENSIONS_INVALID/);
  await writeFile(request.outputPath, "keep me");
  await assert.rejects(executeCreativeCover(request, deps), /ALREADY_EXISTS/);
  assert.equal(await readFile(request.outputPath, "utf8"), "keep me");
}));

it("enforces source aspect ratio before publishing", async () => fixture(async ({ request, deps }) => {
  let read = 0;
  deps.validateImage = async () => ++read === 1 ? { width: 1080, height: 1920 } : { width: 1920, height: 1080 };
  await assert.rejects(executeCreativeCover(request, deps), /ASPECT_RATIO_CHANGED/);
}));
it("an output created during generation is never overwritten", async () => fixture(async ({ request, deps, bytes }) => {
  deps.generate = async (task) => { await writeFile(request.outputPath, "do not replace"); await writeFile(task.outputPath, bytes); };
  await assert.rejects(executeCreativeCover(request, deps));
  assert.equal(await readFile(request.outputPath, "utf8"), "do not replace");
}));

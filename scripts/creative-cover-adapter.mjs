#!/usr/bin/env node
/** Opt-in adapter for cover-reveal-worker.mjs. No network, queue or cloud credentials. */
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { link, lstat, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { assertCreativeCoverReview, buildCreativeCoverTask } from "./creative-cover-recipes.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const MAX_JSON_BYTES = 65536;

export function parseCreativeCommand(raw) {
  let command;
  try { command = JSON.parse(raw); } catch { throw new Error("CREATIVE_COMMAND_INVALID"); }
  if (!Array.isArray(command) || command.length === 0
    || command.some((arg) => typeof arg !== "string" || arg.includes("\0"))
    || !path.isAbsolute(command[0])) throw new Error("CREATIVE_COMMAND_INVALID");
  return command;
}

/** Only explicitly granted provider variables enter children; worker/storage secrets never do. */
export function creativeChildEnvironment(env, permittedNames = []) {
  const result = {};
  for (const name of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "HOME", "USERPROFILE", "TMP", "TEMP", "TMPDIR", "LANG"]) {
    if (typeof env[name] === "string") result[name] = env[name];
  }
  for (const name of permittedNames) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name) || /(COVER_REVEAL|STARTRIPS|DATABASE|AWS_|S3_|R2_|STORAGE|SESSION|COOKIE|LEASE)/.test(name)) {
      throw new Error("CREATIVE_ENV_GRANT_INVALID");
    }
    if (typeof env[name] === "string") result[name] = env[name];
  }
  return result;
}

export function runCreativeCommand(command, input, { env, timeoutMs = 600000, signal } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let bytes = 0;
    const chunks = [];
    const child = spawn(command[0], command.slice(1), {
      shell: false, windowsHide: true, env: env ?? {}, stdio: ["pipe", "pipe", "ignore"], signal,
    });
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) { child.kill("SIGKILL"); reject(error); } else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error("CREATIVE_COMMAND_TIMEOUT")), timeoutMs);
    child.on("error", () => finish(new Error("CREATIVE_COMMAND_FAILED")));
    child.stdin.on("error", () => finish(new Error("CREATIVE_COMMAND_FAILED")));
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_JSON_BYTES) return finish(new Error("CREATIVE_COMMAND_OUTPUT_TOO_LARGE"));
      chunks.push(chunk);
    });
    child.on("close", (code) => {
      if (code !== 0) return finish(new Error("CREATIVE_COMMAND_FAILED"));
      try { finish(null, JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { finish(new Error("CREATIVE_COMMAND_JSON_INVALID")); }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

async function readRegularFile(filePath, maxBytes) {
  const info = await lstat(filePath);
  if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > maxBytes) {
    throw new Error("CREATIVE_OUTPUT_FILE_INVALID");
  }
  const bytes = await readFile(filePath);
  if (bytes.length !== info.size) throw new Error("CREATIVE_OUTPUT_CHANGED");
  return bytes;
}

/** Produces the one JPEG expected by the existing worker, only after byte-bound review. */
export async function executeCreativeCover(request, { generate, review, validateImage, signal }) {
  if (!request || !path.isAbsolute(request.sourcePath ?? "") || !path.isAbsolute(request.outputPath ?? "")) {
    throw new Error("CREATIVE_PATH_INVALID");
  }
  signal?.throwIfAborted();
  const sourcePath = await realpath(request.sourcePath);
  const parent = await realpath(path.dirname(request.outputPath));
  const outputPath = path.join(parent, path.basename(request.outputPath));
  if (sourcePath === outputPath) throw new Error("CREATIVE_SOURCE_OVERWRITE_REFUSED");
  // The worker allocates a fresh scratch destination; never overwrite an existing file/symlink.
  try { await lstat(outputPath); throw new Error("CREATIVE_OUTPUT_ALREADY_EXISTS"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const source = await readFile(sourcePath);
  const sourceHash = sha256(source);
  const task = buildCreativeCoverTask(request, sourceHash);
  const sourceDimensions = await validateImage(source);
  if (!Number.isSafeInteger(sourceDimensions.width) || !Number.isSafeInteger(sourceDimensions.height)
    || sourceDimensions.width <= 0 || sourceDimensions.height <= 0) throw new Error("CREATIVE_SOURCE_DIMENSIONS_INVALID");
  const candidatePath = path.join(parent, `.creative-${randomUUID()}.jpg`);
  const publishPath = path.join(parent, `.creative-${randomUUID()}.publish`);
  try {
    await generate({ ...task, sourcePath, outputPath: candidatePath });
    signal?.throwIfAborted();
    const bytes = await readRegularFile(candidatePath, request.maxBytes);
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) throw new Error("CREATIVE_OUTPUT_NOT_JPEG");
    // Decoder is a trusted implementation, not dimensions declared by the generator.
    const dimensions = await validateImage(bytes);
    if (!Number.isSafeInteger(dimensions.width) || !Number.isSafeInteger(dimensions.height)
      || dimensions.width <= 0 || dimensions.height <= 0
      || Math.max(dimensions.width, dimensions.height) > request.maxEdgePixels) {
      throw new Error("CREATIVE_OUTPUT_DIMENSIONS_INVALID");
    }
    if (Math.abs(dimensions.width * sourceDimensions.height - dimensions.height * sourceDimensions.width)
      > Math.max(sourceDimensions.width, sourceDimensions.height)) throw new Error("CREATIVE_ASPECT_RATIO_CHANGED");
    const outputHash = sha256(bytes);
    const verdict = await review({ ...task, sourcePath, outputPath: candidatePath, outputSha256: outputHash });
    assertCreativeCoverReview(verdict, task, outputHash);
    if (sha256(await readFile(sourcePath)) !== sourceHash) throw new Error("CREATIVE_SOURCE_CHANGED");
    if (sha256(await readRegularFile(candidatePath, request.maxBytes)) !== outputHash) throw new Error("CREATIVE_OUTPUT_CHANGED");
    // Publish the reviewed buffer, not a mutable file still owned by the generator.
    await writeFile(publishPath, bytes, { flag: "wx", mode: 0o600 });
    signal?.throwIfAborted();
    await link(publishPath, outputPath);
    return { recipeId: task.recipe.id, recipeVersion: task.recipe.version, sourceSha256: sourceHash, outputSha256: outputHash };
  } finally {
    await Promise.all([candidatePath, publishPath].map((file) => rm(file, { force: true })));
  }
}

async function main() {
  if (process.argv.includes("--check")) {
    const configured = Boolean(process.env.STARTRIPS_CREATIVE_GENERATOR_COMMAND_JSON);
    if (configured) {
      parseCreativeCommand(process.env.STARTRIPS_CREATIVE_GENERATOR_COMMAND_JSON);
      parseCreativeCommand(process.env.STARTRIPS_CREATIVE_REVIEWER_COMMAND_JSON);
    } else {
      const { creativeProviderConfig } = await import("./creative-cover-openai.mjs");
      creativeProviderConfig(process.env);
    }
    process.stdout.write(JSON.stringify({ ready: true, provider: configured ? "operator-commands" : "openai", recipes: ["ink-wash-memory", "poetic-line-memory", "paper-collage-memory"] }) + "\n");
    return;
  }
  const generatorRaw = process.env.STARTRIPS_CREATIVE_GENERATOR_COMMAND_JSON;
  const reviewerRaw = process.env.STARTRIPS_CREATIVE_REVIEWER_COMMAND_JSON;
  if (Boolean(generatorRaw) !== Boolean(reviewerRaw)) throw new Error("CREATIVE_COMMAND_PAIR_REQUIRED");
  const generator = generatorRaw ? parseCreativeCommand(generatorRaw) : null;
  const reviewer = reviewerRaw ? parseCreativeCommand(reviewerRaw) : null;
  const names = (process.env.STARTRIPS_CREATIVE_PROVIDER_ENV_NAMES ?? "").split(",").map((name) => name.trim()).filter(Boolean);
  const env = creativeChildEnvironment(process.env, names);
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_JSON_BYTES) throw new Error("CREATIVE_INPUT_TOO_LARGE");
    chunks.push(chunk);
  }
  const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  // Sharp is already a Startrips dependency; do not add another image decoder.
  const { default: sharp } = await import("sharp");
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGTERM", abort);
  process.once("SIGINT", abort);
  try {
    const { createOpenAICreativeProvider, creativeProviderConfig } = await import("./creative-cover-openai.mjs");
    const provider = generator && reviewer ? {
      generate: (task) => runCreativeCommand(generator, task, { env, signal: controller.signal }),
      review: (task) => runCreativeCommand(reviewer, task, { env, signal: controller.signal }),
    } : createOpenAICreativeProvider(creativeProviderConfig(process.env), { signal: controller.signal });
    await executeCreativeCover(request, {
      ...provider,
      signal: controller.signal,
      validateImage: async (bytes) => {
        // Read the displayed orientation and decode the complete raster.
        // Source resolution may legitimately exceed the derivative edge ceiling.
        const { info } = await sharp(bytes, { limitInputPixels: 64 * 1024 * 1024 }).rotate().raw().toBuffer({ resolveWithObject: true });
        return { width: info.width, height: info.height };
      },
    });
  } finally {
    process.removeListener("SIGTERM", abort);
    process.removeListener("SIGINT", abort);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(() => { process.stderr.write("CREATIVE_COVER_ADAPTER_FAILED\n"); process.exitCode = 1; });
}

#!/usr/bin/env node
/**
 * Slice 2 of #367: the reference cover-reveal worker client.
 *
 * #368 froze the whole server contract in
 * `docs/architecture/cover-reveal-worker-protocol.md`; #386 added the browser's
 * read of a ready derivative and #379 wired the Journey opening to it. None of
 * that produces a derivative on its own, because the protocol has no consumer.
 * This file is that consumer and nothing else.
 *
 * What it is allowed to reach is the point of it. The client speaks exactly the
 * five `/api/cover-reveal-worker/*` routes with `COVER_REVEAL_WORKER_TOKEN`,
 * plus the two short-lived object URLs the server hands it. It has no database
 * client, no SSH, no object-store credential and no Atlas session — which is
 * checkable here by inspection: the imports below are Node builtins only.
 *
 * It is restart-safe by having no state to restart from. One invocation runs at
 * most one iteration and exits; a crash mid-iteration writes nothing durable
 * and leaves the job to the server's existing lease-expiry reclaim. There is no
 * local queue and no second scheduler.
 */

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Exit codes are the operator's only machine-readable outcome, so `0` has to
 * mean exactly "nothing was pending, or a derivative is published". Every way
 * of not knowing gets its own non-zero code rather than being folded into
 * success — a scheduled invocation that exits 0 after an ambiguous completion
 * would be the one failure mode this client exists to avoid.
 */
export const EXIT_CODES = {
  ok: 0,
  configInvalid: 2,
  leaseLost: 3,
  attemptFailed: 4,
  outputRejected: 5,
  unavailable: 6,
  interrupted: 130,
};

/** The magic bytes of the raster types the protocol calls supported. */
const IMAGE_SIGNATURES = [
  { mimeType: "image/jpeg", bytes: [0xff, 0xd8, 0xff] },
  { mimeType: "image/png", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mimeType: "image/webp", bytes: [0x52, 0x49, 0x46, 0x46], offset: 0 },
];

/**
 * What the file actually is, from its leading bytes rather than from its name
 * or from what the generator claimed. An adapter is an external command the
 * operator configured; taking its word for the type is how a text file, an
 * error page or an SVG reaches an upload slot the server issued for a JPEG.
 */
export function sniffImageMimeType(buffer) {
  for (const signature of IMAGE_SIGNATURES) {
    const offset = signature.offset ?? 0;
    if (buffer.length < offset + signature.bytes.length) continue;
    const matches = signature.bytes.every(
      (byte, index) => buffer[offset + index] === byte,
    );
    if (!matches) continue;
    if (signature.mimeType === "image/webp") {
      if (buffer.length < 12) continue;
      if (buffer.toString("latin1", 8, 12) !== "WEBP") continue;
    }
    return signature.mimeType;
  }
  return null;
}

/**
 * The pre-upload gate, checked against what the CLAIM advertised rather than
 * against a constant of our own. `COVER_REVEAL_MAX_BYTES` and the issued output
 * type are server configuration; a second copy here would be a second authority
 * that drifts, and the acceptance is explicitly the *server-advertised* ceiling.
 *
 * Pixel size is deliberately not checked. The server measures it inside
 * `complete` (`COVER_REVEAL_MAX_EDGE_PIXELS`) and that reading is authoritative;
 * a decoder here would be a second opinion about the same bytes.
 */
export function validateGeneratedOutput({ buffer, expectedMimeType, maxBytes }) {
  if (buffer.length === 0) {
    return { ok: false, reason: "OUTPUT_EMPTY" };
  }
  const mimeType = sniffImageMimeType(buffer);
  if (mimeType === null) {
    return { ok: false, reason: "OUTPUT_NOT_AN_IMAGE" };
  }
  if (mimeType !== expectedMimeType) {
    return { ok: false, reason: "OUTPUT_MIME_MISMATCH", mimeType };
  }
  if (buffer.length > maxBytes) {
    return { ok: false, reason: "OUTPUT_TOO_LARGE", bytes: buffer.length };
  }
  return { ok: true, mimeType, bytes: buffer.length };
}

function requireEnv(env, name) {
  const value = env[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new WorkerConfigError("missing required environment variable " + name);
  }
  return value.trim();
}

export class WorkerConfigError extends Error {}

/**
 * The whole configuration surface, read once and fail-closed, mirroring
 * `server/config.ts`'s posture: a half-configured worker must not start an
 * iteration and discover the gap after it holds a lease.
 */
export function resolveWorkerConfig(env) {
  const origin = requireEnv(env, "STARTRIPS_API_ORIGIN").replace(/\/+$/, "");
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    throw new WorkerConfigError("STARTRIPS_API_ORIGIN is not a URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new WorkerConfigError("STARTRIPS_API_ORIGIN must be http or https");
  }
  const token = requireEnv(env, "COVER_REVEAL_WORKER_TOKEN");
  const command = requireEnv(env, "COVER_REVEAL_GENERATOR_COMMAND");
  let args = [];
  const rawArgs = env.COVER_REVEAL_GENERATOR_ARGS;
  if (typeof rawArgs === "string" && rawArgs.trim() !== "") {
    try {
      args = JSON.parse(rawArgs);
    } catch {
      throw new WorkerConfigError("COVER_REVEAL_GENERATOR_ARGS must be JSON");
    }
    if (!Array.isArray(args) || args.some((entry) => typeof entry !== "string")) {
      throw new WorkerConfigError(
        "COVER_REVEAL_GENERATOR_ARGS must be an array of strings",
      );
    }
  }
  const timeoutMs = Number(env.COVER_REVEAL_GENERATOR_TIMEOUT_MS ?? 600000);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new WorkerConfigError(
      "COVER_REVEAL_GENERATOR_TIMEOUT_MS must be a positive number",
    );
  }
  return {
    origin,
    token,
    generator: { command, args, timeoutMs },
    workdirParent: env.COVER_REVEAL_WORKER_WORKDIR ?? tmpdir(),
  };
}

/**
 * A transport failure, a non-JSON body or a 5xx: the request may or may not
 * have been applied. Kept as its own class because `complete` is the one verb
 * where "I do not know" has a safe resolution (retry, which the protocol
 * documents as idempotent for the claimant) and every other verb must abort.
 */
export class AmbiguousResponseError extends Error {}

function redact(value) {
  return typeof value === "string" && value.length > 0 ? "[redacted]" : value;
}

/**
 * One line of structured log per step. Signed URLs, the lease token and the
 * worker credential never reach it — #368 requires that no durable artifact or
 * log line carry a capability, and a scheduled CLI's stdout is an artifact.
 */
function makeLogger(write) {
  return (event, fields = {}) => {
    write(JSON.stringify({ event, ...fields }) + "\n");
  };
}

async function callWorkerRoute(context, routePath, body) {
  let response;
  try {
    response = await context.fetchImpl(context.origin + routePath, {
      method: "POST",
      headers: {
        authorization: "Bearer " + context.token,
        "content-type": "application/json",
      },
      body: JSON.stringify(body ?? {}),
    });
  } catch (error) {
    throw new AmbiguousResponseError(
      "request to " + routePath + " did not complete: " + describeError(error),
    );
  }
  if (response.status >= 500) {
    throw new AmbiguousResponseError(
      "request to " + routePath + " answered " + response.status,
    );
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new AmbiguousResponseError(
      "request to " + routePath + " answered a non-JSON body",
    );
  }
  return { status: response.status, ok: response.ok, payload };
}

function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Settle OUR OWN live claim. Never called for a lost lease: a
 * `COVER_REVEAL_NOT_CLAIMED` / `COVER_REVEAL_NOT_LEASED` answer means another
 * claimant owns the job, and reporting a failure against someone else's claim
 * is not ours to do. The reason is one of the server's four allowlisted codes.
 */
async function reportFailure(context, jobId, leaseToken, reason) {
  let result;
  try {
    result = await callWorkerRoute(
      context,
      "/api/cover-reveal-worker/jobs/" + jobId + "/fail",
      { leaseToken, reason },
    );
  } catch {
    // Transport failure. The lease expiry reclaims the job anyway, so an
    // undelivered report costs a wait rather than correctness — but the caller
    // must not go on to say the attempt was reported.
    context.log("attempt.failed", { jobId, reason, reportDelivered: false });
    return { delivered: false, leaseLost: false, error: null };
  }
  if (result.ok) {
    context.log("attempt.failed", { jobId, reason });
    return { delivered: true, leaseLost: false, error: null };
  }
  // A long generation can lose its lease before it gets to report anything, and
  // `fail` then answers 404/409 like every other verb. That is a lost lease,
  // not a reported failure.
  const error = result.payload?.error ?? null;
  context.log("attempt.failed", { jobId, reason, reportDelivered: false, error });
  return { delivered: false, leaseLost: isLeaseLost(result.status, error), error };
}

/**
 * Settle this attempt, and let a lease lost in the very act of reporting win:
 * the outcome has to describe what the server actually accepted.
 */
async function settleAttempt(context, job, leaseToken, reason, result) {
  const report = await reportFailure(context, job.id, leaseToken, reason);
  if (report.leaseLost) {
    context.log("lease.lost", { jobId: job.id, error: report.error, step: "fail" });
    return { outcome: "lease-lost", exitCode: EXIT_CODES.leaseLost, error: report.error };
  }
  return result;
}

async function downloadSource(context, url, destination, expectedBytes) {
  let response;
  try {
    response = await context.fetchImpl(url, { method: "GET" });
  } catch (error) {
    return { ok: false, reason: describeError(error) };
  }
  if (!response.ok) {
    return { ok: false, reason: "source read answered " + response.status };
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (typeof expectedBytes === "number" && buffer.length !== expectedBytes) {
    // The job pinned a verified stored-byte identity (#311); a short read is a
    // truncated download, and generating from it would publish a derivative of
    // bytes the member never uploaded.
    return { ok: false, reason: "source byte count did not match the pinned size" };
  }
  await writeFile(destination, buffer);
  return { ok: true, bytes: buffer.length };
}

/**
 * The generator adapter boundary. Startrips runs no model: the operator
 * supplies a command, and it is handed one JSON document on stdin describing
 * the two paths and the deterministic parameters the job pinned.
 *
 * No URL, no lease token and no credential is passed to it — the adapter reads
 * a local file and writes a local file, so nothing it logs or leaks can be a
 * capability against this deployment.
 */
export function buildGeneratorRequest({ job, output, sourcePath, outputPath }) {
  return {
    contractVersion: 1,
    sourcePath,
    outputPath,
    mimeType: output.mimeType,
    maxBytes: output.maxBytes,
    maxEdgePixels: output.maxEdgePixels,
    generationKind: job.generationKind,
    generationVersion: job.generationVersion,
    presetId: job.presetId,
    seed: job.seed,
  };
}

/**
 * Every generator this process started and has not yet reaped. An interrupted
 * run must take its adapter down with it: the child holds the temporary files
 * being removed, and a survivor would go on writing into a directory whose job
 * another claimant is about to take.
 */
const activeGenerators = new Set();

/**
 * A configured adapter is usually a wrapper script that launches the real model
 * process, so signalling the spawned PID alone leaves the descendant running —
 * burning CPU/GPU after the worker has already removed the directory it was
 * writing into, and accumulating across scheduled runs. The child is therefore
 * started as its own process-group leader and the whole group is signalled.
 */
function killProcessTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (typeof child.pid !== "number") return;
  if (process.platform === "win32") {
    // Windows has no process group to signal; `taskkill /T` is the tree walk.
    try {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      child.kill("SIGKILL");
    }
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already reaped.
    }
  }
}

export function terminateActiveGenerators() {
  for (const child of activeGenerators) {
    killProcessTree(child);
  }
  activeGenerators.clear();
}

async function runGenerator(context, request) {
  const { command, args, timeoutMs } = context.generator;
  return await new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        stdio: ["pipe", "pipe", "pipe"],
        // Its own process group, so a timeout or an interrupt can take the
        // adapter's descendants down with it.
        detached: process.platform !== "win32",
      });
    } catch (error) {
      resolve({ ok: false, reason: describeError(error) });
      return;
    }
    activeGenerators.add(child);
    let stderr = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      activeGenerators.delete(child);
      resolve(result);
    };
    const timer = setTimeout(() => {
      killProcessTree(child);
      finish({ ok: false, reason: "generator timed out" });
    }, timeoutMs);
    child.stdout.on("data", () => {});
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-2000);
    });
    child.on("error", (error) => finish({ ok: false, reason: describeError(error) }));
    child.on("close", (code) => {
      if (code === 0) {
        finish({ ok: true });
        return;
      }
      finish({ ok: false, reason: "generator exited " + code, stderr: stderr.trim() });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(request));
  });
}

async function uploadOutput(context, upload, buffer) {
  let response;
  try {
    response = await context.fetchImpl(upload.url, {
      method: "PUT",
      headers: upload.headers ?? {},
      body: buffer,
    });
  } catch (error) {
    return { ok: false, reason: describeError(error) };
  }
  if (!response.ok) {
    return { ok: false, reason: "upload answered " + response.status };
  }
  return { ok: true };
}

/** A lost lease is the same outcome whichever verb discovered it. */
function isLeaseLost(status, error) {
  return (
    (status === 404 && error === "COVER_REVEAL_NOT_CLAIMED")
    || (status === 409 && error === "COVER_REVEAL_NOT_LEASED")
  );
}

/**
 * The completion step, where the two shapes of "I do not know" are different
 * things and are resolved differently.
 *
 * `COVER_REVEAL_OUTPUT_MISSING` is documented as retryable with the job left
 * `leased`: the write has not become visible yet, so the fix is to put the
 * bytes again against a freshly signed capability and complete again.
 *
 * A transport failure or a 5xx is the other ambiguity — the completion may
 * already have been applied. Re-sending `complete` is the documented safe
 * resolution, because a repeated completion by the same claimant answers `200`
 * on an already-`ready` job. Both are bounded; neither ever concludes success
 * from silence.
 */
async function completeWithRecovery(context, job, leaseToken, buffer) {
  const attempts = context.completionAttempts;
  let lastAmbiguity = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let result;
    try {
      result = await callWorkerRoute(
        context,
        "/api/cover-reveal-worker/jobs/" + job.id + "/complete",
        { leaseToken },
      );
    } catch (error) {
      if (!(error instanceof AmbiguousResponseError)) throw error;
      lastAmbiguity = error.message;
      context.log("complete.ambiguous", { jobId: job.id, attempt });
      await context.delay(context.retryDelayMs);
      continue;
    }
    if (result.ok) {
      return { outcome: "completed", derivative: result.payload?.derivative ?? null };
    }
    const error = result.payload?.error ?? null;
    if (isLeaseLost(result.status, error)) {
      return { outcome: "lease-lost", error };
    }
    if (error === "COVER_REVEAL_SOURCE_CHANGED") {
      return { outcome: "superseded", error };
    }
    if (error === "COVER_REVEAL_OUTPUT_MISSING") {
      context.log("complete.output-missing", { jobId: job.id, attempt });
      if (attempt >= attempts) {
        // The server leaves this job `leased` and retryable rather than
        // settling it, so a spent budget means unresolved, never rejected.
        return { outcome: "ambiguous", error };
      }
      let resigned;
      try {
        resigned = await callWorkerRoute(
          context,
          "/api/cover-reveal-worker/jobs/" + job.id + "/output-upload",
          { leaseToken },
        );
      } catch {
        return { outcome: "ambiguous", error };
      }
      if (!resigned.ok) {
        const resignError = resigned.payload?.error ?? error;
        // The lease can be reclaimed between the completion and the re-sign.
        // That is a lost lease, not a rejected output.
        if (
          isLeaseLost(resigned.status, resignError)
          || resignError === "COVER_REVEAL_SOURCE_CHANGED"
        ) {
          return { outcome: "lease-lost", error: resignError };
        }
        return { outcome: "rejected", error: resignError };
      }
      const replayed = await uploadOutput(context, resigned.payload.upload, buffer);
      if (!replayed.ok) {
        return { outcome: "upload-failed", error: replayed.reason };
      }
      await context.delay(context.retryDelayMs);
      continue;
    }
    // `COVER_REVEAL_OUTPUT_TOO_LARGE`, `_PIXELS_TOO_LARGE`, `_UNREADABLE`: the
    // server has already settled this attempt and dropped the object, so there
    // is nothing for the client to report or retry.
    return { outcome: "rejected", error };
  }
  return { outcome: "ambiguous", error: lastAmbiguity };
}

/**
 * One bounded iteration: claim, read the pinned source, generate, validate,
 * upload, complete. Everything it writes lives in a temporary directory the
 * caller removes, so an interrupted run leaves nothing behind but a lease the
 * server will expire.
 */
export async function runCoverRevealWorkerIteration(options) {
  const context = {
    origin: options.config.origin,
    token: options.config.token,
    generator: options.config.generator,
    fetchImpl: options.fetchImpl ?? globalThis.fetch,
    log: options.log ?? (() => {}),
    delay: options.delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    completionAttempts: options.completionAttempts ?? 3,
    retryDelayMs: options.retryDelayMs ?? 1000,
  };
  const workdir = options.workdir;

  let claim;
  try {
    claim = await callWorkerRoute(context, "/api/cover-reveal-worker/claim");
  } catch (error) {
    context.log("claim.unavailable", { detail: describeError(error) });
    return { outcome: "unavailable", exitCode: EXIT_CODES.unavailable };
  }
  if (!claim.ok) {
    const error = claim.payload?.error ?? null;
    if (claim.status === 404 && error === "COVER_REVEAL_NO_WORK") {
      context.log("claim.no-work", {});
      return { outcome: "no-work", exitCode: EXIT_CODES.ok };
    }
    context.log("claim.refused", { status: claim.status, error });
    return { outcome: "unavailable", exitCode: EXIT_CODES.unavailable, error };
  }

  const job = claim.payload.derivative;
  const leaseToken = claim.payload.lease.token;
  const output = claim.payload.output;
  // The lease token is the one capability this process holds beyond its
  // credential. It is threaded through every subsequent request and is never
  // logged, never written to a file and never handed to the generator.
  context.log("claim.taken", {
    jobId: job.id,
    journeyId: job.journeyId,
    presetId: job.presetId,
    attempts: job.attempts,
    leaseToken: redact(leaseToken),
  });

  const sourcePath = path.join(workdir, "source");
  const outputPath = path.join(workdir, "output.jpg");

  let sourceRead;
  try {
    sourceRead = await callWorkerRoute(
      context,
      "/api/cover-reveal-worker/jobs/" + job.id + "/source-read",
      { leaseToken },
    );
  } catch {
    context.log("source-read.ambiguous", { jobId: job.id });
    return { outcome: "unavailable", exitCode: EXIT_CODES.unavailable };
  }
  if (!sourceRead.ok) {
    const error = sourceRead.payload?.error ?? null;
    if (isLeaseLost(sourceRead.status, error) || error === "COVER_REVEAL_SOURCE_CHANGED") {
      context.log("lease.lost", { jobId: job.id, error, step: "source-read" });
      return { outcome: "lease-lost", exitCode: EXIT_CODES.leaseLost, error };
    }
    context.log("source-read.refused", { jobId: job.id, error });
    return await settleAttempt(context, job, leaseToken, "WORKER_SOURCE_UNREADABLE", {
      outcome: "source-unreadable",
      exitCode: EXIT_CODES.attemptFailed,
      error,
    });
  }

  const source = sourceRead.payload.source;
  const downloaded = await downloadSource(context, source.url, sourcePath, source.bytes);
  if (!downloaded.ok) {
    context.log("source.unreadable", { jobId: job.id, detail: downloaded.reason });
    return await settleAttempt(context, job, leaseToken, "WORKER_SOURCE_UNREADABLE", {
      outcome: "source-unreadable",
      exitCode: EXIT_CODES.attemptFailed,
    });
  }
  context.log("source.downloaded", { jobId: job.id, bytes: downloaded.bytes });

  const generated = await runGenerator(
    context,
    buildGeneratorRequest({ job, output, sourcePath, outputPath }),
  );
  if (!generated.ok) {
    context.log("generator.failed", { jobId: job.id, detail: generated.reason });
    return await settleAttempt(context, job, leaseToken, "WORKER_GENERATION_FAILED", {
      outcome: "generator-failed",
      exitCode: EXIT_CODES.attemptFailed,
    });
  }

  let stats;
  try {
    stats = await stat(outputPath);
  } catch {
    context.log("generator.no-output", { jobId: job.id });
    return await settleAttempt(context, job, leaseToken, "WORKER_GENERATION_FAILED", {
      outcome: "generator-failed",
      exitCode: EXIT_CODES.attemptFailed,
    });
  }
  // The ceiling is applied to the file's size before its bytes are read, so a
  // runaway generator cannot exhaust this process's memory and take the
  // rejection, the failure report and the cleanup down with it.
  if (stats.size > output.maxBytes) {
    context.log("output.invalid", {
      jobId: job.id,
      reason: "OUTPUT_TOO_LARGE",
      bytes: stats.size,
    });
    return await settleAttempt(context, job, leaseToken, "WORKER_GENERATION_FAILED", {
      outcome: "output-invalid",
      exitCode: EXIT_CODES.outputRejected,
      reason: "OUTPUT_TOO_LARGE",
    });
  }
  const buffer = await readFile(outputPath);

  const validated = validateGeneratedOutput({
    buffer,
    expectedMimeType: output.mimeType,
    maxBytes: output.maxBytes,
  });
  if (!validated.ok) {
    context.log("output.invalid", { jobId: job.id, reason: validated.reason });
    return await settleAttempt(context, job, leaseToken, "WORKER_GENERATION_FAILED", {
      outcome: "output-invalid",
      exitCode: EXIT_CODES.outputRejected,
      reason: validated.reason,
    });
  }
  context.log("output.validated", { jobId: job.id, bytes: validated.bytes });

  let signed;
  try {
    signed = await callWorkerRoute(
      context,
      "/api/cover-reveal-worker/jobs/" + job.id + "/output-upload",
      { leaseToken },
    );
  } catch {
    context.log("output-upload.ambiguous", { jobId: job.id });
    return { outcome: "unavailable", exitCode: EXIT_CODES.unavailable };
  }
  if (!signed.ok) {
    const error = signed.payload?.error ?? null;
    if (isLeaseLost(signed.status, error) || error === "COVER_REVEAL_SOURCE_CHANGED") {
      context.log("lease.lost", { jobId: job.id, error, step: "output-upload" });
      return { outcome: "lease-lost", exitCode: EXIT_CODES.leaseLost, error };
    }
    context.log("output-upload.refused", { jobId: job.id, error });
    return await settleAttempt(context, job, leaseToken, "WORKER_UPLOAD_FAILED", {
      outcome: "upload-failed",
      exitCode: EXIT_CODES.attemptFailed,
      error,
    });
  }

  const uploaded = await uploadOutput(context, signed.payload.upload, buffer);
  if (!uploaded.ok) {
    context.log("upload.failed", { jobId: job.id, detail: uploaded.reason });
    return await settleAttempt(context, job, leaseToken, "WORKER_UPLOAD_FAILED", {
      outcome: "upload-failed",
      exitCode: EXIT_CODES.attemptFailed,
    });
  }
  context.log("upload.complete", { jobId: job.id, bytes: validated.bytes });

  const completion = await completeWithRecovery(context, job, leaseToken, buffer);
  if (completion.outcome === "completed") {
    context.log("job.ready", {
      jobId: job.id,
      journeyId: job.journeyId,
      state: completion.derivative?.state ?? null,
    });
    return { outcome: "completed", exitCode: EXIT_CODES.ok };
  }
  if (completion.outcome === "lease-lost" || completion.outcome === "superseded") {
    context.log("lease.lost", {
      jobId: job.id,
      error: completion.error,
      step: "complete",
    });
    return { outcome: completion.outcome, exitCode: EXIT_CODES.leaseLost };
  }
  if (completion.outcome === "upload-failed") {
    return await settleAttempt(context, job, leaseToken, "WORKER_UPLOAD_FAILED", {
      outcome: "upload-failed",
      exitCode: EXIT_CODES.attemptFailed,
    });
  }
  if (completion.outcome === "ambiguous") {
    // The bytes are uploaded and the job is still the server's to settle. The
    // next scheduled invocation reclaims it after the lease expires, so the
    // only wrong move here is to exit 0.
    context.log("job.unresolved", { jobId: job.id });
    return { outcome: "ambiguous", exitCode: EXIT_CODES.unavailable };
  }
  context.log("job.rejected", { jobId: job.id, error: completion.error });
  return { outcome: "rejected", exitCode: EXIT_CODES.outputRejected };
}

/**
 * The CLI. Creates one temporary directory, guarantees its removal on every
 * exit path including SIGINT/SIGTERM, and never re-enters the loop.
 */
export async function main({ env = process.env, write = (line) => process.stdout.write(line) } = {}) {
  const log = makeLogger(write);
  let config;
  try {
    config = resolveWorkerConfig(env);
  } catch (error) {
    log("config.invalid", { detail: describeError(error) });
    return EXIT_CODES.configInvalid;
  }

  const workdir = await mkdtemp(path.join(config.workdirParent, "startrips-cover-reveal-"));
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    terminateActiveGenerators();
    await rm(workdir, { recursive: true, force: true });
  };
  // An interrupted generation reports nothing to the server on purpose: the
  // recovery mechanism this client is specified against is the existing lease
  // expiry, and posting `fail` here would substitute a different one.
  const onSignal = (signal) => {
    void cleanup().then(() => {
      log("interrupted", { signal });
      process.exit(EXIT_CODES.interrupted);
    });
  };
  process.once("SIGINT", () => onSignal("SIGINT"));
  process.once("SIGTERM", () => onSignal("SIGTERM"));

  try {
    const result = await runCoverRevealWorkerIteration({ config, workdir, log });
    return result.exitCode;
  } catch (error) {
    log("iteration.aborted", { detail: describeError(error) });
    return EXIT_CODES.unavailable;
  } finally {
    await cleanup();
  }
}

const invokedDirectly = process.argv[1]
  && pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedDirectly) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stdout.write(
        JSON.stringify({ event: "fatal", detail: describeError(error) }) + "\n",
      );
      process.exitCode = EXIT_CODES.unavailable;
    },
  );
}

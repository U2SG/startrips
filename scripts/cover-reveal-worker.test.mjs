import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildGeneratorRequest,
  EXIT_CODES,
  resolveWorkerConfig,
  runCoverRevealWorkerIteration,
  sniffImageMimeType,
  validateGeneratedOutput,
} from "./cover-reveal-worker.mjs";

/**
 * Slice 2 of #367: the contract test for the reference worker client.
 *
 * It runs a stub of the #368 protocol over loopback and a fixture generator
 * that is an ordinary Node script, so the whole iteration — including the
 * spawn, the exit code and the two object transfers — is exercised without a
 * browser, a model, a database or object storage. Every response shape here is
 * transcribed from `docs/architecture/cover-reveal-worker-protocol.md`; the
 * point of the test is that the client is held to the frozen contract rather
 * than to the server's source.
 */

const CLIENT_PATH = fileURLToPath(new URL("./cover-reveal-worker.mjs", import.meta.url));

/** The five routes the client is allowed to speak, and nothing else. */
const WORKER_ROUTES = [
  "/api/cover-reveal-worker/claim",
  "/api/cover-reveal-worker/jobs/:id/source-read",
  "/api/cover-reveal-worker/jobs/:id/output-upload",
  "/api/cover-reveal-worker/jobs/:id/complete",
  "/api/cover-reveal-worker/jobs/:id/fail",
];

const JOB_ID = "6f1f9c60-8c5b-4c2a-9a1f-0d1b6a2c4e88";
const JOURNEY_ID = "1b2c3d4e-5f60-4a1b-8c2d-3e4f5a6b7c8d";
const LEASE_TOKEN = "lease-token-for-the-one-claim";
const SOURCE_BYTES = Buffer.from("a pinned cover photograph");
const OUTPUT_MAX_BYTES = 65536;

function jpeg(size = 512) {
  const buffer = Buffer.alloc(size, 0x20);
  buffer[0] = 0xff;
  buffer[1] = 0xd8;
  buffer[2] = 0xff;
  buffer[3] = 0xe0;
  buffer[size - 2] = 0xff;
  buffer[size - 1] = 0xd9;
  return buffer;
}

function derivative(state) {
  return {
    id: JOB_ID,
    journeyId: JOURNEY_ID,
    state,
    generationKind: "ink-wash-poster",
    generationVersion: 1,
    presetId: "reveal-flow-ink-wash-v1",
    seed: "fixture-seed",
    sourceMediaAssetId: "0a9e1c34-5b67-4d89-9e01-2f3a4b5c6d7e",
    sourceContentHash: "sha256:fixture",
    attempts: 0,
    lastErrorCode: null,
  };
}

/**
 * The protocol stub. `plan` scripts one scenario: which verb refuses, with
 * which documented error, and in what order. Everything it receives is
 * recorded, so a test can assert what the client said as well as what it did.
 */
async function startStubServer(plan = {}) {
  const requests = [];
  const uploads = [];
  const completeScript = [...(plan.complete ?? [])];
  plan = { ...plan, outputUpload: [...(plan.outputUpload ?? [])] };
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const raw = Buffer.concat(chunks);
      const send = (status, payload) => {
        const body = JSON.stringify(payload);
        response.writeHead(status, {
          "content-type": "application/json",
          "cache-control": "private, no-store",
        });
        response.end(body);
      };
      const authorization = request.headers.authorization ?? null;
      let body = null;
      if (raw.length > 0 && request.method === "POST") {
        try {
          body = JSON.parse(raw.toString("utf8"));
        } catch {
          body = null;
        }
      }
      requests.push({
        method: request.method,
        pathname: url.pathname,
        authorization,
        leaseToken: body?.leaseToken ?? null,
        reason: body?.reason ?? null,
      });

      if (url.pathname === "/stub/source" && request.method === "GET") {
        response.writeHead(200, { "content-type": "image/jpeg" });
        response.end(SOURCE_BYTES);
        return;
      }
      if (url.pathname === "/stub/upload" && request.method === "PUT") {
        uploads.push(raw);
        response.writeHead(200);
        response.end();
        return;
      }

      if (!authorization || !authorization.startsWith("Bearer ")) {
        send(401, { error: "COVER_REVEAL_WORKER_UNAUTHORIZED" });
        return;
      }

      if (url.pathname === "/api/cover-reveal-worker/claim") {
        if (plan.noWork) {
          send(404, { error: "COVER_REVEAL_NO_WORK" });
          return;
        }
        send(200, {
          derivative: derivative("leased"),
          lease: {
            token: LEASE_TOKEN,
            expiresAt: new Date(Date.now() + 600000).toISOString(),
          },
          output: {
            mimeType: "image/jpeg",
            maxBytes: OUTPUT_MAX_BYTES,
            maxEdgePixels: 2048,
          },
        });
        return;
      }

      const base = "/api/cover-reveal-worker/jobs/" + JOB_ID + "/";
      if (url.pathname === base + "source-read") {
        if (plan.sourceRead) {
          send(plan.sourceRead.status, { error: plan.sourceRead.error });
          return;
        }
        send(200, {
          source: {
            url: serverOrigin + "/stub/source",
            expiresAt: new Date(Date.now() + 300000).toISOString(),
            mimeType: "image/jpeg",
            bytes: SOURCE_BYTES.length,
          },
        });
        return;
      }
      if (url.pathname === base + "output-upload") {
        const scripted = (plan.outputUpload ?? []).shift();
        if (scripted) {
          send(scripted.status, { error: scripted.error });
          return;
        }
        send(200, {
          upload: {
            url: serverOrigin + "/stub/upload",
            headers: { "content-type": "image/jpeg" },
            expiresAt: new Date(Date.now() + 600000).toISOString(),
            mimeType: "image/jpeg",
            maxBytes: OUTPUT_MAX_BYTES,
            maxEdgePixels: 2048,
          },
        });
        return;
      }
      if (url.pathname === base + "complete") {
        const next = completeScript.shift();
        if (next === "unavailable") {
          send(503, { error: "STORAGE_UNAVAILABLE" });
          return;
        }
        if (next === "output-missing") {
          send(409, { error: "COVER_REVEAL_OUTPUT_MISSING" });
          return;
        }
        if (next === "not-claimed") {
          send(404, { error: "COVER_REVEAL_NOT_CLAIMED" });
          return;
        }
        if (next === "too-large") {
          send(409, { error: "COVER_REVEAL_OUTPUT_TOO_LARGE" });
          return;
        }
        send(200, { derivative: { ...derivative("ready"), state: "ready" } });
        return;
      }
      if (url.pathname === base + "fail") {
        if (plan.fail) {
          send(plan.fail.status, { error: plan.fail.error });
          return;
        }
        send(200, { derivative: derivative("queued") });
        return;
      }
      send(404, { error: "COVER_REVEAL_NOT_CLAIMED" });
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const serverOrigin = "http://127.0.0.1:" + server.address().port;
  return {
    origin: serverOrigin,
    requests,
    uploads,
    async close() {
      // `fetch` keeps its sockets alive, and `close()` waits for open
      // connections, so a plain close would hang the suite.
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

let workspace;
let generators;

async function writeGenerator(name, source) {
  const file = path.join(generators, name);
  await writeFile(file, source, "utf8");
  return file;
}

function configFor(origin, generatorPath, extra = {}) {
  return resolveWorkerConfig({
    STARTRIPS_API_ORIGIN: origin,
    COVER_REVEAL_WORKER_TOKEN: "a-worker-credential-of-more-than-32-bytes",
    COVER_REVEAL_GENERATOR_COMMAND: process.execPath,
    COVER_REVEAL_GENERATOR_ARGS: JSON.stringify([generatorPath]),
    COVER_REVEAL_WORKER_WORKDIR: workspace,
    ...extra,
  });
}

async function runIteration(server, generatorPath, options = {}) {
  const workdir = await mkdtemp(path.join(workspace, "run-"));
  const logs = [];
  const result = await runCoverRevealWorkerIteration({
    config: configFor(server.origin, generatorPath),
    workdir,
    retryDelayMs: 0,
    log: (event, fields) => logs.push({ event, ...fields }),
    ...options,
  });
  const leftovers = await readdir(workdir);
  await rm(workdir, { recursive: true, force: true });
  return { ...result, logs, leftovers };
}

const READ_REQUEST = `
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
`;

const GOOD_GENERATOR = `
import { readFileSync, writeFileSync } from "node:fs";
${READ_REQUEST}
const source = readFileSync(request.sourcePath);
if (source.length === 0) throw new Error("empty source");
const out = Buffer.alloc(512, 0x20);
out[0] = 0xff; out[1] = 0xd8; out[2] = 0xff; out[3] = 0xe0;
out[510] = 0xff; out[511] = 0xd9;
writeFileSync(request.outputPath, out);
`;

const FAILING_GENERATOR = `
process.stderr.write("the model refused\\n");
process.exit(3);
`;

const OVERSIZED_GENERATOR = `
import { writeFileSync } from "node:fs";
${READ_REQUEST}
const out = Buffer.alloc(request.maxBytes + 1024, 0x20);
out[0] = 0xff; out[1] = 0xd8; out[2] = 0xff; out[3] = 0xe0;
writeFileSync(request.outputPath, out);
`;

const NOT_AN_IMAGE_GENERATOR = `
import { writeFileSync } from "node:fs";
${READ_REQUEST}
writeFileSync(request.outputPath, "<svg xmlns='http://www.w3.org/2000/svg'/>");
`;

beforeEach(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "cover-reveal-client-test-"));
  generators = await mkdtemp(path.join(workspace, "generators-"));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe("cover-reveal reference worker client (#468, slice 2 of #367)", () => {
  it("exits cleanly when the server has no work, without claiming anything else", async () => {
    const server = await startStubServer({ noWork: true });
    try {
      const generator = await writeGenerator("good.mjs", GOOD_GENERATOR);
      const result = await runIteration(server, generator);
      expect(result.outcome).toBe("no-work");
      expect(result.exitCode).toBe(EXIT_CODES.ok);
      expect(server.requests.map((entry) => entry.pathname)).toEqual([
        "/api/cover-reveal-worker/claim",
      ]);
      expect(server.uploads).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it("drives one whole iteration and threads the lease through every request", async () => {
    const server = await startStubServer();
    try {
      const generator = await writeGenerator("good.mjs", GOOD_GENERATOR);
      const result = await runIteration(server, generator);
      expect(result.outcome).toBe("completed");
      expect(result.exitCode).toBe(EXIT_CODES.ok);

      const workerCalls = server.requests.filter((entry) =>
        entry.pathname.startsWith("/api/"),
      );
      expect(workerCalls.map((entry) => entry.pathname)).toEqual([
        "/api/cover-reveal-worker/claim",
        "/api/cover-reveal-worker/jobs/" + JOB_ID + "/source-read",
        "/api/cover-reveal-worker/jobs/" + JOB_ID + "/output-upload",
        "/api/cover-reveal-worker/jobs/" + JOB_ID + "/complete",
      ]);
      // Lease/job identity from the claim, carried by every later request.
      for (const call of workerCalls.slice(1)) {
        expect(call.leaseToken).toBe(LEASE_TOKEN);
        expect(call.pathname).toContain(JOB_ID);
      }
      for (const call of workerCalls) {
        expect(call.authorization).toMatch(/^Bearer /);
      }
      expect(server.uploads).toHaveLength(1);
      expect(sniffImageMimeType(server.uploads[0])).toBe("image/jpeg");
      // Everything the iteration wrote is inside the directory its caller owns
      // and removes; nothing lands anywhere else.
      expect(result.leftovers.sort()).toEqual(["output.jpg", "source"]);
    } finally {
      await server.close();
    }
  });

  it("never writes the lease token or a signed URL into its log", async () => {
    const server = await startStubServer();
    try {
      const generator = await writeGenerator("good.mjs", GOOD_GENERATOR);
      const result = await runIteration(server, generator);
      const serialized = JSON.stringify(result.logs);
      expect(serialized).not.toContain(LEASE_TOKEN);
      expect(serialized).not.toContain("/stub/source");
      expect(serialized).not.toContain("/stub/upload");
      expect(serialized).toContain("[redacted]");
    } finally {
      await server.close();
    }
  });

  it("reports a generator failure against its own claim and uploads nothing", async () => {
    const server = await startStubServer();
    try {
      const generator = await writeGenerator("failing.mjs", FAILING_GENERATOR);
      const result = await runIteration(server, generator);
      expect(result.outcome).toBe("generator-failed");
      expect(result.exitCode).toBe(EXIT_CODES.attemptFailed);
      const failCall = server.requests.find((entry) => entry.pathname.endsWith("/fail"));
      expect(failCall?.reason).toBe("WORKER_GENERATION_FAILED");
      expect(failCall?.leaseToken).toBe(LEASE_TOKEN);
      expect(server.uploads).toHaveLength(0);
      expect(
        server.requests.some((entry) => entry.pathname.endsWith("/output-upload")),
      ).toBe(false);
    } finally {
      await server.close();
    }
  });

  it("rejects an oversized output before asking for an upload capability", async () => {
    const server = await startStubServer();
    try {
      const generator = await writeGenerator("oversized.mjs", OVERSIZED_GENERATOR);
      const result = await runIteration(server, generator);
      expect(result.outcome).toBe("output-invalid");
      expect(result.reason).toBe("OUTPUT_TOO_LARGE");
      expect(result.exitCode).toBe(EXIT_CODES.outputRejected);
      expect(
        server.requests.some((entry) => entry.pathname.endsWith("/output-upload")),
      ).toBe(false);
      expect(server.uploads).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it("rejects an output that is not the issued image type", async () => {
    const server = await startStubServer();
    try {
      const generator = await writeGenerator("not-image.mjs", NOT_AN_IMAGE_GENERATOR);
      const result = await runIteration(server, generator);
      expect(result.outcome).toBe("output-invalid");
      expect(result.reason).toBe("OUTPUT_NOT_AN_IMAGE");
      expect(server.uploads).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it("fails closed on a stale lease and does not settle a claim it lost", async () => {
    const server = await startStubServer({
      sourceRead: { status: 404, error: "COVER_REVEAL_NOT_CLAIMED" },
    });
    try {
      const generator = await writeGenerator("good.mjs", GOOD_GENERATOR);
      const result = await runIteration(server, generator);
      expect(result.outcome).toBe("lease-lost");
      expect(result.exitCode).toBe(EXIT_CODES.leaseLost);
      expect(result.exitCode).not.toBe(EXIT_CODES.ok);
      // Another claimant owns the job now; reporting a failure against its
      // claim is not this process's to do.
      expect(server.requests.some((entry) => entry.pathname.endsWith("/fail"))).toBe(
        false,
      );
      expect(server.uploads).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it("fails closed when the completion says another claimant settled the job", async () => {
    const server = await startStubServer({ complete: ["not-claimed"] });
    try {
      const generator = await writeGenerator("good.mjs", GOOD_GENERATOR);
      const result = await runIteration(server, generator);
      expect(result.outcome).toBe("lease-lost");
      expect(result.exitCode).toBe(EXIT_CODES.leaseLost);
      expect(server.requests.some((entry) => entry.pathname.endsWith("/fail"))).toBe(
        false,
      );
    } finally {
      await server.close();
    }
  });

  it("retries an ambiguous completion rather than guessing either way", async () => {
    const server = await startStubServer({ complete: ["unavailable", "ok"] });
    try {
      const generator = await writeGenerator("good.mjs", GOOD_GENERATOR);
      const result = await runIteration(server, generator);
      expect(result.outcome).toBe("completed");
      expect(result.exitCode).toBe(EXIT_CODES.ok);
      const completions = server.requests.filter((entry) =>
        entry.pathname.endsWith("/complete"),
      );
      expect(completions).toHaveLength(2);
      expect(completions[1].leaseToken).toBe(LEASE_TOKEN);
      // The bytes were already delivered; an ambiguous answer is not a reason
      // to regenerate them.
      expect(server.uploads).toHaveLength(1);
      expect(result.logs.some((entry) => entry.event === "complete.ambiguous")).toBe(
        true,
      );
    } finally {
      await server.close();
    }
  });

  it("re-delivers the bytes when the completion reports the output missing", async () => {
    const server = await startStubServer({ complete: ["output-missing", "ok"] });
    try {
      const generator = await writeGenerator("good.mjs", GOOD_GENERATOR);
      const result = await runIteration(server, generator);
      expect(result.outcome).toBe("completed");
      // A retryable missing output is re-signed and re-PUT, not regenerated.
      expect(
        server.requests.filter((entry) => entry.pathname.endsWith("/output-upload")),
      ).toHaveLength(2);
      expect(server.uploads).toHaveLength(2);
      expect(server.uploads[0].equals(server.uploads[1])).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("never reports success when every completion attempt stays ambiguous", async () => {
    const server = await startStubServer({
      complete: ["unavailable", "unavailable", "unavailable"],
    });
    try {
      const generator = await writeGenerator("good.mjs", GOOD_GENERATOR);
      const result = await runIteration(server, generator);
      expect(result.outcome).toBe("ambiguous");
      expect(result.exitCode).not.toBe(EXIT_CODES.ok);
      expect(server.requests.some((entry) => entry.pathname.endsWith("/fail"))).toBe(
        false,
      );
    } finally {
      await server.close();
    }
  });

  it("leaves a server-settled rejection alone", async () => {
    const server = await startStubServer({ complete: ["too-large"] });
    try {
      const generator = await writeGenerator("good.mjs", GOOD_GENERATOR);
      const result = await runIteration(server, generator);
      expect(result.outcome).toBe("rejected");
      expect(result.exitCode).toBe(EXIT_CODES.outputRejected);
      expect(server.requests.some((entry) => entry.pathname.endsWith("/fail"))).toBe(
        false,
      );
    } finally {
      await server.close();
    }
  });

  it(
    "cleans up and leaves the lease reclaimable when it is interrupted mid-generation",
    async () => {
      const server = await startStubServer();
      const marker = path.join(workspace, "generator-started");
      const generator = await writeGenerator(
        "hanging.mjs",
        `
import { writeFileSync } from "node:fs";
${READ_REQUEST}
if (!request.sourcePath) throw new Error("no source");
writeFileSync(${JSON.stringify(marker)}, "started");
setInterval(() => {}, 1000);
`,
      );
      const child = spawn(process.execPath, [CLIENT_PATH], {
        env: {
          ...process.env,
          STARTRIPS_API_ORIGIN: server.origin,
          COVER_REVEAL_WORKER_TOKEN: "a-worker-credential-of-more-than-32-bytes",
          COVER_REVEAL_GENERATOR_COMMAND: process.execPath,
          COVER_REVEAL_GENERATOR_ARGS: JSON.stringify([generator]),
          COVER_REVEAL_WORKER_WORKDIR: workspace,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      try {
        await waitFor(async () => {
          try {
            await readFile(marker);
            return true;
          } catch {
            return false;
          }
        });
        child.kill("SIGINT");
        const [exitCode] = await new Promise((resolve) =>
          child.once("exit", (code, signal) => resolve([code, signal])),
        );

        // Nothing was published and nothing was settled: the job is exactly as
        // the server left it, reclaimable by the existing lease expiry.
        expect(server.uploads).toHaveLength(0);
        expect(
          server.requests.some(
            (entry) =>
              entry.pathname.endsWith("/complete") || entry.pathname.endsWith("/fail"),
          ),
        ).toBe(false);

        if (process.platform !== "win32") {
          // POSIX delivers SIGINT to the handler, so the temporary directory is
          // removed. Windows terminates without running it; CI is ubuntu.
          expect(exitCode).toBe(EXIT_CODES.interrupted);
          const leftovers = (await readdir(workspace)).filter((entry) =>
            entry.startsWith("startrips-cover-reveal-"),
          );
          expect(leftovers).toEqual([]);
        }

        // A fresh invocation after the reclaim takes the job and finishes it,
        // so the crash cost one lease window and nothing else.
        const good = await writeGenerator("good.mjs", GOOD_GENERATOR);
        const restarted = await runIteration(server, good);
        expect(restarted.outcome).toBe("completed");
        expect(restarted.exitCode).toBe(EXIT_CODES.ok);
        expect(server.uploads).toHaveLength(1);
      } finally {
        child.kill("SIGKILL");
        await server.close();
      }
    },
    20000,
  );

  it("passes the generator only local paths and the job's pinned parameters", () => {
    const request = buildGeneratorRequest({
      job: derivative("leased"),
      output: { mimeType: "image/jpeg", maxBytes: OUTPUT_MAX_BYTES, maxEdgePixels: 2048 },
      sourcePath: "/tmp/source",
      outputPath: "/tmp/output.jpg",
    });
    expect(request).toEqual({
      contractVersion: 1,
      sourcePath: "/tmp/source",
      outputPath: "/tmp/output.jpg",
      mimeType: "image/jpeg",
      maxBytes: OUTPUT_MAX_BYTES,
      maxEdgePixels: 2048,
      generationKind: "ink-wash-poster",
      generationVersion: 1,
      presetId: "reveal-flow-ink-wash-v1",
      seed: "fixture-seed",
    });
    // No URL, no lease token, no credential crosses the adapter boundary.
    const serialized = JSON.stringify(request);
    expect(serialized).not.toContain("http");
    expect(serialized).not.toContain(LEASE_TOKEN);
  });

  it("reaches nothing but the five worker routes and the objects it is handed", async () => {
    const source = await readFile(CLIENT_PATH, "utf8");
    const imports = [...source.matchAll(/^import .*? from "([^"]+)";$/gm)].map(
      (match) => match[1],
    );
    expect(imports.every((specifier) => specifier.startsWith("node:"))).toBe(true);
    // The routes are built by concatenation around the job id, so each one is
    // present as its prefix plus its verb suffix.
    for (const route of WORKER_ROUTES) {
      const [prefix, verb] = route.split("/:id/");
      expect(source).toContain(prefix);
      if (verb) expect(source).toContain("/" + verb);
    }
    // And no dynamic escape hatch: a bare-specifier `import()` or a `require()`
    // would be a dependency the static import list above cannot see.
    expect(source).not.toMatch(/\brequire\s*\(/);
    expect(source).not.toMatch(/\bimport\s*\(\s*["'](?!node:)/);
  });

  it("refuses to start without its configuration", () => {
    expect(() => resolveWorkerConfig({})).toThrow(/STARTRIPS_API_ORIGIN/);
    expect(() =>
      resolveWorkerConfig({ STARTRIPS_API_ORIGIN: "file:///etc" }),
    ).toThrow(/http or https/);
    expect(() =>
      resolveWorkerConfig({
        STARTRIPS_API_ORIGIN: "https://startrips.test",
        COVER_REVEAL_WORKER_TOKEN: "a-worker-credential-of-more-than-32-bytes",
      }),
    ).toThrow(/COVER_REVEAL_GENERATOR_COMMAND/);
  });

  it("reports an exhausted output-missing budget as unresolved, not rejected", async () => {
    const server = await startStubServer({
      complete: ["output-missing", "output-missing", "output-missing"],
    });
    try {
      const generator = await writeGenerator("good.mjs", GOOD_GENERATOR);
      const result = await runIteration(server, generator);
      // The server leaves the job leased and retryable in this state, so
      // calling it a rejection would tell the operator the wrong thing.
      expect(result.outcome).toBe("ambiguous");
      expect(result.exitCode).toBe(EXIT_CODES.unavailable);
      expect(result.exitCode).not.toBe(EXIT_CODES.outputRejected);
      expect(server.requests.some((entry) => entry.pathname.endsWith("/fail"))).toBe(
        false,
      );
    } finally {
      await server.close();
    }
  });

  it("keeps a lease lost while re-signing an upload as a lost lease", async () => {
    const server = await startStubServer({
      complete: ["output-missing", "ok"],
      // The first signing succeeds; the re-sign after the missing output finds
      // the claim reclaimed.
      outputUpload: [null, { status: 409, error: "COVER_REVEAL_NOT_LEASED" }],
    });
    try {
      const generator = await writeGenerator("good.mjs", GOOD_GENERATOR);
      const result = await runIteration(server, generator);
      expect(result.outcome).toBe("lease-lost");
      expect(result.exitCode).toBe(EXIT_CODES.leaseLost);
      expect(result.exitCode).not.toBe(EXIT_CODES.outputRejected);
    } finally {
      await server.close();
    }
  });

  it("does not claim an attempt was reported when the fail itself is refused", async () => {
    const server = await startStubServer({
      fail: { status: 404, error: "COVER_REVEAL_NOT_CLAIMED" },
    });
    try {
      const generator = await writeGenerator("failing.mjs", FAILING_GENERATOR);
      const result = await runIteration(server, generator);
      // The generation did fail, but the lease was gone before it could say so,
      // and the outcome has to describe what the server accepted.
      expect(result.outcome).toBe("lease-lost");
      expect(result.exitCode).toBe(EXIT_CODES.leaseLost);
      expect(result.exitCode).not.toBe(EXIT_CODES.attemptFailed);
      const failLog = result.logs.find((entry) => entry.event === "attempt.failed");
      expect(failLog?.reportDelivered).toBe(false);
    } finally {
      await server.close();
    }
  });

  it("signals the generator's whole process group rather than the wrapper PID", async () => {
    // The adapter is usually a wrapper that launches the real model process, so
    // the client starts it as a process-group leader and signals the group.
    const source = await readFile(CLIENT_PATH, "utf8");
    expect(source).toContain("detached: process.platform !== \"win32\"");
    expect(source).toContain("process.kill(-child.pid");
    expect(source).toContain("taskkill");
  });

  it("decides the output type from the bytes rather than from the file name", () => {
    expect(sniffImageMimeType(jpeg())).toBe("image/jpeg");
    expect(sniffImageMimeType(Buffer.from("<svg />"))).toBeNull();
    expect(
      validateGeneratedOutput({
        buffer: jpeg(),
        expectedMimeType: "image/jpeg",
        maxBytes: OUTPUT_MAX_BYTES,
      }),
    ).toMatchObject({ ok: true, mimeType: "image/jpeg" });
    expect(
      validateGeneratedOutput({
        buffer: jpeg(OUTPUT_MAX_BYTES + 1),
        expectedMimeType: "image/jpeg",
        maxBytes: OUTPUT_MAX_BYTES,
      }),
    ).toMatchObject({ ok: false, reason: "OUTPUT_TOO_LARGE" });
    expect(
      validateGeneratedOutput({
        buffer: Buffer.alloc(0),
        expectedMimeType: "image/jpeg",
        maxBytes: OUTPUT_MAX_BYTES,
      }),
    ).toMatchObject({ ok: false, reason: "OUTPUT_EMPTY" });
  });
});

async function waitFor(predicate, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error("timed out waiting for the generator");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

import { describe, expect, it, vi } from "vitest";
import { contentHashOfFile, uploadMediaInParts } from "./multipartUpload";

describe("contentHashOfFile", () => {
  it("returns the sha256 hex digest of a small file", async () => {
    const hash = await contentHashOfFile(new Blob(["startrips"]));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toBeUndefined();
  });

  it("is deterministic for identical content", async () => {
    const first = await contentHashOfFile(new Blob(["memory.jpg"]));
    const second = await contentHashOfFile(new Blob(["memory.jpg"]));
    expect(first).toBe(second);
  });

  it("skips hashing oversized files to avoid buffering them in memory", async () => {
    const big = new Blob(["x".repeat(1024)]);
    Object.defineProperty(big, "size", { value: 129 * 1024 * 1024 });
    await expect(contentHashOfFile(big)).resolves.toBeUndefined();
  });
});

describe("uploadMediaInParts", () => {
  it("uploads bounded chunks and completes them in order", async () => {
    const uploadedSizes: number[] = [];
    const routePointId = "11111111-1111-4111-8111-111111111111";
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/uploads/start") {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          journeyId: "journey-1",
          routePointId,
        });
        return Response.json({ uploadId: "upload-1", partSize: 4, partCount: 3 });
      }
      if (url.includes("/parts/")) {
        const partNumber = Number(url.split("/").at(-1));
        return Response.json({
          url: `https://storage.invalid/${partNumber}`,
          headers: {},
        });
      }
      if (url.startsWith("https://storage.invalid/")) {
        uploadedSizes.push((init?.body as Blob).size);
        return new Response(null, {
          status: 200,
          headers: { etag: `etag-${url.at(-1)}` },
        });
      }
      if (url.endsWith("/complete")) {
        const body = JSON.parse(String(init?.body)) as {
          parts: { partNumber: number }[];
        };
        expect(body.parts.map((part) => part.partNumber)).toEqual([1, 2, 3]);
        return Response.json({ asset: { id: "asset-1" } });
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as unknown as typeof fetch;

    const result = await uploadMediaInParts({
      file: new Blob(["abcdefghij"], { type: "image/webp" }),
      fileName: "memory.webp",
      journeyId: "journey-1",
      routePointId,
      concurrency: 2,
      fetcher,
    });

    expect(result.id).toBe("asset-1");
    expect(uploadedSizes.sort((left, right) => left - right)).toEqual([2, 4, 4]);
  });

  it("retries ambiguous completion without aborting the upload", async () => {
    let completionAttempts = 0;
    let abortAttempts = 0;
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/uploads/start") {
        return Response.json({ uploadId: "upload-2", partSize: 8, partCount: 1 });
      }
      if (url.endsWith("/parts/1")) {
        return Response.json({ url: "https://storage.invalid/only", headers: {} });
      }
      if (url === "https://storage.invalid/only") {
        return new Response(null, { status: 200, headers: { etag: "etag-only" } });
      }
      if (url.endsWith("/complete")) {
        completionAttempts += 1;
        if (completionAttempts === 1) throw new TypeError("network timeout");
        return Response.json({ asset: { id: "asset-2" } });
      }
      if (url === "/api/uploads/upload-2") {
        abortAttempts += 1;
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as unknown as typeof fetch;

    const result = await uploadMediaInParts({
      file: new Blob(["abcdefgh"], { type: "image/webp" }),
      fileName: "memory.webp",
      journeyId: "journey-2",
      fetcher,
    });

    expect(result.id).toBe("asset-2");
    expect(completionAttempts).toBe(2);
    expect(abortAttempts).toBe(0);
  });

  it("cancels and settles sibling workers before aborting the server upload", async () => {
    let siblingSettled = false;
    let serverAbortAfterSettle = false;
    const fetcher = vi.fn(async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = String(input);
      if (url === "/api/uploads/start") {
        return Response.json({ uploadId: "upload-3", partSize: 4, partCount: 2 });
      }
      if (url.includes("/parts/")) {
        const part = url.at(-1);
        return Response.json({ url: `https://storage.invalid/fail-${part}`, headers: {} });
      }
      if (url === "https://storage.invalid/fail-1") {
        return new Response(null, { status: 500 });
      }
      if (url === "https://storage.invalid/fail-2") {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            siblingSettled = true;
            reject(new DOMException("aborted", "AbortError"));
          }, { once: true });
        });
      }
      if (url === "/api/uploads/upload-3") {
        serverAbortAfterSettle = siblingSettled;
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as unknown as typeof fetch;

    await expect(uploadMediaInParts({
      file: new Blob(["abcdefgh"], { type: "image/webp" }),
      fileName: "memory.webp",
      journeyId: "journey-3",
      concurrency: 2,
      fetcher,
    })).rejects.toThrow("Part 1 failed");
    expect(serverAbortAfterSettle).toBe(true);
  });
});

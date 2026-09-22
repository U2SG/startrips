import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  ItineraryImportStageError,
} from "./itinerary-recognition";
import { nodeSourcePageTransport } from "./itinerary-source-fetch";

/**
 * #512: the hop transport itself, against a real socket.
 *
 * Everything else about the guard is asserted with an injected transport,
 * which proves the pin is built and handed over but not that the runtime obeys
 * it. That distinction is the whole defect the pin exists to close, so this
 * file exercises the default transport for real: a hostname that resolves
 * nowhere is requested successfully through a pinned resolver, which is only
 * possible if the resolver is the one actually used for the connection.
 *
 * The server is a loopback listener inside the test process. No network leaves
 * the runner and no fixture is downloaded.
 */

let server: Server | null = null;

afterEach(async () => {
  if (!server) return;
  const closing = server;
  server = null;
  await new Promise<void>((resolve) => closing.close(() => resolve()));
});

async function listen(
  handler: (path: string) => { body: string; contentType?: string },
): Promise<{ port: number; hosts: string[] }> {
  const hosts: string[] = [];
  server = createServer((request, response) => {
    hosts.push(request.headers.host ?? "");
    const reply = handler(request.url ?? "/");
    response.writeHead(200, { "content-type": reply.contentType ?? "text/html" });
    response.end(reply.body);
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as AddressInfo).port, hosts };
}

/** A resolver that answers one fixed address, exactly as the guard builds it. */
function pinnedTo(address: string) {
  return (
    _hostname: string,
    options: { all?: boolean } | undefined,
    callback: (
      error: Error | null,
      value: Array<{ address: string; family: number }> | string,
      family?: number,
    ) => void,
  ) => {
    if (options?.all) callback(null, [{ address, family: 4 }]);
    else callback(null, address, 4);
  };
}

describe("the default hop transport", () => {
  it("connects where the pin says, not where the name resolves", async () => {
    const { port, hosts } = await listen(() => ({ body: "<html>plan</html>" }));

    const reply = await nodeSourcePageTransport({
      // A name with no DNS record at all: if the pinned resolver were ignored,
      // this request could not be made.
      url: new URL(`http://plans.invalid:${port}/tripmap/routePlan`),
      lookup: pinnedTo("127.0.0.1"),
      timeoutMs: 5_000,
      maxBytes: 1_000_000,
      signal: new AbortController().signal,
    });

    expect(reply.status).toBe(200);
    expect(new TextDecoder().decode(reply.body)).toBe("<html>plan</html>");
    expect(reply.headers["content-type"]).toBe("text/html");
    // The hostname still travels as the Host header, so the page is asked for
    // as itself and TLS would still be validated against its own name.
    expect(hosts[0]).toBe(`plans.invalid:${port}`);
  });

  it("refuses an over-long page as too large rather than letting it hang", async () => {
    const { port } = await listen(() => ({ body: "x".repeat(20_000) }));

    await expect(nodeSourcePageTransport({
      url: new URL(`http://plans.invalid:${port}/tripmap/routePlan`),
      lookup: pinnedTo("127.0.0.1"),
      timeoutMs: 5_000,
      maxBytes: 64,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: "ITINERARY_SOURCE_TOO_LARGE",
      stage: "content-read",
    });
  });

  it("reports a resolver that has nothing left to answer with", async () => {
    const { port } = await listen(() => ({ body: "<html>plan</html>" }));

    const failure = await nodeSourcePageTransport({
      url: new URL(`http://plans.invalid:${port}/tripmap/routePlan`),
      lookup: (_hostname, _options, callback) =>
        callback(new Error("no verified address remains for this hop"), []),
      timeoutMs: 5_000,
      maxBytes: 1_000_000,
      signal: new AbortController().signal,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(ItineraryImportStageError);
  });
});

import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PinnedLookup } from "../itinerary/itinerary-source-fetch";

/**
 * #512, the HTTP surface of the import channel.
 *
 * Nothing here talks to PostgreSQL, to a provider or to the network: the Atlas
 * boundary, the configuration and both outbound calls are handed in, because
 * what these tests are about is the guard, the truthful degrade and the shape
 * of the reading — all of which have to hold before any of that exists.
 */

const config = vi.hoisted(() => ({
  serverConfig: {
    itineraryRecognitionDriver: "disabled",
    itineraryRecognitionBaseUrl: null as string | null,
    itineraryRecognitionApiKey: null as string | null,
    itineraryRecognitionModel: "unversioned",
    itineraryRecognitionTimeoutMs: 60_000,
    itinerarySourceFetchDriver: "disabled",
    itinerarySourceRenderUrl: null as string | null,
    itinerarySourceFetchTimeoutMs: 20_000,
    itinerarySourceMaxBytes: 4 * 1024 * 1024,
  },
}));

vi.mock("../config", () => config);
vi.mock("../authorization/atlas-access", () => ({
  requireAtlasAccess: vi.fn(async () => ({ atlas: { id: "atlas-1" } })),
}));

const {
  itineraryImportDependencies,
  itineraryImportRoutes,
} = await import("./itinerary-import");
const {
  ItineraryImportStageError,
  itineraryImportStageFailure,
  parseRecognitionCandidates,
} = await import("../itinerary/itinerary-recognition");
const {
  createPinnedLookup,
  isBlockedSourceAddress,
} = await import("../itinerary/itinerary-source-fetch");
type AddressLookup = (hostname: string) => Promise<
  Array<{ address: string; family: number }>
>;


// The same mapping `server/app.ts` answers with, so the envelope under test is
// the envelope a client sees.
const app = new Hono()
  .route("/api/itinerary-import", itineraryImportRoutes)
  .onError((error, context) => {
    if (error instanceof ItineraryImportStageError) {
      const failure = itineraryImportStageFailure(error);
      return context.json(failure.body, failure.status as 400);
    }
    throw error;
  });

const PUBLIC_ADDRESS = [{ address: "93.184.216.34", family: 4 }];

const upstream = vi.fn<typeof fetch>();
const lookup = vi.fn<AddressLookup>();

/**
 * Every hop a member's link produces, as the route actually issued it.
 *
 * The hop transport is injected rather than `fetch`-shaped because the guard's
 * whole point is that a hop is pinned to the addresses that were checked: the
 * pin travels as `request.lookup`, so a test can ask that resolver where the
 * connection would have been allowed to go. `upstream` still answers the hop,
 * so the existing call-count assertions keep meaning what they said.
 */
const hops: Array<{ url: string; lookup: PinnedLookup }> = [];

const sourceTransport = async (
  request: { url: URL; lookup: PinnedLookup },
): Promise<{
  status: number;
  headers: Record<string, string | undefined>;
  body: Uint8Array;
}> => {
  hops.push({ url: request.url.toString(), lookup: request.lookup });
  const response = await upstream(request.url.toString(), {
    method: "GET",
    redirect: "manual",
  });
  const headers: Record<string, string | undefined> = {};
  response.headers.forEach((value, key) => { headers[key] = value; });
  return {
    status: response.status,
    headers,
    body: new Uint8Array(await response.arrayBuffer()),
  };
};

/** What one pinned resolver is willing to answer with. */
function pinnedAddresses(pin: PinnedLookup): string[] {
  let answered: string[] = [];
  pin("anything.example", { all: true }, (error, addresses) => {
    if (error || typeof addresses === "string") return;
    answered = addresses.map((entry) => entry.address);
  });
  return answered;
}

function post(body: unknown) {
  return app.request("/api/itinerary-import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const READING = {
  contractVersion: 1,
  sourceTitle: "3-day trip",
  sourceReportedDayCount: 3,
  sourceReportedPlaceCount: 4,
  days: [
    {
      dayNumber: 1,
      sourceDayTitle: "Day 1",
      calendarDate: "2026-03-14",
      partialDate: null,
      regionContext: "Chengdu",
    },
  ],
  entries: [
    {
      sourceEntryId: "e1",
      dayNumber: 1,
      orderInDay: 1,
      name: "宽窄巷子",
      role: "attraction",
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  hops.length = 0;
  lookup.mockResolvedValue(PUBLIC_ADDRESS);
  itineraryImportDependencies.fetcher = upstream;
  itineraryImportDependencies.lookup = lookup;
  itineraryImportDependencies.sourceTransport = sourceTransport;
  Object.assign(config.serverConfig, {
    itineraryRecognitionDriver: "disabled",
    itineraryRecognitionBaseUrl: null,
    itineraryRecognitionApiKey: null,
    itineraryRecognitionModel: "unversioned",
    itineraryRecognitionTimeoutMs: 60_000,
    itinerarySourceFetchDriver: "disabled",
    itinerarySourceRenderUrl: null,
    itinerarySourceFetchTimeoutMs: 20_000,
    itinerarySourceMaxBytes: 4 * 1024 * 1024,
  });
});

afterEach(() => {
  itineraryImportDependencies.fetcher = undefined;
  itineraryImportDependencies.lookup = undefined;
  itineraryImportDependencies.sourceTransport = undefined;
});

function enableProviders() {
  config.serverConfig.itinerarySourceFetchDriver = "http";
  config.serverConfig.itineraryRecognitionDriver = "http-model";
  config.serverConfig.itineraryRecognitionBaseUrl = "https://recognizer.example/read";
  config.serverConfig.itineraryRecognitionApiKey = "provider-credential";
  config.serverConfig.itineraryRecognitionModel = "reader-2026-03";
}

describe("link-ingestion request forgery guard", () => {
  it.each([
    ["127.0.0.1", "loopback"],
    ["169.254.169.254", "cloud metadata"],
    ["10.1.2.3", "private"],
    ["172.16.4.5", "private"],
    ["192.168.0.9", "private"],
    ["::1", "loopback"],
    ["fd00::1", "unique local"],
    ["::ffff:169.254.169.254", "IPv4-mapped metadata"],
  ])("refuses %s (%s) wherever a hostname resolves to it", (address) => {
    expect(isBlockedSourceAddress(address)).toBe(true);
  });

  it("allows an ordinary public address", () => {
    expect(isBlockedSourceAddress("93.184.216.34")).toBe(false);
    expect(isBlockedSourceAddress("2606:2800:220:1:248:1893:25c8:1946")).toBe(false);
  });

  it("refuses a redirect whose target is the cloud metadata service", async () => {
    enableProviders();
    lookup.mockImplementation(async (hostname) =>
      hostname === "metadata.example"
        ? [{ address: "169.254.169.254", family: 4 }]
        : PUBLIC_ADDRESS
    );
    upstream.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: "http://metadata.example/latest/meta-data/" },
      }),
    );

    const response = await post({
      source: "link",
      link: "https://plans.example/tripmap/routePlan?id=1",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "ITINERARY_SOURCE_BLOCKED",
      stage: "source-access",
    });
    // The first hop was requested; the redirect target never was.
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("refuses a first hop that already resolves privately, before requesting it", async () => {
    enableProviders();
    lookup.mockResolvedValue([{ address: "192.168.1.10", family: 4 }]);

    const response = await post({ source: "link", link: "https://intranet.example/plan" });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "ITINERARY_SOURCE_BLOCKED",
      stage: "source-access",
    });
    expect(upstream).not.toHaveBeenCalled();
  });

  it("refuses a non-web scheme and a non-standard port outright", async () => {
    enableProviders();
    for (const link of ["file:///etc/passwd", "https://plans.example:2375/plan"]) {
      const response = await post({ source: "link", link });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: "ITINERARY_SOURCE_UNSUPPORTED",
        stage: "source-access",
      });
    }
    expect(upstream).not.toHaveBeenCalled();
  });

  it("pins the hop to the addresses it checked, so a rebound name cannot be reached", async () => {
    enableProviders();
    // The name answers publicly while it is being checked and link-locally
    // straight afterwards — the DNS rebinding case the pin exists for.
    lookup.mockResolvedValueOnce(PUBLIC_ADDRESS);
    upstream
      .mockResolvedValueOnce(new Response("<html>plan</html>", {
        headers: { "content-type": "text/html" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify(READING), {
        headers: { "content-type": "application/json" },
      }));

    const response = await post({
      source: "link",
      link: "https://plans.example/tripmap/routePlan?id=1",
    });
    expect(response.status).toBe(200);

    expect(hops).toHaveLength(1);
    // The request could only ever have connected to the checked address; the
    // resolver it was given consults no name at all.
    expect(pinnedAddresses(hops[0].lookup)).toEqual(["93.184.216.34"]);
  });

  it("refuses to answer a pinned lookup with an address that was never cleared", () => {
    const pin = createPinnedLookup([
      { address: "93.184.216.34", family: 4 },
      { address: "169.254.169.254", family: 4 },
    ]);
    expect(pinnedAddresses(pin)).toEqual(["93.184.216.34"]);

    let failure: Error | null = null;
    createPinnedLookup([{ address: "10.0.0.5", family: 4 }])(
      "plans.example",
      { all: true },
      (error) => { failure = error; },
    );
    expect(failure).toBeInstanceOf(Error);
  });

  it("refuses a rendered reading whose hops the service did not report", async () => {
    enableProviders();
    config.serverConfig.itinerarySourceFetchDriver = "render";
    config.serverConfig.itinerarySourceRenderUrl = "https://renderer.internal/read";
    upstream.mockResolvedValueOnce(new Response(JSON.stringify({
      html: "<html>plan</html>",
      finalUrl: "https://plans.example/tripmap/routePlan?id=1",
    }), { headers: { "content-type": "application/json" } }));

    const response = await post({
      source: "link",
      link: "https://plans.example/tripmap/routePlan?id=1",
    });

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      error: "ITINERARY_SOURCE_RENDER_UNVERIFIED",
      stage: "source-access",
    });
    // The reading was refused, so it never reached the recogniser.
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("refuses a rendered reading that reports reaching a private address", async () => {
    enableProviders();
    config.serverConfig.itinerarySourceFetchDriver = "render";
    config.serverConfig.itinerarySourceRenderUrl = "https://renderer.internal/read";
    upstream.mockResolvedValueOnce(new Response(JSON.stringify({
      html: "<html>plan</html>",
      finalUrl: "http://metadata.example/latest/meta-data/",
      hops: [
        { url: "https://plans.example/tripmap/routePlan?id=1", address: "93.184.216.34" },
        { url: "http://metadata.example/latest/meta-data/", address: "169.254.169.254" },
      ],
    }), { headers: { "content-type": "application/json" } }));

    const response = await post({
      source: "link",
      link: "https://plans.example/tripmap/routePlan?id=1",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "ITINERARY_SOURCE_BLOCKED",
      stage: "source-access",
    });
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("reads a rendered page whose every reported hop stays public", async () => {
    enableProviders();
    config.serverConfig.itinerarySourceFetchDriver = "render";
    config.serverConfig.itinerarySourceRenderUrl = "https://renderer.internal/read";
    upstream
      .mockResolvedValueOnce(new Response(JSON.stringify({
        html: "<html>plan</html>",
        finalUrl: "https://plans.example/tripmap/routePlan?id=1&expanded=1",
        hops: [
          { url: "https://plans.example/tripmap/routePlan?id=1", address: "93.184.216.34" },
          {
            url: "https://plans.example/tripmap/routePlan?id=1&expanded=1",
            address: "93.184.216.34",
          },
        ],
      }), { headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(READING), {
        headers: { "content-type": "application/json" },
      }));

    const response = await post({
      source: "link",
      link: "https://plans.example/tripmap/routePlan?id=1",
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.sourceRead).toEqual({ readVia: "render", contentType: "text/html" });
    // The member's link is never handed to the renderer's own redirect policy
    // without a bound on how far it may go.
    const rendered = JSON.parse(String(upstream.mock.calls[0][1]?.body));
    expect(rendered.maxRedirects).toBe(4);
  });
});

describe("an unconfigured deployment", () => {
  it("reports that link reading is not configured, not that the link is invalid", async () => {
    const response = await post({
      source: "link",
      link: "https://plans.example/tripmap/routePlan?id=1",
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: "ITINERARY_SOURCE_FETCH_UNAVAILABLE",
      stage: "source-access",
    });
    expect(upstream).not.toHaveBeenCalled();
  });

  it("reports that recognition is not configured rather than inventing a reading", async () => {
    const response = await post({ source: "text", text: "Day 1\n景点 宽窄巷子\n" });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: "ITINERARY_RECOGNITION_UNAVAILABLE",
      stage: "ai-extraction",
    });
    expect(upstream).not.toHaveBeenCalled();
  });

  it("says truthfully what it can and cannot do", async () => {
    const response = await app.request("/api/itinerary-import/capabilities");
    expect(await response.json()).toEqual({
      recognition: { configured: false, recognizerVersion: null, timeoutMs: 60_000 },
      linkFetch: { configured: false, driver: "disabled", timeoutMs: 20_000 },
    });
  });
});

describe("a configured deployment", () => {
  it("returns versioned structured candidates and no executable content", async () => {
    enableProviders();
    upstream
      .mockResolvedValueOnce(new Response("<html>plan</html>", {
        headers: { "content-type": "text/html" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ...READING,
        // A reading does not get to name its own provenance.
        recognizerVersion: "something-else",
      }), { headers: { "content-type": "application/json" } }));

    const response = await post({
      source: "link",
      link: "https://plans.example/tripmap/routePlan?id=1",
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.recognition.recognizerVersion).toBe("http-model/reader-2026-03");
    expect(body.recognition.contractVersion).toBe(1);
    expect(body.recognition.entries).toHaveLength(1);
    expect(body.sourceRead).toEqual({ readVia: "http", contentType: "text/html" });
    // Counts travel as the source reported them, never reconciled here.
    expect(body.recognition.sourceReportedPlaceCount).toBe(4);

    const [, recognitionCall] = upstream.mock.calls;
    expect(recognitionCall[0]).toBe("https://recognizer.example/read");
    const headers = (recognitionCall[1]?.headers ?? {}) as Record<string, string>;
    expect(headers.authorization).toBe("Bearer provider-credential");
    // The credential is the server's; nothing about it reaches the response.
    expect(JSON.stringify(body)).not.toContain("provider-credential");
  });

  it("refuses a reading that does not satisfy the contract", async () => {
    enableProviders();
    upstream
      .mockResolvedValueOnce(new Response("<html>plan</html>"))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ...READING,
        entries: [{ ...READING.entries[0], role: "run-this-code" }],
      })));

    const response = await post({
      source: "link",
      link: "https://plans.example/tripmap/routePlan?id=1",
    });
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      error: "ITINERARY_RECOGNITION_MALFORMED",
      stage: "ai-extraction",
    });
  });

  it("separates reaching the page from reading a plan out of it", async () => {
    enableProviders();
    upstream.mockResolvedValueOnce(new Response("   ", {
      headers: { "content-type": "text/html" },
    }));

    const response = await post({
      source: "link",
      link: "https://plans.example/tripmap/routePlan?id=1",
    });
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      error: "ITINERARY_SOURCE_EMPTY",
      stage: "content-read",
    });
  });

  it("separates a source that answered and refused from one it could not reach", async () => {
    // Measured against the owner-supplied real share link: the host answers a
    // non-2xx status to a static read no matter what headers are sent, which
    // is a statement about the reading method, not about reach and not about
    // the link. Reporting it as `source-access`/unreachable would collapse it
    // with an unresolvable name, which is exactly the collapse #512 forbids.
    enableProviders();
    upstream.mockResolvedValueOnce(
      new Response("forbidden", { status: 432, headers: { "content-type": "text/plain" } }),
    );

    const refused = await post({
      source: "link",
      link: "https://plans.example/tripmap/routePlan?id=1",
    });
    expect(refused.status).toBe(502);
    const refusedBody = await refused.json();
    expect(refusedBody).toMatchObject({
      error: "ITINERARY_SOURCE_REFUSED",
      stage: "content-read",
    });
    // The upstream status travels, so a deployment can tell a challenge from a
    // gone page without a second attempt.
    expect(String(refusedBody.message)).toContain("432");
    expect(String(refusedBody.message)).toContain("rendering driver");

    // ...but a gone page is not a rendering problem, and must not be answered
    // with rendering advice.
    upstream.mockResolvedValueOnce(new Response("gone", { status: 404 }));
    const missing = await post({
      source: "link",
      link: "https://plans.example/tripmap/routePlan?id=1",
    });
    const missingBody = await missing.json();
    expect(missingBody).toMatchObject({
      error: "ITINERARY_SOURCE_REFUSED",
      stage: "content-read",
    });
    expect(String(missingBody.message)).toContain("404");
    expect(String(missingBody.message)).not.toContain("rendering driver");

    // ...and the unreachable case still reports itself as one.
    lookup.mockRejectedValueOnce(new Error("ENOTFOUND"));
    const unreachable = await post({
      source: "link",
      link: "https://plans.example/tripmap/routePlan?id=1",
    });
    expect(await unreachable.json()).toMatchObject({
      error: "ITINERARY_SOURCE_UNREACHABLE",
      stage: "source-access",
    });
  });

  it("reports a transport fault as unreachable rather than as an invalid link", async () => {
    enableProviders();
    upstream.mockRejectedValueOnce(new TypeError("fetch failed"));

    const response = await post({
      source: "link",
      link: "https://plans.example/tripmap/routePlan?id=1",
    });
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      error: "ITINERARY_SOURCE_UNREACHABLE",
      stage: "source-access",
    });
  });

  it("gives up on a recogniser that never answers", async () => {
    enableProviders();
    config.serverConfig.itineraryRecognitionTimeoutMs = 1_000;
    upstream.mockResolvedValueOnce(new Response("<html>plan</html>"));
    upstream.mockImplementationOnce((_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })
    );

    vi.useFakeTimers();
    const pending = post({
      source: "link",
      link: "https://plans.example/tripmap/routePlan?id=1",
    });
    await vi.advanceTimersByTimeAsync(1_500);
    const response = await pending;
    vi.useRealTimers();

    expect(response.status).toBe(504);
    expect(await response.json()).toMatchObject({
      error: "ITINERARY_RECOGNITION_TIMEOUT",
      stage: "ai-extraction",
    });
  });

  it("keeps a long screenshot within the app's request envelope", async () => {
    enableProviders();
    const response = await post({
      source: "image",
      image: { mimeType: "image/png", base64: "a".repeat(400_001) },
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: "ITINERARY_IMAGE_SEGMENT_TOO_LARGE",
    });
    expect(upstream).not.toHaveBeenCalled();
  });
});

describe("the recognition contract itself", () => {
  it("records the adapter's build, not the reading's claim about itself", () => {
    const parsed = parseRecognitionCandidates(
      { ...READING, recognizerVersion: "claimed" },
      "http-model/reader-2026-03",
    );
    expect(parsed.recognizerVersion).toBe("http-model/reader-2026-03");
  });

  it("refuses a day date that is not a date and a partial date that carries a year", () => {
    for (const days of [
      [{ ...READING.days[0], calendarDate: "sometime in March" }],
      [{ ...READING.days[0], calendarDate: null, partialDate: "2026-03-14" }],
    ]) {
      expect(() => parseRecognitionCandidates({ ...READING, days }, "v"))
        .toThrow(ItineraryImportStageError);
    }
  });

  it("refuses an entry attached to a day the reading never declared", () => {
    expect(() =>
      parseRecognitionCandidates({
        ...READING,
        entries: [{ ...READING.entries[0], dayNumber: 9 }],
      }, "v")
    ).toThrow(ItineraryImportStageError);
  });
});

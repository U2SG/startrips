import { describe, expect, it, vi } from "vitest";
import { createItineraryRecognizer, reviewItineraryLocations, type ItineraryLocationReviewPlan } from "./create-itinerary-recognition";
import { pageRecognitionDocument } from "./recognition-document";

/**
 * #512: what actually leaves this server when a page is recognised.
 *
 * The type says a page document carries no address, but the assertion that
 * matters is about the bytes: this drives the real provider adapter and reads
 * the request body it built.
 */

const SIGNED = "https://plans.example/tripmap/routePlan?sid=99&sig=ab12cd34&uid=7";

const READING = {
  contractVersion: 1,
  sourceTitle: "3-day trip",
  sourceReportedDayCount: 1,
  sourceReportedPlaceCount: 1,
  days: [
    {
      dayNumber: 1,
      sourceDayTitle: "Day 1",
      calendarDate: "2026-03-14",
      partialDate: null,
      regionContext: "Shanghai",
    },
  ],
  entries: [
    { sourceEntryId: "e1", dayNumber: 1, orderInDay: 1, name: "外滩", role: "attraction" },
  ],
};

describe("http-model recogniser", () => {
  it("sends the read plan and none of the link that carried it", async () => {
    const fetcher = vi.fn(async (_url: string, _init: RequestInit) =>
      new Response(JSON.stringify(READING), {
        headers: { "content-type": "application/json" },
      })
    );
    const recognizer = createItineraryRecognizer({
      driver: "http-model",
      baseUrl: "https://model.example/read",
      apiKey: "secret-key",
      model: "reader-1",
      fetcher: fetcher as unknown as typeof fetch,
    });

    await recognizer.recognize(
      pageRecognitionDocument({
        finalUrl: SIGNED,
        text: `<body><p>第 1 天 外滩 The Bund</p><a href="${SIGNED}">分享</a></body>`,
        contentType: "text/html",
      }),
      {},
    );

    const body = String(fetcher.mock.calls[0][1].body);
    expect(body).toContain("外滩 The Bund");
    expect(body).toContain("https://plans.example");
    // The signature, the member id and the path that carried them are not in
    // the request at all - not in a url field, not inside the page text.
    expect(body).not.toContain("sig=ab12cd34");
    expect(body).not.toContain("uid=7");
    expect(body).not.toContain("routePlan");
    expect(body).not.toContain("href");
  });

  it("does not accept a model-inferred year from unrelated page furniture", async () => {
    const recognizer = createItineraryRecognizer({
      driver: "http-model",
      baseUrl: "https://model.example/read",
      apiKey: null,
      model: "reader-1",
      fetcher: async () => new Response(JSON.stringify({
        ...READING,
        days: [{ ...READING.days[0], calendarDate: "2025-02-11" }],
      })),
    });
    const reading = await recognizer.recognize({
      kind: "page",
      sourceOrigin: "https://example.com",
      text: "第 1 天 02月11日 上海外滩。2026热门酒店。",
    }, {});
    expect(reading.days[0]).toMatchObject({ calendarDate: null, partialDate: "02-11" });
  });

  it("keeps a year that appears with the exact day in the source", async () => {
    const recognizer = createItineraryRecognizer({
      driver: "http-model",
      baseUrl: "https://model.example/read",
      apiKey: null,
      model: "reader-1",
      fetcher: async () => new Response(JSON.stringify(READING)),
    });
    const reading = await recognizer.recognize({
      kind: "text",
      text: "第 1 天 2026年3月14日 上海外滩",
    }, {});
    expect(reading.days[0].calendarDate).toBe("2026-03-14");
  });

  it("grounds English full dates and retains English month/day without a source year", async () => {
    const recognizer = createItineraryRecognizer({
      driver: "http-model",
      baseUrl: "https://model.example/read",
      apiKey: null,
      model: "reader-1",
      fetcher: async () => new Response(JSON.stringify(READING)),
    });
    const dated = await recognizer.recognize({
      kind: "text", text: "Day 1 · March 14, 2026 · Singapore",
    }, {});
    expect(dated.days[0].calendarDate).toBe("2026-03-14");

    const undated = await recognizer.recognize({
      kind: "text", text: "Day 1 · Mar. 14 · Singapore; 2025 hotel ranking",
    }, {});
    expect(undated.days[0]).toMatchObject({ calendarDate: null, partialDate: "03-14" });
  });
});

describe("validated itinerary organization review", () => {
  const plan: ItineraryLocationReviewPlan = {
    sourceTitle: "Synthetic route", days: [{ dayNumber: 1, title: "Day 1", region: "Coast" }],
    entries: Array.from({ length: 5 }, (_, index) => ({ index, name: `Place ${index}`,
      aliases: [], dayNumber: 1, role: "attraction", sourceInvalid: false,
      countryCode: "QA", searchArea: "Coast", candidates: [{ id: `provider-${index}`,
        label: `Place ${index}`, context: "Coast", countryCode: "QA",
      }],
    })),
  };
  const review = (decisions: unknown[]) => reviewItineraryLocations(plan, {
    baseUrl: "https://model.example/read", apiKey: null, model: "reader-1", timeoutMs: 1_000,
    fetcher: async () => new Response(JSON.stringify({ contractVersion: 1, decisions })),
  });

  it("accepts exact neighboring Stops and strips invented provider IDs and coordinates", async () => {
    const decisions = await review([
      { index: 0, isStop: true, stayAnchorIndex: null, candidateId: "provider-0", regionContext: "Town A" },
      { index: 1, isStop: false, stayAnchorIndex: 0, candidateId: "made-up", latitude: 35, longitude: 120 },
      { index: 2, isStop: true, stayAnchorIndex: null },
      { index: 3, isStop: false, stayAnchorIndex: 4 },
      { index: 4, isStop: true, stayAnchorIndex: null },
    ]);
    expect(decisions[0]).toMatchObject({ candidateId: "provider-0", isStop: true, regionContext: "Town A" });
    expect(decisions[1]).toMatchObject({ candidateId: null, isStop: false, stayAnchorIndex: 0 });
    expect(decisions[1]).not.toHaveProperty("latitude");
    expect(decisions[1]).not.toHaveProperty("longitude");
    expect(decisions[3].stayAnchorIndex).toBe(4);
  });

  it("rejects self, non-Stop, missing and non-adjacent ownership and malformed regions", async () => {
    for (const stayAnchorIndex of [1, 3, 4, 99]) {
      const decisions = await review([
        { index: 0, isStop: true }, { index: 1, isStop: false, stayAnchorIndex, regionContext: "bad\nregion" },
        { index: 2, isStop: true }, { index: 3, isStop: false }, { index: 4, isStop: true },
      ]);
      expect(decisions[1].stayAnchorIndex).toBeNull();
      expect(decisions[1]).not.toHaveProperty("regionContext");
    }
  });
});

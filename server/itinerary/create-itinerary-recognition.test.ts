import { describe, expect, it, vi } from "vitest";
import { createItineraryRecognizer } from "./create-itinerary-recognition";
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
});

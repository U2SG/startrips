import { describe, expect, it } from "vitest";
import { MAX_SHARE_LIFETIME_MS } from "../authorization/share-access";
import { MAX_SHARE_JOURNEYS, parseShareInput, readShareInput } from "./shares";

const NOW = new Date("2026-09-03T12:00:00.000Z");
const JOURNEY_A = "11111111-1111-4111-8111-111111111111";
const JOURNEY_B = "22222222-2222-4222-8222-222222222222";
const IN_A_WEEK = "2026-09-10T12:00:00.000Z";

function uuidAt(index: number): string {
  const suffix = index.toString(16).padStart(12, "0");
  return `33333333-3333-4333-8333-${suffix}`;
}

describe("share creation input", () => {
  it("accepts one or several distinct journeys with a future expiry", () => {
    expect(
      parseShareInput({ journeyIds: [JOURNEY_A], expiresAt: IN_A_WEEK }, NOW),
    ).toEqual({ journeyIds: [JOURNEY_A], expiresAt: new Date(IN_A_WEEK) });
    expect(
      parseShareInput(
        { journeyIds: [JOURNEY_A, JOURNEY_B], expiresAt: IN_A_WEEK },
        NOW,
      ),
    ).toMatchObject({ journeyIds: [JOURNEY_A, JOURNEY_B] });
  });

  it("rejects a body that parsed to something other than an object", () => {
    // `JSON.parse` accepts all of these, so `context.req.json()` resolves
    // without a SyntaxError and only this guard stands between a non-object
    // body and a property read that would surface as a 500.
    expect(parseShareInput(null, NOW)).toBeNull();
    expect(parseShareInput(undefined, NOW)).toBeNull();
    expect(parseShareInput(42, NOW)).toBeNull();
    expect(parseShareInput("journey", NOW)).toBeNull();
    expect(parseShareInput(true, NOW)).toBeNull();
    // An array is an object, so it survives the guard and is then rejected by
    // the selection rules like any other body without usable `journeyIds`.
    expect(parseShareInput([JOURNEY_A], NOW)).toBeNull();
  });

  it("rejects an empty, oversized, duplicated or malformed selection", () => {
    expect(parseShareInput({ journeyIds: [], expiresAt: IN_A_WEEK }, NOW)).toBeNull();
    expect(parseShareInput({ expiresAt: IN_A_WEEK }, NOW)).toBeNull();
    expect(
      parseShareInput({ journeyIds: JOURNEY_A, expiresAt: IN_A_WEEK }, NOW),
    ).toBeNull();
    expect(
      parseShareInput(
        { journeyIds: [JOURNEY_A, JOURNEY_A], expiresAt: IN_A_WEEK },
        NOW,
      ),
    ).toBeNull();
    expect(
      parseShareInput({ journeyIds: ["not-a-uuid"], expiresAt: IN_A_WEEK }, NOW),
    ).toBeNull();
    expect(
      parseShareInput({ journeyIds: [null], expiresAt: IN_A_WEEK }, NOW),
    ).toBeNull();
    expect(
      parseShareInput(
        {
          journeyIds: Array.from(
            { length: MAX_SHARE_JOURNEYS + 1 },
            (_unused, index) => uuidAt(index),
          ),
          expiresAt: IN_A_WEEK,
        },
        NOW,
      ),
    ).toBeNull();
  });

  it("requires an expiry that is in the future and at most one year out", () => {
    expect(
      parseShareInput({ journeyIds: [JOURNEY_A], expiresAt: NOW.toISOString() }, NOW),
    ).toBeNull();
    expect(
      parseShareInput(
        { journeyIds: [JOURNEY_A], expiresAt: "2026-09-03T11:59:59.999Z" },
        NOW,
      ),
    ).toBeNull();
    expect(
      parseShareInput({ journeyIds: [JOURNEY_A], expiresAt: "not a date" }, NOW),
    ).toBeNull();
    expect(
      parseShareInput({ journeyIds: [JOURNEY_A], expiresAt: 1234567890 }, NOW),
    ).toBeNull();
    expect(parseShareInput({ journeyIds: [JOURNEY_A] }, NOW)).toBeNull();

    const cap = new Date(NOW.valueOf() + MAX_SHARE_LIFETIME_MS);
    expect(
      parseShareInput(
        { journeyIds: [JOURNEY_A], expiresAt: cap.toISOString() },
        NOW,
      ),
    ).toMatchObject({ expiresAt: cap });
    expect(
      parseShareInput(
        {
          journeyIds: [JOURNEY_A],
          expiresAt: new Date(cap.valueOf() + 1).toISOString(),
        },
        NOW,
      ),
    ).toBeNull();
  });

  it("normalizes a local-offset expiry to the same UTC instant", () => {
    expect(
      parseShareInput(
        { journeyIds: [JOURNEY_A], expiresAt: "2026-09-10T20:00:00.000+08:00" },
        NOW,
      ),
    ).toMatchObject({ expiresAt: new Date("2026-09-10T12:00:00.000Z") });
  });
});

/**
 * These assert `null`, the value the route turns into its `INVALID_SHARE`
 * 400, rather than the status itself: `requireAtlasAccess` runs before the
 * body is read, so asserting the response would mean a database and a
 * session. The `null` is what the already-reviewed 400 branch consumes.
 */
describe("share creation body read", () => {
  function jsonBody(body: string): () => Promise<unknown> {
    return () =>
      new Request("http://localhost/api/shares", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }).json();
  }

  it("rejects a body that is not valid JSON at all", async () => {
    // Truncated mid-array: the read throws a SyntaxError, which without the
    // catch would leave the route as the global handler's INVALID_JSON 400.
    await expect(readShareInput(jsonBody('{"journeyIds": ['), NOW)).resolves
      .toBeNull();
    await expect(readShareInput(jsonBody(""), NOW)).resolves.toBeNull();
  });

  it("still rejects a well-formed body the selection rules refuse", async () => {
    await expect(readShareInput(jsonBody("null"), NOW)).resolves.toBeNull();
    await expect(readShareInput(jsonBody('"journey"'), NOW)).resolves.toBeNull();
    await expect(
      readShareInput(jsonBody('{"expiresAt":"' + IN_A_WEEK + '"}'), NOW),
    ).resolves.toBeNull();
  });

  it("accepts a valid body", async () => {
    await expect(
      readShareInput(
        jsonBody(
          JSON.stringify({ journeyIds: [JOURNEY_A], expiresAt: IN_A_WEEK }),
        ),
        NOW,
      ),
    ).resolves.toEqual({
      journeyIds: [JOURNEY_A],
      expiresAt: new Date(IN_A_WEEK),
    });
  });
});

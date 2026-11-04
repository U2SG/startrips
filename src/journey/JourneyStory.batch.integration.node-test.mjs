import assert from "node:assert/strict";
import test from "node:test";

// Core CI explicitly runs this Node test as real browser integration. Vitest's
// five-second unit-test deadline is not the lifecycle contract for four real
// JourneyStory upload scenarios. Keep the same production fixture and every
// browser assertion without changing any Playwright timeout or retry setting.
test(
  "JourneyStory standard upload entry / #337: file input, draft edit, manual/auto apply, durable readback, undo, partial failure and mobile keyboard",
  async () => {
    assert.equal(process.env.RUN_ST116_CORE_UPLOAD_QA, "1", "Core CI must explicitly enable the full upload acceptance");
    assert.ok(process.env.QA_BASE_URL, "Core integration requires its Vite QA_BASE_URL");
    const { verifyRoutePointBatchJourneyStory } = await import("../../scripts/qa-route-point-batch.mjs");
    await verifyRoutePointBatchJourneyStory();
  },
);

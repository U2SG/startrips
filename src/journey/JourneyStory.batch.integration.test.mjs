import { describe, it } from "vitest";

// Core CI starts its own Vite fixture server and sets this flag. The normal
// unit-test pass does not silently start a browser/server on a developer's
// machine; the dedicated core job step always executes this acceptance test.
describe("JourneyStory standard upload entry / #337 core integration", () => {
  it.runIf(process.env.RUN_ST116_CORE_UPLOAD_QA === "1")(
    "mounts actual file input, edits groups, manually/automatically applies, reopens, reads back and undoes; also verifies atomic partial failure and mobile keyboard traversal",
    async () => {
      if (!process.env.QA_BASE_URL) throw new Error("Core integration requires its Vite QA_BASE_URL");
      const { verifyRoutePointBatchJourneyStory } = await import("../../scripts/qa-route-point-batch.mjs");
      await verifyRoutePointBatchJourneyStory();
    },
  );
});

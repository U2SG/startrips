import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_SUITE_TIMEOUT_MS, parseEntries, runShard } from "./browser-qa-shard.mjs";

test("parses stable suite identities from shard entries", () => {
  assert.deepEqual(
    parseEntries("home-base-context::pnpm qa:home-base-context\nroute-anchoring::pnpm qa:route-anchoring\n"),
    [
      { suite: "home-base-context", command: "pnpm qa:home-base-context" },
      { suite: "route-anchoring", command: "pnpm qa:route-anchoring" },
    ],
  );
});

test("rejects malformed shard entries", () => {
  assert.throws(() => parseEntries("pnpm qa:home-base-context"), /Invalid browser QA shard entry/);
  assert.throws(() => parseEntries("::pnpm qa:home-base-context"), /Invalid browser QA shard entry/);
});

test("a timed-out logical suite does not prevent later suites from executing", async () => {
  const entries = parseEntries("first::sleep forever\nsecond::echo still-runs");
  const executed = [];
  const logs = [];
  const errors = [];
  const result = await runShard(entries, {
    timeoutMs: DEFAULT_SUITE_TIMEOUT_MS,
    execute: async (_command, { suite, timeoutMs }) => {
      executed.push({ suite, timeoutMs });
      if (suite === "first") return { ok: false, timedOut: true, code: null };
      return { ok: true, timedOut: false, code: 0 };
    },
    log: (line) => logs.push(line),
    error: (line) => errors.push(line),
  });

  assert.equal(result, 1);
  assert.deepEqual(executed.map((item) => item.suite), ["first", "second"]);
  assert.ok(executed.every((item) => item.timeoutMs === DEFAULT_SUITE_TIMEOUT_MS));
  assert.ok(logs.includes("STARTRIPS_QA_SUITE=first"));
  assert.ok(logs.includes("STARTRIPS_QA_SUITE=second"));
  assert.match(errors.join("\n"), /first timed out after 720000ms/);
});

test("a failed logical suite also leaves later suites diagnostic coverage", async () => {
  const entries = parseEntries("first::exit 1\nsecond::echo still-runs");
  const executed = [];
  const result = await runShard(entries, {
    execute: async (_command, { suite }) => {
      executed.push(suite);
      return suite === "first"
        ? { ok: false, timedOut: false, code: 1 }
        : { ok: true, timedOut: false, code: 0 };
    },
    log: () => {},
    error: () => {},
  });

  assert.equal(result, 1);
  assert.deepEqual(executed, ["first", "second"]);
});

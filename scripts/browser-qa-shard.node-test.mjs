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

test("timing evidence records success, timeout and throw without suppressing later suites", async () => {
  const timings = [];
  let clock = 0;
  const code = await runShard(parseEntries("ok::one\ntimeout::two\nthrows::three"), {
    now: () => (clock += 125),
    execute: async (_, { suite }) => {
      if (suite === "throws") throw new Error("fixture execution error");
      return { ok: suite === "ok", timedOut: suite === "timeout" };
    },
    record: (row) => timings.push(row), log: () => {}, error: () => {},
  });
  assert.equal(code, 1);
  assert.deepEqual(timings.map((row) => row.status), ["passed", "timed_out", "failed"]);
  assert.ok(timings.every((row) => row.durationMs === 125 && row.timeoutMs === 720000));
});

test("timing writer failure fails closed but preserves sibling coverage", async () => {
  const ran = [];
  assert.equal(await runShard(parseEntries("first::one\nsecond::two"), {
    execute: async (_, { suite }) => { ran.push(suite); return { ok: true }; },
    record: () => { throw new Error("disk fixture"); }, log: () => {}, error: () => {},
  }), 1);
  assert.deepEqual(ran, ["first", "second"]);
});

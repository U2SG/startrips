import assert from "node:assert/strict";
import test from "node:test";
import { validateResults } from "./ci-validation-results.mjs";

const ordinary = {
  LEDGER_RESULT: "success", QUICK_CHECKS_RESULT: "success", SOURCE_PROOF_OUTCOME: "success",
  CLASSIFIED_LEDGER_ONLY: "false", PROVEN_LEDGER_ONLY: "false",
  CORE_RESULT: "success", BROWSER_QA_RESULT: "success", KEEPSAKE_RENDER_RESULT: "success",
};
const final = { ...ordinary, CLASSIFIED_LEDGER_ONLY: "true", PROVEN_LEDGER_ONLY: "true",
  CORE_RESULT: "skipped", BROWSER_QA_RESULT: "skipped", KEEPSAKE_RENDER_RESULT: "skipped" };

test("ordinary changes require every actual product lane", () => {
  assert.match(validateResults(ordinary), /Every validation lane/);
  for (const key of ["CORE_RESULT", "BROWSER_QA_RESULT", "KEEPSAKE_RENDER_RESULT"]) {
    for (const value of ["skipped", "failure", "cancelled", "", undefined]) {
      assert.throws(() => validateResults({ ...ordinary, [key]: value }));
    }
  }
});
test("ledger-only classification is not proof and cannot make skipped tests green", () => {
  assert.match(validateResults(final), /Exact Source proved/);
  for (const change of [
    { SOURCE_PROOF_OUTCOME: "failure" }, { SOURCE_PROOF_OUTCOME: "skipped" },
    { PROVEN_LEDGER_ONLY: "false" }, { CLASSIFIED_LEDGER_ONLY: "false" },
    { CLASSIFIED_LEDGER_ONLY: undefined, PROVEN_LEDGER_ONLY: undefined },
  ]) assert.throws(() => validateResults({ ...final, ...change }));
});
test("ledger, quick checks and failed/cancelled product jobs cannot be waived", () => {
  for (const key of ["LEDGER_RESULT", "QUICK_CHECKS_RESULT"]) {
    for (const value of ["failure", "cancelled", "skipped", undefined]) {
      assert.throws(() => validateResults({ ...final, [key]: value }));
    }
  }
  for (const key of ["CORE_RESULT", "BROWSER_QA_RESULT", "KEEPSAKE_RENDER_RESULT"]) {
    for (const value of ["failure", "cancelled", "success", undefined]) {
      assert.throws(() => validateResults({ ...final, [key]: value }));
    }
  }
});

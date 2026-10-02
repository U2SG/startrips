import process from "node:process";
import { pathToFileURL } from "node:url";

/** Skips are legal only for a separately proved, exact-Source ledger final. */
export function validateResults(env) {
  for (const key of ["LEDGER_RESULT", "QUICK_CHECKS_RESULT"]) {
    if (env[key] !== "success") throw new Error(`${key} must succeed: ${env[key] || "missing"}`);
  }
  if (env.SOURCE_PROOF_OUTCOME !== "success") throw new Error("Independent Source proof did not succeed");
  if (!["true", "false"].includes(env.CLASSIFIED_LEDGER_ONLY)
      || env.CLASSIFIED_LEDGER_ONLY !== env.PROVEN_LEDGER_ONLY) {
    throw new Error("Ledger classification and independent proof must agree");
  }
  const final = env.PROVEN_LEDGER_ONLY === "true";
  const expected = final ? "skipped" : "success";
  for (const key of ["CORE_RESULT", "BROWSER_QA_RESULT", "KEEPSAKE_RENDER_RESULT"]) {
    if (env[key] !== expected) throw new Error(`${key} must be ${expected}: ${env[key] || "missing"}`);
  }
  return final ? "Exact Source proved; ledger-only final validated" : "Every validation lane passed";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(validateResults(process.env));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

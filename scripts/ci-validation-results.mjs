import process from "node:process";
import { pathToFileURL } from "node:url";

/** Skips are legal only for a separately proved, exact-Source ledger final or a re-classified soc-client-only PR. */
export function validateResults(env) {
  for (const key of ["LEDGER_RESULT", "QUICK_CHECKS_RESULT"]) {
    if (env[key] !== "success") throw new Error(`${key} must succeed: ${env[key] || "missing"}`);
  }
  if (env.SOURCE_PROOF_OUTCOME !== "success") throw new Error("Independent Source proof did not succeed");
  if (!["true", "false"].includes(env.CLASSIFIED_LEDGER_ONLY)
      || env.CLASSIFIED_LEDGER_ONLY !== env.PROVEN_LEDGER_ONLY) {
    throw new Error("Ledger classification and independent proof must agree");
  }
  if (!["true", "false"].includes(env.CLASSIFIED_SOC_ONLY)
      || env.CLASSIFIED_SOC_ONLY !== env.PROVEN_SOC_ONLY) {
    throw new Error("Soc-client-only classification and independent re-classification must agree");
  }
  const final = env.PROVEN_LEDGER_ONLY === "true";
  const socOnly = env.PROVEN_SOC_ONLY === "true";
  if (final && socOnly) throw new Error("A change cannot be both ledger-only final and soc-client-only");
  const expected = final || socOnly ? "skipped" : "success";
  for (const key of ["CORE_RESULT", "BROWSER_QA_RESULT", "KEEPSAKE_RENDER_RESULT"]) {
    if (env[key] !== expected) throw new Error(`${key} must be ${expected}: ${env[key] || "missing"}`);
  }
  if (socOnly) return "Soc-client-only change; web product lanes not applicable";
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

import process from "node:process";
import { pathToFileURL } from "node:url";

/** Compare the independent full-PR scope with the actual product job conclusions. */
export function validateProductResults(env) {
  if (env.QUICK_CHECKS_RESULT !== "success") throw new Error("QUICK_CHECKS_RESULT must succeed");
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
  if (!["full", "ios", "mixed", "docs"].includes(env.CLASSIFIED_SCOPE)
      || env.CLASSIFIED_SCOPE !== env.PROVEN_SCOPE
      || !["true", "false"].includes(env.CLASSIFIED_IOS)
      || env.CLASSIFIED_IOS !== env.PROVEN_IOS) {
    throw new Error("Scope classification and independent re-classification must agree");
  }
  if ((["ios", "mixed"].includes(env.PROVEN_SCOPE) && env.PROVEN_IOS !== "true")
      || (env.PROVEN_SCOPE === "docs" && env.PROVEN_IOS !== "false")) {
    throw new Error("Scope and native selection contradict each other");
  }
  const nativeExpected = !final && !socOnly && env.PROVEN_IOS === "true" ? "success" : "skipped";
  if (env.IOS_RESULT !== nativeExpected) throw new Error(`IOS_RESULT must be ${nativeExpected}: ${env.IOS_RESULT || "missing"}`);
  if (final && socOnly) throw new Error("A change cannot be both ledger-only final and soc-client-only");
  const expected = final || socOnly || ["ios", "docs"].includes(env.PROVEN_SCOPE) ? "skipped" : "success";
  for (const key of ["CORE_RESULT", "BROWSER_QA_RESULT", "KEEPSAKE_RENDER_RESULT"]) {
    if (env[key] !== expected) throw new Error(`${key} must be ${expected}: ${env[key] || "missing"}`);
  }
  if (socOnly) return "Soc-client-only change; web product lanes not applicable";
  return final ? "Exact Source proved; ledger-only final validated" : "Every validation lane passed";
}

export function validateResults(env) {
  if (env.LEDGER_RESULT !== "success") throw new Error("LEDGER_RESULT must succeed");
  return validateProductResults(env);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(process.argv[2] === "--product-only" ? validateProductResults(process.env) : validateResults(process.env));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

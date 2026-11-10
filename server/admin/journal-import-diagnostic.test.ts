import { expect, it } from "vitest";
import { ShareIntentError } from "../intents/create-share-intent";
import { ToolArgumentsRejectedError } from "../intents/staging-tool";
import { importDiagnostic } from "./journal-import-diagnostic";
it("reports stable codes without messages, causes, provider content or arbitrary stage", () => {
  const e = new ShareIntentError("INTENT_TIMEOUT", "private source and secret", 504);
  e.cause = "private cause";
  expect(importDiagnostic(e, "llm-preview")).toEqual({ error: "INTENT_TIMEOUT", stage: "llm-preview", kind: "transport", status: 504 });
  expect(importDiagnostic(new ShareIntentError("PRIVATE_CODE", "secret", 502), "private command")).toEqual({ error: "MODEL_STAGE_FAILED", stage: "arguments", kind: "configuration", status: 502 });
  expect(importDiagnostic(new Error("PRIVATE_SECRET"), "apply").error).toBe("IMPORT_FAILED");
  expect(importDiagnostic(new Error("private source /path secret"), "apply")).toEqual({ error: "IMPORT_FAILED", stage: "apply", kind: "operation" });
});
it("carries only the validator-chosen argument path and code of an exhausted correction", () => {
  expect(importDiagnostic(new ToolArgumentsRejectedError("JOURNAL_IMPORT_MALFORMED", "$.chapters[2].events[0].line", "LINE_COVERAGE"), "llm-preview"))
    .toEqual({ error: "JOURNAL_IMPORT_MALFORMED", stage: "llm-preview", kind: "tool_arguments", path: "$.chapters[2].events[0].line", code: "LINE_COVERAGE", status: 422 });
  const forged = new ToolArgumentsRejectedError("JOURNAL_IMPORT_MALFORMED", "$.chapters[0] private source", "lower case secret");
  expect(importDiagnostic(forged, "llm-preview")).toEqual({ error: "JOURNAL_IMPORT_MALFORMED", stage: "llm-preview", kind: "tool_arguments", status: 422 });
});

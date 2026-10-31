import { expect, it } from "vitest";
import { ShareIntentError } from "../intents/create-share-intent";
import { importDiagnostic } from "./journal-import-diagnostic";
it("reports stable codes without messages, causes, provider content or arbitrary stage", () => {
  const e = new ShareIntentError("INTENT_TIMEOUT", "private source and secret", 504);
  e.cause = "private cause";
  expect(importDiagnostic(e, "llm-preview")).toEqual({ error: "INTENT_TIMEOUT", stage: "llm-preview", kind: "transport", status: 504 });
  expect(importDiagnostic(new ShareIntentError("PRIVATE_CODE", "secret", 502), "private command")).toEqual({ error: "MODEL_STAGE_FAILED", stage: "arguments", kind: "configuration", status: 502 });
  expect(importDiagnostic(new Error("PRIVATE_SECRET"), "apply").error).toBe("IMPORT_FAILED");
  expect(importDiagnostic(new Error("private source /path secret"), "apply")).toEqual({ error: "IMPORT_FAILED", stage: "apply", kind: "operation" });
});

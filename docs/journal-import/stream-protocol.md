# Journal import streaming protocol (implementation in progress)

The application worker owns the provider SSE connection. A client or SSH command observes a durable job; reconnecting never starts another model request. No partial output becomes a journal or plan. Existing journal save/apply confirmation remains required.

- `GET /api/intents/journal-import/provider`: `{available,baseUrl,model}` (no key).
- `POST /api/intents/journal-import/jobs`: `{requestId:UUID,journeyId,source,sentence,fallbackDate,provider:{baseUrl,model}}` → 202 `{jobId}`. Repeating the identical requestId/input is idempotent. A different input with the same ID conflicts. Only one active job per Atlas.
- `GET /api/intents/journal-import/jobs/:jobId`: current snapshot.
- `POST /api/intents/journal-import/jobs/:jobId/cancel`: cancel; terminal jobs stay terminal.
- `GET /api/intents/journal-import/jobs/:jobId/events`: authenticated SSE. Reconnect the same ID when an observation connection ends (60-second observation window). No total model-response deadline.

All requests use the authenticated session and active Atlas. Writes require same-origin Origin. Private cache headers apply. Event names:

| Event | Data |
| --- | --- |
| progress | `{jobId,status:"queued"\|"running",phase:"queued"\|"connecting"\|"receiving"\|"validating",characters,chunks}` |
| completed | progress fields plus `{envelope,planDigest}` |
| failed | `{jobId,status:"failed"\|"interrupted",error,kind,stage?,statusCode?}` |
| cancelled | `{jobId,status:"cancelled"}` (may include progress counters) |

`envelope` contains `{plan,signature}`. `plan` contains `version:2,target,sourceHash,importedChapterIds,before:DailyJournal,after:DailyJournal,expires,provider`. Display `plan.after.chapters`; the save base revision is `plan.before.revision`. Completion is a preview, not a write. Ignore late events after account/Journey switch or cancellation. Never render model arguments as trusted HTML. Error code is safe metadata; no provider body is returned.

Explicit cancellation aborts provider transport within the worker polling interval. Observer disconnect merely releases the subscription. A stale worker lease becomes `interrupted`; it is never automatically reissued. Connection, first-byte and semantic-idle budgets remain 30 seconds each; valid incremental output resets idle, heartbeats do not. Output is capped at 1 MB. Other existing model operations keep their legacy behavior.

## Bounded administration

Requires migration 0042 and the ordinary application worker running in the deployed API process. Do not start an SSH background worker.

1. `journal-import llm-job-submit /private/job.json`, stdin `{target,requestId,source,sentence,fallbackDate,provider}`.
2. `journal-import llm-job-status /private/job.json` (repeat bounded read-only commands).
3. Optional `journal-import llm-job-cancel /private/job.json`.
4. On completed, `journal-import llm-job-export /private/job.json /private/plan.json`.
5. Inspect private plan; use existing digest-bound apply/backup command only after confirmation.

Each command is bounded separately; a 70-second CLI or 90-second connector timeout does not terminate the application model stream. Reuse the exact requestId after an uncertain submit. Legacy synchronous `llm-preview` is not the streaming execution path. Private job rows are removed after 24 hours once terminal; original source is removed from failed/cancelled payloads immediately. Completed private envelopes necessarily retain original source until expiry/removal.

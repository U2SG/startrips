# Journal import streaming protocol (implementation in progress)

The application worker owns the provider SSE connection. A client or SSH command observes a durable job; reconnecting never starts another model request. No partial output becomes a journal or plan. Existing journal save/apply confirmation remains required.

- `GET /api/intents/journal-import/provider`: `{available,baseUrl,model,displayName}` (no key). `baseUrl` is an opaque `provider:…` consent identity, not a request URL; echo it unchanged. `displayName` is only the configured hostname. Provider URL paths, query and userinfo never leave the server.
- `POST /api/intents/journal-import/jobs`: `{requestId:UUID,journeyId,source,sentence,fallbackDate,provider:{baseUrl,model}}` → 202 `{jobId}`. Repeating the identical requestId/input is idempotent. A different input with the same ID conflicts. Only one active job per Atlas.
- `GET /api/intents/journal-import/jobs/:jobId`: current snapshot.
- `POST /api/intents/journal-import/jobs/:jobId/cancel`: cancel; terminal jobs stay terminal.
- `GET /api/intents/journal-import/jobs/:jobId/events`: authenticated SSE. Reconnect the same ID when an observation connection ends (60-second observation window). No total model-response deadline.

All requests use the authenticated session and active Atlas. Writes require same-origin Origin. Private cache headers apply. Event names:

| Event | Data |
| --- | --- |
| progress | `{jobId,status:"queued"\|"running",phase:"queued"\|"connecting"\|"receiving"\|"validating",characters,chunks,segments,segmentsDone}` |
| completed | progress fields plus `{envelope,planDigest,degradedLines,degradations}` |
| failed | `{jobId,status:"failed"\|"interrupted",error,kind,stage?,statusCode?,path?,code?}` |
| cancelled | `{jobId,status:"cancelled"}` (may include progress counters) |

`envelope` contains `{plan,signature}`. `plan` contains `version:2,target,sourceHash,importedChapterIds,before:DailyJournal,after:DailyJournal,expires,provider`. Display `plan.after.chapters`; the save base revision is `plan.before.revision`. Completion is a preview, not a write. Ignore late events after account/Journey switch or cancellation. Never render model arguments as trusted HTML. Error code is safe metadata; no provider body is returned.

`characters`/`chunks` sum the current model calls and only show liveness. `segments` is the number of source segments (0 until known) and `segmentsDone` how many are staged; the client renders `segmentsDone/segments` as the only determinate progress. `degradedLines` counts lines left as `uncertain` for review; `degradations` lists `{segment,path,code}` for segments that fell back. `path`/`code` on a failure are the last validator location and code of an exhausted argument correction. All of these are server-chosen; none contains source text, argument values or provider output.

## Segmented staging

The worker splits the normalized source into segments of about 4,000 characters (`JOURNAL_SEGMENT_BUDGET`): it packs whole days (cut before dated-heading lines), cuts an oversized day after blank lines and, as a last resort, at any line. The heading pattern only chooses cut points. Each segment is one forced `stage_journal_import` call with only its lines (absolute `line` numbers), `fallbackYear` and `sentence`; at most 3 calls run at once (`JOURNAL_SEGMENT_CONCURRENCY`). A later segment whose first chapter has `heading:false` and `dateStatus:"absent"` continues the previous segment's last chapter. Line coverage, duplicate chapter source, capacity and the persisted shape are then checked on the assembled document; identical text and date staged by two different calls is joined to the preceding chapter instead of dropping a line. Event and chapter IDs derive from the full source and absolute lines, as before, so re-imports keep matching saved chapters.

The tool no longer copies source text: events refer to lines, a chapter flags `heading`, and the server takes event text and titles from the source. Only short `dateEvidence`, `timeEvidence` and `placeName` substrings are quoted. A failed interpretation of one line (date, clock, place, question capacity, range rules) does not reject the call: that line keeps its source, becomes `uncertain` with no date, time or place claim, and asks `AI 对这一行的识别未通过校验，请核对。`. Structural errors (coverage, chapter boundaries and dates, shape, duplicate chapter source) use the bounded correction loop per segment; if a segment still fails, it becomes a deterministic preview (one chapter per dated-heading split, every nonempty line an `uncertain` event with that question). Only transport, cancellation, configuration and capacity errors fail the job. Cancellation or any fatal error stops every running segment.

Explicit cancellation aborts provider transport within the worker polling interval. Observer disconnect merely releases the subscription. A stale worker lease becomes `interrupted`; it is never automatically reissued. Connection, first-byte and semantic-idle budgets remain 30 seconds each; valid incremental output resets idle, heartbeats do not. Output is capped at 1 MB. Other existing model operations keep their legacy behavior.

## Bounded administration

Requires migrations 0042 and 0043 and the ordinary application worker running in the deployed API process. Do not start an SSH background worker.

1. `journal-import llm-job-submit /private/job.json`, stdin `{target,requestId,source,sentence,fallbackDate,provider}`.
2. `journal-import llm-job-status /private/job.json` (repeat bounded read-only commands).
3. Optional `journal-import llm-job-cancel /private/job.json`.
4. On completed, `journal-import llm-job-export /private/job.json /private/plan.json`.
5. Inspect private plan; use existing digest-bound apply/backup command only after confirmation.

Each command is bounded separately; a 70-second CLI or 90-second connector timeout does not terminate the application model stream. Reuse the exact requestId after an uncertain submit. Legacy synchronous `llm-preview` is not the streaming execution path. Private job rows are removed after 24 hours once terminal; original source is removed from failed/cancelled payloads immediately. Completed private envelopes necessarily retain original source until expiry/removal.

# Daily travel journal (first version)

Open a saved Journey in Stream and choose **每日手记**. Paste a complete text document, select the fallback local date/year, and generate a preview. Explicit `YYYY-MM-DD` and `M月D日` headings create chapters; undated text is retained under the selected date. Events retain source line order. Review each event's status, prose, local date/time and optional existing Journey place/media links, then choose **确认保存**. Cancel discards the preview without writing.

Explicit `实际：`, `计划：`, `取消：`, `待确认：` prefixes (including bracketed labels and section headings) preserve source status; unlabeled/ambiguous prose remains **待确认**. Date headings and pure status headings are metadata rather than extra events. A chapter titled `计划` defaults its unlabeled events to planned, never actual. It does not infer arrival instants, time zones, coordinates, visits or narrative-day boundaries. Only an event marked **实际** can link a map point. A next-day local date can remain inside the previous night's chapter. Reimporting the same source and original import date preserves existing edits, including corrected display dates; the same undated prose on different import days remains distinct. New chapters retain an immutable `importDate` (older JSONB documents may omit it). Changed source becomes a new preview chapter and must be reviewed/removed explicitly. There is no automatic creation of Route Points.

The reading surface has a date directory, full untruncated plain text, original-source disclosure, and inline selected images/videos. Actual linked places return to the existing Stream observation/map bridge. Native vertical scrolling supports long chapters on phones. This is a Stream entry; Book/film layouts are unchanged.

## Hotel tools

After saving the diary, choose **用 AI 查找已入住酒店**. The existing INTENT Chat Completions channel must support strict function tools. Two whitelisted calls (`search_hotels`, `stage_hotel_links`) extract explicit completed stays and select only returned location candidates. This does not give the model HTTP, SQL, credentials, account IDs or write authority. Original chapter context is sent to the configured model; only hotel name/area reaches the existing location-search adapter. Edited prose and media are excluded. No live provider was used during development.

Explicit planned/cancelled events are excluded. Actual and uncertain events may produce a proposal, but missing names/areas, ambiguous branches, conflicting nearby existing points or unreturned candidate IDs never create a point. Names and areas must be verbatim source evidence; coordinates come only from the existing search adapter. A reliable existing Journey point is reused before searching externally. Strict name/address matching is deliberately conservative: translated aliases or incomplete addresses may remain questions rather than being guessed.

Independent review additionally required a server-side factual gate: the selected hotel must be the immediate object of an explicit completed-stay verb, with no plan/cancellation/negation/uncertainty/instruction markers. Unsupported word order and English `stayed ... for ...` purposes/durations remain questions. Mixed replacement sentences remain questions rather than being cropped into misleading proof. The preview displays the complete event source, and confirmation rechecks it. Normalized name/area must be nonempty, so punctuation cannot stand in for a city. These conservative checks do not claim to prove every natural-language assertion; the member reviews the full source before approval.

Review the batch, then choose **确认批量添加及关联**. This is approval for this exact preview only. The server signs a 15-minute plan bound to Atlas, Journey and both revisions; confirmation rechecks authorization and locks the same active Atlas/Journey as existing writes. Hotel points and journal links commit together. Exact replay is a no-op; stale plans return 409. Repeated stays reuse the same point. New hotels are appended in source-event order; existing route order, dates, local times, source and manually edited prose are untouched. No UTC timestamp is invented. Canceling a preview writes nothing; accepted saves cannot be described as canceled.

No additional database migration is required beyond 0040/0041. `pnpm qa:journal-hotels` runs the existing journal browser baseline plus desktop/phone hotel confirmation, duplicate-click, cancellation and account-switch checks. Unavailable model/search services leave the manual journal workflow available. This feature has not imported any private travel source.

Hotel writes update the owner application's Journey state as well as the open Stream. The browser regression remounts Stream and verifies the new point/link survives, avoiding stale route revisions after closing the reader.

## Persistence and access

Migrations `0040_daily_journal.sql` and `0041_journal_write_replay.sql` add one `journey_journals` row per Journey: a separate optimistic revision and a bounded JSONB chapter document. A private digest of the last accepted request makes response-loss retries safe even when the server cleared stale references. These migrations are additive; old Journeys read as revision 0 with no chapters. Apply with the existing `pnpm db:migrate` workflow before deploying code. There is no backfill or production-data import. Hard Journey/Atlas deletion cascades; soft-deleted parents cannot be read or written.

The API uses existing active Atlas membership and permission checks:

- `GET /api/journeys/:id/journal`
- `PUT /api/journeys/:id/journal` with `{baseRevision, chapters}`
- `POST /api/journeys/:id/journal/suggest` with `{chapters}`

Writes lock Atlas then Journey, validate all media/place references belong to that Journey, preserve existing raw evidence, and reject stale revisions. Structurally identical retries are no-ops even after a lost response. Journals are absent from all shared-link/Journey projections; they remain available only through the Atlas-authorized API. API reads are private/no-store. No draft text is placed in browser storage.

Preview validation caps documents to 120 chapters, 2,000 events and 480,000 UTF-8 JSON bytes, staying below the existing API body limit. Source text input has a 200,000-character ceiling; the encoded-document ceiling may be reached first. No timestamps are synthesized from wall-clock values.

## Optional model adapter

The daily journal now directly reuses `server/intents/intent-model-request.ts`, the existing standard Chat Completions transport. It uses the already supported server settings:

- `INTENT_DRIVER=http-model`
- `INTENT_BASE_URL`: the API root, for example `https://model.example/v1` (the adapter appends `/chat/completions`).
- `INTENT_API_KEY`, `INTENT_MODEL`, `INTENT_TIMEOUT_MS`: existing server-only credential/model/timeout settings.

It sends `messages` and a strict `response_format: json_schema`, and decodes `choices[0].message.content`. A compatible model must support strict JSON Schema output. DashScope uses the existing transport's `enable_thinking:false` handling. Unsupported schemas, refusals, invalid JSON, omitted/duplicate events, transport errors and timeouts fail explicitly; no automatic retries or cross-provider fallback occur. No proxy/bridge or externally implemented `daily-journal` service is needed.

The older `ITINERARY_RECOGNITION_*` recognizer is a **different, custom** `{document, contractVersion}` protocol. Merely configuring that custom recognizer does not enable journal AI. Journal AI does not send new payloads to that external service. A deployment already using the existing `INTENT_*` channel needs no extra configuration or external code. A deployment with that channel disabled needs its operator to enable the existing supported settings; this implementation does not create credentials or alter deployment configuration. The task environment has not made any paid/live model call.

Only source text, chapter dates, event IDs and reviewed status go to the model; member-edited prose, media, coordinates and account fields are excluded. The model cannot mutate dates/status/attachments. Suggestions stay separate, include questions and clearly unverified background, and can be adopted for all untouched event prose with one preview action. Hand-edited prose remains protected. Saving still requires **确认保存**. Generation cannot mechanically prove factual entailment, so members must review suggestions.

Saving blocks close/discard controls until the request resolves; aborting a browser request is not represented as undoing a server write. Existing references to deleted/moved media or places are cleared during the next authorized write, but newly supplied foreign references remain errors. Media links can also be explicitly cleared even when no media remains in the Journey.

## Verification

`pnpm test` includes model, parser and real PostgreSQL API tests. Run with the repository's normal isolated test database environment. `pnpm qa:daily-journal` uses the production Stream and journal components with synthetic data and an intercepted API at `QA_ORIGIN` (default `http://127.0.0.1:4173`). It checks desktop/mobile import, cancellation, duplicate clicking/import, manual-edit protection, late model results, account switch, long text, and linked place navigation, and writes screenshots under ignored `artifacts/daily-journal/`.

The browser harness is not production data. Private journey source must never be checked into this repository or passed to a model during development.

# Daily travel journal (first version)

Open a saved Journey in Stream and choose **每日手记**. Paste a complete text document, select the fallback local date/year, and generate a preview. Explicit `YYYY-MM-DD` and `M月D日` headings create chapters; undated text is retained under the selected date. Events retain source line order. Review each event's status, prose, local date/time and optional existing Journey place/media links, then choose **确认保存**. Cancel discards the preview without writing.

The first version deliberately imports every event as **待确认**. It does not infer arrival instants, time zones, coordinates, visits or narrative-day boundaries. Only an event marked **实际** can link a map point. A next-day local date can remain inside the previous night's chapter. Reimporting identical chapter source preserves existing edits; changed source becomes a new preview chapter and must be reviewed/removed explicitly. There is no automatic creation of Route Points.

The reading surface has a date directory, full untruncated plain text, original-source disclosure, and inline selected images/videos. Actual linked places return to the existing Stream observation/map bridge. Native vertical scrolling supports long chapters on phones. This is a Stream entry; Book/film layouts are unchanged.

## Persistence and access

Migration `0040_daily_journal.sql` adds one `journey_journals` row per Journey: a separate optimistic revision and a bounded JSONB chapter document. It is additive; old Journeys read as revision 0 with no chapters. Apply with the existing `pnpm db:migrate` workflow before deploying code. There is no backfill or production-data import. Hard Journey/Atlas deletion cascades; soft-deleted parents cannot be read or written.

The API uses existing active Atlas membership and permission checks:

- `GET /api/journeys/:id/journal`
- `PUT /api/journeys/:id/journal` with `{baseRevision, chapters}`
- `POST /api/journeys/:id/journal/suggest` with `{chapters}`

Writes lock Atlas then Journey, validate all media/place references belong to that Journey, preserve existing raw evidence, and reject stale revisions. Structurally identical retries are no-ops even after a lost response. Journals are absent from all shared-link/Journey projections; they remain available only through the Atlas-authorized API. API reads are private/no-store. No draft text is placed in browser storage.

Preview validation caps documents to 120 chapters, 2,000 events and 480,000 UTF-8 JSON bytes, staying below the existing API body limit. Source text input has a 200,000-character ceiling; the encoded-document ceiling may be reached first. No timestamps are synthesized from wall-clock values.

## Optional model adapter

Uses the existing `ITINERARY_RECOGNITION_*` provider configuration, credentials and timeout. No new provider or paid credential is required. The existing provider-neutral HTTP endpoint must support the additional envelope:

```json
{"model":"configured-model","contractVersion":1,"document":{"kind":"daily-journal","chapters":[{"date":"2027-04-03","source":"fictional source","events":[{"id":"event-id","source":"fictional line"}]}]},"instructions":"source-only rewrite policy"}
```

Response:

```json
{"contractVersion":1,"suggestions":[{"eventId":"event-id","text":"proposed prose","questions":["unresolved detail"],"background":"unverified general background, if any"}]}
```

The model sees original source only, not the member's edited prose or media. It cannot return dates, status, coordinates, attachments or executable actions. Suggestions remain separate; explicit per-event adoption is disabled after a member edit. Missing/conflicting facts should become questions, background is labeled unverified, and the member must check factual accuracy. This contract does not mechanically prove factual entailment. A disabled or incompatible provider returns an explicit error while manual preview/edit/save still works. No live provider calls were used for development.

## Verification

`pnpm test` includes model, parser and real PostgreSQL API tests. Run with the repository's normal isolated test database environment. `pnpm qa:daily-journal` uses the production Stream and journal components with synthetic data and an intercepted API at `QA_ORIGIN` (default `http://127.0.0.1:4173`). It checks desktop/mobile import, cancellation, duplicate clicking/import, manual-edit protection, late model results, account switch, long text, and linked place navigation, and writes screenshots under ignored `artifacts/daily-journal/`.

The browser harness is not production data. Private journey source must never be checked into this repository or passed to a model during development.

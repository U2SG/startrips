# One-sentence journal import with hotel linking

This is a bounded workflow, not an agent with arbitrary HTTP/SQL access. The
current journal import uses a durable application-owned job and actual provider
SSE tool-call deltas. Frontend and administrative callers submit and observe the
same job; only a fully received and validated answer becomes a preview. Existing
journal and hotel confirmation routes remain available. No new credentials are
introduced. See [the streaming protocol](../../docs/journal-import/stream-protocol.md)
for endpoints, progress events and cancellation semantics.

Migrations 0042 and 0043 and the normal API worker must be deployed before using jobs. Do
not run an ad hoc SSH background worker or bypass the migration release process.

## Input and provider scope

The CLI uses `node --import tsx server/admin/journal-import-cli.ts`, or the single
bundle built by `node scripts/build-journal-admin.mjs` (see README for transport
and private-file permissions). Each short submit/status/export invocation retains its 70-second deadline; the
model stream belongs to the application and survives observer/CLI disconnect.
The original text travels via stdin, never command-line arguments or logs.

`llm-job-submit /private/job.json` stdin (retain the requestId for uncertain-submit replay):

```json
{"requestId":"client-generated-uuid","target":{"userId":"confirmed-id","email":"confirmed@example.test","atlasId":"confirmed-atlas","journeyId":"confirmed-journey"},"sentence":"导入这份流水账并关联已入住酒店","source":"private original text","fallbackDate":"2028-06-01","provider":{"baseUrl":"provider:current-discovered-identity","model":"configured-journal-model"}}
```

The jobs API accepts the same sentence/source/fallbackDate/provider and journeyId;
it obtains user and Atlas from the authenticated session. Discover the current
provider through the authenticated provider endpoint and echo its opaque baseUrl
identity unchanged. The displayName contains only the hostname. Administrative
callers may acknowledge the existing raw configured baseUrl for compatibility,
but new plans and job payloads retain only the opaque, configuration-bound identity.
No URL credentials/path/query or API key are returned. Hotel continuation refuses
a changed provider configuration.

Legacy synchronous `llm-preview` and POST `/journal-import` remain compatibility
paths with their previous deadlines; they are not the streaming execution path.
Use jobs for whole-document imports. No partial stream is resumed after a worker
crash: the job becomes interrupted without automatic model replay. Observer
reconnection resumes observation of an existing live job, not model regeneration.

Whole-source extraction sends only the requested source lines/indexes, sentence
and fallback year. It excludes existing member prose, photos, credentials and
account metadata. Hotel processing sends only chapters belonging to this input,
not other stored journals. Hotel selection retains that private extraction
conversation and its matched trusted candidate labels/addresses; geocoding
receives only hotel name and source area. No member-edited prose is added.
Never substitute another provider or treat authorization of a different input as
permission to send this source.

## Evidence and preview

The model calls only `stage_journal_import` once per source segment (see the
streaming protocol), returning chapter line boundaries, a heading flag, line
references, statuses, local clocks/ranges, explicit date evidence, one actual place name (or null), and
questions. The server takes all event text and titles from the source lines; it never asks
the model to copy a line. It validates coverage/order, exact short references, normalized
calendar/clock format, structured interval ordering and existing journal references.
The tool instructs the model to keep mixed narratives uncertain, cancellations
cancelled, and date ranges unallocated. The server does not independently prove
these semantic interpretations. It never derives another date or UTC conversion
from clock order. Duplicate chapter text/date within one input is a grouping error:
correction must preserve every repeated line, not treat it as a saved-record replay.

Original source and event prose stay intact; the importer proposes no rewritten
prose, so each suggestion is the source line. A line whose date, clock or place
claim fails validation stays in the preview as `uncertain` with a review
question; a segment whose structure cannot be corrected becomes a deterministic
review preview, and the job status reports `degradedLines` and each fallback
segment's `{segment,path,code}` without source text. This
bounded importer does not claim to prove arbitrary generated prose true. The
separate existing reading-suggestion UI is not silently invoked. Matching previous
chapters retain all manual text, suggestions, corrected dates, media and links.
Identical undated text on different archive dates remains distinct.

The private signed v2 plan contains before/after snapshots, exact target,
importedChapterIds, source digest, provider and expiry. Stdout contains only stage,
mode, provider, revisions, dates, counts and planDigest. Inspect the private plan
and evidence before applying; neither schema success nor mock tests establish that
a real provider response is correct. Old v1 previews are rejected. Do not apply
old plans generated by the deterministic-only version.

## Stages and recovery (not one cross-stage transaction)

1. `llm-job-submit JOB_REF` — enqueue a private preview job. Poll with
   `llm-job-status JOB_REF`; optionally stop with `llm-job-cancel JOB_REF`.
   After completed, `llm-job-export JOB_REF JOURNAL_PLAN` writes the private signed
   plan. No journal or Route Point is written by these operations. The worker
   persists only progress counts during generation, not partial model arguments.
2. `apply JOURNAL_PLAN PLAN_DIGEST JOURNAL_BACKUP` — existing journal transaction
   with locked target/membership and revision check, after a durable private backup.
3. `hotels-preview JOURNAL_PLAN HOTEL_PLAN` — stdin `{"provider":{...}}`; requires
   the saved journal to match the journal plan, then uses the existing two bounded
   hotel tool calls and trusted location adapter. No point writes. Review the
   signed checkpoint's candidates/questions, not only a zero/nonzero count.
4. `hotels-apply HOTEL_PLAN PLAN_DIGEST HOTEL_BACKUP` — exact signature, target,
   revisions and full-source checks; durable backup includes journal and Journey
   snapshot; the existing hotel repository creates/reuses points and links journal
   events in one transaction. It never changes Journey date bounds or old media.

The **journal and hotel stages are separate commits**. Hotel failure leaves the
completed journal intact; report that state honestly. Continue with the same
journal plan and a new hotel-preview file, without reimporting the source or
silently repeating model calls. Missing/ambiguous hotels return questions and
`hotels-unresolved`/`hotels-partial`, never fabricated successful associations.
No model is allowed to choose coordinates, arbitrary candidates or a different
account/Journey. Existing same-hotel points are reused.

If an apply times out or loses its response, outcome is UNKNOWN. Replay the same
signed checkpoint and digest: receipt/content checks return already-applied
without another write/backup. Expiry does not prevent a verified read-only receipt
confirmation, but an expired plan without a receipt cannot write. If concurrent
editing changes the journal/Journey revision, stop and make a new reviewed preview;
never enlarge timeouts, suppress assertions or overwrite the edit.

After each write, run `readback JOURNAL_PLAN PRIVATE_OUTPUT` (or use the existing
repository/API) and verify
original-source coverage, statuses/clocks, retained manual content/media, and hotel
links to the returned owned route points. Retain both signed plans and backups.
`rollback-check JOURNAL_BACKUP` applies to the journal-only stage; after hotels
are linked it intentionally does not report the old journal-only state eligible.
Restoring hotel effects requires comparing the hotel checkpoint and current
journal/Journey state, then using existing authorized domain mutations under the
same revision guards. There is no automatic destructive rollback or direct SQL
restore command. Do not restore a whole database over later unrelated edits.

Real-provider acceptance is an operator step after mock/review/CI: validate the
configured provider identity, run only preview stages first, inspect full private
output (including ambiguous/mixed cases), and apply solely within the explicitly
authorized target and data scope. The repository fixtures are fictional.

## Staging tool contract and bounded correction

`stage_journal_import` now requires a chapter/event `dateStatus`: `absent`,
`unknown`, `single`, or `range`. Unknown dates retain an exact source quote, null
normalized values and a question. Chapter ranges have two valid, ordered inclusive
YYYY-MM-DD endpoints. Events cannot be assigned one day from a range; they retain
null `localDate` and a question. Clock values use local 24-hour HH:mm, with no
inferred midnight date or timezone conversion. Every nonempty line must be an
exact event reference except an explicitly quoted whole first-line heading.

Field descriptions assign semantic interpretation to the model. Server code checks
JSON shape, forbidden extra fields, line coverage, exact references on the associated
line, calendar/clock validity and cross-field consistency. It does not rescan prose
with fuzzy date/clock/status regexes. A substring proves provenance, not correct
interpretation or completeness of the quote: an incorrect `single` classification
can still pass structural validation. Review the preserved original and preview.
The `3.5公里` and fullwidth `？` cases in tests are synthetic model claims, not
real-provider quality measurements.

Each named tool permits at most three provider calls (two corrections), stopping
earlier when the same field/error repeats. Only `ToolArgumentError` from pure
pre-execution validation is fed back as a bounded, server-owned error with the
original call ID and full assistant/tool protocol messages. Tool identity, unknown
execution outcome, cancellation, lease/permission/version changes, transport and
server-validator failures are terminal. No search or write is repeated to fix a
later tool's arguments. Hotel stages share the matched search result and use only
trusted candidate IDs/coordinates; existing stay/branch and write guards remain.
A hotel workflow has two stages, hence at most six model calls and 30 searches.

Before each attempt and execution, callers recheck current authority/state. Job
corrections recheck the lease and configuration digest. A successful preview stops
without a billable final prose request. Tool messages remain private in memory;
no raw arguments or provider exceptions enter error feedback or diagnostics.
Signed plans, explicit save, backups, revision checks and replay receipts remain
required. This change does not add automatic save, a model fallback, or model
selection configuration.

## Failure diagnostics and long-input acceptance

Ali Qwen3.8 Max streaming tool requests set `tool_stream: true` as well as
`stream: true`. The provider's [Chat API contract](https://www.alibabacloud.com/help/en/model-studio/qwen-api-via-openai-chat-completions)
documents that array/object tool parameters are buffered by default unless this
additional switch is enabled. The journal's nested chapter/event arrays need
incremental arguments to make progress within the existing 30-second semantic
idle budget. The extension is restricted to this model family on Ali endpoints;
synchronous requests, non-tool requests and other models are unchanged.

This does not increase connection, first-byte or idle timeouts. Keepalives and
reasoning-only frames are not tool-argument progress, and incomplete responses
never become previews. The provider notes a complex-format accuracy tradeoff for
incremental output: schema/semantic-parameter validation, bounded correction and
operator preview review remain required. Mock buffered/incremental streams verify
the request contract and failure boundaries; they do not establish that a real
failed request was buffered or that another paid call will succeed. A terminal
transport failure must not be retried automatically.

CLI failure stderr is one JSON object with allowlisted `error`, command `stage`,
`kind` (`transport`, `protocol`, `tool_arguments`, `validator`, `business`,
`permission`, `cancelled`, `configuration`, `operation`) and, for model errors,
the application's mapped HTTP `status`. It never prints exception messages,
causes, provider response bodies, private source, keys or URLs. In journal
extraction, `INTENT_TIMEOUT`, `INTENT_UNREACHABLE` and `INTENT_FAILED` remain
transport errors; `JOURNAL_IMPORT_MALFORMED` means the response could not satisfy
the structured argument/reference boundary within its correction budget (HTTP 422).
`INTENT_TOOL_PROTOCOL_INVALID` identifies a bad call envelope or ID;
`TOOL_VALIDATOR_ERROR` identifies an unexpected server validation failure. Neither
is automatically corrected. These diagnoses do not attribute a server defect to the model.
The status is the application's mapping, not the provider's raw HTTP status.

An earlier real acceptance attempt returned only `IMPORT_FAILED`; that lost
cause cannot be reconstructed from elapsed time. This diagnostic repair does not
claim the provider extraction succeeded. Run at most one explicitly authorized
new preview with the repaired bundle; inspect its stable code and absence/presence
of a plan before deciding the next step. No automatic transport retry or timeout increase.

Whole-source extraction uses one complete response per attempt (up to three for argument correction). Hundreds of events, including
verbatim evidence and reading fields, can exceed a short provider latency/output
budget even when input bytes are small. Mock tests do not establish real-provider
throughput. A future bounded extraction checkpoint should bind the full source
hash, exact target, provider, before revision and global line indexes; retain the
full date-heading context; issue one bounded chapter/window request per invocation;
store validated results privately; and seal a final plan only after proving complete,
nonoverlapping coverage/order. A failed window must not erase earlier validated
windows, silently resubmit them, or save a partial journal. Date-range, midnight,
and international date-line context must cross boundaries without inferred dates.
Heading/window detection may select source spans, but may not replace model fact
classification with a regular-expression import. This resumable extraction layer
is not implemented by the diagnostic repair; current checkpoints resume the
journal/hotel stages, not partial model responses.

The tool instructs the model to include meridiem cues in clock evidence: for
example, interpret `晚上9:00` or `9:00 PM` as `21:00`. It also instructs the model
to retain ambiguous/approximate or incomplete clocks as null values with questions.
The server checks clock format, reference existence and cross-field consistency;
it does not establish that cues were included or interpreted correctly. A claim
of `09:00` citing `9:00` in `晚上9:00` can pass these structural checks. Inspect the
preserved source and preview; mock tests do not prove real-model interpretation.
A structured clock range retains the supplied quote without deriving another date.

## Existing journey place and media links

The same extraction call may cite one exact place name from an actual event.
It must return null for mere mentions, multiple places, plans and cancellations.
The server matches the complete name (Unicode/letter-case normalization only)
against the current journey's locked route points. No aliases, substring search,
new coordinates or new route points are inferred. Multiple same-name points and
impossible explicit-date conflicts remain unlinked with a review question.
A timestamp is rejected only if incompatible with the event's explicit date (or an explicit single-day heading when the event has
no date claim) in
all UTC offsets within ±14 hours; archive dates never count as event evidence.
The model's semantic claim is still a reviewable interpretation, not independent
proof that the visit occurred. No existing journey metadata is sent to the model.

Only new events receive these links; saved events, including deliberately empty
links, are preserved on replay. The resulting preview still requires Save.
Reading and editing project photos/videos already owned by a linked route point,
in an explicitly labeled place-context group (not event capture evidence), separately
from manual event links and deduplicated. Clearing manual links does not suppress
place context; the editor explains this next to the control. Each visible place gallery appears once, collapsed by default; other events link
to it. Media read components mount only when expanded. No media IDs are copied
or ownership changed.
Already-linked saved journals therefore show their location media without import.
Route timestamps are displayed separately, never used to fill missing journal
local date/time. Unlinked old events need explicit editing or a new import, rather
than silently guessing whether a member intentionally cleared their links.

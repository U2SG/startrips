# Cover-reveal worker protocol

Slice 1 of #367, specified by #368. This is the whole server-side contract an
external local worker needs in order to produce a private artistic derivative
of a Journey's canonical cover — and nothing more.

**Out of scope, by construction.** No RevealFlow renderer, no Journey opening
UX, no local AI worker client, no `ink-wash-poster` execution on the server, no
guest or share publication of a derivative. Those belong to ST-073 and the
later slices of #367. This document exists so Slice 2 can implement its client
against a frozen contract rather than against the server's source.

## What the protocol is for

The canonical cover of a Journey is a `media_assets` row whose bytes the member
uploaded. A derivative is a second, private image generated from it. The
derivative must never replace, reorder or touch the original, and the worker
that produces it must never receive database access, SSH access, an
object-store master credential, an Atlas session or a share.

So the derivative lives in its own table, the worker gets its own credential
class, and every object the worker touches is one the server chose.

```text
owner enqueue   POST /api/cover-reveal/journeys/:journeyId   (session)
claim           POST /api/cover-reveal-worker/claim          (worker credential)
source read     POST /api/cover-reveal-worker/jobs/:id/source-read
output upload   POST /api/cover-reveal-worker/jobs/:id/output-upload
complete        POST /api/cover-reveal-worker/jobs/:id/complete
fail            POST /api/cover-reveal-worker/jobs/:id/fail
```

One restart-safe worker iteration is: `claim` → `source-read` → `output-upload`
→ PUT the bytes → `complete`, or `fail` at any point. A worker that crashes
mid-iteration does nothing: its lease expires and the job is reclaimable.

## Principals

| Principal | How it is resolved | What it may do |
| --- | --- | --- |
| Atlas owner | Better Auth session → `session.session.activeOrganizationId` → `requireAtlasAccess` | enqueue a derivative for a Journey of its own Atlas |
| Cover-reveal worker | `Authorization: Bearer <COVER_REVEAL_WORKER_TOKEN>` | the five `/api/cover-reveal-worker/*` routes, and nothing else |
| Claimant | `leaseToken` in the request body | act on the one job it holds the lease for |

The worker credential is **not** a session and is never converted into one. It
is one env value (`COVER_REVEAL_WORKER_TOKEN`), so revocation and rotation are
a config change plus a restart — no row to find and invalidate. With it unset
every worker route answers `401 COVER_REVEAL_WORKER_UNAUTHORIZED` and the rest
of the API is unaffected.

The credential and the lease token are deliberately different things. The
credential says which process may speak here at all; the lease says which claim
of which job it is speaking as. Only the lease token's SHA-256 is stored, so a
database reader cannot complete a job it did not claim.

## Eligibility, decided by the server

`server/cover-reveal/eligibility.ts` is a pure, DOM-free module. A worker never
chooses a Journey or an asset: it names a job id and a lease token, and the job
already names everything else.

The effective cover is the explicit `journeys.cover_media_asset_id` when it
still names a visual asset of this Journey, otherwise the first visual asset by
`sort_order` — the same rule `journeyCover()` applies in the client. It must
then be:

- a supported raster image (`image/jpeg`, `image/png`, `image/webp`; SVG is
  refused because it is markup, and a video cover is refused rather than
  skipped past, because skipping would generate a derivative of something the
  member does not see as the cover);
- carrying a **verified** stored-byte identity — `content_hash_verified = true`
  from #311. An unverified or absent hash fails closed; #368 forbids a second,
  weaker client-asserted identity.

Refusal reasons: `JOURNEY_UNAVAILABLE`, `NO_COVER`, `SOURCE_UNSUPPORTED`,
`SOURCE_IDENTITY_UNVERIFIED`.

## Durable state

`cover_reveal_derivatives` — one job, distinct from `media_assets`:

| Column | Meaning |
| --- | --- |
| `journey_id` | FK, `on delete cascade` |
| `source_media_asset_id` | the pinned cover. **No FK**: the job must still be able to say what it was pinned to after that row is gone |
| `source_content_hash` | #311's verified stored-byte identity of the pinned source |
| `generation_kind` / `generation_version` | `ink-wash-poster` and the contract version. No prompt text, no executable blob |
| `preset_id` / `seed` | the RevealFlow preset and the deterministic seed the worker must use |
| `output_storage_driver` / `output_storage_key` | object identity of the generated object |
| `output_mime_type` / `output_bytes` / `output_width` / `output_height` | what the server **measured**, set only at completion |
| `state` | `queued \| leased \| ready \| failed \| superseded` (DB check constraint) |
| `lease_token_hash` / `lease_expires_at` | SHA-256 and expiry of the most recent claim |
| `attempts` / `last_error_code` | bounded retry metadata; the code is chosen from a server-side allowlist, never the worker's message |
| `superseded_at`, `created_at`, `updated_at` | timestamps |

`cover_reveal_writes` — the record of one issued write, with **no foreign key
at all**, so it survives the cascade whose victim it exists to clean up after.

**Nothing durable is ever a secret.** No column holds a signed read URL, a
signed upload URL, a raw lease token or a storage credential; `*_storage_key`
is object identity and `lease_token_hash` is a hash. The column set is pinned
by a named case in `server/cover-reveal/derivative-secrets.test.ts`, which also
asserts that no cover-reveal module logs a token, a URL or a credential.

Two more rules live in the database rather than in prose: a lease is a hash and
an expiry together or neither, and a row cannot say `ready` without the
complete description of the object that makes it servable.

## State machine

```text
            enqueue
              ↓
           queued ─────claim────→ leased ────complete (validated)────→ ready
              ↑                     │
              └──fail / invalid─────┤  (attempts < COVER_REVEAL_MAX_ATTEMPTS)
                                    │
                                    ├──fail / invalid──→ failed  (budget spent)
                                    │
  cover identity moved, source gone, Journey deleting
                                    ↓
                               superseded
```

`superseded` is terminal and is not a failure: nothing went wrong, the member
changed the cover. The row is kept rather than deleted, because it is what
makes a late completion from the old claimant recognisable and refusable.

## Claim and lease

The claim is one statement:

```sql
update cover_reveal_derivatives set state = 'leased', lease_token_hash = …, …
where id = (
  select id from cover_reveal_derivatives
  where (state = 'queued' or (state = 'leased' and lease_expires_at <= now))
    and attempts < :maxAttempts
    and exists (select 1 from journeys
                where journeys.id = journey_id and deletion_started_at is null)
  order by created_at limit 1 for update skip locked)
returning …
```

- **At most one active lease.** Two concurrent claims of one queued job: one
  wins, the other skips the locked row and is answered
  `404 COVER_REVEAL_NO_WORK`. Several scheduled worker invocations are
  therefore safe — they take different jobs rather than serialising.
- **Reclaim** falls out of the same predicate: an expired lease makes its job
  selectable again, and the update overwrites `lease_token_hash`.
- **Ownership is the token, not the clock.** A worker that finishes a moment
  after its lease expired still completes *if nobody reclaimed*, and can never
  complete once somebody did.
- **A fresh output key per claim**, because a reclaim is a new generation and
  must not be able to publish whatever the previous claimant may still be
  uploading.

## Requests and responses

All worker requests carry `Authorization: Bearer <credential>` and, except for
`claim`, a JSON body `{ "leaseToken": "<token>" }`. Responses are
`private, no-store`.

### `POST /api/cover-reveal/journeys/:journeyId` — owner

`200` →

```json
{ "derivative": { "id": "…", "journeyId": "…", "state": "queued",
  "generationKind": "ink-wash-poster", "generationVersion": 1,
  "presetId": "reveal-flow-ink-wash-v1", "seed": "…",
  "sourceMediaAssetId": "…", "sourceContentHash": "…",
  "attempts": 0, "lastErrorCode": null } }
```

Idempotent by pinned identity: a Journey whose cover has not moved already has
the job it needs, and the same job is returned. A job pinned to a source that
is no longer the cover is superseded in the same call. The guarantee is a
partial unique index over `(journey_id, source_media_asset_id,
source_content_hash, generation_kind, generation_version)` restricted to the
live states, so two concurrent enqueues leave one job rather than two — the
read-before-insert is only an optimisation.

The guarantee is the database's, not the read's. A partial unique index over
`(journey_id, source_media_asset_id, source_content_hash, generation_kind,
generation_version)` restricted to the live states `queued | leased | ready`
means two owner requests arriving together cannot both insert: the loser
conflicts, writes nothing, and reads the winner back, so a client may call this
route as often as it likes. The predicate is the live set on purpose — a
`failed` or `superseded` job is history and never blocks a fresh attempt on the
same cover.

`404 JOURNEY_UNAVAILABLE`; `409 NO_COVER` / `SOURCE_UNSUPPORTED` /
`SOURCE_IDENTITY_UNVERIFIED`; `409 JOURNEY_UNAVAILABLE` in the narrow case
where the winner left the live set between the conflict and the read back,
which only a cover change can do — the client asks again.

### `POST /api/cover-reveal-worker/claim`

`200` →

```json
{ "derivative": { … },
  "lease": { "token": "…", "expiresAt": "2026-09-15T06:00:00.000Z" },
  "output": { "mimeType": "image/jpeg", "maxBytes": 4194304,
              "maxEdgePixels": 2048 } }
```

`404 COVER_REVEAL_NO_WORK` when nothing is claimable. The raw lease token
appears in this response and nowhere else, ever.

### `POST /api/cover-reveal-worker/jobs/:id/source-read`

`200` → `{ "source": { "url", "expiresAt", "mimeType", "bytes" } }`

A presigned read of exactly the pinned source object, for
`COVER_REVEAL_SOURCE_READ_EXPIRES_IN_SECONDS` **clamped to what is left of the
lease**, so a capability can never outlive the claim it belongs to and an
already-expired claimant mints nothing at all. The key is read from the pinned
row, not from the request, and the pinned stored-byte identity must still
match, so a worker cannot be handed a read of an object the job was not pinned
to. `404 COVER_REVEAL_NOT_CLAIMED`; `409 COVER_REVEAL_NOT_LEASED` /
`COVER_REVEAL_SOURCE_CHANGED`.

### `POST /api/cover-reveal-worker/jobs/:id/output-upload`

`200` → `{ "upload": { "url", "headers", "expiresAt", "mimeType", "maxBytes",
"maxEdgePixels" } }`

A presigned single-object PUT to exactly the key this claim owns, for
`COVER_REVEAL_UPLOAD_EXPIRES_IN_SECONDS` clamped to the remaining lease. **There is no
storage key on this request**, so an arbitrary key cannot be requested. The
write is recorded in `cover_reveal_writes` before it is signed, so the object
has an owner no cascade can take away. The worker then PUTs its JPEG to `url`
with the returned `headers`.

### `POST /api/cover-reveal-worker/jobs/:id/complete`

`200` → `{ "derivative": { …, "state": "ready" } }`

Before publishing, the server validates, in order:

1. the caller still holds the lease and the job is `leased`;
2. the Journey's effective cover **re-resolves** to the pinned asset id *and*
   the pinned verified content hash — a pointer comparison would miss a
   reordering, and `server/routes/uploads.ts` nulls the pointer on media
   move/undo. This check is made twice: once early, to avoid a pointless
   storage read, and then again **inside the transaction that writes `ready`**,
   holding a `FOR UPDATE` lock on the Journey row and on its media rows in the
   repository's lock order. Without the second check the cover could move
   between the validation and the write, because nothing about a Journey or
   media mutation conflicts with the derivative row;
3. the expected output object exists;
4. its byte size is within `COVER_REVEAL_MAX_BYTES`;
5. its bytes decode as the issued JPEG and its encoded pixel size is within
   `COVER_REVEAL_MAX_EDGE_PIXELS`.

Failures: `404 COVER_REVEAL_NOT_CLAIMED`; `409 COVER_REVEAL_NOT_LEASED`,
`COVER_REVEAL_SOURCE_CHANGED` (job → `superseded`, object removed),
`COVER_REVEAL_OUTPUT_MISSING` (**retryable**: the job stays `leased`, because
"the upload has not landed yet" is not a permanent loss),
`COVER_REVEAL_OUTPUT_TOO_LARGE`, `COVER_REVEAL_OUTPUT_PIXELS_TOO_LARGE`,
`COVER_REVEAL_OUTPUT_UNREADABLE` (object dropped, attempt settled).

The one residual the row locks cannot exclude is an INSERT of a brand-new
asset, which no lock on existing rows can prevent. A new asset can only win the
`sort_order` fallback, never displace an explicit pointer, and the invalidation
pass supersedes the job on its next run — so the outcome is a derivative that
is retired, never one attached to the wrong cover.

A successful completion writes only `cover_reveal_derivatives`. The Journey's
`cover_media_asset_id`, its `revision`, and every `media_assets` row —
identity, stored bytes and `sort_order` — are untouched.

### `POST /api/cover-reveal-worker/jobs/:id/fail`

Body `{ "leaseToken", "reason" }` where `reason` is one of
`WORKER_SOURCE_UNREADABLE`, `WORKER_GENERATION_FAILED`, `WORKER_UPLOAD_FAILED`,
`WORKER_CANCELLED`; anything else is recorded as `WORKER_UNSPECIFIED`. The job
returns to `queued` while the retry budget lasts, and becomes `failed` once it
does not.

Settling an attempt — by `fail` or by a rejected output — also clears the
output key, so the object that attempt may have written stops being referenced
and the sweeps below can retire it. A retry mints a fresh key at its next
claim, so nothing needs the old one.

### Idempotency

`complete` and `fail` are retry-safe for the claimant that made them, because
the lease hash survives the transition and identifies which claim settled the
job:

- repeated `complete` on a `ready` job → `200`, nothing written twice;
- repeated `fail` on a `queued`/`failed` job → `200`;
- **contradictory** calls (`fail` after `complete`, `complete` after `fail`) →
  `409 COVER_REVEAL_NOT_LEASED`, published state unchanged;
- **stale** calls, after someone reclaimed → `404 COVER_REVEAL_NOT_CLAIMED`,
  published state unchanged.

## Invalidation and cleanup

Three passes, started together by `startCoverRevealReconciler()` every ten
minutes:

1. **Invalidation.** Every live job whose Journey no longer resolves to the
   pinned identity — cover replaced, source deleted or replaced, Journey
   deleting — becomes `superseded` and its generated object is deleted.
   Reordering media that does *not* change the effective cover changes nothing,
   because the rule is the existing Journey/media authority rather than a
   second cover owner.
2. **Write records.** A record past its expiry plus a five-minute margin is
   retired; if no job references its key, the object is deleted first.
3. **Namespace sweep.** Everything under `cover-reveals/` that no job
   references is deleted. This is the half that needs no records and no clock,
   so an object that landed after its record was forgotten is still found.

The prefix is deliberately **not** `previews/`: `reconcilePreviewNamespace()`
deletes every object under that prefix that no `media_assets` row references,
which would take every derivative with it. The two namespaces are disjoint and
each has its own sweep.

A hard Journey deletion cascades the job row away; the object it may have
written is owned by `cover_reveal_writes` and retired by passes 2 and 3.

## Configuration

| Variable | Default | Band |
| --- | --- | --- |
| `COVER_REVEAL_WORKER_TOKEN` | unset (worker disabled) | ≥ 32 characters |
| `COVER_REVEAL_LEASE_SECONDS` | 600 | 60–3600 |
| `COVER_REVEAL_SOURCE_READ_EXPIRES_IN_SECONDS` | 300 | 30–900 |
| `COVER_REVEAL_UPLOAD_EXPIRES_IN_SECONDS` | 600 | 60–3600 |
| `COVER_REVEAL_MAX_BYTES` | 4194304 | 65536–16777216 |
| `COVER_REVEAL_MAX_EDGE_PIXELS` | 2048 | 256–4096 |
| `COVER_REVEAL_MAX_ATTEMPTS` | 3 | 1–10 |

Neither capability window may exceed the lease, so a capability cannot outlive
the claim it belongs to. `server/config.ts` is the single fail-closed reader
and refuses every violation at startup.

With `STORAGE_DRIVER=disabled` the protocol degrades truthfully: a job can be
enqueued and claimed, and the capability routes answer `503
STORAGE_UNAVAILABLE` rather than returning a fake URL.

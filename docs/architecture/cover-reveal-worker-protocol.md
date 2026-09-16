# Cover-reveal worker protocol

Slice 1 of #367, specified by #368. This is the whole server-side contract an
external local worker needs in order to produce a private artistic derivative
of a Journey's canonical cover — and nothing more.

#386 adds the other end of the same contract: how the ordinary authenticated
browser discovers a derivative it may display and obtains a short-lived read of
it. It lives here rather than in a sibling document because the two halves are
one state machine seen from two authorities, and the whole point is that those
authorities never meet — see *Browser display authority is not worker
processing authority* below, and
`GET /api/cover-reveal/journeys/:journeyId`.

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
| Atlas owner | Better Auth session → `session.session.activeOrganizationId` → `requireAtlasAccess` | enqueue a derivative for a Journey of its own Atlas, and read what may be displayed for it |
| Cover-reveal worker | `Authorization: Bearer <COVER_REVEAL_WORKER_TOKEN>` | the five `/api/cover-reveal-worker/*` routes, and nothing else |
| Claimant | `leaseToken` in the request body | act on the one job it holds the lease for |

### Browser display authority is not worker processing authority

#386 adds the ordinary browser's read to the owner router, and the two
authorities stay disjoint in both directions:

| | Browser display authority | Worker processing authority |
| --- | --- | --- |
| Credential | a Better Auth session cookie | `COVER_REVEAL_WORKER_TOKEN` |
| Names | a Journey of its own Atlas | a job id plus the lease token it was handed |
| Object it reaches | the published derivative, read-only | the pinned **source**, read; the job's own output key, write |
| Sees | `ready` metadata for the current cover revision | `seed`, `attempts`, `lastErrorCode`, the output key |
| Lifetime | the owner media-read TTL | bounded by the remaining lease |

Neither principal can be spoken in the other's terms. The worker credential and
a guest share token are both bearer tokens, and this server has **no**
bearer-to-session path — `server/auth.ts` loads the `organization` plugin only
— so either presented on the browser route resolves no session and answers
exactly as presenting nothing does: `401 AUTH_REQUIRED`. Conversely a session
authorizes nothing on `/api/cover-reveal-worker/*`, which reads only the
configured credential.

Neither side ever names a storage key. A worker is handed a read of the source
its job pinned; a browser is handed a read of the object that job published;
both keys are chosen by the server from a row.

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

### `GET /api/cover-reveal/journeys/:journeyId` — owner

The ordinary browser's read (#386), the Backend prerequisite #379 wires the
Journey cover and Story opening against. Read-only: it never enqueues, never
supersedes and takes no lock. Responses are `private, no-store`.

`200`, a derivative that may be displayed right now →

```json
{ "derivative": { "id": "…", "journeyId": "…",
  "generationKind": "ink-wash-poster", "generationVersion": 1,
  "presetId": "reveal-flow-ink-wash-v1",
  "sourceMediaAssetId": "…", "sourceContentHash": "…",
  "mimeType": "image/jpeg", "width": 1536, "height": 1024 },
  "display": { "url": "https://…", "expiresAt": "2026-09-16T07:00:00.000Z" } }
```

That field set is the whole contract, and it is narrower than the enqueue
response on purpose. `sourceMediaAssetId` plus `sourceContentHash` are how a
client proves the derivative belongs to the cover it is about to paint over;
`generationKind` / `generationVersion` / `presetId` select the approved
deterministic renderer; `mimeType` / `width` / `height` let it lay the image out
before it loads. There is no `seed`, no `attempts`, no `lastErrorCode`, no
storage key, no lease hash, no source read URL and no upload target — those are
processing state. There is no `state` either: this shape exists only for a
`ready` row.

`200`, nothing to display →

```json
{ "derivative": null, "reason": "NO_READY_DERIVATIVE" }
```

`reason` is `NO_READY_DERIVATIVE`, or one of the eligibility reasons `NO_COVER`
/ `SOURCE_UNSUPPORTED` / `SOURCE_IDENTITY_UNVERIFIED` / `JOURNEY_UNAVAILABLE`
when the cover itself cannot be a source or the Journey is inside its deletion
grace window. All of them mean one thing to a client: **display the canonical
original**. It is a `200` rather than the `409` the enqueue verb gives the same
state because the two ask different questions — an enqueue refusing to start
work is a decided outcome, while this read's entire contract is "display this or
fall back", and the fallback is not an error. `queued`, `leased`, `failed`,
`superseded` and a derivative pinned to a cover that has moved are one reason
rather than five: the difference between them is queue state, and a client that
branched on it would be reimplementing the retry policy the server owns.

`404 JOURNEY_UNAVAILABLE` for an unknown id, a malformed id and a Journey of
another Atlas alike, so the route cannot be used to discover that a Journey —
let alone a derivative — exists. `503 STORAGE_UNAVAILABLE` where the deployment
has no object storage: a derivative that cannot be served is not reported as
displayable.

**An old metadata payload is never authorization.** Every call re-resolves the
Journey, re-runs `evaluateCoverRevealEligibility` over live rows and requires
the row to be `ready` and pinned to exactly that asset and that verified
stored-byte identity. Replacing the cover, reordering media, replacing the
photograph behind it, deleting the source or the Journey, supersession, or the
member leaving the Atlas therefore stops new display URLs on the very next
request, with no invalidation pass in between. What stays open is the ordinary
signed-URL window every private read in the product has: a cover replaced a
moment *after* a signature is minted leaves that one URL alive for its TTL. It
is bounded by the owner media-read policy, and it is the owner's own capability
to their own derivative of their own cover.

The display TTL is `MEDIA_READ_URL_EXPIRES_IN_SECONDS`, the policy that already
governs an owner's read of their own private media. A derivative is neither
more nor less sensitive than the photograph it was made from, so there is no
separate knob.

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

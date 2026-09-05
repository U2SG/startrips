# Share token lifecycle — security review note

Issue #200 asks phase F for a security review that records the share token's lifecycle
end to end. This is that record. It is a review of the shipped implementation, not a
design proposal: every claim below names the file that makes it true, so a later reader
can check the claim rather than trust the note.

No real token, token hash or signed URL appears anywhere in this document. Every example
value is a placeholder of the right shape.

## What the credential is

> A share link is a temporary read-only capability over an explicit Journey set.

There is no recipient account, no invitation and no per-recipient identity. Anyone
holding the link can view the selected Journeys until it expires or is revoked, and the
owner-facing copy says exactly that. That is the product definition, and the threat model
below is the threat model of a bearer capability — not of an authenticated session.

## Stage 1 — generation

`generateShareToken()` in `server/authorization/share-access.ts` returns
`randomBytes(32).toString("base64url")`: 256 bits from the platform CSPRNG, encoded
URL-safely as 43 characters with no padding. #200 asks for at least 128 bits and prefers
192 or 256.

The token is not derived from a Journey id, an Atlas id, a user id or a timestamp, so it
carries no structure an attacker could exploit or enumerate, and the grant's own primary
key is never the credential. `MAX_SHARE_LIFETIME_MS` caps any link at one year, so a
permanent public link stays an explicit future product decision rather than something a
client can request by sending a distant `expiresAt`.

A share is created only by `POST /api/shares` behind `requireAtlasAccess(..., "create")`,
inside a transaction that locks the Atlas row and the selected Journey rows, so a grant
is written against exactly the state it was authorized against.

## Stage 2 — fragment transport

The link is `https://<host>/share#<token>`.

The fragment is the design amendment agreed on #200 after the #201 findings, and it is
what makes "the token must never appear in server logs" true by construction rather than
by redaction. A fragment is never sent to any server: it cannot enter an access log, it
cannot enter a `Referer` header, and a link-preview bot fetching the URL receives the SPA
shell and no content.

Client side, `createShareTokenHolder` in `src/journey/sharedAtlas.ts` reads
`location.hash` exactly once per document and keeps the value in a closure. It is never
written to the path, the query string, `localStorage` or `sessionStorage`. Reading once
means a later `history.pushState` — the mobile surface pushes one per opened sheet —
cannot smuggle it anywhere, and a re-read cannot observe a fragment some other code has
changed. Anything that is not exactly 43 base64url characters is treated as no token at
all, so a hand-edited fragment produces the unavailable state instead of a request.

The `browser-qa / guest-share` lane asserts this on a live document after it has opened
two overlays and pushed history entries: the token is present in `location.hash` and
absent from the pathname, the query string, `localStorage`, `sessionStorage` and
`history.state`.

## Stage 3 — bearer header

Every guest request carries `Authorization: Bearer <token>`, parsed by
`parseBearerToken()`. Caddy redacts `Authorization` by default, so the edge log never
sees it, and `server/request-log.ts` writes the matched route pattern rather than the raw
path. The `/share/` and `/api/shared/` path-segment redaction added by #203 stays in
`deploy/Caddyfile` as defence in depth even though no route puts a token in a path.

Guest requests are sent with `credentials: "omit"`. A guest is not a session, and sending
an owner's cookie to a guest route would make the owner's own link resolve through a
different identity than every other recipient's.

No guest route accepts a token, a Journey id or an Atlas id in a path, a query string or
a body. The scope is whatever grant the bearer header resolves to, so there is nothing
for a guest to enumerate — the lane sends `?journeyId=...&atlasId=...` pointing at
another Atlas and the response is unchanged.

## Stage 4 — hashed storage

Only `sha256(token)` is stored, in `share_grants.token_hash`. A single SHA-256 is the
right choice here and a slow KDF would be theatre: a slow hash protects a low-entropy
secret, and this secret has 256 bits.

Lookup is `where token_hash = sha256(presented)`, so the comparison happens in the index
rather than in application code and there is no secret-dependent branch to time. The raw
token exists exactly once outside the recipient's browser — in the 201 response body of
the create call — and `GET /api/shares` can never return it, which is why the owner
surface offers revoke and re-create rather than "copy again".

The integration suite asserts the stored row holds the hash and not the token, and that
no guest response body contains it.

## Stage 5 — presign capping

Guest media is never public. `GET /api/shared/assets/:assetId/read-url` returns a
short-lived presigned storage URL, and the guest `<img>` and `<video>` therefore carry a
storage URL and never the share token.

Authorization is re-derived per request, never cached:
`resolveSharedMediaRead` re-evaluates the grant and re-derives membership from the
asset's **current** `journey_id` inside one `repeatable read`, `read only` transaction, so
the authorization decision and the ownership check describe one instant. A grant does not
permanently bless an asset id — moving a photo out of a shared Journey stops it resolving
the moment that move commits.

The lifetime is `min(SHARE_MEDIA_READ_URL_EXPIRES_IN_SECONDS, the owner ceiling, the
grant's remaining lifetime)`, floored to whole seconds and computed from the clock one
statement before the presign rather than from when the request started. Below one second
of remaining grant, nothing is signed at all. After signing, the returned expiry is
compared against the grant deadline and a signature that reaches past it is refused
rather than returned.

**The honest limitation.** A presigned object-storage URL cannot be withdrawn. Revoking a
share stops the API issuing new ones immediately, but a URL already in a recipient's hands
keeps working until it expires. That residual window is exactly
`SHARE_MEDIA_READ_URL_EXPIRES_IN_SECONDS` (default 90 s) and never longer than the grant's
own remaining lifetime. Strict instantaneous revocation would need a proxy or CDN
revocation design, which V1 does not have and does not claim to have.

## Stage 6 — revocation and expiry

`evaluateShareGrant()` is the whole contract as one pure decision over the server clock:
revoked, Atlas deleting, `expiresAt <= now`, otherwise active. `requireActiveShareGrant()`
applies it on **every** guest request, so expiry is enforced for an already-open page and
not only at load.

Every grant-side cause — unknown token, revoked, expired, deleting Atlas, and a grant with
under a second left — raises the same byte-identical `SHARE_UNAVAILABLE` 404. A token
probe cannot tell them apart and learns nothing about whether a token ever existed. Asset-
side causes answer a separate, equally uniform `MEDIA_UNAVAILABLE` 404, because one
withdrawn photo must not tear down a live viewing session.

Revocation is idempotent by `coalesce(revoked_at, now())`, so a second revoke keeps the
first timestamp and needs no read-then-write window.

Client side, `SharedAtlasView` re-reads the grant when the reported expiry passes and no
faster than `SHARE_EXPIRY_RECHECK_MIN_MS` (15 s), so a browser clock running fast produces
one extra read rather than a poll loop, and the server stays the authority. The `guest-share`
lane revokes a grant under a live session and asserts the viewer reaches the polished
unavailable state without a reload.

The concurrent cases are asserted as invariants rather than as schedules: over interleaved
revoke-and-read, expire-and-presign and delete-and-read batches, no payload and no
signature is ever produced from a state that had already been withdrawn, and no signature
reaches past the grant deadline whichever side of it the request landed on.

## Abuse resistance

`server/share-rate-limit.ts` is mounted on `/api/shared/*` and nowhere else. Data reads and
media issuance are charged **per grant**, because a link is meant to be forwarded and
charging its recipients by address would throttle the feature's own purpose. Requests whose
token resolves to nothing are charged **per client address**, because there is no grant to
charge and that is the one class an attacker controls the volume of; rotating the token
does not dodge it. A token hash that turns out to name no grant is dropped from the counter
immediately, so random tokens cannot inflate the map.

The address budget does not make a 256-bit token guessable or not — nothing does. It caps
what a flood costs.

## Residual risks, stated plainly

1. **Forwarding forwards access.** Anyone holding the link can view until expiry or
   revocation. This is the grant model, and the owner copy says so. An optional PIN for
   sensitive shares could be added later without changing it.
2. **A presigned URL survives revocation for up to its TTL.** Bounded and documented
   above; the only lever is the TTL setting.
3. **The token appears in the recipient's browser history**, by design, because that is
   what makes a reload work. It is kept out of `Referer`, out of indexing, and out of both
   web storages.
4. **A shared device shows a previous recipient's link if they left the page open.** The
   guest API responses are `private, no-store` and the app registers no service worker that could cache them, but
   browser history is browser history.
5. **`x-forwarded-for` is trusted** for the address budget, which is correct behind the
   deployment stack's Caddy and would be wrong if the API were ever exposed directly. That
   would weaken one abuse budget; it grants no access.

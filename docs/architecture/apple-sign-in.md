# Sign in with Apple

Issue #350. Apple is configured like every other external provider in
`portable-auth-storage.md`: chosen at deployment time, absent when unconfigured,
and unable to change the Journey domain model either way.

What makes it different from the others is that its credential **expires**, and
that the address it hands over may be a relay that stops working. Both are
handled here rather than left as operational folklore.

## What a deployment supplies

| Variable | What it is | Where it comes from |
| --- | --- | --- |
| `APPLE_SERVICE_ID` | The approved **Services identifier**, used as the OAuth client id and as the id-token audience | Apple Developer → Identifiers → Services IDs |
| `APPLE_TEAM_ID` | The Developer Team that owns the key | Apple Developer → Membership |
| `APPLE_KEY_ID` | The id of the *Sign in with Apple* key | Apple Developer → Keys |
| `APPLE_PRIVATE_KEY` | The PKCS#8 PEM text of the downloaded `.p8` file, newlines written `\n` | Downloaded once, at key creation |
| `APPLE_APP_BUNDLE_IDENTIFIER` | Optional. A native app bundle id accepted as an additional id-token audience | Apple Developer → Identifiers → App IDs |

The Service identifier needs **two** registered Return URLs, because sign-in
and explicit binding are different flows that return to different handlers:

| Flow | Return URL |
| --- | --- |
| Sign in / sign up | `<APP_ORIGIN>/api/auth/callback/apple` |
| Bind to an existing Account (#504) | `<APP_ORIGIN>/api/account-identities/providers/apple/callback` |

Both must be HTTPS, which `config.ts` already requires of `APP_ORIGIN` in
production; Apple accepts no `http://127.0.0.1` Return URL, so a real Apple
round trip needs an HTTPS origin even in development. Apple posts both
callbacks as `form_post`. Better Auth handles that shape itself for sign-in;
the bind route handles it as described under *Explicit binding* below.

`server/config.ts` refuses a partially named credential at startup in every
environment. Naming none is a supported state: `server/auth.ts` then registers
no Apple provider at all, `/api/auth/sign-in/social` reports an unknown
provider, `/api/auth/callback/apple` reports `oauth_provider_not_found`, and
`/api/account-identities` advertises neither a sign-in nor a bindable Apple
provider. There is no mock and no partial mode.

## The client secret is minted, never stored

Apple issues no static client secret. The token endpoint wants an **ES256 JWT**
signed with the `.p8` key — issued by the Team, identified by the Key id, scoped
to the Service id, audienced at `https://appleid.apple.com`, and valid for at
most six months.

Startrips never stores one. `server/account-identities/apple-client-secret.ts`
mints a ten-minute assertion on the way to the token endpoint and re-mints it a
minute before it expires, so a process that runs for a year still presents a
live secret on every exchange. The only credential with a human lifetime is the
`.p8` key itself.

Consequences worth stating: the private key exists only in the server's
environment, it is never sent to a browser, never written to a log, and never
appears in a repository or an issue; and the classic Apple outage — a secret
minted at deploy time silently expiring months later — cannot happen here.

## Rotating the key

Rotation is additive and needs no downtime, because Apple accepts any key the
Team currently has.

1. Create a second *Sign in with Apple* key in the Apple Developer account and
   download its `.p8`.
2. Set `APPLE_KEY_ID` and `APPLE_PRIVATE_KEY` to the new pair and restart the
   API. The next token exchange presents an assertion signed by the new key.
3. Confirm a real sign-in succeeds against the deployment.
4. Only then revoke the old key in the Apple Developer account.

## Revoking a key, and what it does not destroy

Revoking the key in use makes Apple reject the client secret, so the token
exchange fails and `/api/auth/callback/apple` redirects to the error URL with
`error=invalid_code`. That is the whole blast radius:

- no Startrips user, account row or `account_identity_ownerships` row is
  touched;
- an already-bound Apple identity stays bound, and signs in again as soon as a
  valid key is configured;
- every OTHER identity the account actually has — an enrolled password, any
  other bound provider — keeps working untouched.

What that list does not promise is that a second identity exists. An account
created by a first-time Apple authorization has exactly one: Apple. Social
sign-up writes a provider `account` row and its ownership row and no
`credential` row, and `password-enrollment.ts` is an explicit, re-verified
action the owner has to take later. #345's guarantee is
`hasUsableLoginAfterRemoval` — it refuses to UNLINK a last usable method; it
never manufactures a fallback for an account that only ever had one.

`server/tests/account-identity-apple.integration.test.ts` asserts exactly this
sequence: a rejected client secret, then the same account signing in unchanged
once the credential works again.

## Shutting Apple down, and who it locks out

To stop offering Apple entirely, clear all five variables and restart. Read the
consequence before doing it: `apple` leaves `usableProviderIds`, so every Apple
`account` row stops satisfying `accountIdentityUsable`, and an account whose
only identity is Apple — the normal shape of one created by Apple sign-up —
has no way in at all. The same holds for the narrower case above while a
revoked key is in place.

Such an owner cannot self-serve out of it: password enrollment and identity
management both require a signed-in, re-verified session, which is exactly what
they no longer have. So a shutdown is reversible only from the operator's side:

- before clearing the variables, give Apple-only owners a window to enroll a
  password or bind another provider, and expect that not all of them will;
- treat restoring the five variables as the recovery path for anyone who did
  not, rather than assuming a password identity is waiting for them;
- an outright Apple-Developer revocation with no intent to restore therefore
  needs an out-of-band account-recovery plan, not this runbook.

## Identity is the subject, never the address

Apple's `sub` claim is the stable identity. The email may be a **Hide My Email**
relay (`…@privaterelay.appleid.com`), may differ from the address the person uses
elsewhere, and is not guaranteed to be verified for Apple at Work & School
accounts.

Startrips therefore never treats an Apple address as evidence of account
ownership. `STARTRIPS_ACCOUNT_LINKING_POLICY` keeps Better Auth's implicit
email-based linking off, so an Apple authorization whose address matches an
existing account is refused with `error=account_not_linked` rather than linked.
The only way to attach an Apple identity to an existing account is the ST-067
pipeline — `createIdentityLinkIntent` → `verifyProviderIdentityProof` →
`completeIdentityLink` — driven by the signed-in owner after re-verification.

## Explicit binding

Issue #504. The pipeline above is reachable for Apple through the same
`/providers/:providerId/authorize` → `/providers/:providerId/callback` round
trip #349 built for Google, so `bindableSocialProviderIds` includes `apple`
whenever the full credential is configured and `availableLinkProviders`
offers it. Apple's authorization uses `response_mode=form_post`, so it hands
the browser back with a **cross-site POST** rather than a same-site GET, and
three decisions make the shared flow receive it:

- **The callback accepts a POST.** `server/routes/account-identities.ts`
  serves the callback path for both methods through one core: a GET reads
  `state`/`code`/`error` from the query, a POST reads them from the
  urlencoded body and answers `303`. The body's own `id_token` and `user`
  fields are ignored; the identity is the one in the token this server
  exchanges the code for and then verifies. There is no same-origin gate on
  that POST, since its Origin is Apple's: the signed single-use bind cookie
  and a `state` only that cookie and the authorization URL ever held are
  what authenticate it.
- **`IDENTITY_BIND_COOKIE` is `SameSite=None; Secure`.** A browser sends no
  `Lax` cookie on a cross-site POST, so under `Lax` the flow could not recover
  its own state. The owner decided on #504 to change the one shared cookie
  rather than split it per provider, so Google's GET bind return carries a
  `None` cookie too. The cookie is still signed, HttpOnly, scoped to
  `/api/account-identities`, ten minutes long and cleared — with the same
  attributes — on the first callback, so what `None` widens is only when the
  browser presents it, never who can read or author it. `Secure` is
  unconditional: every deployed `APP_ORIGIN` is HTTPS, and Chromium and
  Firefox treat `http://127.0.0.1` as a secure context for it in local
  development; Safari may not, so a local Safari session can lose the bind
  cookie. The Better Auth session cookie
  stays `Lax`, so the form_post carries no session: the callback checks the
  session the signed cookie names against the session table instead, and
  stops before the exchange when it has ended. `/link/complete`, a same-origin
  request, still compares the proof with the real cookie session.
- **PKCE is a per-provider opt-out.** `IdentityBindProvider.pkce` is `true`
  for Google and `false` for Apple. The pinned `apple` adapter never sends a
  `code_challenge`, and the shared token exchange writes `code_verifier`
  whenever it is handed one, so for Apple the authorize route mints no
  verifier, the signed cookie records `null`, and the exchange sends none. The
  callback refuses a cookie whose verifier disagrees with the provider's
  policy. Apple's code is bound instead by `state` and by the client-secret
  assertion only this server can mint.

Apple releases the email only on the first authorization for an app, so a
bind by an Apple ID that has already authorized this Service may carry no
email. The proof then records the subject with no verified email, exactly
what Apple asserted.

## A returning authorization carries only the subject

Apple releases `email` and `name` on the **first** authorization for an app and
never again. Every later authorization carries the stable `sub` and nothing
else. The pinned Better Auth 1.6.23 `api/routes/callback.mjs` refuses
`!userInfo.email` with `email_not_found` *before* it looks the provider account
up, so a returning Apple user would otherwise be locked out of an account they
had already created.

`appleSignInOptions`'s `getUserInfo` closes that on the only seam the library
leaves. When the verified claims carry no address it looks the account row up by
`(providerId = "apple", accountId = sub)` — by subject, never by email — and
hands the library that bound user's own address back. An **unknown** subject
finds no row, the claims are returned untouched and `email_not_found` still
stands, so this is not an email-matching path: it can only ever resolve a
subject that is already bound.

Two things it deliberately does not do. It echoes the stored `emailVerified`
rather than asserting `true`, so no verification is granted that Apple did not
send. And it records no pending identity, so the
`databaseHooks.account.update.after` refresh finds nothing and leaves the
ownership row's `providerEmail`/`providerEmailVerified` as the authorization
that *did* carry a claim recorded them — silence from Apple is not a retraction,
and a downgrade here would read as an unusable method under #345's
last-usable-fallback rule.

A first-time Apple signup does record an ST-067 ownership row: the verified
identity taken from the callback is carried across by
`rememberVerifiedProviderIdentity` and consumed in `databaseHooks.account.create`
/`update`, exactly as Google's is. What it records is what Apple actually
asserted — an unverified or absent address is stored as unverified, so the
method reads as unusable rather than as verified-by-assumption.

A relay address is a deliverable channel only while the person keeps the app
authorized. Treat it as a login identity, not as a guaranteed recovery channel:
recovery still depends on the account's own verified address.

## An id token is spent once

The Web flow is protected by its own single-use `code` and `state`. The direct
`POST /api/auth/sign-in/social` path with an `idToken` body has neither: the
pinned Better Auth 1.6.23 router verifies the token and signs the subject in,
so the same still-valid token posted a second time -- from another client,
without the original request -- would be a second successful authentication.

`appleSignInOptions` therefore supplies `verifyIdToken`. It runs the adapter's
own checks first, through a base provider built without the override, and only
a token that passed signature, issuer, audience, age and nonce is then spent
through `consumeVerifiedIdToken` in
`server/account-identities/id-token-consumption.ts`. That ordering matters: a
token that failed verification is never recorded, so a forged string cannot
occupy the record a genuine token would later need.

What is recorded is one row in `provider_id_token_consumptions`:

- a SHA-256 digest of the provider id and the token -- never the token, in the
  table, in a log or in an error;
- the provider id;
- `expires_at`, the end of the window in which the adapter would still accept
  that token: the earlier of the token's own `exp` and the adapter's one-hour
  maximum age.

The digest is the primary key, and the row is taken with a single
`insert ... on conflict do nothing ... returning`. That is what makes the rule
hold across instances rather than per process: concurrent presentations of one
token, on any number of API processes, are decided by PostgreSQL and exactly
one of them receives the row. A restarted process reaches the same verdict for
the same reason -- the verdict is a row, not memory.

Pruning happens on the same path and deletes only rows whose `expires_at` has
already passed, which is to say only tokens the adapter already refuses for
being too old. The table is therefore bounded by that one-hour window without a
background task, and cleanup can never make an acceptable token replayable.

A storage failure refuses the token. Treating an unreachable replay store as
"probably fine" would turn any transient database fault into an open replay
window, so `consumeVerifiedIdToken` returns `false` and the sign-in answers
`401`.

What is single-use is the token, not the person: a freshly issued token for an
Apple subject that already owns an account signs that same account back in, and
a refused replay neither revokes the session the first use established nor
marks the account in any way.

## What CI does not prove

The fake-provider tests run Better Auth's real Apple adapter against a fake
Apple. They cover first-time signup, a returning authorization with no email signing
the same subject back in, an unknown subject with no email being refused, a
relay address, a rejected client secret, a wrong audience, a stale id token, a
mismatched nonce, a replayed callback and a duplicate concurrent callback.
They also cover the one-time id token above: a spent token refused on its
second presentation, at most one success among concurrent presentations of the
same token, a fresh token for the same subject still signing in, a failed
verification not spending the token, the record surviving the request that
wrote it, and pruning that removes only closed windows. The replay store's own
failure behaviour is covered by
`server/account-identities/id-token-consumption.test.ts`.

The explicit Apple bind is covered end to end in the same file: authorize →
a form_post callback whose cookie jar holds only the `SameSite=None` cookies a
cross-site POST would carry → `link/complete`, with no PKCE challenge or
verifier sent to Apple, an ignored body `id_token`, a refused resend, an ended
session and a cancelled or mismatched return.

They do **not** prove an approved Service identifier, a registered return URL, a
live Apple key, or a real Web authorization and bind. That evidence is an
external gate: it requires an authorized Apple Developer account and a
deployment on a registered HTTPS origin, and it is obtained outside CI.

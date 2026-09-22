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

The return URL registered with Apple is
`<APP_ORIGIN>/api/auth/callback/apple`. It must be HTTPS, which `config.ts`
already requires of `APP_ORIGIN` in production. Apple posts the callback as
`form_post`; Better Auth handles that shape itself.

`server/config.ts` refuses a partially named credential at startup in every
environment. Naming none is a supported state: `server/auth.ts` then registers
no Apple provider at all, `/api/auth/sign-in/social` reports an unknown
provider, `/api/auth/callback/apple` reports `oauth_provider_not_found`, and
`/api/account-identities` advertises no bindable provider. There is no mock and
no partial mode.

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
- every other way into the account — the password identity, and any other bound
  provider — keeps working, which is the #345 last-actually-usable-method
  guarantee.

`server/tests/account-identity-apple.integration.test.ts` asserts exactly this
sequence: a rejected client secret, then the same account signing in unchanged
once the credential works again.

To stop offering Apple entirely, clear all five variables and restart. Accounts
whose only bound identity was Apple keep their password identity; #345 is what
prevents an account from reaching a state where Apple was its only way in.

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

That pipeline is not yet reachable for Apple, and the reason is Apple's return
mode rather than a missing proof issuer. #349 shipped the shared callback
contract this feature was sequenced behind — `issueVerifiedProviderIdentityProof`
and the `/providers/:providerId/authorize` → `/providers/:providerId/callback`
round trip — but that round trip assumes the provider hands the browser back
with a same-site GET. Apple's authorization uses `response_mode=form_post`, so
it returns a cross-site POST, and three things in the shared flow assume
otherwise:

- the callback route is a `GET` and reads `state`/`code` from the query string;
- `IDENTITY_BIND_COOKIE` is `SameSite=Lax`, which a browser does not send on a
  cross-site POST at all, so the flow could not even recover its own state;
- the pinned `apple` adapter's `createAuthorizationURL` never forwards
  `codeVerifier`, so no PKCE challenge is sent, while the shared token exchange
  sends `code_verifier` whenever one is present.

`availableLinkProviders` drives a generic bind button in
`src/auth/AuthGateway.tsx`, so Startrips does **not** advertise `apple` as
bindable: `bindableSocialProviderIds` deliberately omits it while
`configuredSocialProviderIds` includes it. An operator should expect Apple
sign-in and returning sign-in to work, and explicit binding of an Apple subject
to an existing account to be unavailable and unoffered rather than offered and
broken. Issue #504 tracks building that path.

A first-time Apple signup does record an ST-067 ownership row: the verified
identity taken from the callback is carried across by
`rememberVerifiedProviderIdentity` and consumed in `databaseHooks.account.create`
/`update`, exactly as Google's is. What it records is what Apple actually
asserted — an unverified or absent address is stored as unverified, so the
method reads as unusable rather than as verified-by-assumption.

A relay address is a deliverable channel only while the person keeps the app
authorized. Treat it as a login identity, not as a guaranteed recovery channel:
recovery still depends on the account's own verified address.

## What CI does not prove

The fake-provider tests run Better Auth's real Apple adapter against a fake
Apple. They cover first-time signup, a returning authorization with no email, a
relay address, a rejected client secret, a wrong audience, a stale id token, a
mismatched nonce, a replayed callback and a duplicate concurrent callback.

They do **not** prove an approved Service identifier, a registered return URL, a
live Apple key, or a real Web authorization and bind. That evidence is an
external gate: it requires an authorized Apple Developer account and a
deployment on a registered HTTPS origin, and it is obtained outside CI.

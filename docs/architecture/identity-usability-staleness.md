# Identity usability: login versus recovery (#486)

## The gap

A provider identity's `account_identity_ownerships` row stores the email the
provider reported when it last authorized that subject: `provider_email`,
`provider_email_verified` and `verified_at`. The row is refreshed only when a
new authorization for the same subject arrives. When the address stops
resolving later, nothing tells Startrips. A revoked Apple Hide My Email relay
is the routine example, and a closed mailbox behind any provider has the same
shape. So the row's claim describes the moment of binding, not the present.

Before #486 one function, `accountIdentityUsable()`, answered two different
questions with that claim: "can this identity still sign the person in?" and,
implicitly, "does the account still have a way back if access is lost?".

## Decision (2026-09-25, option B)

The owner chose to split the two concepts rather than add a freshness bound on
`verified_at` (option A) or leave the single predicate as it was.

- **Login usability** — `accountIdentityLoginUsable()` in
  `server/account-identities/identity-policy.ts`. A provider identity is
  login-usable while its bound subject matches, the provider is configured,
  and the provider's last authorization carried a verified email. There is no
  age bound. An old verification does not remove a login the provider still
  honours. The credential identity is login-usable with a password set and the
  Account's own address verified. These rules are unchanged from #345.
- **Recovery reachability** — `accountIdentityRecoveryChannel()`. It answers
  whether Startrips can mail this channel now and expect delivery. A provider
  identity never qualifies on its bind-time claim alone, because the row holds
  no later delivery evidence. The credential identity's channel is the
  Account's own verified address, which the password send-link and reset flow
  already mails.

The rule is provider-generic. Apple is not special-cased.

## Who reads which dimension

| Caller | Dimension | Why |
| --- | --- | --- |
| `buildIdentityMethods()` → `usable` and `canUnlink` | login | The list reports which identities can sign in. |
| `hasUsableLoginAfterRemoval()` — the #345 unlink guard | login | The guard promises that a remaining method can still sign the person in. A provider left behind counts because it can authenticate, never because its email looks like a recovery route. |
| Any future flow that mails a provider address, or tells the person they can recover through it | recovery | Such a flow must not rely on a stale provider claim. |

No current UI or API field promises that a provider email is reachable. The
password panel (`src/auth/accountPassword.ts`) offers a set-password link only
to the Account's own verified address.

## What the guard does not promise

The unlink guard keeps a login method, not a recovery channel. An account that
holds only provider identities can unlink down to one of them. It then depends
on that provider alone, exactly as an account created by provider sign-up
always has (`docs/architecture/apple-sign-in.md`). Refusing such an unlink
would be a new product rule, and #486 did not decide one.

## Residual

For an Account created by provider sign-up, `user.email` and
`user.emailVerified` are themselves seeded from the provider's claim at
sign-up. The credential recovery channel can therefore inherit a bind-time
claim through that route. Account-level email semantics are out of scope here
and stay as they are.

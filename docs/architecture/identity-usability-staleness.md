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
| `buildIdentityMethods()` → `usable` | login | The list reports which identities can sign in. |
| `hasProtectedAccessAfterRemoval()` — the #345 unlink guard, and `buildIdentityMethods()` → `canUnlink` | login and recovery | After the removal a login-usable identity must remain AND the Account must keep a reachable recovery channel (`accountRecoveryChannelReachable()`). A provider left behind counts toward the login; it never counts toward recovery. `canUnlink` reads the same predicate, so the list never offers an unlink the server refuses. |
| Any future flow that mails a provider address, or tells the person they can recover through it | recovery | Such a flow must not rely on a stale provider claim. |

The Account's recovery channel is its own verified address. The password
reset and #445 enrollment links mail it whether or not a credential row
exists. No current UI or API field promises that a provider email is
reachable.

## What the guard refuses

An Account whose own address is not verified has no recovery channel, however
many provider identities it holds. The guard then refuses to unlink any
provider identity, because the one left behind could still sign in but a
stale or revoked provider address would be the only way back. The refusal
keeps the existing `IDENTITY_LAST_USABLE_LOGIN` code. While the Account's
address is verified, an Account holding only provider identities can still
unlink down to one of them.

## Residual

For an Account created by provider sign-up, `user.email` and
`user.emailVerified` are themselves seeded from the provider's claim at
sign-up. The credential recovery channel can therefore inherit a bind-time
claim through that route. Account-level email semantics are out of scope here
and stay as they are.

# Account Earth experience preference

The durable half of #332. `#331` / `src/scene/earthDive.ts` already owns what
`particle-only` *means* at runtime; this document describes where the value
lives, who may read or change it, and what a client can trust about the answer.

The client account-menu surface, the hydration and cache strategy, and wiring
the stored value into the Dive are deliberately **not** part of this contract.
Nothing in the product reads this preference yet.

## What the value is

`Earth experience` is one of exactly two documented values:

| Value | Meaning |
| --- | --- |
| `default` | Every renderer this deployment offers may load. |
| `particle-only` | Detailed Earth resources may not load at all. |

`src/journey/earthExperiencePreference.ts` is the single source of truth for the
two values, the default, and `isEarthExperiencePreference`. `EarthExperiencePolicy`
in `src/scene/earthDive.ts` is an alias of that type, so a value the API accepts
cannot drift from a value the Dive controller understands.

It is a **personal** preference, not Atlas state. An Atlas is shared by its
members, so storing a renderer choice on Atlas-owned data would let one member
decide what another member's machine loads, and would put the value inside a
guest share payload. It is keyed by the stable Better Auth user instead.

## Storage

`account_experience_preferences` (`server/db/app-schema.ts`, migration
`0024_chief_silk_fever.sql`):

| Column | Notes |
| --- | --- |
| `user_id` | **Primary key**, `references user(id) on delete cascade`. One person, at most one row. There is no separate `id`: nothing references this table. |
| `earth_experience` | `text`, constrained by `account_experience_preferences_earth_experience_check` to the two documented values. |
| `revision` | `integer`, starts at 1, `>= 1`. Counts value **transitions**, not requests. |
| `created_at` / `updated_at` | `timestamptz`. `updated_at` moves only on a transition. |

**Absence is not a missing value — it is `default`.** A person who never chose
has no row, and nothing on the read path inserts one. Deleting the account
cascades the row away; nothing else in the product owns or copies it.

## API

Both verbs are owner-only and derive the user **solely** from the session
resolved for that request. There is no `:userId` path segment, no `userId`
query parameter, and the request body's named field is the only field read — so
cross-user access has no expression in this API rather than being a check that
could be forgotten.

### `GET /api/account-preferences/earth-experience`

```json
{ "earthExperience": "particle-only", "revision": 3, "updatedAt": "2026-09-17T02:00:00.000Z" }
```

Absent row: `{ "earthExperience": "default", "revision": 0, "updatedAt": null }`.
Same shape, no 404, no write.

### `PUT /api/account-preferences/earth-experience`

```json
{ "earthExperience": "particle-only" }
```

Answers `200` with the same body shape as `GET`, describing the row that is now
durable.

### Failures

| Status | Body | When |
| --- | --- | --- |
| `401` | `{ "error": "UNAUTHORIZED" }` | No session. A guest share **token** is not a session, so `Authorization: Bearer <share token>` lands here. |
| `400` | `{ "error": "INVALID_EARTH_EXPERIENCE", "message": … }` | Any value outside the two documented ones, an omitted field, or a body that is not a JSON object. Nothing is normalized: `Particle-Only` and `" particle-only"` are refused, not repaired. |

Both responses carry `Cache-Control: private, no-store, max-age=0`, the same
header the Home Base and Everyday Fragment surfaces use, so no shared cache
stores one person's answer and no browser replays account A's response after a
sign-in as account B.

## What a client may trust

- **`revision` counts transitions.** A write that stores the value already
  stored returns the revision and `updatedAt` unchanged. That is the honest
  answer, and it is how a client tells *"my write landed and changed nothing"*
  from *"someone moved this since I read it"*.
- **A `200` means the row is durable.** The write is one
  `INSERT … ON CONFLICT (user_id) DO UPDATE … RETURNING` statement
  (`server/repositories/account-preference-repository.ts`). It is atomic, so two
  concurrent writers cannot both insert and cannot interleave a read-then-write;
  whichever statement PostgreSQL applies last is the deterministic final winner,
  and the `RETURNING` clause — which yields a row on the no-op branch too —
  describes state that is committed. A failed statement throws; nothing reports
  persistence success without a committed row.
- **A stale response can be discarded.** A response whose `revision` is lower
  than one the client has already seen lost a race and must not overwrite local
  state.
- **A share grant conveys nothing.** A signed-in person holding a grant on
  somebody else's Atlas reads their **own** preference; the sharer's value is
  not reachable through the grant.

## What a write does not touch

Nothing but the one row. A preference write changes no Atlas membership, no
Journey or Route data, no Home Base history, no Everyday Fragment, no renderer
availability and no Reduced Motion state. It is covered by
`server/tests/account-preferences.integration.test.ts`, which snapshots the
Atlas row and the `GET /api/journeys` payload across two writes.

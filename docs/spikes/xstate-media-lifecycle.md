# Spike: XState per-media Playback lifecycle

Status: spike, not wired. It follows discussion #539, section 6. Baseline: `6fcf7e1`.

## What the spike adds

- `src/journey/playbackMediaLifecycle.ts` (308 lines): one XState v5 machine for each Route Point Media asset
  that Playback intends to show.
  - Lifecycle: `idle` → `active.reading` → `active.ready`, then to `failed`.
  - `active.ready` is a parallel state with two regions:
    - `signedUrl`: `fresh` ↔ `refreshing`
    - `decode`: `checking` / `decoding` / `decoded` / `notNeeded` / `failed`
  - Reads, refreshes and decodes run as invoked promise actors. When the state that owns an actor is left, the actor
    is stopped and its `AbortSignal` is aborted, so a superseded intent cannot deliver a late result.
- The rules are reused, not restated:
  - freshness and refresh timing: `mediaReadRefreshDelayMs` and `playbackReadIsReusable`
  - the stale-intent boundary: `prefetchDispatchDecision`
  - the gate and hold answers: `playbackMediaGate` and `playbackHoldReason`. The snapshot is mapped back onto
    `MediaReadState` and `DecodedReadiness`, so those functions stay the single source.
- `src/journey/playbackMediaLifecycle.test.ts` (409 lines): node-environment tests using fake timers. They replay:
  - a stale prefetch intent, and a late resolve after a supersede (#287)
  - a signed URL going stale mid-read or mid-decode, followed by a refresh (#200 phase D)
  - a close during decode, by both `RELEASE` and `actor.stop()` (77e9e28)
  - reopening the same media: a fresh read is reused, an outlived read is re-signed, and a failed read gets a new
    attempt (#276, #284)
  - truthful read, refresh and decode failures
- Only `xstate` is added. `@xstate/react` is not used, because nothing is wired.

## What wiring would replace in `JourneyPlaybackOverlay.tsx`

| Lines | Today | With the machine |
| --- | --- | --- |
| 287–311 | `mediaReads` state, `mediaReadsRef`, `decodeRegistryRef`, `decodeSettleRevision` and its `onSettle` effect | A map of per-asset actors plus one subscription revision. The soundtrack seed stays (see Risks). |
| 522 | `pendingReads` ref (in-flight dedupe) | Being in the `active` state is the dedupe |
| 536–571 | `loadMediaRead`: reuse check, pending set, loading/ready/error writes | The `reading` and `refreshing` states |
| 623–658 | Stale-revision check and microtask read dispatch | One `PREPARE` per entering asset and one `RELEASE` per leaving asset. The guard is `prefetchDispatchDecision`. |
| 660–686 | Decode-ahead effect, keyed on `mediaReads` and `decodeSettleRevision` | The `decode` region, which starts from `ready` without an effect |
| 696–736 | Hold effect that gathers the read and the decode readiness | The same effect, fed by `playbackLifecycleHoldReason`, with fewer dependencies |
| ~1100–1156 | Gate and opening-still derivations at render time that read the registry | Selectors over the snapshots |

Estimate: about 180 lines leave the overlay and about 90 come back, as a `usePlaybackMediaLifecycles` hook
(actor map, `useSyncExternalStore` subscription, and stop-all on close) plus call sites. The overlay goes from
21 `useEffect` + 5 `useLayoutEffect` calls to about 17 effects in total, and from 24 `useRef` calls to about 21.
Counting the machine, the net change for the repository is roughly +200 lines of production code.

Out of scope, and **not** replaced:

- The trim, stall and fallback watchdogs for a video beat (lines 321–515, 8 effects and 5 refs). They are where
  the remaining step-keyed races live, and they are the natural target for a second machine.
- The soundtrack, the sampler and the audio transport (lines 743–822).
- `JourneyStory.tsx`. Its read lifecycle could reuse this machine, pinning the media that Story autoplay owns
  (`shouldRefreshStoryMediaRead`).

## Bundle cost

The spike ships 0 bytes: no production module imports the machine, and nothing outside the test imports it. If it
is wired, `xstate` adds about 14.6 kB gzip. That figure comes from the brief and was not measured here; the CI
`build` step on the wiring PR should confirm it. Using `useSyncExternalStore` directly avoids the extra
`@xstate/react` cost.

## Risks

- **Deliberate behaviour changes:**
  - A refresh keeps the previous URL visible. Today the overlay drops a stale read to `loading` (547–550), which
    can blank the frame for a beat.
  - A failed refresh settles as `failed`, not as a stale URL that is still usable.
  - Decode state is kept per asset across a re-sign, the same as today's registry.
- **The soundtrack does not fit as it stands.** Its seeded read has a non-finite expiry, so
  `mediaReadRefreshDelayMs` would fall back to a 5-minute re-read and break the "never re-read while playing" rule.
  It needs either a `pinned` guard or its current path.
- **Cancellation stops at the client.** `readMedia` takes no `AbortSignal`, so an aborted read still completes on
  the network and only its result is dropped. That matches today's behaviour. Real cancellation would mean
  threading the signal into `getPrivateMediaRead`.
- **Lane conflict.** ST-137 owns dense chapters in Playback and is editing the same overlay. Wiring before it lands
  guarantees a rebase fight.
- **Test and QA probes.** The CI `qa:playback-prefetch` script reads `data-playback-prefetch-dispatch-intent`
  and `data-playback-prefetch-suppressed`. Wiring has to keep emitting both; `suppressedIntents` in context exists for
  that.
- **A second idiom.** The codebase's style is pure helpers plus a reducer (`playbackReducer` stays the pure
  transport). Adding XState means reviewers need to know two models. That cost is only worth paying if the
  video-beat machine follows.

## Recommendation

**Go, conditionally, sequenced after ST-137.**

- The read/decode class of races (#287, #276, 77e9e28) becomes structural. Pending work belongs to a state and dies
  with it, so the order of fixes stops depending on step-index keys, refs and revision attributes.
- On its own, though, read/decode removes only about 180 overlay lines for 14.6 kB gzip. The case holds only if the
  video-beat machine (trim, stall, fallback) is the planned second step. If it is not, a zero-dependency
  per-intent `AbortController` refactor of `loadMediaRead` would get most of the benefit.

Wiring plan:

1. Wait for ST-137 to merge, then rebase onto `main`.
2. Add `usePlaybackMediaLifecycles(prefetchAssetIds, director)`:
   - create actors lazily and provide `readMedia` and `decodeImage`
   - send `PREPARE` with the director's intent boundary, or `RELEASE`, on every window change
   - stop every actor on close
3. Replace `mediaReads`, `pendingReads` and `decodeRegistryRef` with snapshot selectors. The soundtrack keeps its
   current path.
4. Keep the QA data attributes, run the `qa:playback-prefetch` and `qa:playback-continuity` checks in CI, and
   measure the bundle delta on the `build` step.
5. Follow-up PR: a video-beat machine for the trim, stall and fallback watchdogs (321–515).
6. Later: move the Story read lifecycle onto the same machine, with a pinned-media guard.

# Keepsake private render prototype (#87)

## Status and scope

This is an exploration artifact, not a shipped video editor or a Continuous Journey release prerequisite. The deterministic Keepsake manifest, revision/identity checks, chapter ordering and 15/30/60-second timing already exist on main and remain the authority. This prototype starts **after** that boundary.

The contract exercised here is:

`validated Keepsake manifest + authorized media IDs + revision-pinned Journey spatial/presentation context -> deterministic private render`

The serialized render plan contains semantic scenes and authorized asset IDs only. It contains no storage key, signed URL, guest share URL, arbitrary render code or model-generated command. The plan is intentionally **not** geographically complete: a trusted `AuthorizedKeepsakeJourneyContextResolver` must resolve revision-pinned Route Point coordinates/labels/notes for the exact `journeyId + journeyRevision`, while `AuthorizedKeepsakeMediaResolver` is the separate privileged boundary that materializes private bytes. A worker must not infer geography from IDs or read mutable Journey state outside these declared boundaries. The plan also retains the canonical narrative snapshot, and the privileged byte resolver requires a freshly verified Journey context so media moves/reorders/deletes that do not bump `journeyRevision` still fail closed before private bytes are read.

## Mechanism decision

The prototype uses a **trusted offline FFmpeg encoder** driven by a small deterministic renderer adapter. It converts the existing Keepsake manifest into static scene frames and encodes those frames as H.264 MP4. The fixture uses synthetic/private-safe media payloads, but they still cross the same authorized-ID resolver boundary that a server render worker would use for real private objects.

Why this mechanism first:

- FFmpeg proves real encoding, deterministic decoded output, codec/container behavior and measurable resource cost without introducing a second playback state machine.
- It adds no browser renderer or framework dependency to the product runtime. Remotion, Revideo and headless-browser capture remain possible mechanisms if later visual-fidelity work shows that reusing the live Three.js composition is worth the browser/GPU cost.
- The render worker can remain the only holder of private-media read authority. The client never needs a storage coordinate or expiring public/share URL to produce an artifact.
- The same manifest can be retried idempotently. Encoder-specific metadata can make byte equality an unnecessarily brittle contract, so CI compares decoded-frame `framemd5` output and also records whether the container bytes happened to be identical.

The visual adapter is deliberately small: it renders Startrips-style dark world/route beats, Route Point labels and private media beats rather than capturing interactive application chrome. In this CI fixture, the `ROUTE_POINTS` coordinates and labels are hard-coded **fixture-only** presentation data; they are not part of the manifest and must not be treated as a production renderer input. A production worker must obtain equivalent presentation truth through the revision-pinned Journey-context boundary above.

## Deterministic three-stop fixture

`scripts/qa-keepsake-private-render.ts` builds one portrait 15-second-preset Journey fixture with three ordered Route Points (Hong Kong -> Taipei -> Tokyo), an opening image, per-stop visual media and one video-typed media beat. It then:

1. builds the normal `KeepsakeRenderManifest`;
2. converts it to `KeepsakePrivateRenderPlan` without changing chapter/media/camera ordering or timing;
3. resolves every private asset exactly once through `AuthorizedKeepsakeMediaResolver`;
4. writes one deterministic visual frame per semantic scene;
5. encodes the same frame/timing input twice to MP4;
6. decodes both outputs to FFmpeg `framemd5` and requires identical decoded-frame signatures;
7. records container hashes, wall time, peak RSS when `/usr/bin/time` is available, output bytes, codec, dimensions, pixel format, frame rate, frame count and semantic scene order.

The prototype encodes at 360x640 / 12 fps to keep CI cost bounded while remaining a real vertical H.264 artifact. The authoritative manifest continues to request the product portrait size (1080x1920); production output quality is a render-worker sizing decision, not a new narrative contract.

CI stores both encoded outputs, `metrics.json` and `summary.md` as short-lived workflow artifacts. Heavy encoding is not part of local developer validation.

## Privacy and artifact boundary

Recommended production boundary:

- the owner explicitly requests a render for one Journey and one existing Keepsake preset;
- the API validates current Journey revision/identity and persists or submits the validated manifest plus authorized media IDs, while the render worker resolves canonical spatial/presentation context through a trusted resolver that verifies the same `journeyId + journeyRevision`;
- a trusted render worker resolves IDs to private bytes using owner-scoped authorization;
- inputs live only in job scratch storage and are deleted on success/failure/cancellation;
- the encoded artifact is private by default and receives a bounded lifetime (recommended starting point: 24 hours unless the owner explicitly saves it);
- downloads use separate authenticated artifact access. Creating a render does **not** publish the Journey and does not reuse guest Journey share URLs;
- soundtrack remains `none` until the product/legal/codec decision is explicit.

## Client / server / hybrid recommendation

**Recommend hybrid orchestration with trusted server/offline rendering.** The client owns the explicit user action and can show job state; the existing deterministic manifest remains shared product semantics; a trusted worker owns private-media resolution and encoding.

Client-only capture is attractive for privacy but is weaker for codec consistency, mobile thermal/memory limits, long-running cancellation and reproducible output. A fully server-authored timeline would be reliable to encode but would duplicate narrative authority. The hybrid shape keeps the manifest as the single narrative contract while putting only the privileged and resource-heavy steps on the worker.

A production render job should have explicit `queued -> running -> succeeded | failed | cancelled` states. Retry should reuse the same manifest/revision and idempotency key, never silently rebuild a new narrative after a partial failure. Suggested initial worker bounds are one render per process, a wall-time limit, a memory limit, cancellation propagated to FFmpeg, and scratch/artifact deletion in `finally` paths. Exact limits should be chosen from CI/server measurements rather than hard-coded by this exploration.

## Evidence and known limits

The `keepsake-render` CI lane is the executable evidence. It records, per exact PR head:

- two real MP4 outputs from the same validated manifest;
- decoded-frame deterministic signature and container SHA-256 values;
- render wall time, peak RSS where available and file size;
- codec/resolution/fps/pixel-format probe data;
- ordered semantic scene labels proving map/travel/arrival/media/outro order comes from the existing manifest;
- private media IDs used by the trusted resolver.

Known limits of this phase:

- the synthetic renderer does not yet reuse the live Three.js particle globe pixel-for-pixel;
- synthetic fixture media proves authorization/acquisition and encoding flow, not production image/video color-management or HDR behavior;
- no production render queue, cancellation API, persistence table, download UI or public sharing surface is added;
- no soundtrack is encoded;
- 360x640 / 12 fps is intentionally a CI prototype quality tier, not the final export quality target.

Those limits are why FFmpeg is selected as the current **mechanism proof**, not declared the permanent product architecture.

# Journey Keepsake Export ? phase 1 recommendation

Issue: #87

## Decision

Use a **hybrid deterministic render pipeline**. The interactive client chooses a Journey, a 15/30/60-second pacing preset, and portrait/landscape output. It submits a small `KeepsakeRenderManifest` containing semantic scene ordering and stable Journey/media IDs. A trusted render worker re-authorizes the Journey and resolves private media server-side immediately before rendering.

This keeps live Journey Playback and export on one narrative contract while avoiding browser codec/CORS/thermal variability and avoiding long-lived signed media URLs in manifests or queues.

## Shared semantic source

`buildKeepsakeRenderManifest()` consumes the existing `buildPlaybackSteps()` director. Export therefore preserves:

`intro ? stop 1 ? media ? travel ? stop 2 ? media ? ? ? outro`

Map scenes are narrative punctuation: route overview, inter-stop travel, one arrival beat per point, final pullback. Adjacent media at the same point stay adjacent; the exporter does not inject a map scene between every photo.

## Pacing

15s / 30s / 60s are deterministic target presets, not destructive hard caps. Every semantic chapter and visual media item receives a readable minimum. Remaining time is allocated proportionally to the live playback director's desired durations. If a media-heavy Journey cannot fit the requested preset without dropping content below its minimum, output deliberately runs longer rather than randomly deleting memories.

Phase 1 does not provide a clip editor, templates, stickers, or per-clip trimming.

## Privacy and media lifecycle

The manifest contains stable Journey/media/route-point **IDs only**, never storage keys or signed URLs. `pointIndex` may be retained as a generation-time ordering hint, but workers must resolve geography by `routePointId`; travel scenes carry stable `fromRoutePointId` and `toRoutePointId`.

A queued manifest is valid only for the exact `journeyId + journeyRevision` it was generated from. Before resolving any media or camera scene, the worker must load the Journey and reject a revision mismatch with `keepsake_manifest_revision_mismatch`; it must never reinterpret old indexes against a newer route order. Missing referenced point/media IDs are likewise hard failures, not fallback-to-index behavior.

The render worker must:

1. authenticate the render job owner;
2. re-authorize access to the Journey/Atlas at render time;
3. resolve media IDs through the existing private-media read path;
4. keep fetched inputs and encoded outputs in bounded temporary storage;
5. create a private artifact by default;
6. treat any future share link as a separate explicit permission object.

The phase-1 manifest explicitly exports with no soundtrack. User-uploaded audio can be added only after codec, ownership, and product/legal semantics are explicit.

## Output baseline

Portrait is the default: 1080?1920. Landscape is 1920?1080. No interactive application chrome belongs in the renderer; the render worker should mount a dedicated playback surface driven only by manifest scenes.

## Next implementation slice

The next PR after this manifest contract should build a renderer harness for one deterministic 3-stop fixture and record encode time, peak memory, output size, and visual captures. That experiment should compare server/offline rendering against a browser capture only as evidence; the production recommendation remains hybrid unless the measurements overturn the privacy/reliability tradeoff.

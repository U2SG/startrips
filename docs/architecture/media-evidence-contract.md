# Media evidence contract

Issue #388 / ST-088 adds owner-scoped location and capture-time evidence to an existing media asset without changing that asset's Journey, Route Point, or Everyday Fragment ownership.

## Stored truths

`media_asset_evidence` is one-to-one with `media_assets` and cascades only when the asset itself is deleted. The row contains three independent concerns:

- recorded spatial evidence: source, granularity, optional coordinates, optional real accuracy, and city label;
- recorded capture-time evidence: source plus offset-known, local-only, or unknown timezone state;
- display state: member correction and hide state.

The effective displayed location is derived at read time. It is never persisted as a third copy that could drift from the recorded evidence or member correction.

An asset with no evidence row is a valid historical asset. It reads as revision `0` with explicit unknown spatial/time evidence. No migration copies Route Point coordinates into media evidence.

## Precision semantics

Spatial granularity is `coordinate`, `city`, or `unknown`. Coordinate evidence requires latitude/longitude but does not require accuracy; a missing `accuracyMeters` remains unknown. City evidence carries a label and no exact coordinate. Unknown evidence contains no spatial values.

Recorded sources are provenance labels such as `exif`, `container-metadata`, or `imported`; they are not server truth certifications. `contentHashVerified` proves durable byte identity only and is never surfaced as geographic verification.

Capture time keeps the original semantic state. `offset-known` requires a local wall-clock value, an explicit offset, and a consistent instant. `local-only` keeps the wall clock without manufacturing UTC. `unknown` contains no time values.

## Owner API

The owner surface is mounted at `/api/media-evidence/:assetId` and always resolves the Atlas from the authenticated session through `requireAtlasAccess`.

- `GET /:assetId` reads evidence, including the historical unknown state.
- `PUT /:assetId/recorded` writes normalized recorded evidence.
- `PUT /:assetId/display` changes only correction/hide state.

Writes carry `expectedRevision`. A changed write with a stale revision returns `409`; an exact retry is idempotent and returns the already-stored state without incrementing the revision. Asset ownership is locked during mutation so two writers cannot create duplicate evidence rows.

The API validates finite/ranged coordinates, accuracy bounds, allowed source/granularity combinations, capture-time/timezone combinations, valid local calendar values, explicit offsets, and Atlas ownership. Error responses never echo submitted private coordinates.

## Ownership and moves

Evidence is keyed only by `media_asset_id`. Route Point reassignment therefore cannot overwrite it. Reclassifying the same asset between Journey and Everyday Fragment ownership preserves the same evidence row as long as the media asset ID is preserved.

No operation in this contract creates a Route Point, changes Home Base, reverse-geocodes a label, or copies evidence between assets.

## Privacy boundary

The new route is owner/member authorization only. Guest/share routes are separate and do not join `media_asset_evidence`, so precise recorded or corrected coordinates do not enter share JSON by default.

This JSON boundary does not claim that an authorized download of an original media object has had embedded EXIF stripped; existing original-object sharing policy remains separate.

Precise coordinates are not included in validation errors or telemetry added by this feature.

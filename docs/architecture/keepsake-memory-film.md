# Private memory-film director — v2 implementation slice (#693)

This layer enriches the existing `KeepsakePrivateRenderPlan`, not a new source
of travel facts. Every shot points to a canonical source scene in the same order.
The old manifest builder, v1 export and live playback semantics are unchanged.

`preparePrivateMemoryFilm` uses the existing authorized context/media resolvers.
A cover resolver, when supplied by a trusted server integration, must authorize
the current canonical cover and its ready derivative atomically. Preparation
compares the source-byte SHA-256, Journey/revision and presentation context,
including notes/labels/coordinates before and after media materialization. It
refuses changed context instead of mixing revisions. It is not an HTTP route or
an authorization substitute. Production job publication must still recheck
permissions/cancellation and follow the existing cleanup lifecycle.

`buildMemoryFilm` returns a serializable private v2 manifest plus ephemeral
caption memory. The manifest has identities and frame timing, not private bytes,
notes, coordinates, signed URLs or storage keys. Notes default off. This slice
supports Route Point notes at their first arrival, not standalone live note beats.
Long notes are grapheme-paginated and extend the shot for reading; excessive input
is rejected rather than truncated. No AI-generated narration or guessed facts.

`sampleMemoryFilmFrame` is deterministic and supports out-of-order seeking.
Cumulative frame boundaries prevent per-shot rounding drift at 24/30 fps.
An authorized creative cover is composited once over its source image; the final
half of the shot is the unchanged original. Reduced motion skips that opening
and is forwarded to the original renderer. It does not infer animated grass,
cloud masks or moving people from a single flattened image.

`renderMemoryFilmFrame` exposes three renderer operations: render the existing
private scene, composite the decoded opening, and draw the authorized caption.
The caller supplies the existing map/media renderer, not a replacement basemap.
The prepared media/context/caption bundle is private ephemeral render state:
do not serialize or log the entire return value as if it were a manifest.

## Delivery boundary

This is a tested director and privileged-preparation bridge, **not a completed
user-facing MP4 export**. The owner action, concrete renderer/encoder binding,
current-cover authorization implementation, job cancellation/publication and
full real-media/browser/Chinese-caption acceptance remain before rollout.
No export button is enabled prematurely. No model call, paid generation, real
user-media render, upload, deployment or installed-runtime change occurred.

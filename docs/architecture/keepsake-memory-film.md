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

## Owner export button

Story's existing Edit / Manage controls now expose **导出短片** when both
`canEditJourney` and the explicitly provided owner export client are present.
Guest/demo providers do not acquire an owner client as a fallback. A lazy native
dialog offers 15/30/60 second targets, portrait/landscape 1080p output, opt-in
Route Point captions, and an optional already-ready artistic opening. Dirty
notes must be saved or discarded before opening export. Closing, cancelling,
losing the export capability or changing the active Journey snapshot aborts the
current attempt. Duplicate clicks do not start a second attempt.

`journeyFilmExport.ts` freshly reads the Journey through its existing owner API,
reads each original through its separately authorized short-lived read URL, and
checks canonical byte length and verified SHA-256 where available. It brackets
rendering with fresh Journey/Atlas/media/route/note identity checks and repeats
the check on each explicit **下载 MP4** click. No object-store credentials,
privileged server resolver, persistent queue, public share or upload is introduced.
The browser plan is explicitly marked `authorized-owner-fetch`, not falsely
represented as a server-atomic media materialization. Server authorization on
existing routes remains the security boundary; a browser cannot provide an
atomic database snapshot across its independent HTTP reads.

`journeyFilmCanvas.ts` uses pinned Mediabunny 1.61.3 with native WebCodecs H.264
encoding and MP4 muxing. It draws frame-exact timestamps rather than recording
a visible page. Photos are contained without cropping or warping. Videos run
from their start at normal speed within their scene allocation; short clips hold
the last frame rather than loop. Output is **silent**, as in the existing v1
Keepsake contract. Unsupported encoding/decoding fails visibly; a WebM is never
renamed to MP4. Decoder inputs, image bitmaps and the output are disposed on
success, failure and cancellation. Only the current media shot is decoded.

The route scene is explicitly a **schematic**, derived from canonical ordered
waypoints with date-line unwrapping, not a recording of the particle globe or
road navigation. Non-stop shaping points remain geometry, not independent
Stop markers. Labels and Chinese captions use plain canvas text and the device's
fonts. Native reduced motion skips the artistic opening and route cursor motion.

Boundaries: 128 MiB per source, 256 MiB total source transfers (including an
optional opening), two minutes of actual output, 96 MiB encoded output, a five
minute operation deadline and bounded media reads. Notes may extend the selected
target; exceeding the output-duration budget is an error, not silent truncation.
Keep the page open during generation. The prepared Blob and its download URL
live only until the export dialog is dismissed; downloaded files cannot be
recalled after a later access revocation.

## Verification and remaining scope

`journeyFilmExport.test.ts` exercises the real orchestration with injected network
and encoder fixtures: source identity, permissions, revocation, cancellation,
late completions, size/duration limits and absence of guest fallback. Fixture
encoder bytes in unit tests are not evidence of a playable video.

`pnpm qa:journey-film-export` runs against a Vite dev server (`QA_ORIGIN`, default
port 4195), mounts the actual Story and export dialog, serves synthetic image/video
bytes behind HTTP authorization fixtures and checks the downloaded file with
FFprobe. Its generated harness is temporary and never part of the product bundle.
It requires FFmpeg/FFprobe and the existing browser QA runtime; override executable
paths with `FFMPEG_PATH`, `FFPROBE_PATH`, `QA_BROWSER_PATH` when necessary.

The separate server-side preparation bridge and old v1 QA remain unchanged.
Server-rendered exports, actual globe rendering, audio mixing, durable output
storage and newly generated creative recipes are **not** enabled by this browser
button. This change does not merge, deploy, activate a worker or alter user media.

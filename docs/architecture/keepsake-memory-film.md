# Private Journey memory films (#693)

The owner Story editor operation area exposes 导出短片 on desktop and phone.
It opens a native modal with portrait/landscape, 15/30/60-second target, optional
Route Point notes (off by default), the Journey's existing soundtrack (on by
default), and an already-generated creative cover.
Guests/read-only views receive no exporter capability. Unsaved notes must be
saved/discarded before export. Scope changes close the modal and cancel the job.

## Shipping implementation

The owner browser fetches a fresh authorized Journey, preserves canonical
Keepsake scene ordering, and resolves original media through existing owner
signed-read routes. It never substitutes previews or uses share credentials.
The v2 film manifest truthfully names authorized-owner-fetch; the separate
privileged preparation helper still uses authorized-server-fetch. No new public
export endpoint, render queue, scheduler, media upload or server credential is
introduced. Downloaded films remain local to the member device.

The frame renderer uses Canvas and Mediabunny 1.61.3 (WebCodecs H.264 + MP4
muxing) at 1080p/30 FPS. Photos are contained without cropping; video clips play
from their start and hold their last frame when short. The map is a clearly
labelled canonical-waypoint schematic, not a road route or captured globe.
All canonical waypoints shape the route; only actual stops receive dots.

Creative openings use the same versioned recipe registry and vendored
RevealFlow as the owner preview. Each authorized opening is shown only over
its source photograph, and at least the final half of the shot is the unchanged
original. Reduced Motion omits it and stops the schematic travel cursor motion.
If WebGL cannot render the selected opening, the user can explicitly disable it;
no ordinary fade is falsely described as a recipe-specific animation.

Route Point captions are opt-in and include Stop and non-Stop notes exactly once.
Stops retain their arrival captions; a via uses its own media when present,
otherwise the travel span containing its canonical route position. Trailing vias
without a content/travel shot use the closing route overview; an all-via text-only
Journey uses its opening overview. Shared-shot notes follow canonical point order.
This adds no Stop, live note beat or new v1 scene. Missing note context is rejected
instead of treated as empty. Captions are grapheme/newline paginated with enough
reading time. Excessive text/size/duration is rejected with an actionable message,
not silently omitted. Titles shrink to fit bounded heading space; the renderer
refuses unrenderable text rather than clipping it. Standalone live note beats,
generated narration and source video audio are not exported. The selected
owner-uploaded Journey soundtrack is decoded with a bounded queue, looped from
its beginning, interleaved with video, and encoded as stereo 48 kHz AAC-LC.
Browsers without native AAC load the official matching
`@mediabunny/aac-encoder@1.61.3` extension. A missing track is disclosed as silent;
an unreadable selected track fails closed rather than producing a silent substitute.
The owner may explicitly switch music off. No external music is acquired.

## Complete-film storage and duration

15/30/60 seconds remain pacing targets. There is no two-minute rejection: every
canonical scene and enabled caption remains in one complete video. Before media
reads, the modal receives actual timeline duration and an approximate file size:
4 Mbps video plus 128 kbps audio when selected, 20% encoding headroom and 2 MiB
metadata allowance. This estimate is not a promise that variable-rate encoding
will produce exactly that size.

The encoder uses a positioned, backpressured `StreamTarget` with 1 MiB chunks
and an ordinary MP4 with `fastStart: false`; it does not retain the whole movie
for in-memory fast-start relocation. OPFS provides origin-private temporary
disk staging. Admission uses at most half the reported remaining quota and a
512 MiB aggregate staging ceiling, with at most eight active/retained exports.
The ceiling bounds accumulated private staging, not film duration. Each output
also has a runtime byte bound derived from its estimate plus 25% or 8 MiB
headroom, whichever is larger, within the available aggregate/quota budget.
Position plus write length is checked before a physical write; rewrites do not
consume the cumulative-byte budget twice. Actual quota/write errors fail closed.

Without OPFS plus Web Locks, a paged memory target is available only for an
estimate within the existing 96 MiB limit, enforced again on every write. It
does not grow one unbounded ArrayBuffer. Unsupported or insufficient storage
produces an actionable error; no automatic truncation, quality reduction or
multi-part output occurs.

Random-ID staging directories contain only reservation/retention metadata and
the private movie. Per-export Web Locks prevent another tab from deleting an
active export; a registry lock serializes reservations. A future export may
reclaim only unretained directories whose active-export lease is absent. Films
retained for an anchor download are never age-deleted automatically. The dialog
can show the retained count/bytes and explicitly clear them after the member
confirms all downloads finished. This bounded registry survives navigation and
crashes without logging Journey names, coordinates or signed URLs.

Where a save picker is supported, the finished movie is streamed to the chosen
destination, authorization is checked before and after copying, and destination
close is awaited before deleting staging. Other browsers use a regular download;
because it has no completion signal, its staging file and object URL survive
dialog dismissal until explicit cleanup. A retained file is not proof of a
successful download. No persistent-storage permission is requested.

## Privacy and cancellation

Original files must match declared byte size and, when verified, stored SHA-256.
Cover identity checks include source ID/hash, recipe/version, preset and output
metadata. Its signed URL is refreshed immediately before reading and rechecked
on render completion and each later explicit download. All rendered Journey
facts are re-read before release, including note/media changes without a Journey
revision increment. A changed/unauthorized source fails closed.

Fetches/stream readers/decoder/encoder have a shared abort signal. The active
encoding slot belongs to the page-level export service, not a dialog mount.
Closing, switching Journey or immediately reopening cannot free it: a second
export fails with a retryable busy message until the first exporter settles.
The renderer awaits the actual Output.cancel promise even when the library has
already marked its state canceled, so disposal really completes before release.
Images/video inputs/reveal contexts are released; original-byte caches
are cleared and stale download URLs are revoked. No partial MP4 is offered.
Source caps remain 128 MiB per source and 256 MiB combined input, now including
the selected soundtrack. The five-minute total timer is replaced with a
two-minute no-progress watchdog; advancing frames, successful writes and source
reads keep a healthy long export alive. Individual network reads retain their
60-second timeout. Aborting requests disposal but does not falsely claim native
codec or filesystem teardown has already settled; the page slot stays held
until actual settlement. Existing Keepsake v1 and live playback are unchanged.

## CI evidence

The existing keepsake-render job retains its job budget and runs both the old
private prototype regression and the actual owner Story button -> native modal
-> real H.264 MP4 -> download test. It decodes the resulting file to verify
opening/original frames, captures Stop and shape-only via Chinese captions, checks landscape/reduced
motion, requires the phone button, and exercises cancellation, expiry/revocation,
Journey changes and guest omission. Synthetic photos/videos and mocked owner
HTTP responses are used: this is browser/codec integration evidence, not a paid
model-output aesthetic evaluation or a production account test.

The portrait fixture now exceeds two minutes and includes a short synthetic
soundtrack. CI requires the entire expected frame count and all caption text,
an AAC track covering the movie (allowing codec padding), audible decoded PCM
before/after a loop and near the end, retained OPFS storage across dialog remount,
and explicit cleanup. Landscape verifies opt-out despite source-video audio;
the no-track case verifies the truthful silent message. These synthetic fixtures
do not claim reproduction on a member's private Journey.

The unmodified AAC fallback is supplied by Mediabunny under MPL-2.0. Its
[version-pinned source](https://github.com/Vanilagy/mediabunny/tree/v1.61.3/packages/aac-encoder)
and [license](https://github.com/Vanilagy/mediabunny/blob/v1.61.3/packages/aac-encoder/LICENSE)
remain available; this dependency supplies a codec, not licensed music content.

A separate real-dialog unmount/remount test injects deliberately delayed encoder
disposal through the actual export service. It verifies no second encoder starts
until the previous exporter settles, then an explicit retry can start. Unit tests
also cover a canceled output whose disposal promise is still pending. These
controlled-lifetime tests supplement, not replace, native MP4 generation.

The shared creative-cover registry, original owner film export and #707's
validated editor-navigation implementation are inherited from main. This
complete-film and soundtrack change preserves their integration fixtures and
required CI coverage. Its Source is rebuilt onto the exact merged parent and
requires fresh complete CI and independent review before the ledger-only final.
Code push does not change the installed worker, enable paid image calls, deploy
or merge.

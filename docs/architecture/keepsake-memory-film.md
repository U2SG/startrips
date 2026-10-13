# Private Journey memory films (#693)

The owner Story management footer exposes 导出短片 on desktop and phone.
It opens a native modal with portrait/landscape, 15/30/60-second target, optional
Route Point notes (off by default), and an already-generated creative cover.
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

Route Point captions are opt-in and grapheme/newline paginated with sufficient
reading time. Excessive text/size/duration is rejected with an actionable message,
not silently omitted. Titles shrink to fit bounded heading space; the renderer
refuses unrenderable text rather than clipping it. This version does not export
standalone live note beats, generated narration, music or source video audio;
the modal explicitly describes the file as a silent film.

## Privacy and cancellation

Original files must match declared byte size and, when verified, stored SHA-256.
Cover identity checks include source ID/hash, recipe/version, preset and output
metadata. Its signed URL is refreshed immediately before reading and rechecked
on render completion and each later explicit download. All rendered Journey
facts are re-read before release, including note/media changes without a Journey
revision increment. A changed/unauthorized source fails closed.

Fetches/stream readers/decoder/encoder have a shared abort signal. Cancellation
keeps the run slot until teardown settles, so restart cannot overlap a surviving
encode. Images/video inputs/reveal contexts are released; original-byte caches
are cleared and stale download URLs are revoked. No partial MP4 is offered.
Caps: 128 MiB per source, 256 MiB combined input, 120 seconds, 96 MiB output.
These caps are checked and exposed to the user rather than silently dropping
scenes. Existing Keepsake v1 construction and live playback remain unchanged.

## CI evidence

The existing keepsake-render job retains its job budget and runs both the old
private prototype regression and the actual owner Story button -> native modal
-> real H.264 MP4 -> download test. It decodes the resulting file to verify
opening/original frames, captures Chinese captions, checks landscape/reduced
motion, requires the phone button, and exercises cancellation, expiry/revocation,
Journey changes and guest omission. Synthetic photos/videos and mocked owner
HTTP responses are used: this is browser/codec integration evidence, not a paid
model-output aesthetic evaluation or a production account test.

#694 is merged into main and supplies the shared creative-cover registry and
protocol. #695 now targets main after rebasing its export-only changes; the
parent's final polling and Journey Book QA fixes stay inherited, not copied
into the child diff. Rebased Source CI and independent review remain required
before sealing. Code push does not change the installed worker, enable paid
image calls, deploy or merge.

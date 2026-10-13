# Story presentation repair — #699

The owner rejected the current mobile experience after #697/#698. Existing CI
success is not UX acceptance. This patch repairs connected behavior; it does not
claim that the four classic layouts are now meaningfully different. Their
structural redesign remains #700.

## Verified problems and changes

**One-way presentation and stale settings.** The Journey-specific classic latch
kept selecting the classic component while the account preference remained Book
or Stream. It also prevented classic-layout settings from taking effect. Remove
that latch, give each writable reader the same complete presentation chooser,
and seed a replacement reader from the last actual Journey/point/media
observation before mounting it. Classic and Note Overlay share their live reader.
Read-only shares retain their existing local classic recovery only.

**Account menu underneath Story.** Story is portaled to the document body, but
the account sheet was inside the lower app-shell stacking context. A larger
z-index inside that context alone did not repair pointer interception. Portal the
account sheet to the same root with the modal layer, and dismiss the account
surface in the same confirmed preference handoff, not on a rejected save. An
unfinished edit or mutation blocks changes from both Account and Story.

**Notes over unrelated photos.** Media-free Route Points retain their own
logical sequence position. Render them on an opaque text page and stop painting
neighbouring physical pages behind a settled note. Do not discard those nodes or
interrupt decoding. A deliberate swipe may reveal its legitimate next page.
The note text remains selectable and natively scrollable.

**Scroll ownership and closed-reader work.** Mobile Story does not forward wheel
input into the desktop copy column, and that column is no longer a nested
vertical scroller. Include safe-area padding inside the classic sheet's height
and use its border-box in the expand/collapse offset.

The pinned page-flip 2.0.7 package also leaves every destroyed renderer's
requestAnimationFrame loop alive. Its actual browser bundle reproduced continued
render calls after DOM removal. The version-bound pnpm patch cancels the owned
frame and prevents rescheduling, including destruction inside a frame. It changes
neither drawing geometry nor animation durations. Both published builds are
patched, Docker receives patches before its frozen install, and patch files use
LF for reproducible hashes. See `patches/README.md` and upstream
Nodlik/StPageFlip#71.

## Evidence and acceptance

- `node scripts/qa-page-flip-lifecycle.mjs`: real installed library, normal and
  in-frame destruction. Baseline continued for 12/17 observed post-destroy
  frames; patched results are zero/zero. No global animation API is replaced.
- `node scripts/qa-story-presentation-flow.mjs 320` and `390`: the actual signed-in
  app and account preference provider; all five presentations; account changes;
  media-free note position; native note/body touch scrolling; rejected saves;
  unsaved edit protection; a simulated 34px safe-area inset. Saves are mocked only
  at the API boundary; component state is not force-set.
- Existing classic-layout and note-beat suites remain in force. The new flow and
  lifecycle checks run inside the existing classic-view suite, not another CI
  shard. CI uploads screenshots, the WebM recording and per-frame observations
  under `story-presentation-<attempt>`.
- The frame samples document this emulated browser, not an iPhone performance
  guarantee. Removing the proved background render leak and conflicting scroll
  ownership does not certify every device's frame rate or the final visual taste.
- #700 must provide structurally different reading flows and a separate user
  trial; this PR is not a replacement for that deliverable.

Local artifacts are under `artifacts/story-repair/`. No deployment or final
owner acceptance is implied by a code/test pass.

# Scoped dependency patches

## page-flip 2.0.7 — render-loop ownership

The pinned package's Render.start schedules requestAnimationFrame recursively,
but PageFlip.destroy only removes UI/DOM. This leaves every closed or rebuilt
JourneyBook rendering forever. Upstream report: Nodlik/StPageFlip#71.

The patch retains both published builds (browser and module), without altering
page geometry, draw logic, gesture thresholds or flip duration:

- start is idempotent while running and stores the scheduled frame identifier.
- the callback checks ownership both before render and before rescheduling.
- stop clears ownership, cancels its own frame and discards the retired animation.
- destroy stops that renderer before removing the UI and book DOM.

`pnpm patch-commit` generated the manifest entry and lockfile patch hash. No
package versions changed. Normal frozen installs apply the exact-version patch;
do not enable ignored patch failures or mutate a shared node_modules in place.

`node scripts/qa-page-flip-lifecycle.mjs` loads the actual installed browser
bundle and observes normal destruction and destruction from inside a frame.
The unpatched build rendered 12/17 additional frames after destruction in the
bounded probes. The patched build rendered zero in both cases. The observer does
not replace requestAnimationFrame or suppress the library's draw behavior.

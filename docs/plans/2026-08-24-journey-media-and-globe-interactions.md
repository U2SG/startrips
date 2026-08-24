# Journey Media and Globe Interactions Implementation Plan

> **For Codex:** REQUIRED SKILL: Use @executing-plans to implement this plan task-by-task in the current worktree. Preserve unrelated user changes; do not commit, push, migrate production data, or deploy unless explicitly requested.

**Goal:** Make large journey photo sets easy to browse, let each journey use an uploaded soundtrack, connect the active journey card to its real projected location, keep the visual ambience on by default without a toggle, and wait 10 seconds before idle globe rotation resumes.

**Architecture:** Keep photos, videos, and soundtrack files in the existing private `media_assets`/multipart-upload pipeline, distinguishing visual media from audio by MIME type so no database migration or new endpoint is needed. Refactor the story UI into a visual-media browser plus one journey-level soundtrack, render the card connector inside the existing globe SVG projection layer, and make the existing aurora ambience an unconditional visual layer instead of persisted user state. Preserve reduced-motion behavior and all existing authorization/storage boundaries.

**Tech Stack:** React 19, TypeScript, Hono, Drizzle/PostgreSQL, S3-compatible multipart storage, Three.js/SVG projection, Vitest, Playwright QA, GitHub Actions.

---

## Product decisions and acceptance criteria

- Large photo sets get an “全部照片” overview grid. Clicking any thumbnail jumps directly to that item; the existing previous/next, autoplay, fullscreen, reorder, and delete paths remain available.
- Thumbnail reads reuse `GET /api/uploads/assets/:id/read-url`, cache signed URLs in the open dialog, use `loading="lazy"`/`decoding="async"`, and do not introduce a thumbnail service in this slice.
- A journey has one active soundtrack. Uploading a new soundtrack replaces the previous active track only after the new upload succeeds; older audio is then removed through the existing media-delete path.
- Soundtracks are journey-scoped (`routePointId = null`) audio assets. They never appear in photo/video counts, grids, card covers, route-point counts, or media ordering controls.
- Supported soundtrack formats: MP3, M4A/MP4 audio, AAC, OGG, and WAV, up to 100 MB. The server remains the authoritative MIME/size validator.
- The synthesized default pad is removed. A journey without an uploaded soundtrack plays its slideshow silently.
- “氛围” means the existing visual aurora field behind the particle globe, not soundtrack audio. It is rendered by default, has no toggle button, and no longer reads or writes `startrips.ambience` in local storage.
- Starting photo autoplay starts the custom soundtrack from its current position and loops it; pausing autoplay pauses audio. Closing/navigating the story stops playback. Native audio controls remain available for preview and volume control.
- The card connector terminates at the same focused route point used by `journeyFocus`. It updates while the globe rotates/zooms and when the card or viewport moves. If the point is behind the globe, outside the scene, or overlaps the card, the entire connector is hidden—there is never a decorative stub.
- Idle rotation resumes 10,000 ms after the latest globe pointer/wheel interaction, only when drag inertia has stopped and reduced-motion is off.

### Task 1: Separate visual media and journey soundtrack contracts

**Files:**
- Modify: `src/journey/journeyModel.ts`
- Test: `src/journey/journeyModel.test.ts`
- Modify: `server/routes/uploads.ts`
- Test: `server/routes/uploads-validation.test.ts`

**Steps:**
1. Add pure helpers for `isVisualMediaAsset`, `isSoundtrackAsset`, `journeyVisualMedia`, and `journeySoundtrack`; select the highest `sortOrder` audio asset as the active soundtrack.
2. Keep `validateJourneyFiles` restricted to the current photo/video types so the composer cannot accidentally treat audio as a route-point visual.
3. Add `validateJourneySoundtrack` for exactly one audio file, a non-empty filename, an allowed audio MIME type, and a 100 MB maximum.
4. Extend the server upload allowlist with the same audio MIME types and enforce the audio-specific 100 MB limit inside `parseStartUpload`; keep the existing 2 GB cap for visual media.
5. Add focused tests proving visual/audio classification, latest-track selection, supported audio acceptance, unsupported MIME rejection, and the 100 MB boundary on both client and server.

**Expected behavior:** Existing image/video uploads are unchanged; direct attempts to upload oversized or unsupported audio return `INVALID_UPLOAD`.

### Task 2: Add direct-access browsing for large photo sets

**Files:**
- Modify: `src/journey/JourneyStory.tsx`
- Modify: `src/styles/living-atlas.css`
- Test: `src/journey/JourneyStory.test.ts`
- Modify: `scripts/qa-journey-story.mjs`

**Steps:**
1. Derive `scopedMedia` from visual assets only and preserve the existing route-point scope behavior.
2. Stop replacing `mediaReads` whenever the active item changes; cache ready signed reads for the lifetime of the dialog and refresh each URL before expiry.
3. Add an “全部照片” control when the current scope has more than one visual item. It switches the media pane to a scrollable thumbnail grid with the current item clearly selected.
4. Load visible grid items lazily, render image thumbnails with `loading="lazy"` and `decoding="async"`, and render video tiles with a video badge instead of autoplaying every video.
5. Clicking a tile sets `assetIndex`, exits overview mode, and displays that item immediately. Preserve focus visibility, `aria-current`, keyboard activation, and at least 44px mobile targets.
6. Keep fullscreen navigation and autoplay bound to visual media only; return to single-item mode before starting autoplay.
7. Extend component coverage for overview availability, visual-only counts, direct selection semantics, and audio exclusion. Extend the deterministic story QA to assert that a non-adjacent thumbnail can be selected without repeated next clicks.

**Expected behavior:** With dozens of photos, any item is reachable in one overview action plus one tile click; signed reads remain private and cached only in memory.

### Task 3: Upload, replace, preview, and play a custom soundtrack

**Files:**
- Modify: `src/journey/JourneyStory.tsx`
- Modify: `src/styles/living-atlas.css`
- Modify: `src/journey/LivingAtlasApp.tsx`
- Modify: `src/journey/JourneyComposer.test.ts`
- Test: `src/journey/JourneyStory.test.ts`
- Delete: `src/journey/ambientMusic.ts`
- Modify: `scripts/qa-journey-story.mjs`

**Steps:**
1. Add a dedicated “旅程配乐” section and hidden single-file input with the accepted audio MIME list; keep it separate from “添加照片或视频”.
2. Upload the selected file through `uploadJourneyMedia` with `routePointId` omitted, then refresh the journey through the existing `onMediaAdded` callback.
3. After a successful replacement, delete the previous audio asset through `deleteMedia`, refresh again, and surface a non-blocking cleanup warning if old-track removal fails. Never delete the old track before the new asset is confirmed.
4. Resolve the active soundtrack’s signed read URL using the existing private read API and refresh it before expiry.
5. Render an `<audio controls loop preload="metadata">` element with the uploaded filename plus explicit replace/remove actions. Use the same pending/error presentation as visual uploads.
6. Replace `startAmbientMusic`/`stopAmbientMusic` with an `audioRef`: slideshow play calls `audio.play()` after the user gesture, pause calls `audio.pause()`, and dialog close/journey navigation pauses and resets playback. Treat a rejected `play()` promise as silent playback, not a broken story.
7. Filter audio out of `JourneyCardMedia`, `has-media`, card media counts, story visual counts, and reorder payloads. A soundtrack-only journey must not render a broken image cover.
8. Add tests for soundtrack-only journeys, replacement ordering, failed-new-upload preservation of the old track, and silent slideshow behavior when no soundtrack exists. Extend story QA to upload a tiny audio fixture and verify the track is exposed as audio rather than as a photo tile.

**Expected behavior:** Users can upload, preview, replace, or remove one soundtrack per journey; visual media behavior and storage authorization remain unchanged.

### Task 4: Replace the decorative card stub with a projected connector

**Files:**
- Modify: `src/scene/ParticleEarthScene.tsx`
- Modify: `src/app.css`
- Modify: `src/styles/living-atlas.css`
- Test: `src/scene/ParticleEarthScene.test.tsx`
- Modify: `scripts/qa-live-globe.mjs`

**Steps:**
1. Remove `.living-atlas__active::before`, the fixed 78px decorative line.
2. Add a dedicated `particle-earth-journey-connector` path to the existing `routeVectorLayer`; color it with the active journey color and keep it non-interactive/`aria-hidden`.
3. Reuse the personal focus point’s globe-space vector and `projectRoutePoint` visibility check to obtain the geographic endpoint.
4. Compute the card anchor from `.living-atlas__active.getBoundingClientRect()` relative to the scene host: use the left edge on desktop and top edge on compact/mobile layouts.
5. Build a short elbow path from the card anchor to the projected point. Hide the whole path when there is no active card/focus, the focus is occluded/outside the scene, or the endpoint lies inside the card.
6. Recompute the connector when projection state, active route/focus, viewport size, or card bounds change. Include card bounds/focus revision in the projection invalidation so a static globe still updates correctly.
7. Export and test the pure anchor/path/visibility helpers. Extend live-globe QA to compare the path endpoints against `data-personal-point-x/y` and the card edge at desktop and mobile viewports.

**Expected behavior:** The line visibly touches the selected geographic marker and the active card at both ends; if a truthful connection cannot be drawn, no line is shown.

### Task 5: Change idle auto-rotation delay to 10 seconds

**Files:**
- Modify: `src/scene/ParticleEarthScene.tsx`
- Test: `src/scene/ParticleEarthScene.test.tsx`

**Steps:**
1. Change `GLOBE_IDLE_RESUME_DELAY_MS` from `1_800` to `10_000`.
2. Keep the existing guards for pointer activity, inertia, disabled drag, and reduced motion.
3. Update boundary coverage to assert no rotation at 9,999 ms and rotation at 10,000 ms after the latest interaction.

**Expected behavior:** The globe remains still for a full 10 seconds after user interaction and then resumes at the existing rotation speed.

### Task 6: Make visual ambience always on and remove its toggle

**Files:**
- Modify: `src/scene/LivingAtlasGlobe.tsx`
- Modify: `src/styles/living-atlas.css`
- Test: the closest scene/component test or deterministic globe QA coverage

**Steps:**
1. Remove `AMBIENCE_STORAGE_KEY`, `preferredAmbience`, the `ambience` state, and the local-storage persistence effect.
2. Render `.living-atlas-ambience` unconditionally in the particle-globe shell while retaining `aria-hidden="true"` and the existing reduced-motion CSS.
3. Remove the `IconSparkles` import and the entire `data-ambience-toggle` button; remove its hover/active/mobile CSS because the control must not exist in the DOM.
4. Remove the now-meaningless dynamic `data-ambience` attribute unless a deterministic QA selector requires it; if QA needs a marker, use a static `data-ambience="on"` rather than state.
5. Add coverage proving the ambience layer is present on first render, the toggle is absent, and no local-storage preference can turn the visual layer off.

**Expected behavior:** The visual ambience is always present by default, respects reduced-motion for animation, and exposes no ambience button or persisted preference.

### Task 7: Review and CI verification

**Files:**
- Review: all files above
- Verify: `.github/workflows/ci.yml`

**Steps:**
1. Run local static checks only: `git diff --check` and inspect `git diff --stat`/`git diff` for unrelated changes.
2. Do not run local `pnpm test`, `pnpm typecheck`, or `pnpm build`; the user’s project preference reserves those gates for GitHub Actions.
3. When the user authorizes commit/push, keep implementation commits atomic by concern and wait for the `ci` workflow: generated auth schema check, isolated PostgreSQL migrations, TypeScript, Vitest, and production build.
4. Run the deterministic browser QA scripts only in the approved controlled preview workflow and retain screenshots for desktop/mobile gallery overview plus the connected card/location line.
5. Report any browser-specific audio decoding limitation by actual MIME type; do not silently fall back to the removed synthesized pad.

**Final acceptance:** All five requested behaviors pass deterministic QA, GitHub `ci` is green, no database migration is introduced, and unrelated untracked files remain untouched.


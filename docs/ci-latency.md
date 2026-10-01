# CI latency: preserve coverage, remove avoidable setup

## Baseline evidence

Observed on 2026-09-30, before this change (main `8042f7a7051780521f0bbd14e8cfa2a26ce200fb`):

- Run `36732369930`, job `109945090218`: **3,332 seconds** in `Install Chromium`; browser QA never started. The log stalls in Ubuntu APT metadata retrieval.
- Run `36741072484`, job `109975307883`: 314 seconds before starting, 468 seconds installing Chromium/system dependencies, then 688 seconds of browser QA. The APT package download alone took 7m27s; dependency installation with pnpm took two seconds.
- That second job's suites took approximately: prefetch 111s, continuity 236s, manual camera 171s, final acceptance 152s, brand 16s. These are one-run observations, not percentiles.
- Its shell/composer QA took 176s and route-candidates QA took 40s.

Source runs: https://github.com/U2SG/startrips/actions/runs/36732369930 and https://github.com/U2SG/startrips/actions/runs/36741072484.

## Changes

1. **Reuse the browser already used by the QA harness.** `qa-browser.mjs` preferred the hosted image's `/usr/bin/google-chrome` even while CI downloaded a separate Chromium and installed its dependencies. Browser jobs now use `ubuntu-24.04`, keep that Chrome preference, and install only Playwright's small FFmpeg recorder. No per-run Chromium or browser APT installation remains. A one-minute selection guard records the executable/browser/image versions. Mandatory H.264 capability and actual recording checks reuse each real suite browser, with its existing launch options and suite budget, rather than creating a second cold browser. If the image loses its browser, fail explicitly instead of silently switching engines.
2. **Rebalance, do not remove coverage.** Keep all 31 stable suite identities, all 33 original pnpm QA invocations, all desktop/mobile cases, at most eight shards, failure continuation, evidence uploads and each suite's 12-minute cap. Move manual-camera to the previously short route-candidates shard and final-acceptance to shell-composer. The sampled playback shard loses about 323 seconds of serial work; that is an estimate from the old sample, not a measured new CI result. Other long shards and runner queues can still dominate.
3. **Fast feedback before heavy provisioning.** `quick-checks` classifies final-ledger eligibility, tests CI contracts and runs typecheck exactly once. Product validation depends on quick-checks, not ledger: an unsealed Source must still be able to obtain real product QA evidence. A type failure prevents expensive follow-on jobs.
4. **Skip environments only for an independently proved final.** The existing classifier's single-ledger-commit rule is unchanged. Heavy jobs do not start for a classified ledger final. `verify` independently proves the exact Source CI, then accepts heavy-job skips only when the proof succeeded and agrees with classification; ledger and quick-checks must still succeed. Ordinary code, main pushes and manual exact-main recovery require actual success in every product lane. Missing, failed or cancelled evidence is never success.
5. **Separate infrastructure budgets from test budgets.** pnpm installation is bounded at three minutes, recorder setup at two minutes, and browser smoke at one minute. Full FFmpeg/ffprobe setup, used by actual rendering, has a three-minute step budget plus bounded APT operations. It uses invocation-scoped official Ubuntu HTTPS sources and the Ubuntu archive signing key instead of the slow hosted Azure HTTP mirror; no global source file is rewritten. These are setup failures, not grounds to waive product assertions.
6. **Measure future tuning.** Every suite preserves `STARTRIPS_QA_SUITE` and additionally emits `STARTRIPS_QA_RESULT` with monotonic duration and status. JSONL artifacts and the job summary include passed/failed/timed-out suites. The runner continues to siblings after failure; a timing-write failure also fails closed.

The production-autoplay workflow retains **both baseline and candidate**, its original baseline SHA, real timers and pixel/video evidence. It copies the current infrastructure helpers alongside its observing harness before checking out the old source. No assertion, viewport, pixel threshold or product code changed.

The image-container alternative is deliberately not used in this first change: substituting bundled Chromium for the already-selected Chrome would change the media-test runtime and could change codec behavior. This patch removes unused setup while preserving the existing browser choice. Hosted Chrome is not version-frozen; its exact version and runner image are recorded for each job, just as the hosted image continues to supply updates.

## Validation and acceptance

Local targeted suite: 22 tests pass, including complete suite inventory, command equality, fast-path proof failures, rejected skips on ordinary changes, dependency/browser selection and timing failure continuation. YAML parsing, Bash syntax and `git diff --check` also pass.

The full PR browser/core workflows remain necessary. Local dependency installation and an expanded test invocation hit execution budgets on this Windows host, so neither a local full application run nor improved end-to-end CI time is claimed. Compare repeated ordinary-Source runs by queue, setup, actual suite time, failure type and total runner minutes; report median and tail after collecting sufficient samples. A faster failed run is not success.

Related follow-up: #476. No new task backlog, owner reassignment, merge permission or review waiver is introduced.

## Source CI repair after the first cloud run

Run `36751927316` on `7c1d90590d5db3fc2bceea3a523f9e964b50b97b` found two setup failures before product assertions:

- `keepsake-render` job `110013372221`: the APT install hit the unchanged 90-second cap while downloading dependencies from `azure.archive.ubuntu.com`. Merely adding that cap did not remove the slow download source. Setup now uses temporary, signed official Ubuntu HTTPS sources for both index and package downloads; distro, package selection and time/retry caps are unchanged. Shell command-double regressions cover already-installed tools, missing ffprobe, non-root/root setup, failed update/install and cleanup.
- `story-media` job `110013372522`: the extra preflight browser launch timed out at its new 20-second limit; neither Story suite ran. The log does not establish why that runner's cold launch was slow. Remove the extra launch, not the capability assertions: `qa-browser.mjs` now verifies H.264/recording on the same browser that the real suite already launches with its original options/budget. There is no retry or product-timeout increase; a failed runtime assertion still closes the browser and fails the suite. Request one painted frame before flushing the recorder rather than sleeping.

Both production baseline/candidate checks and the other nine browser shards passed on that Source. `ledger` remains unsealed and `verify` correctly rejected the incomplete validation. The repaired Source still requires new exact-head CI and independent review. No local tests were run in this repair; local work is restricted to syntax and diff checks.

## Story rail observation repair

The raw Actions log for job `110152469469` (Source `3ef26f1a`) and timing artifact `11133328167` identify the actual remaining failure as `story-desktop-chapter-rail-media-first`. The failed report has `railWidth=1560`, `railScrollLeft=0`, `activeVisible=true`, no console/page errors, and all 21 keyboard chapter activations. The assertion `initial.railScrollLeft > 0` incorrectly assumed chapter 17 must be clipped at every initial font/layout width. A tool-rendered preview/404 summary did not match the exact source blob and was discarded; no network error is suppressed by this repair.

Grade actual active-chapter containment and whether its unscrolled geometry needs a reveal. Keep the initial containment checks and require a real automatic scroll after the existing 1920-to-1280 viewport resize: the narrow fixture must demonstrably need scrolling, have scrolled, and contain the active button. No CSS, scripted scrolling, click/focus help or product code is introduced. Existing keyboard End/Home/Tab/Enter, wheel, media size and note visibility assertions remain. New cloud unit tests distinguish already-visible, correctly revealed, unrevealed, overshot, and invalid-geometry observations. Full Story QA remains required.

## Recorder first-frame ownership repair

Run `36795828405` on `473b78e0` exposed a race in the new runtime probe: city-label-anchoring job `110159119777` and production baseline job `110158912909` both report `Page did not produce any video frames` at the probe's `video.path()`. A completed screenshot does not prove that Playwright's independent screencast recorder has published an artifact. Closing the page first can settle its video promise without any recording.

Await `video.path()` while the producer context is alive, with a bounded first-frame deadline; only then close/flush and assert a nonempty recording file. Keep capability checks, a real screenshot, all application suites and original suite budgets. No fixed sleep, browser restart, retry, ignored error or empty-video waiver. Cloud regression doubles verify publication-before-close, missing/rejected transports and bounded no-frame failure.

## Timestamp collision in the existing privacy regression

Source `1ce536fc`, core job `110161278048`: 2,838 assertions passed and the one failing test rejected a response containing `12.5`. The raw response shows no private precision field: the substring came from the legitimate expiry `2026-10-08T00:32:12.547Z`. Replace the short serialized substring match with recursive JSON scalar checks for both numeric `12.5` and exact string `"12.5"`; retain every private-field/storage/owner/coordinate assertion and add an exact five-field guest media allowlist plus an explicit HTTP 200 assertion. A deterministic fixture reproduces the timestamp collision and proves nested numeric/string precision remains detectable. Other numeric substring guards were searched; their longer/specific coordinate values or `991.5` do not have this seconds/milliseconds collision. No clock manipulation, data exposure, test deletion or rerun-to-green is used.

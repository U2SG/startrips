# CI latency: preserve coverage, remove avoidable setup

## Baseline evidence

Observed on 2026-09-30, before this change (main `8042f7a7051780521f0bbd14e8cfa2a26ce200fb`):

- Run `36732369930`, job `109945090218`: **3,332 seconds** in `Install Chromium`; browser QA never started. The log stalls in Ubuntu APT metadata retrieval.
- Run `36741072484`, job `109975307883`: 314 seconds before starting, 468 seconds installing Chromium/system dependencies, then 688 seconds of browser QA. The APT package download alone took 7m27s; dependency installation with pnpm took two seconds.
- That second job's suites took approximately: prefetch 111s, continuity 236s, manual camera 171s, final acceptance 152s, brand 16s. These are one-run observations, not percentiles.
- Its shell/composer QA took 176s and route-candidates QA took 40s.

Source runs: https://github.com/U2SG/startrips/actions/runs/36732369930 and https://github.com/U2SG/startrips/actions/runs/36741072484.

## Changes

1. **Reuse the browser already used by the QA harness.** `qa-browser.mjs` preferred the hosted image's `/usr/bin/google-chrome` even while CI downloaded a separate Chromium and installed its dependencies. Browser jobs now use `ubuntu-24.04`, keep that Chrome preference, and install only Playwright's small FFmpeg recorder. No per-run Chromium or browser APT installation remains. A one-minute smoke guard records the executable/browser/image versions and verifies H.264 capability and actual recording before the suites. If the image loses its browser, fail explicitly instead of silently switching engines.
2. **Rebalance, do not remove coverage.** Keep all 31 stable suite identities, all 33 original pnpm QA invocations, all desktop/mobile cases, ten shards, failure continuation, evidence uploads and each suite's 12-minute cap. Move manual-camera to the previously short route-candidates shard and final-acceptance to shell-composer. The sampled playback shard loses about 323 seconds of serial work; that is an estimate from the old sample, not a measured new CI result. Other long shards and runner queues can still dominate.
3. **Fast feedback before heavy provisioning.** `quick-checks` classifies final-ledger eligibility, tests CI contracts and runs typecheck exactly once. Product validation depends on quick-checks, not ledger: an unsealed Source must still be able to obtain real product QA evidence. A type failure prevents expensive follow-on jobs.
4. **Skip environments only for an independently proved final.** The existing classifier's single-ledger-commit rule is unchanged. Heavy jobs do not start for a classified ledger final. `verify` independently proves the exact Source CI, then accepts heavy-job skips only when the proof succeeded and agrees with classification; ledger and quick-checks must still succeed. Ordinary code, main pushes and manual exact-main recovery require actual success in every product lane. Missing, failed or cancelled evidence is never success.
5. **Separate infrastructure budgets from test budgets.** pnpm installation is bounded at three minutes, recorder setup at two minutes, and browser smoke at one minute. Full FFmpeg/ffprobe setup, used by actual rendering, has a three-minute step budget plus bounded APT operations. These are setup failures, not grounds to waive product assertions.
6. **Measure future tuning.** Every suite preserves `STARTRIPS_QA_SUITE` and additionally emits `STARTRIPS_QA_RESULT` with monotonic duration and status. JSONL artifacts and the job summary include passed/failed/timed-out suites. The runner continues to siblings after failure; a timing-write failure also fails closed.

The production-autoplay workflow retains **both baseline and candidate**, its original baseline SHA, real timers and pixel/video evidence. It copies the current infrastructure helpers alongside its observing harness before checking out the old source. No assertion, viewport, pixel threshold or product code changed.

The image-container alternative is deliberately not used in this first change: substituting bundled Chromium for the already-selected Chrome would change the media-test runtime and could change codec behavior. This patch removes unused setup while preserving the existing browser choice. Hosted Chrome is not version-frozen; its exact version and runner image are recorded for each job, just as the hosted image continues to supply updates.

## Validation and acceptance

Local targeted suite: 22 tests pass, including complete suite inventory, command equality, fast-path proof failures, rejected skips on ordinary changes, dependency/browser selection and timing failure continuation. YAML parsing, Bash syntax and `git diff --check` also pass.

The full PR browser/core workflows remain necessary. Local dependency installation and an expanded test invocation hit execution budgets on this Windows host, so neither a local full application run nor improved end-to-end CI time is claimed. Compare repeated ordinary-Source runs by queue, setup, actual suite time, failure type and total runner minutes; report median and tail after collecting sufficient samples. A faster failed run is not success.

Related follow-up: #476. No new task backlog, owner reassignment, merge permission or review waiver is introduced.

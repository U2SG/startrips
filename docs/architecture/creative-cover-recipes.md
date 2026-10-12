# Creative cover recipes — opt-in adapter slice (#692)

The production owner/worker protocol remains `cover-reveal-worker-protocol.md`.
`creative-cover-adapter.mjs` implements its existing local generator stdin boundary.
It does not introduce a worker, scheduler, storage credential or runtime GitHub dependency.

## Implemented

Three Startrips-owned recipes: `ink-wash-memory` (legacy generation kind
`ink-wash-poster`, v1), `poetic-line-memory` v1 and `paper-collage-memory` v1.
Each task pins the recipe, source SHA-256 and the server's preset/seed. It carries
art direction, fact-to-mark requirements and non-executable motion intent. The
opening has the source aspect ratio, no poster frame or experimental text, and
must not replace the source. Subjects/camera remain locked; this is not image
segmentation or natural-object animation.

The generator writes a separate JPEG. A separately configured reviewer must
return a pass bound to the exact source/output hashes and recipe, all four
checks, and two to four fact-to-mark pairs. File type, decoded dimensions,
aspect ratio, source integrity and post-review output integrity are checked.
Publication uses an exclusive hard link of the reviewed buffer; a pre-existing
output is not overwritten. Temporary files are removed on completion/failure.
The server remains authoritative for uploaded object validation.

## Operator integration (not activated by this PR)

Keep `COVER_REVEAL_GENERATOR_COMMAND` set to the absolute Node executable and set
`COVER_REVEAL_GENERATOR_ARGS` to a JSON array containing the absolute path to
`scripts/creative-cover-adapter.mjs`.

Configure `STARTRIPS_CREATIVE_GENERATOR_COMMAND_JSON` and
`STARTRIPS_CREATIVE_REVIEWER_COMMAND_JSON` as operator-owned absolute argv arrays.
Both programs read one JSON document on stdin and return one JSON object on stdout.
The generator reads `sourcePath` and writes its JPEG to `outputPath` (reply `{}`).
The reviewer examines both paths and returns the shape tested in
`creative-cover-adapter.test.mjs`. Neither command comes from a job or prompt.
Only explicitly named provider environment variables from
`STARTRIPS_CREATIVE_PROVIDER_ENV_NAMES` are forwarded; worker/database/storage
credentials are refused. Child stderr and untrusted error text are not logged.

Sharp is the existing repository decoder. This adapter is trusted local code,
not a sandbox for hostile generator programs. Provider and reviewer commands
must be installed and reviewed by the operator; do not execute remote Skills.

## Delivery boundary

This is **not** the completed product feature. Current owner enqueue/display
still pins `ink-wash-poster` v1. The two additional recipes are registered for
integration, not silently substituted under an ink-wash job. Server-side recipe
selection/idempotency/display recognition, the owner selector, installed worker
configuration, real-photo visual evaluation and browser/renderer regression are
still required before rollout. No live configuration or source image was changed.

Tests use synthetic bytes and an injected decoder/reviewer. They prove contract
and publication behavior, not the aesthetic quality of a generated photograph.

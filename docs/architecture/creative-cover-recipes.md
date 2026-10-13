# Creative Journey covers (#692)

The owner editor selects water-ink, poetic-line or paper-collage art. One shared
versioned registry supplies the browser, server and local generator. The existing
five-route worker, private derivative table, storage namespace and RevealFlow stay
in place. There is no third-party runtime Skill download and no second scheduler.

## End-to-end flow

Owner recipe selection -> transactionally pinned source/recipe/seed/preset ->
existing worker claim -> verified source SHA-256 -> image analysis -> image edit ->
independent pixel review -> reviewed JPEG publication -> owner status/preview ->
Story opening and optional Journey-film opening. Source bytes are never replaced.

Enqueue locks the canonical Journey and media, then its live derivative rows.
Reselecting the same style/source returns the existing job. Changing styles
supersedes the previous live job, including an in-flight claim. A late completion
cannot restore a deselected style. A pending or failed replacement shows the
original, not the last style by worker completion time. Re-selecting a previously
superseded style generates again; this version does not claim a multi-style cache.
No database migration or preference copy is needed: the one live derivative is
the durable selection. Existing unique identity indexes remain in force.

GET /api/cover-reveal/recipes is the deployment capability; GET
/api/cover-reveal/journeys/:id/status is the owner editor's bounded state read.
Neither accepts worker authority or exposes credentials, object keys or signed
source URLs. Display signing retains its fresh canonical-cover revalidation.
The editor polls only while a job is pending, stops on unmount, offers explicit
refresh/retry, and previews with the real RevealFlow component. Reduced motion
and source-preserving final frames are inherited from that component.

## Existing worker configuration

Use the absolute Node executable as COVER_REVEAL_GENERATOR_COMMAND and the
absolute path to scripts/creative-cover-adapter.mjs as the sole JSON-array entry
in COVER_REVEAL_GENERATOR_ARGS. Run the adapter with --check before enabling.
With no operator command overrides, the built-in provider uses OPENAI_API_KEY,
STARTRIPS_CREATIVE_IMAGE_MODEL (default gpt-image-2-2026-04-21), and
STARTRIPS_CREATIVE_REVIEW_MODEL (default gpt-6.1-sol). It performs three separate
API requests: observable-fact analysis, image editing, independent review. These
requests consume API quota; the application does not use ChatGPT subscription
credentials. Original metadata is stripped before provider transfer; Responses
requests use store:false. No worker capability is sent to the model.

Once that existing worker is configured, set COVER_REVEAL_CREATIVE_ENABLED=true
on the API service. Until then, the UI truthfully offers the legacy ink recipe
and the API refuses new recipe IDs instead of queueing unsupported jobs. Production
configuration, paid calls, deployment and owner photos are not modified by a PR.

Operator-installed generator/reviewer commands remain supported by the existing
*_COMMAND_JSON settings. Both must be configured together; each consumes one
JSON stdin document. They are trusted local programs, not sandboxed remote Skills.
Only explicitly granted provider environment variables enter these children.

## Validation

Source/output hashes, decoded JPEG dimensions/aspect, post-review integrity and
exclusive publication are enforced locally; stored object validation remains
server-authoritative. The review must pass four visual checks and provide two to
four observable fact-to-mark correspondences for these exact bytes. A rejection
publishes nothing. The adapter has no hidden paid retry; normal bounded worker
attempt policy remains unchanged.

CI covers real JPEG decoding against a mocked provider, transaction/concurrency,
late completion, owner/worker isolation, and browser selection/status/preview.
Mock-provider checks prove integration, not the artistic quality of a real paid
model result; evaluate representative owner-approved photographs before enabling
new styles in production. The final photo remains the unchanged canonical source.

Provider API contracts checked 2026-10-12:
- https://developers.openai.com/api/reference/python/resources/images/methods/edit
- https://developers.openai.com/api/reference/resources/responses/methods/create

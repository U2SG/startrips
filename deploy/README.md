# Portable preview deployment

This Compose deployment keeps the application independent of a cloud vendor. It runs:

- Caddy for automatic HTTPS, static files, and same-origin `/api` proxying;
- the Node API;
- PostgreSQL 17 with a persistent named volume;
- a one-shot Drizzle migration container;
- Mailpit on remote loopback only for preview email verification.

The Caddy configuration requests a publicly trusted, short-lived Let's Encrypt certificate directly for the IPv4 address. This avoids requiring a temporary domain; public TCP ports 80 and 443 must both be allowed by the cloud firewall/security group.

Copy `deploy/env.example` to the ignored repository-root `.env.deploy`, replace both secrets, and run from the repository root:

```bash
docker compose --env-file .env.deploy -f deploy/compose.yaml up -d --build
```

## Repeatable main deployment

From a trusted workstation with `git`, authenticated `gh`, Python `paramiko`, and SSH credentials loaded into the operating-system SSH agent, run one command:

```powershell
python scripts/deploy-main.py
```

On Windows, enable the built-in OpenSSH agent once from an elevated PowerShell and load the server key:

```powershell
Set-Service ssh-agent -StartupType Automatic
Start-Service ssh-agent
ssh-add D:\path\to\server-key.pem
```

`--key "D:\path\to\server-key.pem"` remains available as an explicit manual fallback when an SSH agent is intentionally not used.

The script fetches the exact remote `main` commit into its deployment-owned ref without switching or modifying the current worktree, waits for that exact commit's GitHub Actions run to pass, uploads a `git archive`, backs up PostgreSQL, tags the running API/Web images for rollback, builds the new release, applies migrations, recreates API/Web, and verifies container state plus public HTTPS. It holds a server-side deployment lock, verifies any automatic application rollback, requires 5 GiB of free disk, and retains the five newest script-managed releases, backups, and rollback tags. The PEM contents and production `.env.deploy` are never copied into Git.

The default server's SSH host keys are pinned in the script. A different `--server` must also pass one or more trusted `--host-key-sha256` fingerprints. The CI wait defaults to 25 minutes and the remote deployment deadline to one hour; both are configurable command-line options. Server-local HTTPS checks are the activation gate; a workstation public-path failure is reported as a warning because a local network problem must not roll back an otherwise healthy server.

Inspect preview mail only through an SSH tunnel or a server-local API request. Do not publish port 8025.

Location search is selected through `LOCATION_SEARCH_DRIVER`. The preview defaults
to the low-volume public Photon demo because it is reachable from the current host;
`nominatim` and `disabled` remain available without changing client code. A public
demo has no availability guarantee, so production should use a contracted endpoint
or a self-hosted compatible service.

## Itinerary import

Importing an itinerary (#512) uses two independent adapters, both `disabled` by
default. Pasted text is read in the browser and needs neither of them, so a
deployment that installs nothing still imports a plan a member can paste.

`ITINERARY_SOURCE_FETCH_DRIVER` selects how a shared plan link is read: `http`
reads the page as served, and `render` posts the URL to the bounded rendering
service named by `ITINERARY_SOURCE_RENDER_URL` for a page that composes itself
in a browser. Every hop, including each redirect, is resolved before it is
requested and refused when it lands on a private, loopback, link-local or
cloud-metadata address. A link this deployment cannot reach is reported as
unreachable at the source-access stage, never as an invalid link.

`ITINERARY_RECOGNITION_DRIVER=http-model` posts the submitted document to
`ITINERARY_RECOGNITION_BASE_URL` with `ITINERARY_RECOGNITION_API_KEY` and
accepts only versioned structured candidates in reply; anything else is refused
at the extraction stage. `ITINERARY_RECOGNITION_MODEL` is recorded on every
reading, so a draft stays attributable to the build that produced it and a
newer build is a configuration change rather than a code change. The credential
is never sent to a browser, and only what the member submitted for this import
is sent to the provider.

## Detailed earth map

The Living Atlas keeps its particle globe in Three.js and preloads a MapLibre
vector detail view for zoom levels up to 20. It reveals the map only after the
initial vector tiles are ready, then releases the hidden Three.js context. The
detail view intentionally contains no Journey overlays and defaults to Chinese
labels with a Chinese/bilingual switch.

The map renderer is provider-neutral. It uses OpenFreeMap's Fiord vector style by
default. Set `ATLAS_MAP_STYLE_URL` in `.env.deploy` to use a contracted or
self-hosted MapLibre style without changing application code. A replacement style
must allow browser CORS access from `https://${APP_HOST}` and expose `name:zh` or
`name:zh-Hans` fields when Chinese labels are required.

## Private media storage

Media uses the existing multipart API with an `s3` protocol adapter. The browser
uploads signed parts directly to a private AWS S3, Tencent COS, Alibaba OSS, or
MinIO bucket; permanent credentials stay in the API container. Keep
`STORAGE_DRIVER=disabled` until the bucket is ready, then configure the `S3_*`
values from `deploy/env.example` and use `STORAGE_DRIVER=s3`.

Set `S3_BACKEND_ID` once for the physical storage location (for example,
`primary-media-v1`) and do not reuse that ID for a different bucket. It is stored
with each media row so a later provider switch fails closed instead of reading an
old key from the wrong bucket. Changing the endpoint, bucket, or key prefix also
requires a new backend ID.

To pause new uploads without stopping recovery, set `STORAGE_DRIVER=disabled`
but keep the complete `S3_*` backend configuration. The API rejects new starts
while its reconciler can still finish or clean existing uploads.

`S3_KEY_PREFIX` scopes logical media keys to a directory inside the bucket. For
the current COS mount use `live`, matching the bucket prefix mounted at
`/cos-data`; other providers may leave it empty or choose another prefix.

The bucket CORS policy must allow `PUT` from `https://${APP_HOST}`, allow request
headers used by signed uploads, and expose the `ETag` response header. It must
also allow signed `GET`/`HEAD` reads from `https://${APP_HOST}` and return
`Access-Control-Allow-Origin` for that origin so the optional #20 Web Audio
analysis clone can read soundtrack energy. The real soundtrack player does not
use CORS mode, so a missing/incorrect read CORS rule degrades only the reactive
atmosphere and must not block audio playback. Keep virtual-hosted addressing
(`S3_FORCE_PATH_STYLE=false`) for COS and OSS; path style is intended only for
compatible providers such as a locally configured MinIO deployment.

Before activation, add a bucket lifecycle rule that aborts incomplete multipart
uploads after seven days. The client and API abort failed uploads immediately,
while the lifecycle rule covers browser crashes and interrupted sessions.

### Signed read lifetimes

`MEDIA_READ_URL_EXPIRES_IN_SECONDS` (60-3600, default 900) is the lifetime of a
signed read issued to a member of the Atlas.
`SHARE_MEDIA_READ_URL_EXPIRES_IN_SECONDS` (15-600, default 90) is the ceiling
for a share-link guest, and the value actually issued is
`min(that ceiling, the owner ceiling, the grant's remaining lifetime)`.

The guest value is short because it is the only bound that exists on an
already-issued URL. A presigned storage URL cannot be withdrawn: revoking a
share stops the API issuing new ones immediately, but a URL already in a
guest's hands keeps working until it expires. That residual window is exactly
this setting, so raising it lengthens how long a revoked share can still fetch
bytes. Lowering it costs a guest an extra API round trip per asset while a page
is open. Do not raise it to match the owner value.

### Guest share abuse budgets

Startrips has no application-wide API rate limiter; that blanket `/api/*`
bucket was removed deliberately because a limit belongs to an endpoint's own
cost and threat model. `/api/shared/*` is the one public, unauthenticated
surface the product exposes, so it carries its own budgets and nothing else in
the API is throttled by them.

`SHARE_RATE_LIMIT_WINDOW_SECONDS` (10-3600, default 60) is the fixed window all
three ceilings are measured over.

`SHARE_DATA_RATE_LIMIT` (>=10, default 60) and `SHARE_MEDIA_RATE_LIMIT` (>=30,
default 240) are counted **per share grant**, not per client address. A share
link is meant to be forwarded, so many addresses legitimately hold one
capability and charging them individually would throttle the feature's own
purpose. The two are separate budgets because one open Journey issues far more
media read-URLs than payload reads: at the default 90-second guest presign a
continuously displayed asset costs about 1.3 reads per minute, so 240 sustains
roughly 180 such assets or thirty full eight-asset playback prefetch bursts a
minute, while 60 data reads carries about fifteen simultaneous recipients of
one link.

`SHARE_UNKNOWN_TOKEN_RATE_LIMIT` (>=5, default 30) is the only budget counted
per client address, and it is charged only for a request whose token resolved
to nothing — an unknown, revoked, expired or absent token. A request that
reaches a live grant never spends it, and a `MEDIA_UNAVAILABLE` answer does not
either, because that is the owner having moved one photo rather than an attack.
It does not make a 256-bit token guessable or not; it caps what a flood costs,
including a batch sent all at once: the budget is reserved before the token is
looked up and released again when it turns out to name a live grant.

Raising a budget weakens abuse resistance. Lowering one below its floor is
refused at startup, because #200 is explicit that a limit which breaks a normal
image-heavy Journey during playback prefetch is the worse outcome.

## Google sign-in

Google is off unless this deployment names an OAuth client. `GOOGLE_CLIENT_ID`
and `GOOGLE_CLIENT_SECRET` are read together: set neither and the provider is
absent from the API entirely -- no sign-in button, no linkable provider, and
`/api/account-identities` advertises nothing -- set exactly one and the API
refuses to start, because a half-configured client is a mistake rather than a
disabled feature. There is no development fallback and no mock: a deployment
without credentials degrades by not offering the entry point.

**Approved origins and redirect URIs.** The OAuth client needs `APP_ORIGIN` as
its authorized JavaScript origin and **two** authorized redirect URIs, because
sign-in and explicit binding are different flows that return to different
handlers:

| Flow | Redirect URI |
| --- | --- |
| Sign in / sign up | `<APP_ORIGIN>/api/auth/callback/google` |
| Bind to an existing Account | `<APP_ORIGIN>/api/account-identities/providers/google/callback` |

Register one client per environment rather than sharing one across them, so a
test origin can never complete a production sign-in:

| Environment | `APP_ORIGIN` |
| --- | --- |
| Local development | `http://127.0.0.1:5173` |
| Test / staging | the staging HTTPS origin, e.g. `https://staging.<your-domain>` |
| Production | the production HTTPS origin, e.g. `https://<your-domain>` |

`APP_ORIGIN` must be HTTPS outside development; `config.ts` refuses a non-HTTPS
origin in production. Requested scopes are the adapter's defaults -- `openid`,
`email`, `profile` -- and nothing widens them. Startrips never requests Drive,
Photos or any other Google API scope.

**Outbound network.** Completing a callback needs the API container to reach
`https://oauth2.googleapis.com/token` (the code exchange) **and**
`https://www.googleapis.com/oauth2/v3/certs` (Google's signing keys). The ID
token's issuer, audience and signature are checked against that key document
before Startrips believes the identity, so an egress policy that blocks it does
not weaken the check -- it fails every Google sign-in closed. Allow both hosts
wherever egress is filtered.

**Injecting the secret.** `GOOGLE_CLIENT_SECRET` is a deployment secret on the
same footing as `BETTER_AUTH_SECRET`: put it in the `.env` file the Compose
stack reads (or your orchestrator's secret store) and nowhere else. It is read
only by the API container, never reaches the browser bundle, and must not be
written into the repository, an issue, a PR, or a CI artifact. Rotating it is a
value replacement plus an API restart; old sessions survive, because a Startrips
session is not a Google token.

**Turning it off.** Unset both variables and restart the API. Existing Google
account rows stay, and anyone who has only that method keeps their Account but
cannot sign in with it until the provider is configured again -- so give people
a password first if you intend the removal to be permanent. Nothing is deleted
by disabling the provider.

**What is not verified by CI.** Every callback family is covered in CI against a
fake OAuth transport. A real login, bind and re-login against an authorized
Google test client is an external gate performed with real credentials before
release; CI passing is not evidence that a real client is connected.

## Access log redaction

Caddy's access log records `request>uri`, which is the path plus the query
string, and some of those URIs carry a live credential: a password reset link
puts its token in a path segment (`/api/auth/reset-password/<token>`), while
email verification and the SPA reset callback pass it as `?token=`. Both would
otherwise be written to the container log and persisted by the `json-file`
driver, so the `log` directive filters `request>uri` before encoding: the
segment after `reset-password/`, `/share/` and `/api/shared/` and the values of
the `token` and `callbackURL` query keys are replaced with `REDACTED`.

The filter is a single `regexp` entry by design. Caddy keys log field filters
by field name, so adding a second filter on `request>uri` silently replaces the
first one rather than chaining onto it. Extend the existing pattern instead of
adding another `request>uri` line, and re-check it with
`caddy validate --config deploy/Caddyfile --adapter caddyfile` (with `APP_HOST`
set) after any change. The API logs the matched route pattern rather than the
request path, so the same tokens never reach the API container log either.

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

From a trusted workstation with `git`, authenticated `gh`, Python `paramiko`, and the server PEM key, run one command:

```powershell
python scripts/deploy-main.py --key "D:\path\to\server-key.pem"
```

The script switches to and fast-forwards `main`, waits for that exact commit's GitHub Actions run to pass, uploads a `git archive`, backs up PostgreSQL, tags the running API/Web images for rollback, builds the new release, applies migrations, recreates API/Web, and verifies container state plus public HTTPS. It holds a server-side deployment lock, verifies any automatic application rollback, requires 5 GiB of free disk, and retains the five newest script-managed releases, backups, and rollback tags. The PEM contents and production `.env.deploy` are never copied into Git.

The default server's SSH host keys are pinned in the script. A different `--server` must also pass one or more trusted `--host-key-sha256` fingerprints. The CI wait defaults to 25 minutes and the remote deployment deadline to one hour; both are configurable command-line options. Server-local HTTPS checks are the activation gate; a workstation public-path failure is reported as a warning because a local network problem must not roll back an otherwise healthy server.

Inspect preview mail only through an SSH tunnel or a server-local API request. Do not publish port 8025.

Location search is selected through `LOCATION_SEARCH_DRIVER`. The preview defaults
to the low-volume public Photon demo because it is reachable from the current host;
`nominatim` and `disabled` remain available without changing client code. A public
demo has no availability guarantee, so production should use a contracted endpoint
or a self-hosted compatible service.

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

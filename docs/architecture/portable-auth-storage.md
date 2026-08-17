# Portable authentication, tenancy, storage, and location search

The Living Atlas core is designed to run behind one public origin on infrastructure chosen at deployment time. No Cloudflare, Tencent Cloud, Alibaba Cloud, AWS, or other vendor is a domain dependency.

## Trust boundary

- Better Auth owns verified email/password identities, sessions, password reset, invitations, and Organization membership.
- One Organization owns one private Atlas and may have at most two members.
- Every Journey, upload, and private-media read first derives the active Organization and Atlas from the authenticated server session. Browser-supplied atlas or organization IDs are not accepted as ownership evidence.
- Application tables reference the application-owned Atlas. They do not add foreign keys into Better Auth's changing schema.

## Journey persistence

A Journey owns its date range, story, light color, media, and exactly one ordered Route. Route Points are replaced with Journey metadata in one database transaction, and database `sortOrder` is derived from browser array order.

PostgreSQL is the only database contract. A managed PostgreSQL service from any provider or a self-hosted service is acceptable. TLS certificate verification is enabled by default; private certificate authorities can be supplied with `DATABASE_SSL_CA_BASE64`.

## Object storage adapter

`server/storage/multipart-storage.ts` defines the required multipart and private-read operations. `server/storage/storage-registry.ts` currently registers only the `disabled` driver.

A production adapter must implement:

1. create multipart upload;
2. sign upload parts;
3. complete and abort multipart upload;
4. inspect an object for ambiguous-completion reconciliation;
5. create a short-lived private read URL.

Set `STORAGE_DRIVER` only after that adapter is installed and registered. Candidate services include Tencent COS, Alibaba OSS, Cloudflare R2, AWS S3, MinIO, or another service that satisfies the same contract. The API does not buffer complete media files; the browser uploads Blob slices directly to object storage. The composer processes one file at a time with two concurrent part workers.

With `STORAGE_DRIVER=disabled`, Journey and Route persistence still works. Media upload returns a structured `STORAGE_UNAVAILABLE` response, and the UI reports partial success without deleting the Journey.

## Location-search adapter

`server/location/location-search.ts` defines a small query-to-coordinate contract. `server/location/disabled-location-search.ts` currently supplies the only installed implementation.

A concrete adapter should return stable result IDs, a display label and context, an ISO country code, latitude, and longitude. It must honor the provided abort signal and server result limit. Provider credentials stay in server environment variables and must never be sent to the browser.

Set `LOCATION_SEARCH_DRIVER` only after the adapter is installed in `createLocationSearch`. Possible providers include a Tencent, Alibaba, Google, Mapbox, HERE, or self-hosted geocoding service; the product contract does not prefer one.

With `LOCATION_SEARCH_DRIVER=disabled`, the authenticated endpoint returns `503 LOCATION_SEARCH_UNAVAILABLE`. Manual coordinates and globe-surface picking remain fully usable, and the UI does not substitute fake search results.

## Deployment shape

- Serve the Vite application and reverse-proxy `/api` through the same HTTPS origin so session cookies stay first-party.
- Supply PostgreSQL, SMTP, Better Auth secret, and the selected adapter credentials through environment variables.
- Apply the checked-in Drizzle migrations through the deployment pipeline, not from a browser process.
- Better Auth's database-backed limiter protects authentication endpoints. The API additionally rate limits requests without a session cookie per client IP (`ANON_RATE_LIMIT_WINDOW_SECONDS`, `ANON_RATE_LIMIT_MAX_REQUESTS`); authenticated requests are never limited by the API. Edge-level enforcement can still be added for non-API traffic.
- Keep stored objects private. Only the tenant-authorized read-url endpoint may mint short-lived media access.

The checked-in defaults keep storage and location search disabled so a missing deployment choice is visible instead of silently coupling the product to a provider.

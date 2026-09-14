# Startrips

[中文说明](README.zh-CN.md)

Startrips is a private living atlas for turning a real journey into an ordered geographic route, story, and media collection. A Journey can cross cities, span a flight or sailing passage, remain continuously in transit, or stay in one place.

## Current capabilities

- Email/password accounts with verified email, password reset, revocable sessions, and database-backed rate limiting.
- One private atlas per Organization, a two-member limit, and server-derived tenant isolation.
- Route-first Journey creation with one to 64 ordered coordinates, optional named Stops, dates, story, color, and up to twelve photos or videos.
- Route input by globe click or manual coordinates; provider-neutral location search can be enabled by a deployment adapter.
- Private multipart media uploads with bounded concurrency, progress, cancellation, and failed-file-only retry.
- A chronological timeline, lazy signed-media reads, and a single low-memory Three.js globe with bounded spherical route geometry.
- Expiring read-only guest share links for one or several Journeys, with scoped Story and Journey Playback viewing plus owner-side revoke controls.
- Journey Playback with deterministic transport/timing and a Story return contract that preserves the last successfully presented Route Point/media observation.
- Mobile Viewer mode keeps Story media, immersive viewing, Journey switching, and Playback reachable through the shared compact-layout contract without exposing edit authority to guests. Mobile Story and Share now use one top-level surface owner, so Escape/Back, pending share mutations, rapid reopen, and Story→Share replacement cannot leave stacked or ghost surfaces.
- Home Base foundations cover dated periods, deterministic suggestion evidence, quiet Atlas presence, persisted confirmation/dismissal, and owner-private on-demand period context opened from the visible Home anchor; eligible historical Home can also frame owner Journey Playback as a private Prelude/Epilogue.
- Development-only deterministic `qaState` routes for visual regression work; they are not the authenticated product path.

## Architecture

The application is deliberately provider-neutral:

- PostgreSQL and Drizzle own account, atlas, Journey, route, upload, and media metadata.
- Better Auth owns authentication and Organization membership.
- Object storage is behind a multipart-storage interface.
- Location search is behind a provider-neutral search interface.
- The browser and API should share one public origin so secure session cookies remain first-party.

Cloudflare, Tencent Cloud, Alibaba Cloud, AWS, or self-hosted services can be selected at deployment time without changing the Journey domain model. See [portable auth and storage](docs/architecture/portable-auth-storage.md).

## Development

Requirements: Node.js 22, pnpm 10.17.1, and PostgreSQL 17.

```powershell
pnpm install --frozen-lockfile
Copy-Item .env.example .env
pnpm db:migrate
pnpm dev:api
pnpm dev
```

Configure the database, authentication secret, mail delivery, and public origin before starting. `STORAGE_DRIVER=disabled` and `LOCATION_SEARCH_DRIVER=disabled` are truthful fallback states: route entry still works by globe click/manual coordinates, while media persistence and location search remain unavailable until adapters are installed.

## Verification

GitHub Actions provisions an isolated PostgreSQL service and runs:

```text
generated auth schema check -> migrations -> TypeScript -> tests -> production build
```

Local low-memory work can use `pnpm typecheck` without starting the Three.js preview. Runtime visual comparison should use the documented deterministic QA states and a controlled browser session.

## License

[MIT](LICENSE)

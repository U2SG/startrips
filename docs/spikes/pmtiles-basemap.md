# Spike: optional self-hosted PMTiles basemap

Status: spike, not for merge. Discussion #539, section 4. The code has not been
checked against a real PMTiles archive. Only the pure style and label functions
have unit tests.

## Why

`server/routes/mapstyle.ts` and `server/services/map-style-cache.ts` proxy
OpenFreeMap styles, planet tiles, fonts, sprites and Natural Earth through the
app origin, with a disk cache under `/tmp`. The proxy and its path allowlist
have needed about ten fixes since 2026-08-18. A single PMTiles archive on storage
the deployment owns, read with HTTP Range requests, would remove the proxy
entirely. The browser would still never see a third-party map-provider URL.

## What the spike adds

- `VITE_ATLAS_PMTILES_URL` (`ATLAS_PMTILES_URL` in `.env.deploy`): the archive
  URL. It can be a same-origin path (`/basemap/region.pmtiles`) or the
  deployment's own object storage. It must be a URL the deployment owns. Do not
  point it at a public demo bucket or a third-party CDN.
- `VITE_ATLAS_PMTILES_GLYPHS_URL`: the glyph template. The default is
  `/basemap/fonts/{fontstack}/{range}.pbf` on the app origin.
- `VITE_ATLAS_MAP_STYLE_URL` still takes precedence. With both variables unset,
  behavior is unchanged: the proxied Fiord style.
- `src/scene/pmtilesProtocol.ts`: registers `pmtiles://` with MapLibre once per
  page, and only when a PMTiles basemap is configured. The `pmtiles` package
  (about 380 KB unpacked with `fflate`) goes into the lazily loaded
  `DetailedEarthMap` chunk, not the entry bundle.
- `src/scene/pmtilesBasemapStyle.ts`: a small hand-written dark style (earth,
  landcover, water, roads, boundaries, place labels). It uses no sprite.
- `createDetailedEarthLabelExpression(language, schema)`: Protomaps labels
  resolve `name:zh-Hans`, then `name:zh-Hant`, then `name`, then `name:en`. The
  OpenMapTiles coalesce is unchanged. `pgf:name*` is not read, because those
  fields are pre-shaped Devanagari glyph indices that need a custom font stack.

### Why a hand style and not `@protomaps/basemaps`

`@protomaps/basemaps` (5.x, about 440 KB unpacked) generates about 80 layers per
flavor and expects its own sprite and font stacks. Its look also differs from the
Fiord style that the dive handoff and `design-qa.md` were tuned against. The
detail view only needs a quiet backdrop for the handoff and labels, so about eight
layers are enough. If the product later wants full cartography, generate the
style with `@protomaps/basemaps` at build time and commit the JSON rather than
shipping the generator.

## What the owner must provide

1. **An archive.** Extract a region or the planet from a Protomaps daily build:
   `pmtiles extract https://build.protomaps.com/<date>.pmtiles region.pmtiles --bbox=<w,s,e,n> --maxzoom=15`.
   Run this once, on the owner's machine. The browser never reads that URL.
   Approximate sizes: planet about 120 GB (z15), China about 8–10 GB, a
   single-city bbox tens to hundreds of MB. The map's `maxZoom` is 16 and z15
   overzooms. Record the build date for attribution and refresh.
2. **Object storage or static hosting** for the archive, with:
   - `Accept-Ranges: bytes` and correct `206 Partial Content` responses.
   - CORS for `https://${APP_HOST}`: allow `GET` and `HEAD`, allow the `Range`
     request header, and expose `Content-Range`, `Content-Length` and `ETag`.
   - The same `ETag` for the whole life of the file. Upload a new build under a
     new file name, so a changed archive cannot mix headers from two builds.
3. **Glyphs.** The `Noto Sans Regular` PBF font stack (for example from
   `protomaps/basemaps-assets`), copied to the glyph path. CJK labels are drawn
   by MapLibre's local ideograph font, so only the Latin ranges are fetched in
   practice.
4. **Sprites.** None. The spike style has no icons.
5. **Same-origin serving, if used.** `deploy/Caddyfile` has no `/basemap/*`
   route today. The catch-all `try_files {path} /index.html` would answer a
   missing archive or glyph with index.html and a 200, which shows up as a
   parse error, not a 404. Add a `handle /basemap/*` block with `root` on a
   mounted volume and `file_server` (Caddy serves Range requests there) before
   the catch-all. The Caddyfile sets no Content-Security-Policy today. If one is
   added later, the archive and glyph origins must be in `connect-src`.

## Code that would be deleted if adopted

- `server/services/map-style-cache.ts` and the `startMapStyleCacheSweeper()`
  reconciler in `server/index.ts`.
- `server/routes/mapstyle.ts`, its mount in `server/app.ts`, and
  `server/routes/mapstyle.test.ts` and `server/routes/mapstyle-http.test.ts`.
- `DEFAULT_DETAILED_EARTH_STYLE_URL`, the OpenMapTiles label schema, and the
  `/api/mapstyle` references in `server/app-global-rate-limit.test.ts` and
  the `scripts/qa-*.mjs` browser checks.

## Risks

- **Range request cost.** Every tile is a Range GET, plus directory fetches the
  first time a region is opened. Object storage bills per request and per egress
  byte. A CDN in front of the bucket needs Range-aware caching.
- **Cache headers.** A long `Cache-Control` together with a stable `ETag` is
  required. If an archive is overwritten in place, cached directories go stale
  and tiles come back corrupt. Always use a new file name.
- **Cold start.** The first view reads the header and root directory before any
  tile loads. The detail map is revealed only after its tiles are ready, so a
  slow first fetch delays the dive handoff instead of showing a blank map.
  Measure this on the real host.
- **Labels.** Protomaps has no `name:zh` for many small places, so the label
  falls back to the local `name`. Check that coverage matches what the
  OpenFreeMap path shows. The local `name` is tried before `name:en` on
  purpose. This matches the existing OpenMapTiles path; Protomaps' own styles
  try English first.
- **Look.** The hand style is not Fiord. Screens tied to the Fiord colors need a
  design pass before adoption.

## Manual acceptance checklist (after an archive exists)

- [ ] `curl -I <app origin>/basemap/fonts/Noto%20Sans%20Regular/0-255.pbf`
      returns a protobuf, not index.html.
- [ ] `curl -I -H "Range: bytes=0-16383" <archive URL>` returns `206` with
      `Content-Range` and an `ETag`.
- [ ] A cross-origin fetch from `https://${APP_HOST}` with a `Range` header
      succeeds (no CORS error in the console).
- [ ] Build with `ATLAS_PMTILES_URL` set, with `ATLAS_MAP_STYLE_URL` empty.
- [ ] The dive from the particle globe to the detail map reveals tiles with no
      visible jump, and no request goes to `openfreemap.org` or any
      third-party map host.
- [ ] Chinese labels appear by default. The bilingual switch adds an English
      second line where `name:en` differs.
- [ ] Remounting the detail map (leave it and dive again) logs no
      duplicate-protocol error, and archive requests are reused.
- [ ] Record the first-view latency and the per-view request count, to compare
      with the proxy.
- [ ] Unsetting `ATLAS_PMTILES_URL` brings back the proxied Fiord style.

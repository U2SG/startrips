# Local 10m coastline chunks

This directory is generated from Natural Earth `ne_10m_land.geojson`. Natural Earth vector data is public domain.

The runtime does **not** parse or ship the global 10m GeoJSON. `scripts/preprocess-coastline-local.mjs` converts the upstream source into deterministic 2-degree chunk files and a bounded manifest. The raw upstream file is intentionally not committed. Exact duplicate/reversed source segments are removed during preprocessing so adjacent chunks do not double-brighten shared coastline geometry.

Regenerate from an explicitly downloaded Natural Earth 10m land GeoJSON:

```sh
node scripts/preprocess-coastline-local.mjs /path/to/ne_10m_land.geojson public/earth/coastline-10m
```

Current representative coverage is deliberately regional rather than global:

- Hong Kong / Pearl River Delta: 110E..118E, 18N..26N
- Japan: 132E..146E, 30N..46N
- Mediterranean: 10E..30E, 34N..46N
- Norway fjords: 4E..14E, 56N..70N

The manifest records the named coverage regions, source scale/license, deterministic chunk bounds, per-chunk segment count and preprocessing chunk limit. Runtime selection still loads at most the existing 3x3 neighborhood and keeps the bounded LRU cache; outside these regions the 50m regional foundation remains authoritative.

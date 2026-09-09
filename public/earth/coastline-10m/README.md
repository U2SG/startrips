# Local 10m coastline chunks

This directory is generated from Natural Earth `ne_10m_land.geojson` for the first Startrips local-coastline coverage slice (Hong Kong / Pearl River Delta). Natural Earth vector data is public domain.

The runtime does **not** parse or ship the global 10m GeoJSON. `scripts/preprocess-coastline-local.mjs` converts the upstream source into deterministic 2-degree chunk files and a bounded manifest. The raw upstream file is intentionally not committed.

Regenerate from an explicitly downloaded Natural Earth 10m land GeoJSON:

```sh
node scripts/preprocess-coastline-local.mjs /path/to/ne_10m_land.geojson public/earth/coastline-10m
```

Current coverage: 110E..118E, 18N..26N. The manifest records source scale, license, bounds, per-chunk segment count and the preprocessing chunk limit.

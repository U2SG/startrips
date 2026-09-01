# Terrain relief experiment (#82)

## Decision so far

Proceed with **shaded-relief bump illusion as the first experiment**, not production terrain displacement.

The prototype is intentionally opt-in with `?terrainRelief=1`. Without that query parameter, Startrips renders exactly the existing globe path and does not fetch the relief texture.

The experiment reuses the existing 2048x1024 grayscale `natural-earth-shaded-relief-2048.jpg` only as a `MeshPhongMaterial.bumpMap`. It is never exposed as a visible map texture, so no satellite/terrain-map colors are introduced and the particle Earth remains the primary renderer.

## Zoom contract

| View | Representative zoom | High-quality relief strength | Target opacity | Bump scale |
| --- | ---: | ---: | ---: | ---: |
| Global | 1.0 | < 0.05 | ~0.006 | ~0.001 |
| Regional | 2.0 | progressive | progressive | progressive |
| Near | 2.8 | near maximum | <= 0.058 | <= 0.0055 |

Low-quality mode halves the structural relief strength. `surfaceEarth` mode suppresses the experimental relief layer entirely so the experiment cannot accidentally compound the existing photographic surface path.

## Performance budget

The source JPEG is about 200 KiB on disk. Decoded as an RGBA 2048x1024 GPU texture it is approximately 8 MiB before driver-specific mipmap/storage overhead. The experiment adds one material + one sphere draw and reuses the existing sphere geometry; there is no terrain tessellation, tile engine, network map SDK, or vertex displacement.

Before enabling this by default, capture representative mobile measurements for:

- idle rotation frame time;
- pinch/drag frame time;
- first globe render with and without `?terrainRelief=1`;
- decoded texture/GPU memory;
- global/regional/near screenshots at the same geographic center.

## Visual acceptance matrix

Use the same center and compare relief OFF vs ON at three zooms:

1. **Global:** the ON capture should be hard to distinguish at a glance; particles remain dominant.
2. **Regional:** mountain/landform structure may be perceived, but no conventional terrain map should become readable.
3. **Near:** terrain structure should be legible enough to ground geography while routes, memory points, cities, coastlines, and particles remain optically above it.

Reject the experiment if any zoom resembles a renderer handoff, if grayscale relief becomes a readable map surface, or if touch/rotation responsiveness measurably regresses.

## Recommendation boundary

This PR establishes the lowest-risk A/B harness and zoom semantics. It does **not** recommend particle displacement yet. Only consider normal-map or particle-carried elevation after the shaded-relief experiment has same-center visual captures and representative mobile performance evidence showing that the extra depth is worth the cost.

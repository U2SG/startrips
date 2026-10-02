# Country access defaults

The stock OSRM walking and cycling profiles omit `trunk` and `trunk_link`
without explicit access tags. These wrappers add their normal speeds only
inside a country polygon whose corresponding `startrips_*_trunk` property is
`yes`. Each way uses a separate, immutable profile variant. Unlisted countries
retain stock behavior; a permitted country never changes another country's
profile. Existing access, motorroad, sidewalk/cycleway, barrier and directional
handlers still run. Motorways receive no new default.

`country-access.geojson` currently contains New Zealand's reviewed defaults.
This is a country rule, not a Journey or city exception. Public-road walking
and cycling are allowed subject to road-specific restrictions; consult
[NZTA pedestrian guidance](https://nzta.govt.nz/assets/Walking-Cycling-and-Public-Transport/docs/pedestrian-network-guidance/docs/1-Walking-in-NZ-Feb-2025.pdf)
and [NZTA cycling guidance](https://www.nzta.govt.nz/roadcode/code-for-cycling/paths-cycle-lanes-and-bus-lanes/).
Add another country only after verifying its access defaults and boundary.
This file supplements a clipped road extract; it does not download more roads.

The geometry is unchanged from the New Zealand `ISO_A3=NZL` feature in
[Natural Earth 10m countries](https://github.com/nvkelso/natural-earth-vector/blob/ca96624a56bd078437bca8184e78163e5039ad19/geojson/ne_10m_admin_0_countries.geojson),
commit `ca96624a56bd078437bca8184e78163e5039ad19`, original file SHA-256
`239eec57ac17f100a11e2536cffc56752c318b50ae765b0918ff7aab4ce8f255`.
Natural Earth data is [public domain](https://www.naturalearthdata.com/about/terms-of-use/).

Use the matching pinned OSRM v26.9.0 runtime and its stock `/opt` profiles:

```sh
osrm-extract --threads 2 -p /profiles/walking.lua \
  --location-dependent-data=/profiles/country-access.geojson /data/journey.osm.pbf
osrm-partition --threads 2 /data/journey.osrm
osrm-customize --threads 2 /data/journey.osrm
```

Use `cycling.lua` for the cycling graph. Regenerate and verify each graph before
activating it; changing the Lua files alone does not change a running graph.
Preserve the prior immutable dataset for rollback. Record the input, profile,
country-data and runtime hashes in the generated dataset's build evidence.

`pnpm qa:route-candidates` starts with actual pinned OSRM extraction and routing
on an anonymous miniature network. It verifies permitted trunk roads, unlisted
regions, explicit prohibitions, motorroads, motorways, separately mapped paths,
and directional access before the UI checks. Run code QA in GitHub CI.

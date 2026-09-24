# Spike: Journey-context bias for place search

Status: spike, not for merge yet. Discussion: #539, section 1.

## What changed

- `LocationSearchOptions` gains an optional `focus: { latitude, longitude }`.
  Only those two numbers reach a provider; no Journey, Atlas or member
  identifier does. Adapters round the focus to 2 decimals (about 1 km) before
  sending it and before keying the cache.
- Photon sends `lat`/`lon` (its location bias) on both the primary and the
  English round trip. Nominatim sends a `viewbox` of +/-0.5 degrees around the
  focus with `bounded=0`, so the box is a preference, never a filter.
- Both 24h caches key on the rounded focus, so a biased answer is never served
  to an unbiased search or to a different Journey context.
- `GET /api/locations/search` accepts optional `lat` and `lon`. Both or
  neither; a half-given, non-numeric or out-of-range focus is answered with
  `400 { error: "INVALID_LOCATION_FOCUS", message }` through `app.onError`.
- The Journey composer sends the last Route Point of the draft as the focus.
  The last point, not the centroid: a Route through Beijing and Shanghai has
  its centroid in neither city. Itinerary import sends no focus yet.
- `LOCATION_SEARCH_DRIVER=disabled` is unchanged: it ignores the focus and
  still reports search as unavailable.
- Out of scope: `bounds`, Startrips-side re-ranking, any new provider.

## Evaluation set

Each row is one search the owner runs twice against a real Photon endpoint:
once without a focus (baseline) and once with the Journey context as
`lat`/`lon`. Journey context coordinates are city centres, standing in for the
last Route Point of a Journey in that city. The target is the place a member
with that Journey means. Rows marked "control" check that the bias does not
hide a far-away place the member plainly asked for.

| # | Query | Journey context (lat, lon) | Target |
| --- | --- | --- | --- |
| 1 | 故宫 | Beijing (39.90, 116.41) | 故宫博物院, Beijing |
| 2 | 故宫 | Taipei (25.03, 121.56) | 国立故宫博物院, Taipei |
| 3 | 故宫 | Hong Kong (22.32, 114.17) | 香港故宫文化博物馆, West Kowloon |
| 4 | 迪士尼 | Shanghai (31.23, 121.47) | 上海迪士尼度假区, Pudong |
| 5 | 迪士尼 | Tokyo (35.68, 139.69) | 东京迪士尼度假区, Urayasu |
| 6 | 迪士尼 | Hong Kong (22.32, 114.17) | 香港迪士尼乐园, Lantau |
| 7 | 中央公园 | New York (40.71, -74.01) | Central Park, Manhattan |
| 8 | 天后站 | Hong Kong (22.32, 114.17) | MTR Tin Hau station |
| 9 | 中山公园 | Shanghai (31.23, 121.47) | 中山公园, Changning |
| 10 | 中山公园 | Beijing (39.90, 116.41) | 中山公园, west of Tiananmen |
| 11 | 西湖 | Hangzhou (30.27, 120.16) | 西湖, Hangzhou |
| 12 | 西湖 | Fuzhou (26.07, 119.30) | 西湖公园, Fuzhou |
| 13 | 中央车站 | New York (40.71, -74.01) | Grand Central Terminal |
| 14 | 中央车站 | Amsterdam (52.37, 4.90) | Amsterdam Centraal |
| 15 | 唐人街 | San Francisco (37.77, -122.42) | Chinatown, San Francisco |
| 16 | 唐人街 | London (51.51, -0.13) | Chinatown, Soho |
| 17 | 国家博物馆 | Beijing (39.90, 116.41) | 中国国家博物馆 |
| 18 | 国家博物馆 | Singapore (1.29, 103.85) | National Museum of Singapore |
| 19 | 人民广场 | Shanghai (31.23, 121.47) | 人民广场, Huangpu |
| 20 | 人民公园 | Chengdu (30.66, 104.07) | 人民公园, Qingyang |
| 21 | 外滩 | Shanghai (31.23, 121.47) | The Bund |
| 22 | 维多利亚港 | Hong Kong (22.32, 114.17) | Victoria Harbour |
| 23 | 浅草寺 | Tokyo (35.68, 139.69) | Senso-ji, Asakusa |
| 24 | 清水寺 | Kyoto (35.01, 135.77) | Kiyomizu-dera |
| 25 | 鸭川 | Kyoto (35.01, 135.77) | Kamo River |
| 26 | 羽田机场 | Tokyo (35.68, 139.69) | Haneda Airport |
| 27 | 夫子庙 | Nanjing (32.06, 118.80) | 夫子庙, Qinhuai |
| 28 | 大本钟 | London (51.51, -0.13) | Big Ben / Elizabeth Tower |
| 29 | 圣家堂 | Barcelona (41.39, 2.17) | Sagrada Familia |
| 30 | 埃菲尔铁塔 | Beijing (39.90, 116.41) | Eiffel Tower, Paris (control) |
| 31 | 自由女神像 | Shanghai (31.23, 121.47) | Statue of Liberty, New York (control) |
| 32 | 天坛 | Tokyo (35.68, 139.69) | 天坛, Beijing (control) |

## How to score

1. Point a deployment at the Photon endpoint under evaluation
   (`LOCATION_SEARCH_DRIVER=photon`) and sign in as a member of any Atlas.
2. For each row call `GET /api/locations/search?q=<query>` and
   `GET /api/locations/search?q=<query>&lat=<lat>&lon=<lon>`. Keep to the
   adapter's one request per second; the server already queues, so a plain
   sequential loop is enough.
3. On the first run, record the reference coordinate of each target by hand.
   A result is a hit when its label names the target (any of `label`,
   `labelEnglish`, `labelLocal`) and it lies within 2 km of the reference
   (5 km for areas such as 西湖, 外滩, 维多利亚港, 鸭川).
4. Report per run: top-1 hit rate and top-3 hit rate over rows 1-29, and
   separately whether each control row (30-32) still has its target in the
   top 3.

Suggested acceptance for Photon + bias: top-3 hit rate of at least 90% on
rows 1-29, a clear top-1 gain over the unbiased baseline on the ambiguous
pairs (1-6, 9-18), and all three controls kept in the top 3.

No results are recorded here yet; the set is for the owner to run against a
real endpoint.

## Next steps

- If Photon + bias meets the bar: drop the "spike" label, decide whether the
  itinerary import should send the first confirmed Route Point as its focus,
  and whether `bounds` is worth adding.
- If it fails the set: add a Pelias adapter behind the same `LocationSearch`
  port (Pelias has `focus.point.lat/lon` and Chinese-aware analysis) and rerun
  the same set. Only a failed Photon run justifies that operational cost.
- Later: evaluate Overture Places as a POI source for self-hosted search.

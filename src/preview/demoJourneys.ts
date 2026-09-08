import type { Journey, JourneyMediaAsset, RoutePoint } from "../journey/types";

// Synthetic preview content with existing local artwork. Motion-reference
// clips stay available as QA fixtures but never appear as travel memories.
const DEMO_ATLAS_ID = "a0000000-0000-4000-8000-000000000001";
const DEMO_USER_ID = "a0000000-0000-4000-8000-000000000002";

const EAST_ASIA_ID = "a1000000-0000-4000-8000-000000000001";
const EUROPE_ID = "a1000000-0000-4000-8000-000000000002";
const ICELAND_ID = "a1000000-0000-4000-8000-000000000003";

const EAST_ASIA_POINTS = {
  busan: "b1000000-0000-4000-8000-000000000001",
  fukuoka: "b1000000-0000-4000-8000-000000000002",
} as const;

const EUROPE_POINTS = {
  lisbon: "b2000000-0000-4000-8000-000000000001",
  arles: "b2000000-0000-4000-8000-000000000002",
  venice: "b2000000-0000-4000-8000-000000000003",
} as const;

const ICELAND_POINTS = {
  reykjavik: "b3000000-0000-4000-8000-000000000001",
  vik: "b3000000-0000-4000-8000-000000000002",
  hofn: "b3000000-0000-4000-8000-000000000003",
} as const;

const MEDIA_IDS = {
  eastWave: "c1000000-0000-4000-8000-000000000001",
  eastScroll: "c1000000-0000-4000-8000-000000000002",
  eastDancer: "c1000000-0000-4000-8000-000000000003",
  eastAkbarnama: "c1000000-0000-4000-8000-000000000004",
  eastLacquerBox: "c1000000-0000-4000-8000-000000000005",
  eastWalkman: "c1000000-0000-4000-8000-000000000006",
  europeLilies: "c2000000-0000-4000-8000-000000000001",
  europeHand: "c2000000-0000-4000-8000-000000000002",
  europeAmphora: "c2000000-0000-4000-8000-000000000003",
  icelandHands: "c3000000-0000-4000-8000-000000000001",
  icelandVessel: "c3000000-0000-4000-8000-000000000002",
  icelandPoster: "c3000000-0000-4000-8000-000000000003",
} as const;

function createRoutePoint(
  journeyId: string,
  id: string,
  sortOrder: number,
  latitude: number,
  longitude: number,
  label: string,
  occurredAt: string,
  note: string,
): RoutePoint {
  return {
    id,
    journeyId,
    sortOrder,
    latitude,
    longitude,
    label,
    isStop: true,
    occurredAt,
    note,
    createdAt: occurredAt,
  };
}

function createImage(
  journeyId: string,
  id: string,
  routePointId: string | null,
  sortOrder: number,
  fileName: string,
  bytes: number,
  createdAt: string,
): JourneyMediaAsset {
  return {
    id,
    journeyId,
    routePointId,
    storageDriver: "demo",
    storageKey: `demo/${fileName}`,
    fileName,
    mimeType: "image/jpeg",
    bytes,
    sortOrder,
    uploadedByUserId: DEMO_USER_ID,
    createdAt,
  };
}

const eastAsiaPoints: RoutePoint[] = [
  createRoutePoint(
    EAST_ASIA_ID,
    EAST_ASIA_POINTS.busan,
    0,
    35.1796,
    129.0756,
    "釜山港边",
    "2024-11-08T09:00:00.000Z",
    "潮声贴着防波堤走，天色还留着一点蓝。",
  ),
  createRoutePoint(
    EAST_ASIA_ID,
    EAST_ASIA_POINTS.fukuoka,
    1,
    33.5904,
    130.4017,
    "福冈海风",
    "2024-11-11T09:00:00.000Z",
    "小巷尽头有热茶，风把云吹得很慢。",
  ),
];

const europePoints: RoutePoint[] = [
  createRoutePoint(
    EUROPE_ID,
    EUROPE_POINTS.lisbon,
    0,
    38.7223,
    -9.1393,
    "里斯本旧坡",
    "2025-05-18T09:00:00.000Z",
    "雨后的坡道泛着暖色，电车从窗边轻轻经过。",
  ),
  createRoutePoint(
    EUROPE_ID,
    EUROPE_POINTS.arles,
    1,
    43.6766,
    4.6278,
    "阿尔勒河岸",
    "2025-05-22T09:00:00.000Z",
    "河水把云影拉长，午后的脚步没有催促。",
  ),
  createRoutePoint(
    EUROPE_ID,
    EUROPE_POINTS.venice,
    2,
    45.4408,
    12.3155,
    "威尼斯水巷",
    "2025-05-27T09:00:00.000Z",
    "水巷在黄昏里转弯，灯火一盏一盏亮起来。",
  ),
];

const icelandPoints: RoutePoint[] = [
  createRoutePoint(
    ICELAND_ID,
    ICELAND_POINTS.reykjavik,
    0,
    64.1466,
    -21.9426,
    "雷克雅未克天台",
    "2026-02-04T09:00:00.000Z",
    "屋顶的风很清澈，远处的海面接住微亮的天。",
  ),
  createRoutePoint(
    ICELAND_ID,
    ICELAND_POINTS.vik,
    1,
    63.4186,
    -19.0060,
    "维克黑沙滩",
    "2026-02-08T09:00:00.000Z",
    "黑沙向海铺开，浪花在天边留下一线白。",
  ),
  createRoutePoint(
    ICELAND_ID,
    ICELAND_POINTS.hofn,
    2,
    64.2539,
    -15.2082,
    "霍芬冰湾",
    "2026-02-12T09:00:00.000Z",
    "冰面慢慢转动，风把远处的光带到脚边。",
  ),
];

const eastAsiaMedia: JourneyMediaAsset[] = [
  createImage(
    EAST_ASIA_ID,
    MEDIA_IDS.eastWave,
    EAST_ASIA_POINTS.busan,
    0,
    "east-01-hokusai-wave.jpg",
    410933,
    "2024-11-08T09:05:00.000Z",
  ),
  createImage(
    EAST_ASIA_ID,
    MEDIA_IDS.eastAkbarnama,
    EAST_ASIA_POINTS.busan,
    1,
    "east-02-mughal-akbarnama.jpg",
    749079,
    "2024-11-08T09:06:00.000Z",
  ),
  createImage(
    EAST_ASIA_ID,
    MEDIA_IDS.eastLacquerBox,
    EAST_ASIA_POINTS.busan,
    2,
    "east-03-han-lacquer-box.jpg",
    37838,
    "2024-11-08T09:07:00.000Z",
  ),
  createImage(
    EAST_ASIA_ID,
    MEDIA_IDS.eastScroll,
    EAST_ASIA_POINTS.busan,
    3,
    "east-04-china-handscroll.jpg",
    842602,
    "2024-11-08T09:08:00.000Z",
  ),
  createImage(
    EAST_ASIA_ID,
    MEDIA_IDS.eastDancer,
    EAST_ASIA_POINTS.fukuoka,
    4,
    "east-05-han-dancer.jpg",
    236090,
    "2024-11-11T09:05:00.000Z",
  ),
  createImage(
    EAST_ASIA_ID,
    MEDIA_IDS.eastWalkman,
    null,
    5,
    "east-06-sony-walkman.jpg",
    47606,
    "2024-11-11T09:06:00.000Z",
  ),
];

const europeMedia: JourneyMediaAsset[] = [
  createImage(
    EUROPE_ID,
    MEDIA_IDS.europeLilies,
    EUROPE_POINTS.lisbon,
    0,
    "europe-01-monet-water-lilies.jpg",
    1802650,
    "2025-05-18T09:05:00.000Z",
  ),
  createImage(
    EUROPE_ID,
    MEDIA_IDS.europeHand,
    EUROPE_POINTS.arles,
    1,
    "europe-02-stieglitz-hand-of-man.jpg",
    251714,
    "2025-05-22T09:05:00.000Z",
  ),
  createImage(
    EUROPE_ID,
    MEDIA_IDS.europeAmphora,
    EUROPE_POINTS.venice,
    2,
    "europe-03-greek-amphora.jpg",
    298338,
    "2025-05-27T09:05:00.000Z",
  ),
];

const icelandMedia: JourneyMediaAsset[] = [
  createImage(
    ICELAND_ID,
    MEDIA_IDS.icelandHands,
    ICELAND_POINTS.reykjavik,
    0,
    "iceland-01-prehistoric-hands.jpg",
    570608,
    "2026-02-04T09:05:00.000Z",
  ),
  createImage(
    ICELAND_ID,
    MEDIA_IDS.icelandVessel,
    ICELAND_POINTS.vik,
    1,
    "iceland-02-eastern-zhou-hu.jpg",
    176675,
    "2026-02-08T09:05:00.000Z",
  ),
  createImage(
    ICELAND_ID,
    MEDIA_IDS.icelandPoster,
    ICELAND_POINTS.hofn,
    2,
    "iceland-03-woman-power-poster.jpg",
    294966,
    "2026-02-12T09:05:00.000Z",
  ),
];

export const demoJourneys: Journey[] = [
  {
    id: EAST_ASIA_ID,
    atlasId: DEMO_ATLAS_ID,
    title: "沿潮声向南",
    startedOn: "2024-11-08",
    endedOn: "2024-11-15",
    note: "港口的晚风走到清晨的石阶，给每一站留一点安静的光。",
    lightColor: "#77c8c2",
    lightEffect: "aurora",
    coverMediaAssetId: MEDIA_IDS.eastWave,
    revision: 1,
    createdByUserId: DEMO_USER_ID,
    createdAt: "2024-11-16T09:00:00.000Z",
    updatedAt: "2024-11-16T09:00:00.000Z",
    routePoints: eastAsiaPoints,
    media: eastAsiaMedia,
  },
  {
    id: EUROPE_ID,
    atlasId: DEMO_ATLAS_ID,
    title: "雨后从河岸出发",
    startedOn: "2025-05-18",
    endedOn: "2025-05-27",
    note: "雨停后沿着河岸慢慢走，城市的颜色在水面上重新排列。",
    lightColor: "#e99578",
    lightEffect: "sunset",
    coverMediaAssetId: MEDIA_IDS.europeLilies,
    revision: 1,
    createdByUserId: DEMO_USER_ID,
    createdAt: "2025-05-28T09:00:00.000Z",
    updatedAt: "2025-05-28T09:00:00.000Z",
    routePoints: europePoints,
    media: europeMedia,
  },
  {
    id: ICELAND_ID,
    atlasId: DEMO_ATLAS_ID,
    title: "风从黑沙滩来",
    startedOn: "2026-02-04",
    endedOn: "2026-02-12",
    note: "海风、火山和长长的黄昏，把脚步带向更远的天边。",
    lightColor: "#8ca8df",
    lightEffect: "nebula",
    coverMediaAssetId: MEDIA_IDS.icelandHands,
    revision: 1,
    createdByUserId: DEMO_USER_ID,
    createdAt: "2026-02-13T09:00:00.000Z",
    updatedAt: "2026-02-13T09:00:00.000Z",
    routePoints: icelandPoints,
    media: icelandMedia,
  },
];

export const demoMediaUrls: Record<string, string> = {
  [MEDIA_IDS.eastWave]: "/artworks/hokusai-wave.jpg",
  [MEDIA_IDS.eastAkbarnama]: "/artworks/mughal-akbarnama.jpg",
  [MEDIA_IDS.eastLacquerBox]: "/artworks/han-lacquer-box.jpg",
  [MEDIA_IDS.eastScroll]: "/artworks/china-handscroll.jpg",
  [MEDIA_IDS.eastDancer]: "/artworks/han-dancer.jpg",
  [MEDIA_IDS.eastWalkman]: "/artworks/sony-walkman-tps-l2.jpg",
  [MEDIA_IDS.europeLilies]: "/artworks/monet-water-lilies.jpg",
  [MEDIA_IDS.europeHand]: "/artworks/stieglitz-hand-of-man.jpg",
  [MEDIA_IDS.europeAmphora]: "/artworks/greek-amphora.jpg",
  [MEDIA_IDS.icelandHands]: "/artworks/prehistoric-hands.jpg",
  [MEDIA_IDS.icelandVessel]: "/artworks/eastern-zhou-hu.jpg",
  [MEDIA_IDS.icelandPoster]: "/artworks/woman-power-poster.jpg",
};

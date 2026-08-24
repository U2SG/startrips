import { latLonToVector3 } from "./geo";

export type CityPoint = {
  name: string;
  latitude: number;
  longitude: number;
  population: number;
  /** Administrative containment rank: 0 national capital, 1 first-level
   *  capital (province), 2 second-level capital (prefecture), 3 others. */
  rank: number;
  /** Precomputed unit direction on the globe-local sphere (radius 1). */
  direction: readonly [number, number, number];
};

// GeoNames' compact city export intentionally keeps only asciiname. Keep the
// visible China set localized locally so the particle globe does not regress
// to English while the detailed vector map uses its own provider labels.
const CHINESE_CITY_LABELS: Readonly<Record<string, string>> = {
  Shanghai: "上海",
  Beijing: "北京",
  Shenzhen: "深圳",
  Guangzhou: "广州",
  Chengdu: "成都",
  Tianjin: "天津",
  Wuhan: "武汉",
  Dongguan: "东莞",
  "Xi'an": "西安",
  "Xi’an": "西安",
  Nanjing: "南京",
  Hangzhou: "杭州",
  Foshan: "佛山",
  Chongqing: "重庆",
  Wuzhong: "吴忠",
  Puxi: "浦西",
  Pudong: "浦东",
  Qingdao: "青岛",
  Shenyang: "沈阳",
  Suzhou: "苏州",
  Xiamen: "厦门",
  Ningbo: "宁波",
  Fuzhou: "福州",
  Harbin: "哈尔滨",
  Hefei: "合肥",
  Dalian: "大连",
  "Bao'an": "宝安",
  Baoshan: "宝山",
  Minhang: "闵行",
  Songjiang: "松江",
  Jiading: "嘉定",
  Qingpu: "青浦",
  Putuo: "普陀",
  Yangpu: "杨浦",
  Jinan: "济南",
  Taiyuan: "太原",
  "Lüliang": "吕梁",
  Zhengzhou: "郑州",
  Shijiazhuang: "石家庄",
  Kunming: "昆明",
  Nanning: "南宁",
  Shantou: "汕头",
  Huizhou: "惠州",
  Haikou: "海口",
  Changsha: "长沙",
  Guiyang: "贵阳",
  Nanchang: "南昌",
  Lanzhou: "兰州",
  Urumqi: "乌鲁木齐",
  "Ürümqi": "乌鲁木齐",
  Hohhot: "呼和浩特",
  Xining: "西宁",
  Yinchuan: "银川",
  Lhasa: "拉萨",
  Jilin: "吉林",
  Changchun: "长春",
  Daqing: "大庆",
  Qiqihar: "齐齐哈尔",
  Zibo: "淄博",
  Yantai: "烟台",
  Weifang: "潍坊",
  Linyi: "临沂",
  Tangshan: "唐山",
  Baoding: "保定",
  Cangzhou: "沧州",
  Handan: "邯郸",
  Langfang: "廊坊",
  Datong: "大同",
  Linfen: "临汾",
  Anshan: "鞍山",
  Fushun: "抚顺",
  Dandong: "丹东",
  Jinzhou: "锦州",
  Wuxi: "无锡",
  Changzhou: "常州",
  Nantong: "南通",
  Yangzhou: "扬州",
  Xuzhou: "徐州",
  Yancheng: "盐城",
  Jiaxing: "嘉兴",
  Shaoxing: "绍兴",
  Jinhua: "金华",
  Wenzhou: "温州",
  Zhuhai: "珠海",
  Zhongshan: "中山",
  Jiangmen: "江门",
  Jieyang: "揭阳",
  Zhanjiang: "湛江",
  Maoming: "茂名",
  Guilin: "桂林",
  Liuzhou: "柳州",
  Sanya: "三亚",
  Baotou: "包头",
  Ordos: "鄂尔多斯",
  Xingtai: "邢台",
  Xiangyang: "襄阳",
  Yichang: "宜昌",
  Luoyang: "洛阳",
  Kaifeng: "开封",
  Zhuzhou: "株洲",
  Xiangtan: "湘潭",
  Yuxi: "玉溪",
  Qujing: "曲靖",
  Dali: "大理",
  Mianyang: "绵阳",
  Leshan: "乐山",
  Xianyang: "咸阳",
  Baoji: "宝鸡",
  Hanzhong: "汉中",
  Ulanqab: "乌兰察布",
  "Lu’an": "六安",
  "Tai’an": "泰安",
  "Huai'an": "淮安",
  Puyang: "濮阳",
  Shiyan: "十堰",
  Bazhong: "巴中",
  Yunfu: "云浮",
  Qingyang: "庆阳",
  Kunshan: "昆山",
  Zunyi: "遵义",
  Lianyungang: "连云港",
  Ganzhou: "赣州",
  Nanchong: "南充",
  Nanyang: "南阳",
  Jiangyin: "江阴",
  Fuyang: "阜阳",
  Chaozhou: "潮州",
  Qingyuan: "清远",
  Changshu: "常熟",
  Huainan: "淮南",
  Taizhou: "泰州",
  Wuhu: "芜湖",
  Dazhou: "达州",
  Zhaoqing: "肇庆",
  Wanzhou: "万州",
  Putian: "莆田",
  Yiwu: "义乌",
  Quanzhou: "泉州",
  Cixi: "慈溪",
  Changde: "常德",
  Suqian: "宿迁",
  Zhangjiagang: "张家港",
  Jinjiang: "晋江",
  Bozhou: "亳州",
  Guankou: "观口",
  Heze: "菏泽",
  Liupanshui: "六盘水",
  Qinzhou: "钦州",
  Luohe: "漯河",
  Yangjiang: "阳江",
  Yixing: "宜兴",
  Xuchang: "许昌",
  Zigong: "自贡",
  Neijiang: "内江",
  Heshan: "鹤山",
  Jining: "济宁",
  Xinyang: "信阳",
  Liaocheng: "聊城",
  Jinzhong: "晋中",
  Changzhi: "长治",
  Tianshui: "天水",
  "Hong Kong": "香港",
  "New Taipei City": "新北市",
  "New Territories": "新界",
  Kowloon: "九龙",
  Taichung: "台中",
  Kaohsiung: "高雄",
  Tainan: "台南",
};

function normalizeCityName(name: string) {
  return name.trim().normalize("NFKC").replace(/[’‘`]/g, "'");
}

export function getCityDisplayName(name: string) {
  return CHINESE_CITY_LABELS[normalizeCityName(name)] ?? name;
}

export type CityTier = "coarse" | "fine";

type CityFeature = {
  properties?: {
    NAME?: unknown;
    POP_MAX?: unknown;
  };
  geometry?: {
    coordinates?: unknown;
  };
};

export function parseCityFeatures(
  payload: { features?: unknown },
): CityPoint[] {
  if (!Array.isArray(payload.features)) return [];
  const cities: CityPoint[] = [];
  for (const raw of payload.features) {
    const feature = raw as CityFeature;
    const coordinates = feature.geometry?.coordinates;
    const name = typeof feature.properties?.NAME === "string"
      ? getCityDisplayName(feature.properties.NAME)
      : "";
    if (!Array.isArray(coordinates) || !name) continue;
    const longitude = Number(coordinates[0]);
    const latitude = Number(coordinates[1]);
    if (
      !Number.isFinite(latitude)
      || latitude < -90
      || latitude > 90
      || !Number.isFinite(longitude)
      || longitude < -180
      || longitude > 180
    ) {
      continue;
    }
    const population = Number(feature.properties?.POP_MAX ?? 0);
    const vector = latLonToVector3(latitude, longitude, 1);
    cities.push({
      name,
      latitude,
      longitude,
      population: Number.isFinite(population) ? population : 0,
      // Natural Earth 110m populated places are capitals and major cities.
      rank: 1,
      direction: [vector.x, vector.y, vector.z],
    });
  }
  // Largest first so a bounded label budget keeps the most important cities.
  return cities.sort((left, right) => right.population - left.population);
}

/**
 * Parse the compact GeoNames build (public/earth/cities.json): an array of
 * { n: asciiname, la: latitude, lo: longitude, p: population } objects,
 * pre-sorted by population descending. Directions are computed once here so
 * per-frame view filtering is pure dot products.
 */
export function parseCityList(payload: { cities?: unknown }): CityPoint[] {
  if (!Array.isArray(payload.cities)) return [];
  const cities: CityPoint[] = [];
  for (const raw of payload.cities) {
    const entry = raw as {
      n?: unknown;
      la?: unknown;
      lo?: unknown;
      p?: unknown;
      r?: unknown;
    };
    const name = typeof entry.n === "string" ? getCityDisplayName(entry.n) : "";
    const latitude = Number(entry.la);
    const longitude = Number(entry.lo);
    const population = Number(entry.p);
    const rank = Number(entry.r);
    if (
      !name
      || !Number.isFinite(latitude)
      || latitude < -90
      || latitude > 90
      || !Number.isFinite(longitude)
      || longitude < -180
      || longitude > 180
      || !Number.isFinite(population)
      || population <= 0
    ) {
      continue;
    }
    const vector = latLonToVector3(latitude, longitude, 1);
    cities.push({
      name,
      latitude,
      longitude,
      population,
      rank: Number.isFinite(rank) ? Math.max(0, Math.min(3, rank)) : 3,
      direction: [vector.x, vector.y, vector.z],
    });
  }
  return cities;
}

/**
 * Pick the cities worth labeling for the current view. `facingDirection` is
 * the globe-local unit vector from the globe center toward the camera; cities
 * are filtered by how directly they face the camera (the threshold tightens
 * as the globe zooms in) and then sorted nearest-to-view-center first, with
 * population breaking ties. This is what makes zooming reveal nearby cities
 * instead of always the world's largest ones.
 *
 * `maxRank` enforces containment-aware zoom levels: pass 1 to show only
 * national/provincial capitals, 2 to add prefecture cities, or 3 (or omit)
 * for every city.
 */
export function selectCityCandidates(
  cities: readonly CityPoint[],
  facingDirection: readonly [number, number, number],
  facingThreshold: number,
  limit: number,
  maxRank = 3,
): CityPoint[] {
  if (limit <= 0) return [];
  const facingLength = Math.hypot(
    facingDirection[0],
    facingDirection[1],
    facingDirection[2],
  );
  if (facingLength === 0) return [];
  const directionX = facingDirection[0] / facingLength;
  const directionY = facingDirection[1] / facingLength;
  const directionZ = facingDirection[2] / facingLength;
  const candidates: Array<{ city: CityPoint; facing: number }> = [];
  for (const city of cities) {
    if (city.rank > maxRank) continue;
    const facing = city.direction[0] * directionX
      + city.direction[1] * directionY
      + city.direction[2] * directionZ;
    if (facing < facingThreshold) continue;
    candidates.push({ city, facing });
  }
  candidates.sort(
    (left, right) => right.facing - left.facing
      || right.city.population - left.city.population,
  );
  return candidates.slice(0, limit).map((candidate) => candidate.city);
}

let cityCache: { cities: CityPoint[] } | null = null;

export async function loadCityTiers(
  fetcher: typeof fetch = fetch,
): Promise<{ cities: CityPoint[] }> {
  if (cityCache) return cityCache;
  const response = await fetcher("/earth/cities.json", { cache: "force-cache" });
  if (!response.ok) {
    throw new Error("City label data is unavailable");
  }
  const payload = await response.json();
  cityCache = { cities: parseCityList(payload as { cities?: unknown }) };
  return cityCache;
}

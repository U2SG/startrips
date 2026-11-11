export type HotelSelection = {
  eventId: string;
  evidence: string;
  sourceName: string;
  label: string;
  context: string;
  sourceArea: string;
  /** Model-proposed official name used only as the search query; never a fact. */
  searchName: string;
  latitude: number;
  longitude: number;
  providerId: string;
  existingPointId: string | null;
};
export type HotelPreview = {
  token: string;
  hotels: HotelSelection[];
  questions: string[];
};

/** Conservative factual gate, independent of model instructions and cropped quotations. */
export function hasExplicitHotelStay(source: string, name: string): boolean {
  const text = source.normalize("NFKC");
  const ambiguous = /无(?:酒店|住宿)|取消|计划|打算|预[订定]|待确认|不确定|是否|可能|也许|好像|[?？]|(?:未|没|没有|不).{0,8}(?:入住|住宿|住进|住在)|准备.{0,30}(?:入住|住宿)|忽略|指令|提示词|调用|标为|标记为|\b(?:cancel\w*|plan\w*|book\w*|maybe|might|would|could|ignore|instructions?|system|assistant|tools?)\b|\b(?:not|never|didn.t)\s+(?:stay|check)/iu;
  // Match the selected name as the immediate object of a completed stay verb.
  // Do not normalize away clause boundaries or search across unrelated activities.
  // Unsupported word order remains a question rather than guessing a relationship.
  // "Stayed ... for ..." can describe a purpose, not an overnight stay.
  // Reject the event rather than attributing a mixed-purpose object by proximity.
  if (/\bstayed\b[^.!;\n]*\bfor\b/iu.test(text)
    || /\b(?:not|never|didn.t|hadn.t|haven.t|wasn.t|weren.t)\b[^.!;\n]*\b(?:stayed|stay|checked|check)\b/iu.test(text)) return false;
  const hotel = name.normalize("NFKC").trim();
  if (!/[\p{L}\p{N}]/u.test(hotel) || ambiguous.test(text)) return false;
  const literal = hotel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const chinese = new RegExp(`(?:入住|住进|住在|住了)\\s*${literal}(?=$|[\\s，,。.!！;；:：])`, "iu");
  const english = new RegExp(`\\b(?:checked\\s+in\\s+(?:at|to)|stayed\\s+(?:at|in))\\s+(?:the\\s+)?${literal}(?=$|[,.!;:]|\\s+(?:in|on|and|then|before|after)\\b)`, "iu");
  // A labelled itinerary line ("住宿：<hotel>") records the night's lodging.
  const labelled = new RegExp(`^\\s*(?:[-*•]\\s*)?(?:住宿|入住|酒店|hotel|lodging|accommodation)\\s*[：:]\\s*${literal}(?=$|[\\s（(，,。.;；|｜\\\\])`, "iu");
  return chinese.test(text) || english.test(text) || labelled.test(text);
}

/** Require geography in the selected stay clause, never in another event/chapter. */
export function hasExplicitHotelStayAt(source: string, name: string, area: unknown): boolean {
  if (typeof area !== "string" || !/[\p{L}\p{N}]/u.test(area) || !hasExplicitHotelStay(source, name)) return false;
  const escape = (s: string) => s.normalize("NFKC").trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const location = escape(area), hotel = escape(name), text = source.normalize("NFKC");
  // Deliberately supported constructions only. Chapter headings, pronouns and
  // location mentions separated by another action cannot supply stay geography.
  const chinese = new RegExp(`在\\s*${location}\\s*(?:再次)?(?:入住|住进|住在|住了)\\s*${hotel}(?=$|[\\s，,。.!！;；:：])`, "iu");
  const stay = `(?:checked\\s+in\\s+(?:at|to)|stayed\\s+(?:at|in))\\s+(?:the\\s+)?${hotel}`;
  const prefix = new RegExp(`\\bin\\s+${location}\\s+(?:(?:we|she|he|they|I)\\s+)?${stay}(?=$|[,.!;:]|\\s+(?:and|then|before|after)\\b)`, "iu");
  const suffix = new RegExp(`\\b${stay}\\s+in\\s+${location}(?=$|[,.!;:]|\\s+(?:and|then|before|after)\\b)`, "iu");
  return chinese.test(text) || prefix.test(text) || suffix.test(text);
}

/** Provider addresses are opaque: require an entire delimited component, not a city substring. */
export function hotelContextMatchesArea(context: string | null | undefined, area: unknown): boolean {
  const normalize = (s: string) => s.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
  if (typeof area !== "string" || !/[\p{L}\p{N}]/u.test(area) || typeof context !== "string") return false;
  const expected = normalize(area);
  return context.split(/[,，;；/|·\n]/u).some(component => normalize(component) === expected);
}

const HOTEL_NAME_STOPWORDS = new Set(["the", "at", "by", "of", "and", "hotel", "hotels"]);
const nameTokens = (s: string) => new Set((s.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(t => /[a-z0-9]/.test(t) && !HOTEL_NAME_STOPWORDS.has(t)));
const compact = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
/** Provider names add brands and drop qualifiers ("Best Western Plus Carmel Bay View Inn"):
 * one name containing the other, or the shorter name's words all present in the longer. */
export function similarHotelName(a: string, b: string): boolean {
  const x = compact(a), y = compact(b);
  if (x.length >= 4 && y.length >= 4 && (x.includes(y) || y.includes(x))) return true;
  const ta = nameTokens(a), tb = nameTokens(b), [small, large] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  if (small.size > 0 && [...small].every(t => large.has(t))) return true;
  // A distinctive word ("Fontainebleau") identifies the property across brand suffixes.
  return [...ta].some(t => t.length >= 6 && !GENERIC_HOTEL_WORDS.has(t) && tb.has(t));
}
const GENERIC_HOTEL_WORDS = new Set(["resort", "resorts", "casino", "suites", "garden", "gardens", "international", "airport", "regency", "centric", "courtyard",
  "marriott", "hilton", "hyatt", "sheraton", "westin", "holiday", "express", "plaza", "palace", "motel", "hostel", "apartments", "village", "center", "centre", "downtown", "boutique"]);
/** A labelled day-summary line ("住宿：<hotel>") names that night's lodging. */
export const isLodgingLabelLine = (source: string) => /^\s*(?:[-*•]\s*)?(?:住宿|入住|酒店|hotel|lodging|accommodation)\s*[：:]/iu.test(source.normalize("NFKC"));
/** Stays the hotel step may consider: actual or uncertain events, plus labelled
 * lodging lines the importer read as planned. Cancelled events never qualify. */
export const isHotelEligible = (event: { status: string; source: string }) =>
  event.status === "actual" || event.status === "uncertain" || event.status === "planned" && isLodgingLabelLine(event.source);
/** Lodging features only; an unclassified provider result is left to the model and member. */
export const isLodgingCategory = (category: string | undefined) =>
  category === undefined || /^(?:tourism:(?:hotel|motel|guest_house|hostel|apartment|chalet|alpine_hut|resort)|building:hotel|leisure:resort)$/.test(category);
/** Great-circle distance in kilometres. */
export function distanceKm(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }) {
  const r = Math.PI / 180, dLat = (b.latitude - a.latitude) * r, dLon = (b.longitude - a.longitude) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.latitude * r) * Math.cos(b.latitude * r) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.min(1, Math.sqrt(h)));
}

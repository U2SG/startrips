export type HotelSelection = {
  eventId: string;
  evidence: string;
  label: string;
  context: string;
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
  const ambiguous = /取消|计划|打算|预[订定]|待确认|不确定|是否|可能|也许|好像|[?？]|(?:未|没|没有|不).{0,8}(?:入住|住宿|住进|住在)|准备.{0,30}(?:入住|住宿)|忽略|指令|提示词|调用|标为|标记为|\b(?:cancel\w*|plan\w*|book\w*|maybe|might|would|could|ignore|instructions?|system|assistant|tools?)\b|\b(?:not|never|didn.t)\s+(?:stay|check)/iu;
  const normalize = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  return !!normalize(name) && normalize(source).includes(normalize(name)) && !ambiguous.test(source)
    && /入住|住进|住在|住了|\bchecked\s+in\b|\bstayed\s+(?:at|in)\b/iu.test(source);
}

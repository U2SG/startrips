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
  const text = source.normalize("NFKC");
  const ambiguous = /取消|计划|打算|预[订定]|待确认|不确定|是否|可能|也许|好像|[?？]|(?:未|没|没有|不).{0,8}(?:入住|住宿|住进|住在)|准备.{0,30}(?:入住|住宿)|忽略|指令|提示词|调用|标为|标记为|\b(?:cancel\w*|plan\w*|book\w*|maybe|might|would|could|ignore|instructions?|system|assistant|tools?)\b|\b(?:not|never|didn.t)\s+(?:stay|check)/iu;
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
  return chinese.test(text) || english.test(text);
}

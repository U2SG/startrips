import fs from "node:fs";

const config = JSON.parse(fs.readFileSync("/run/secrets/qwen.json", "utf8"));
const UPSTREAM = config.baseUrl.replace(/\/$/, "") + "/chat/completions";
// A rendered page arrives already minimised by the caller, but a pathological
// one must fail on cost here rather than at the provider.
const MAX_DOCUMENT_CHARS = Number(process.env.BRIDGE_MAX_DOC_CHARS ?? 400_000);

let cachedKey = null;
function apiKey() {
  cachedKey ??= config.apiKey.trim();
  if (!cachedKey) throw new Error("The recognition key file is empty");
  return cachedKey;
}

const ROLES = ["accommodation", "attraction", "transport", "pure-transit"];

const DAY = {
  type: "object",
  additionalProperties: false,
  required: ["dayNumber", "sourceDayTitle", "calendarDate", "partialDate", "regionContext"],
  properties: {
    dayNumber: { type: "integer", description: "1-based, in source order" },
    sourceDayTitle: { type: ["string", "null"] },
    calendarDate: {
      type: ["string", "null"],
      description: "YYYY-MM-DD, ONLY when the source states the year",
    },
    partialDate: {
      type: ["string", "null"],
      description: "MM-DD, when the source gives month and day but no year",
    },
    regionContext: { type: ["string", "null"] },
  },
};

const ENTRY = {
  type: "object",
  additionalProperties: false,
  required: [
    "sourceEntryId", "dayNumber", "orderInDay", "name", "aliases",
    "regionContext", "role", "transitEndpoints", "truncated", "sourceInvalid",
  ],
  properties: {
    sourceEntryId: { type: ["string", "null"] },
    dayNumber: { type: "integer" },
    orderInDay: { type: "integer", description: "1-based within its day" },
    name: { type: "string", description: "Exactly as printed; never completed" },
    aliases: { type: "array", items: { type: "string" } },
    regionContext: { type: ["string", "null"] },
    role: { type: "string", enum: ROLES },
    transitEndpoints: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["from", "to"],
      properties: { from: { type: "string" }, to: { type: "string" } },
    },
    truncated: { type: "boolean" },
    sourceInvalid: { type: "boolean" },
  },
};

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "contractVersion", "sourceTitle", "sourceReportedDayCount",
    "sourceReportedPlaceCount", "days", "entries",
  ],
  properties: {
    contractVersion: { type: "integer" },
    sourceTitle: { type: ["string", "null"] },
    sourceReportedDayCount: {
      type: ["integer", "null"],
      description: "What the source CLAIMS, even when it contradicts the days listed",
    },
    sourceReportedPlaceCount: { type: ["integer", "null"] },
    days: { type: "array", items: DAY },
    entries: { type: "array", items: ENTRY },
  },
};

const HINTS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["hints"],
  properties: {
    hints: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["index", "name", "aliases", "countryCode", "searchArea", "nonPlace"],
        properties: {
          index: { type: "integer" },
          name: { type: "string" },
          aliases: { type: "array", items: { type: "string" } },
          countryCode: { type: ["string", "null"] },
          searchArea: { type: ["string", "null"] },
          nonPlace: { type: "boolean" },
        },
      },
    },
  },
};

// Every rule here is an acceptance item on issue #512, not a style preference.
// A model left to its own judgement deduplicates repeated places, completes
// truncated names and infers the missing year -- each of which is a specific
// documented failure.
const SYSTEM = `You read a travel itinerary and report ONLY what it actually says.

Report, never repair:
- A source day count that disagrees with the dates actually listed is reported
  as stated in sourceReportedDayCount AND the listed days are returned in full.
  Never truncate, reorder or reconcile them.
- An entry the source marks invalid, cancelled or unavailable keeps
  sourceInvalid=true and stays in the list. Never drop it.
- A name cut off by line width keeps truncated=true and the text exactly as
  printed. Never complete a venue, date or title you cannot see.
- The same place appearing on several days -- adjacent or not, a multi-day stay,
  a multi-city day, or an A->B->A return -- stays as one entry PER VISIT.
  Never merge or globally deduplicate by name.
- A day header without a year sets partialDate (MM-DD) and leaves calendarDate
  null. Never infer the year from today's date or from a weekday.
- A day carrying a date but listing nothing is returned as a day with no
  entries. Never drop it and never invent an entry for it.

Roles: accommodation (where they sleep), attraction (a place visited),
transport (a named station, airport or terminal), pure-transit (a leg whose
only content is travelling between two places -- set transitEndpoints).

Never output coordinates, latitude or longitude. A place is a name and a
region; where it is on Earth is resolved later by a place search.

Write names in the language the source uses. Return exactly one JSON object matching the supplied schema, never a top-level array. Return valid JSON only.`;

const HINTS_SYSTEM = `Add search hints to an already extracted itinerary. Never add, remove,
reorder or rename an entry. Return one hint for each input index and repeat its
name exactly so the caller can verify alignment. The hints are not facts about
the source and are never coordinates.

For a Chinese-named venue, aliases may contain up to two established English
or local endonyms of that exact venue. Avoid generic translations and guessed
hotel brands. For an airport, put its full official English name before any
three-letter airport code. Use a locality-qualified conventional name for a
generic landmark when one exists. An English-named venue needs no alias. Use
[] if uncertain.

countryCode is the two-letter ISO code when the itinerary context makes the
country clear. searchArea is the specific English locality, optionally followed
by a state or province, for checking a map result: e.g. "San Francisco,
California" or "Page, Arizona". Use null if a day crosses cities and you do
not know which locality this entry belongs to. A flight number is not a place;
do not copy its origin to its destination.

nonPlace is true only for an event or tour title with no stated venue. A named
venue, beach, park, airport, hotel or station is a place. Do not infer
coordinates. Return only valid JSON matching the supplied schema.`;

async function enrichLocationHints(reading, signal) {
  const input = {
    sourceTitle: reading.sourceTitle,
    days: reading.days.map((day) => ({
      dayNumber: day.dayNumber,
      sourceDayTitle: day.sourceDayTitle,
      regionContext: day.regionContext,
    })),
    entries: reading.entries.map((entry, index) => ({
      index, name: entry.name, dayNumber: entry.dayNumber, role: entry.role,
    })),
  };
  const response = await fetch(UPSTREAM, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey()}`,
    },
    signal,
    body: JSON.stringify({
      model: config.model,
      enable_thinking: false,
      messages: [
        { role: "system", content: HINTS_SYSTEM },
        { role: "user", content: JSON.stringify(input) },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "itinerary_location_hints", strict: true, schema: HINTS_SCHEMA },
      },
    }),
  });
  if (!response.ok) throw new Error(`Hint provider answered ${response.status}`);
  const payload = await response.json();
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("Hint provider returned no content");
  const parsed = JSON.parse(content);
  if (!Array.isArray(parsed.hints)) throw new Error("Hint provider returned no hint list");
  const seen = new Set();
  for (const hint of parsed.hints) {
    if (!Number.isInteger(hint.index) || seen.has(hint.index)) continue;
    const entry = reading.entries[hint.index];
    if (!entry || entry.name !== hint.name) continue;
    seen.add(hint.index);
    entry.aliases = Array.isArray(hint.aliases)
      ? hint.aliases.filter((alias) => typeof alias === "string"
        && alias.length <= 120 && /^[\x20-\x7e]+$/.test(alias)).slice(0, 2)
      : [];
    entry.countryCode = typeof hint.countryCode === "string"
      && /^[A-Z]{2}$/.test(hint.countryCode) ? hint.countryCode : null;
    entry.searchArea = typeof hint.searchArea === "string"
      && hint.searchArea.length <= 120 && /^[\x20-\x7e]+$/.test(hint.searchArea)
      ? hint.searchArea : null;
    if (hint.nonPlace === true && entry.role === "attraction") entry.role = "activity";
  }
}

function userContent(document) {
  if (document.kind === "image") {
    return [
      { type: "text", text: "Read this itinerary screenshot." },
      {
        type: "image_url",
        image_url: {
          url: `data:${document.mimeType};base64,${document.base64}`,
          detail: "high",
        },
      },
    ];
  }
  const body = String(document.text ?? "");
  if (body.length > MAX_DOCUMENT_CHARS) {
    throw new Error(`Document is ${body.length} chars, over the ${MAX_DOCUMENT_CHARS} limit`);
  }
  const origin = document.kind === "page" && document.sourceOrigin
    ? `The page was served from ${document.sourceOrigin}.\n\n`
    : "";
  return [{ type: "text", text: `${origin}Read this itinerary:\n\n${body}` }];
}

export async function recognize({ model, document }, { signal } = {}) {
  const requestSignal = signal ?? AbortSignal.timeout(175_000);
  const response = await fetch(UPSTREAM, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey()}`,
    },
    signal: requestSignal,
    body: JSON.stringify({
      model: config.model,
      enable_thinking: false,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: userContent(document) },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "itinerary_reading", strict: true, schema: SCHEMA },
      },
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Provider answered ${response.status}`);
  }

  const payload = await response.json();
  const text = payload.choices?.[0]?.message?.content;
  if (typeof text !== "string") {
    throw new Error("Provider returned no message content");
  }
  const parsed = JSON.parse(text);
  // Some compatible endpoints wrap one image document in a singleton array.
  // Unwrap only that transport envelope; never merge or repair documents.
  const reading = Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : parsed;
  if (!reading || Array.isArray(reading) || reading.contractVersion !== 1 ||
      !Array.isArray(reading.days) || !Array.isArray(reading.entries)) {
    throw new Error("Provider returned an invalid recognition document");
  }
  // The caller records provenance from its own configuration, so anything the
  // reading claims about its own version is discarded rather than trusted.
  reading.contractVersion = 1;
  try {
    await enrichLocationHints(reading, requestSignal);
  } catch {
    // The extracted reading remains intact. Missing hints simply leave those
    // places for manual search; no model suggestion ever becomes a coordinate.
    console.error("Itinerary location hints were unavailable");
  }
  return { reading, usage: payload.usage ?? null };
}

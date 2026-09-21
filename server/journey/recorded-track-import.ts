/**
 * #341: the import channel that turns a file the member already holds into
 * recorded-track evidence.
 *
 * The channel is not a format. A request declares which format it carries,
 * this module looks that name up in one registration table, and the named
 * reader turns the bytes into the same write document
 * `normalizeRecordedTrackWrite` already accepts. A second format registers
 * here and becomes importable without a new route, a new store shape or a
 * changed error meaning.
 *
 * Three consequences of that split are deliberate:
 *
 * - The ceilings belong to the registration, not to a reader. Every reader is
 *   handed the limits it must honour, so a later format declares its own
 *   without editing this one's code.
 * - The replay identity belongs to the channel, not to a format.
 *   `recordedTrackImportOperationKey` hashes the uploaded bytes and nothing
 *   else, so re-submitting one file to one Journey is a replay whatever the
 *   file happens to be.
 * - A document this slice does not yet accept is `UNSUPPORTED_FORMAT`, not
 *   `MALFORMED_FILE`. The two codes mean different things forever: the first
 *   says "not yet", and a later slice can start accepting that document
 *   without reversing anything; the second says "broken", and reversing it
 *   would be a contract change.
 *
 * This is a one-shot, user-initiated read of a file that already exists.
 * Nothing here starts a recorder or subscribes to location updates.
 */

import { createHash } from "node:crypto";
import {
  MAX_RECORDED_TRACK_SAMPLES,
  MAX_RECORDED_TRACK_SAMPLES_PER_SEGMENT,
  MAX_RECORDED_TRACK_SEGMENTS,
  normalizeRecordedTrackWrite,
  type RecordedTrackWrite,
} from "./recorded-track";

export const RECORDED_TRACK_IMPORT_REJECTIONS = [
  // The declared format is not registered, or the document is a shape the
  // registered reader does not accept yet. Never a statement about validity.
  "UNSUPPORTED_FORMAT",
  // The document asks the reader to resolve something outside itself.
  "UNSAFE_DOCUMENT",
  // The document is the declared format and is broken.
  "MALFORMED_FILE",
  "FILE_TOO_LARGE",
  "TOO_MANY_POINTS",
  "TOO_MANY_SEGMENTS",
] as const;

export type RecordedTrackImportRejection =
  (typeof RECORDED_TRACK_IMPORT_REJECTIONS)[number];

/**
 * One reader's declared ceilings. `maxBytes` is checked against the uploaded
 * bytes before anything is read, and the counts are checked as the reader
 * selects points out of the parsed document, before any of it becomes a
 * write. So a file that cannot be stored is refused by the limit that
 * describes it rather than by a second-tier rejection from the normalizer,
 * and the counts are of points that would actually be stored — text that only
 * looks like a track point counts towards nothing.
 */
export type RecordedTrackImportLimits = {
  maxBytes: number;
  maxSegments: number;
  maxPoints: number;
  maxPointsPerSegment: number;
};

/** A point a reader recovered, still unvalidated. */
export type ReadTrackPoint = {
  latitude: number;
  longitude: number;
  /** Exactly as written in the document; the normalizer decides if it reads. */
  recordedAt: string | null;
};

export type ReadTrackSegment = { points: ReadTrackPoint[] };

export type RecordedTrackRead =
  | { ok: true; segments: ReadTrackSegment[] }
  | { ok: false; reason: RecordedTrackImportRejection };

export type RecordedTrackImportFormat = {
  /** Also the stored provenance, so the store records what produced a segment set. */
  id: string;
  limits: RecordedTrackImportLimits;
  read: (text: string, limits: RecordedTrackImportLimits) => RecordedTrackRead;
};

/**
 * The store's own ceilings are the hard ones: the segment, sample and
 * per-segment counts are enforced by `normalizeRecordedTrackWrite` and again
 * by CHECK constraints on `journey_recorded_track_segments`. A registration
 * may declare something smaller; declaring something larger would mean a file
 * the reader accepted and the store refused, so these are the ceiling every
 * registration is written against.
 *
 * `maxBytes` is this channel's own. It stays well under the 512 KB request
 * body limit in `server/app.ts` so an over-ceiling upload is refused by the
 * format that declared the ceiling rather than by the transport.
 */
const GPX_LIMITS: RecordedTrackImportLimits = {
  maxBytes: 128 * 1024,
  maxSegments: MAX_RECORDED_TRACK_SEGMENTS,
  maxPoints: MAX_RECORDED_TRACK_SAMPLES,
  maxPointsPerSegment: MAX_RECORDED_TRACK_SAMPLES_PER_SEGMENT,
};

/**
 * A document that wants something resolved from outside itself. The reader
 * below never fetches anything and never expands a declared entity, so these
 * constructs cannot do what they were written to do — but a document carrying
 * one is refused rather than silently read as if it were inert, because what
 * it asked for is not what it would get.
 */
const EXTERNAL_RESOLUTION = /<!DOCTYPE|<!ENTITY|<!\[CDATA\[\s*<!/i;

/**
 * The structural reader below is a bounded, iterative XML scanner rather than
 * a set of patterns run over the raw text. A pattern cannot tell a `<trkpt>`
 * element from the same characters written inside a comment, a CDATA section
 * or a vendor `<extensions>` block, and it cannot tell a complete document
 * from a truncated one whose first segments happen to be intact. Both would
 * end as stored positions nobody recorded, so the document is parsed and
 * validated in full first, and only then are the GPX elements selected out of
 * the structure it produced.
 *
 * It is not a general XML implementation. It reads elements, attributes,
 * text, CDATA, comments and processing instructions; it expands no entity,
 * resolves nothing, and recurses nowhere — depth lives on an explicit stack,
 * so a deeply nested document costs memory bounded by the byte ceiling rather
 * than stack frames.
 */
type XmlElement = {
  /** Exactly as written, prefix included. A close tag must match it. */
  rawName: string;
  /** The prefix resolved against the declarations in scope; "" when none. */
  namespaceUri: string;
  /**
   * The part after the prefix, case preserved. XML names are case-sensitive,
   * so `<TRKPT>` is a different element from `<trkpt>` and is not a sample.
   */
  localName: string;
  /** The open tag's attributes, by the exact name each was written under. */
  attributes: XmlAttributes;
  children: XmlElement[];
  /** This element's own text and CDATA. A child's text is the child's. */
  text: string;
};

type XmlParse =
  | { ok: true; root: XmlElement }
  | { ok: false; reason: "MALFORMED_FILE" | "UNSAFE_DOCUMENT" };

const MALFORMED: XmlParse = { ok: false, reason: "MALFORMED_FILE" };

const ELEMENT_NAME = /^([^\s/>]+)([\s\S]*)$/;

/**
 * An attribute is read from a parsed token, never searched for in the open
 * tag's text. Searching cannot tell `lat` from `data-lat`, from a prefixed
 * `gpx:lat`, or from the characters `lat="80"` sitting inside another
 * attribute's quoted value - each of which would give a track point a
 * latitude the document never declared for it. So the tag is tokenized into
 * exact name="value" pairs first, and selection asks for the one name.
 *
 * Nothing is expanded: a value is the text between its quotes, entity
 * references included. A tag that is not a sequence of quoted, singly
 * declared, named attributes is not well-formed, and the document carrying
 * it is malformed rather than half-read.
 */
type XmlAttributes = Map<string, string>;

const WHITESPACE = /\s/;

function parseAttributes(text: string): XmlAttributes | null {
  const attributes: XmlAttributes = new Map();
  let index = 0;
  while (index < text.length) {
    if (WHITESPACE.test(text[index])) {
      index += 1;
      continue;
    }

    let cursor = index;
    while (
      cursor < text.length &&
      !WHITESPACE.test(text[cursor]) &&
      text[cursor] !== "="
    ) {
      cursor += 1;
    }
    const name = text.slice(index, cursor);
    if (name === "") return null;

    while (cursor < text.length && WHITESPACE.test(text[cursor])) cursor += 1;
    // A bare name carrying no value is not an XML attribute.
    if (text[cursor] !== "=") return null;
    cursor += 1;
    while (cursor < text.length && WHITESPACE.test(text[cursor])) cursor += 1;

    const quote = text[cursor];
    if (quote !== '"' && quote !== "'") return null;
    const end = text.indexOf(quote, cursor + 1);
    if (end === -1) return null;

    // A name declared twice leaves no single value to read.
    if (attributes.has(name)) return null;
    attributes.set(name, text.slice(cursor + 1, end));
    index = end + 1;
  }
  return attributes;
}

/**
 * GPX element identity is the namespace plus the local name, never the local
 * name alone. A document is free to write the track under any prefix it
 * declares for the GPX namespace, and a writer that predates namespaces
 * declares none at all — but `<evil:trkpt xmlns:evil="urn:evil">` is an
 * element belonging to somebody else that happens to share five characters
 * with this one. Selecting on the local name stores it as a recorded
 * position, and structural context does not make it a GPX element: a foreign
 * document is free to nest its own elements in exactly that shape.
 *
 * Three namespaces are admitted at the root: GPX 1.1, which every current
 * writer emits; GPX 1.0, because refusing a real recording as a broken file
 * is worse than reading one more declared namespace; and the empty one, the
 * no-namespace compatibility form used by writers that declare nothing.
 *
 * That set admits a *root*, and only a root. GPX identity is a document
 * mode, not a per-element membership test: the root resolves the document's
 * GPX namespace once, and every structural descendant has to be in that same
 * namespace. So the compatibility form is a property of a document that
 * declares nothing, never a re-entry a namespaced document can take inside
 * itself. A nested `xmlns=""`, or a switch to the other GPX version, puts
 * that element outside the document's own GPX namespace, and an element
 * foreign to the root is not a track, a segment or a sample however it is
 * nested.
 */
const GPX_NAMESPACES: ReadonlySet<string> = new Set([
  "http://www.topografix.com/GPX/1/1",
  "http://www.topografix.com/GPX/1/0",
  "",
]);

const XML_NAMESPACE = "http://www.w3.org/XML/1998/namespace";

/**
 * The declarations visible to one element, by prefix, with the default
 * namespace under the empty key. A scope is copied only where a tag actually
 * declares something, so an ordinary document carries one map.
 */
type NamespaceScope = ReadonlyMap<string, string>;

const ROOT_SCOPE: NamespaceScope = new Map();

/**
 * Apply an open tag's own `xmlns` declarations. They bind the element that
 * carries them, so `<gpx xmlns="...GPX/1/1">` is itself in that namespace.
 * Returns null for a declaration XML forbids, which makes the document
 * malformed rather than read under a prefix that means nothing.
 */
function extendScope(
  parent: NamespaceScope,
  attributes: XmlAttributes,
): NamespaceScope | null {
  let scope: Map<string, string> | null = null;
  for (const [name, value] of attributes) {
    let prefix: string;
    if (name === "xmlns") prefix = "";
    else if (name.startsWith("xmlns:")) prefix = name.slice(6);
    else continue;
    // `xmlns:` with no prefix, and a prefix bound to nothing, are both names
    // that could never be resolved.
    if (prefix === "" && name !== "xmlns") return null;
    if (prefix !== "" && value === "") return null;
    if (scope === null) scope = new Map(parent);
    scope.set(prefix, value);
  }
  return scope ?? parent;
}

type ResolvedName = { namespaceUri: string; localName: string };

/**
 * Resolve an element name. An unprefixed name takes the default namespace in
 * scope; a prefixed one takes its prefix's declaration, and an undeclared
 * prefix is not a namespace-well-formed document — it is refused rather than
 * read as if the prefix were decoration.
 */
function resolveElementName(
  rawName: string,
  scope: NamespaceScope,
): ResolvedName | null {
  const colon = rawName.indexOf(":");
  if (colon === -1) {
    return { namespaceUri: scope.get("") ?? "", localName: rawName };
  }
  const prefix = rawName.slice(0, colon);
  const localName = rawName.slice(colon + 1);
  // An empty prefix, an empty local part or a second colon is not a name.
  if (prefix === "" || localName === "" || localName.includes(":")) return null;
  if (prefix === "xml") return { namespaceUri: XML_NAMESPACE, localName };
  const namespaceUri = scope.get(prefix);
  if (namespaceUri === undefined) return null;
  return { namespaceUri, localName };
}

function parseXmlDocument(text: string): XmlParse {
  const stack: XmlElement[] = [];
  // The declarations in scope for each open element, so a child resolves
  // against everything its ancestors declared.
  const scopes: NamespaceScope[] = [];
  let root: XmlElement | null = null;
  let index = 0;

  while (index < text.length) {
    const open = text.indexOf("<", index);
    const chunk = text.slice(index, open === -1 ? text.length : open);
    if (chunk !== "") {
      const current = stack[stack.length - 1];
      if (current) current.text += chunk;
      // Character data outside the root element is not a document.
      else if (chunk.trim() !== "") return MALFORMED;
    }
    if (open === -1) break;
    index = open;

    if (text.startsWith("<!--", index)) {
      const end = text.indexOf("-->", index + 4);
      if (end === -1) return MALFORMED;
      index = end + 3;
      continue;
    }
    if (text.startsWith("<![CDATA[", index)) {
      const end = text.indexOf("]]>", index + 9);
      if (end === -1) return MALFORMED;
      const current = stack[stack.length - 1];
      if (!current) return MALFORMED;
      current.text += text.slice(index + 9, end);
      index = end + 3;
      continue;
    }
    if (text.startsWith("<?", index)) {
      const end = text.indexOf("?>", index + 2);
      if (end === -1) return MALFORMED;
      index = end + 2;
      continue;
    }
    // A declaration — a DTD or an entity — asks for something outside the
    // document, so it is never read as inert markup.
    if (text.startsWith("<!", index)) {
      return { ok: false, reason: "UNSAFE_DOCUMENT" };
    }

    if (text.startsWith("</", index)) {
      const end = text.indexOf(">", index + 2);
      if (end === -1) return MALFORMED;
      const closing = stack.pop();
      scopes.pop();
      if (!closing || closing.rawName !== text.slice(index + 2, end).trim()) {
        return MALFORMED;
      }
      index = end + 1;
      continue;
    }

    // An open tag. The scan is quote-aware so a `>` inside an attribute value
    // does not end the tag, and a bare `<` inside one is a broken document.
    let cursor = index + 1;
    let quote: string | null = null;
    let end = -1;
    while (cursor < text.length) {
      const char = text[cursor];
      if (quote !== null) {
        if (char === quote) quote = null;
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === ">") {
        end = cursor;
        break;
      } else if (char === "<") {
        return MALFORMED;
      }
      cursor += 1;
    }
    if (end === -1) return MALFORMED;

    const inner = text.slice(index + 1, end);
    const trimmed = inner.trimEnd();
    const selfClosing = trimmed.endsWith("/");
    const parts = ELEMENT_NAME.exec(selfClosing ? trimmed.slice(0, -1) : inner);
    if (!parts) return MALFORMED;

    const attributes = parseAttributes(parts[2]);
    if (!attributes) return MALFORMED;

    // Only the element name is resolved. An unprefixed attribute is in no
    // namespace whatever the default declaration says, and a prefixed one
    // belongs to whatever declared it rather than to this point, so `lat` and
    // `lon` stay keyed on the exact names they were written under.
    const scope = extendScope(
      scopes[scopes.length - 1] ?? ROOT_SCOPE,
      attributes,
    );
    if (!scope) return MALFORMED;
    const resolved = resolveElementName(parts[1], scope);
    if (!resolved) return MALFORMED;

    const element: XmlElement = {
      rawName: parts[1],
      namespaceUri: resolved.namespaceUri,
      localName: resolved.localName,
      attributes,
      children: [],
      text: "",
    };
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(element);
    // One root element, and nothing beside it.
    else if (root) return MALFORMED;
    else root = element;
    if (!selfClosing) {
      stack.push(element);
      scopes.push(scope);
    }
    index = end + 1;
  }

  // An element left open is a truncated document, whatever was complete
  // before the cut.
  if (stack.length > 0) return MALFORMED;
  if (!root) return MALFORMED;
  return { ok: true, root };
}

/**
 * Root admission: does this element open a GPX document at all, and in which
 * of the accepted namespaces. This is the only place the accepted set is
 * consulted, and its answer becomes the document namespace every element
 * below is then held to.
 */
function gpxDocumentNamespace(root: XmlElement): string | null {
  if (root.localName !== "gpx") return null;
  return GPX_NAMESPACES.has(root.namespaceUri) ? root.namespaceUri : null;
}

/**
 * The GPX children of one element, pinned to the document's own namespace.
 * Structural position says where an element sits; the resolved namespace says
 * whose element it is. Both have to hold, so a foreign `<evil:trkseg>`
 * sitting in exactly the right place is not a segment, a `<trkpt xmlns="">`
 * nested under a namespaced root is not a sample, and a foreign `<evil:wpt>`
 * does not make a document an unsupported format either.
 */
function childrenNamed(
  element: XmlElement,
  namespaceUri: string,
  localName: string,
): XmlElement[] {
  return element.children.filter(
    (child) =>
      child.localName === localName && child.namespaceUri === namespaceUri,
  );
}

/**
 * A coordinate is read strictly. `Number` accepts `''`, `'0x1f'` and
 * whitespace, all of which would turn an unreadable attribute into a position
 * on the equator, so the written text has to look like a decimal number
 * before it is one.
 */
const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

function readCoordinate(value: string | undefined): number | null {
  if (value === undefined) return null;
  const text = value.trim();
  if (!DECIMAL.test(text)) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Read `<trk>/<trkseg>/<trkpt>` and nothing else.
 *
 * Every element is a GPX element taken as a direct child of the element that
 * may contain it: a track under the root, a segment under a track, a point
 * under a segment, a `<time>` under a point. That is what makes a `<trkpt>`
 * written inside an `<extensions>` block, a comment or a CDATA section not a
 * sample, and what makes a namespace GPX never claimed not a track at all —
 * and it keeps both out of the point ceilings too, which count what would be
 * stored rather than what the file mentions.
 *
 * What it deliberately does not take:
 *
 * - `<ele>` and `<hdop>`. Elevation is not part of the stored sample, and
 *   HDOP is a unitless dilution figure — writing it into a metres column
 *   would invent an accuracy the recorder never claimed, so `accuracyMeters`
 *   stays null for every GPX point.
 * - `<wpt>` and `<rte>`. A document carrying only those is a format this
 *   slice does not accept yet, not a broken one.
 *
 * An empty `<trkseg>` is dropped rather than refused: a segment with no
 * points is not a break between two recordings, and keeping it would make a
 * legal GPX file a malformed one at the normalizer. Every segment that does
 * carry points is kept exactly where it was — no two are merged because their
 * ends are close, and nothing is interpolated across the gap.
 *
 * A `<trkpt>` whose lat/lon cannot be read refuses the whole document. A
 * coordinate that does not parse is a broken file, and silently skipping it
 * would store a recording missing a piece nobody was told about.
 */
export function readGpxRecordedTrack(
  text: string,
  limits: RecordedTrackImportLimits,
): RecordedTrackRead {
  if (EXTERNAL_RESOLUTION.test(text)) {
    return { ok: false, reason: "UNSAFE_DOCUMENT" };
  }
  const parsed = parseXmlDocument(text);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };

  const root = parsed.root;
  // A root that is not a GPX `<gpx>` is a broken track document, not a format
  // still to come: `UNSUPPORTED_FORMAT` is reserved for a real GPX file this
  // slice does not read yet, and a lookalike root must not borrow it.
  const gpxNamespace = gpxDocumentNamespace(root);
  if (gpxNamespace === null) return { ok: false, reason: "MALFORMED_FILE" };

  const tracks = childrenNamed(root, gpxNamespace, "trk");
  if (tracks.length === 0) {
    // Ordered so a document carrying both is read as the track document it is.
    return childrenNamed(root, gpxNamespace, "wpt").length > 0 ||
        childrenNamed(root, gpxNamespace, "rte").length > 0
      ? { ok: false, reason: "UNSUPPORTED_FORMAT" }
      // No track, no waypoint, no route: nothing this reader could have taken,
      // which is a broken track document rather than a format still to come.
      : { ok: false, reason: "MALFORMED_FILE" };
  }

  const segments: ReadTrackSegment[] = [];
  let totalPoints = 0;
  for (const track of tracks) {
    for (const trackSegment of childrenNamed(track, gpxNamespace, "trkseg")) {
      const points: ReadTrackPoint[] = [];
      for (const trackPoint of childrenNamed(trackSegment, gpxNamespace, "trkpt")) {
        // The point's own `lat` and `lon`, under exactly those names: a
        // prefixed or vendor-namespaced coordinate belongs to whatever wrote
        // it, not to this sample.
        const latitude = readCoordinate(trackPoint.attributes.get("lat"));
        const longitude = readCoordinate(trackPoint.attributes.get("lon"));
        if (latitude === null || longitude === null) {
          return { ok: false, reason: "MALFORMED_FILE" };
        }

        const time = childrenNamed(trackPoint, gpxNamespace, "time")[0];
        points.push({
          latitude,
          longitude,
          recordedAt: time ? time.text.trim() : null,
        });
        if (points.length > limits.maxPointsPerSegment) {
          return { ok: false, reason: "TOO_MANY_POINTS" };
        }
        totalPoints += 1;
        if (totalPoints > limits.maxPoints) {
          return { ok: false, reason: "TOO_MANY_POINTS" };
        }
      }

      if (points.length === 0) continue;
      segments.push({ points });
      if (segments.length > limits.maxSegments) {
        return { ok: false, reason: "TOO_MANY_SEGMENTS" };
      }
    }
  }

  // One point is a position, not a track. The store would take it; this
  // channel does not, because a single sample carries no recorded movement.
  if (totalPoints < 2) return { ok: false, reason: "MALFORMED_FILE" };
  return { ok: true, segments };
}

/**
 * Every format this channel accepts, keyed by the name a request declares.
 * Adding a format is adding an entry here.
 */
export const RECORDED_TRACK_IMPORT_FORMATS: Record<
  string,
  RecordedTrackImportFormat
> = {
  gpx: { id: "gpx", limits: GPX_LIMITS, read: readGpxRecordedTrack },
};

export function findRecordedTrackImportFormat(
  declared: unknown,
): RecordedTrackImportFormat | null {
  if (typeof declared !== "string") return null;
  return Object.hasOwn(RECORDED_TRACK_IMPORT_FORMATS, declared)
    ? RECORDED_TRACK_IMPORT_FORMATS[declared]
    : null;
}

/**
 * The replay identity of one upload. It hashes the uploaded bytes and nothing
 * else — not the declared format, not the reader's output, not the clock — so
 * the same file submitted twice to the same Journey is the same operation,
 * and the Journey scoping comes from the row the write lands on rather than
 * from this key.
 */
export function recordedTrackImportOperationKey(bytes: Buffer): string {
  return `import:sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export type RecordedTrackImportResult =
  | { ok: true; format: RecordedTrackImportFormat; write: RecordedTrackWrite }
  | { ok: false; reason: RecordedTrackImportRejection };

/**
 * Read one uploaded document into a write the existing store accepts.
 *
 * The samples reach persistence only through `writeRecordedTrackForAtlas`,
 * and only after `normalizeRecordedTrackWrite` has passed them: a reader
 * produces candidate positions, it never decides what is storable. A document
 * the reader accepted but the normalizer refuses is a malformed file — the
 * reader's limits are declared to sit at or under the store's, so the
 * normalizer refusing is a statement about the document, not about a
 * disagreement between two ceilings.
 */
export function readRecordedTrackImport(
  declaredFormat: unknown,
  bytes: Buffer,
): RecordedTrackImportResult {
  const format = findRecordedTrackImportFormat(declaredFormat);
  if (!format) return { ok: false, reason: "UNSUPPORTED_FORMAT" };
  if (bytes.byteLength > format.limits.maxBytes) {
    return { ok: false, reason: "FILE_TOO_LARGE" };
  }

  const read = format.read(bytes.toString("utf8"), format.limits);
  if (!read.ok) return read;

  const normalized = normalizeRecordedTrackWrite({
    operationKey: recordedTrackImportOperationKey(bytes),
    source: "imported-file",
    // The stored provenance is the format's own id. The column name says
    // nothing about GPX, and a second format writes its own id here.
    provenance: format.id,
    segments: read.segments.map((segment) => ({
      samples: segment.points.map((point) => ({
        latitude: point.latitude,
        longitude: point.longitude,
        recordedAt: point.recordedAt,
        accuracyMeters: null,
      })),
    })),
  });
  if (!normalized.ok) return { ok: false, reason: "MALFORMED_FILE" };
  return { ok: true, format, write: normalized.write };
}

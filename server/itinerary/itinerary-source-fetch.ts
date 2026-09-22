/**
 * #512: reading the page behind a shared itinerary link.
 *
 * Two things are true at once here, and the design has to hold both.
 *
 * A member's shared plan link is a normal public page they can open in a
 * browser, and one static HTTP attempt failing is not evidence the link is
 * invalid — it is evidence about this deployment's reach. So the fetch path is
 * a configured adapter with room for a real rendering step, and every failure
 * says which stage it happened in.
 *
 * And a URL a member pastes is attacker-controllable input that this server
 * would otherwise fetch with the server's own network position. So every hop —
 * the first request and every redirect it is answered with — is resolved and
 * checked before a connection is made, and a hop that lands on a private,
 * loopback, link-local or cloud-metadata address is refused. Redirects are
 * followed manually for exactly that reason: `redirect: "follow"` would make
 * the check unenforceable, because the dangerous request is the one the
 * runtime performs on its own.
 *
 * Checking a hop and then handing the hostname back to the runtime to resolve
 * again is the same hole one step later: a name that answered a public address
 * while it was being checked is free to answer a link-local address a
 * millisecond later, and the socket goes where the second answer says. So a
 * checked hop is *pinned* — the request is made through a resolver that can
 * only return the addresses this module already validated, and that resolves
 * no name itself. The hostname still travels as the `Host` header and as the
 * TLS server name, so certificate validation is unaffected; only the choice of
 * destination address is taken out of the network's hands.
 *
 * The rendering driver cannot be pinned the same way, because the connection
 * is made inside another process. It is held to the same contract from the
 * other end instead: the renderer reports the hops it actually followed and
 * the addresses it actually connected to, and a reading whose reported hops do
 * not all pass this module's own check is refused rather than read. A renderer
 * that reports nothing is refused too — an unverifiable reading is not a safe
 * one. `deploy/README.md` carries the deployment half of that contract.
 */

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { lookup as dnsLookup } from "node:dns/promises";
import type { LookupFunction } from "node:net";
import { ItineraryImportStageError } from "./itinerary-recognition";

export type ItinerarySourceDriver = "disabled" | "http" | "render";

export type ItinerarySourcePage = {
  /** The hop the content was actually read from, after any redirect. */
  finalUrl: string;
  contentType: string;
  text: string;
  /** How the page was obtained, recorded so evidence stays attributable. */
  readVia: "http" | "render";
};

export type LookupAddress = { address: string; family: number };
export type AddressLookup = (hostname: string) => Promise<LookupAddress[]>;

/**
 * A Node-style resolver handed to one request. It answers from a fixed list
 * and never consults DNS, which is the whole point. Typed as the socket
 * layer's own resolver so it is the thing `node:http` actually accepts.
 */
export type PinnedLookup = LookupFunction;

export const MAX_SOURCE_REDIRECTS = 4;

function refuse(code: string, message: string, status = 400): never {
  throw new ItineraryImportStageError("source-access", code, message, status);
}

function parseIpv4(address: string): number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => Number(part));
  return octets.every((octet) =>
      Number.isInteger(octet) && octet >= 0 && octet <= 255
    )
    ? octets
    : null;
}

/**
 * Whether one resolved address is somewhere this server must never fetch from.
 *
 * Written as an allowlist of refusals over the address itself rather than over
 * the hostname: a name is free to say anything, and `metadata.example` and
 * `127.0.0.1.nip.io` both resolve exactly where their author wanted.
 * IPv4-mapped and IPv4-compatible IPv6 forms are unwrapped first, because
 * `::ffff:169.254.169.254` is the same request as the address it wraps.
 */
export function isBlockedSourceAddress(address: string): boolean {
  const value = address.trim().toLowerCase();
  if (!value) return true;

  const mapped = value.match(/^::ffff:(.+)$/) ?? value.match(/^::(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped && parseIpv4(mapped[1])) return isBlockedSourceAddress(mapped[1]);

  const ipv4 = parseIpv4(value);
  if (ipv4) {
    const [a, b] = ipv4;
    if (a === 0) return true;                       // this network
    if (a === 10) return true;                      // private
    if (a === 127) return true;                     // loopback
    if (a === 169 && b === 254) return true;        // link-local, incl. metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 192 && b === 0) return true;          // protocol assignments
    if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
    if (a >= 224) return true;                      // multicast and reserved
    return false;
  }

  if (value === "::" || value === "::1") return true;
  if (value.startsWith("fe80")) return true;        // link-local
  if (/^f[cd]/.test(value)) return true;            // unique local
  if (value.startsWith("ff")) return true;          // multicast
  // Anything unparseable is refused rather than guessed at.
  return !/^[0-9a-f:]+$/.test(value);
}

/**
 * The syntactic half of the hop check, applied to a URL on its own.
 *
 * Kept separate because it is also what a hop *reported back* by the rendering
 * service is held to, where there is nothing left for this process to resolve.
 */
export function assertSourceUrlShape(url: URL): void {
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    refuse("ITINERARY_SOURCE_UNSUPPORTED", "Only an http or https link can be read");
  }
  if (url.username || url.password) {
    refuse("ITINERARY_SOURCE_UNSUPPORTED", "A link carrying credentials is not read");
  }
  if (url.port && url.port !== "80" && url.port !== "443") {
    refuse("ITINERARY_SOURCE_UNSUPPORTED", "Only the standard web ports are read");
  }
}

/**
 * Check one hop before it is requested, and return the addresses it is allowed
 * to be requested at.
 *
 * Scheme, port and credentials are checked on the URL; the destination is
 * checked on every address the hostname resolves to, not just the first, so a
 * name answering one public and one private address cannot pass by ordering.
 * The return value is what the caller pins the connection to, so the check and
 * the connection share one set of addresses by construction — there is no
 * second resolution in between for anyone to change the answer to.
 */
export async function assertFetchableSourceUrl(
  url: URL,
  lookup: AddressLookup,
): Promise<LookupAddress[]> {
  assertSourceUrlShape(url);

  let addresses: LookupAddress[];
  try {
    addresses = await lookup(url.hostname);
  } catch {
    // Unresolvable is a transport fact about this deployment, never a verdict
    // on the member's link.
    refuse(
      "ITINERARY_SOURCE_UNREACHABLE",
      "The link's host could not be resolved from here",
      502,
    );
  }
  if (addresses.length === 0) {
    refuse(
      "ITINERARY_SOURCE_UNREACHABLE",
      "The link's host could not be resolved from here",
      502,
    );
  }
  if (addresses.some((entry) => isBlockedSourceAddress(entry.address))) {
    refuse("ITINERARY_SOURCE_BLOCKED", "That link resolves to a private address");
  }
  return addresses;
}

/**
 * A resolver that can only answer with addresses that were already checked.
 *
 * The hostname argument is deliberately ignored: this is not a lookup, it is
 * the refusal to perform a second one. Every address is re-checked on the way
 * out as well, so a mistake upstream still cannot produce a private connection.
 */
export function createPinnedLookup(
  verified: readonly LookupAddress[],
): PinnedLookup {
  const allowed = verified.filter((entry) => !isBlockedSourceAddress(entry.address));
  return (_hostname, options, callback) => {
    if (allowed.length === 0) {
      callback(new Error("no verified address remains for this hop"), []);
      return;
    }
    if (options?.all) {
      callback(null, allowed.map((entry) => ({ ...entry })));
      return;
    }
    callback(null, allowed[0].address, allowed[0].family);
  };
}

/** One hop's reply, reduced to what this module reads. */
export type SourcePageReply = {
  status: number;
  headers: Record<string, string | undefined>;
  body: Uint8Array;
};

export type SourcePageRequest = {
  url: URL;
  /** The only addresses this request may connect to. */
  lookup: PinnedLookup;
  timeoutMs: number;
  maxBytes: number;
  signal: AbortSignal;
};

export type SourcePageTransport = (
  request: SourcePageRequest,
) => Promise<SourcePageReply>;

/**
 * The default hop transport: one request, no redirect following, connecting
 * only where `request.lookup` allows. `node:http`/`node:https` are used rather
 * than `fetch` for exactly one reason — they take the resolver as a per-request
 * option, which is what makes the pin enforceable without a new dependency.
 */
export const nodeSourcePageTransport: SourcePageTransport = (request) =>
  new Promise<SourcePageReply>((resolve, reject) => {
    const send = request.url.protocol === "https:" ? httpsRequest : httpRequest;
    const call = send(
      request.url,
      {
        method: "GET",
        lookup: request.lookup,
        timeout: request.timeoutMs,
        headers: {
          accept: "text/html,application/xhtml+xml,application/json",
          "accept-encoding": "identity",
        },
        signal: request.signal,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let overflowed = false;
        response.on("data", (chunk: Buffer) => {
          size += chunk.byteLength;
          if (size > request.maxBytes) {
            overflowed = true;
            response.destroy();
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          if (overflowed) {
            reject(new ItineraryImportStageError(
              "content-read",
              "ITINERARY_SOURCE_TOO_LARGE",
              "The page is larger than this deployment reads",
              413,
            ));
            return;
          }
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers as Record<string, string | undefined>,
            body: Buffer.concat(chunks),
          });
        });
        response.on("error", reject);
      },
    );
    call.on("timeout", () => call.destroy(new Error("the hop timed out")));
    call.on("error", reject);
    call.end();
  });

export const defaultAddressLookup: AddressLookup = (hostname) =>
  dnsLookup(hostname, { all: true });

export type ItinerarySourceFetchOptions = {
  driver: ItinerarySourceDriver;
  /** The bounded rendering service, required by the `render` driver. */
  renderUrl: string | null;
  timeoutMs: number;
  maxBytes: number;
  /** Used for the rendering service only; a member's link never reaches it. */
  fetcher?: typeof fetch;
  lookup?: AddressLookup;
  transport?: SourcePageTransport;
};

function decodeBounded(body: Uint8Array, maxBytes: number): string {
  if (body.byteLength > maxBytes) {
    throw new ItineraryImportStageError(
      "content-read",
      "ITINERARY_SOURCE_TOO_LARGE",
      "The page is larger than this deployment reads",
      413,
    );
  }
  return new TextDecoder("utf-8").decode(body);
}

/**
 * What the rendering service has to say about where it actually went.
 *
 * `finalUrl` and every hop before it are checked here with the same rules a
 * local hop gets, over the renderer's own report of the sockets it opened.
 * This is a contract, not a courtesy: a renderer that omits it gets its
 * reading refused, because "we cannot tell where this came from" and "this
 * came from somewhere safe" are not the same sentence.
 */
type RenderedReply = {
  html?: unknown;
  text?: unknown;
  finalUrl?: unknown;
  hops?: unknown;
};

function assertRenderedHops(reply: RenderedReply, requested: URL): string {
  const hops = Array.isArray(reply.hops) ? reply.hops : null;
  if (!hops || hops.length === 0) {
    throw new ItineraryImportStageError(
      "source-access",
      "ITINERARY_SOURCE_RENDER_UNVERIFIED",
      "The rendering service did not report where it connected",
      502,
    );
  }
  if (hops.length > MAX_SOURCE_REDIRECTS + 1) {
    throw new ItineraryImportStageError(
      "source-access",
      "ITINERARY_SOURCE_UNREACHABLE",
      "The link redirected more times than this deployment follows",
      502,
    );
  }

  let last: URL | null = null;
  let first: URL | null = null;
  for (const hop of hops) {
    const entry = hop as { url?: unknown; address?: unknown };
    if (typeof entry.url !== "string" || typeof entry.address !== "string") {
      throw new ItineraryImportStageError(
        "source-access",
        "ITINERARY_SOURCE_RENDER_UNVERIFIED",
        "The rendering service reported a hop it could not describe",
        502,
      );
    }
    let hopUrl: URL;
    try {
      hopUrl = new URL(entry.url);
    } catch {
      refuse(
        "ITINERARY_SOURCE_UNSUPPORTED",
        "The rendering service reported an unreadable hop",
      );
    }
    assertSourceUrlShape(hopUrl);
    if (isBlockedSourceAddress(entry.address)) {
      refuse(
        "ITINERARY_SOURCE_BLOCKED",
        "The rendering service reached a private address for that link",
      );
    }
    first ??= hopUrl;
    last = hopUrl;
  }

  if (first === null || first.toString() !== requested.toString()) {
    throw new ItineraryImportStageError(
      "source-access",
      "ITINERARY_SOURCE_RENDER_UNVERIFIED",
      "The rendering service started somewhere other than the requested link",
      502,
    );
  }

  const reported = typeof reply.finalUrl === "string" ? reply.finalUrl : null;
  if (reported === null) return (last ?? requested).toString();
  let finalUrl: URL;
  try {
    finalUrl = new URL(reported);
  } catch {
    refuse(
      "ITINERARY_SOURCE_UNSUPPORTED",
      "The rendering service reported an unreadable final link",
    );
  }
  assertSourceUrlShape(finalUrl);
  if (last && finalUrl.toString() !== last.toString()) {
    throw new ItineraryImportStageError(
      "source-access",
      "ITINERARY_SOURCE_RENDER_UNVERIFIED",
      "The rendering service read a page it did not report reaching",
      502,
    );
  }
  return finalUrl.toString();
}

/**
 * Fetch one itinerary page.
 *
 * `disabled` says so and reads nothing. `http` reads the page as served, which
 * is enough for a link whose plan is in the delivered document. `render`
 * hands the URL to a configured rendering service for a page that composes
 * itself in a browser — the case a static read cannot serve, and the reason a
 * failed static attempt must never be reported as an invalid link.
 */
export async function fetchItinerarySourcePage(
  link: string,
  options: ItinerarySourceFetchOptions,
): Promise<ItinerarySourcePage> {
  if (options.driver === "disabled") {
    throw new ItineraryImportStageError(
      "source-access",
      "ITINERARY_SOURCE_FETCH_UNAVAILABLE",
      "Reading a shared link is not configured on this deployment",
      503,
    );
  }

  let url: URL;
  try {
    url = new URL(link);
  } catch {
    refuse("ITINERARY_SOURCE_UNSUPPORTED", "That is not a readable link");
  }

  const fetcher = options.fetcher ?? fetch;
  const lookup = options.lookup ?? defaultAddressLookup;
  const transport = options.transport ?? nodeSourcePageTransport;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);

  try {
    if (options.driver === "render") {
      if (!options.renderUrl) {
        throw new ItineraryImportStageError(
          "source-access",
          "ITINERARY_SOURCE_FETCH_UNAVAILABLE",
          "The rendering service for shared links is not configured",
          503,
        );
      }
      // The member's link is checked before it is handed on, and the hops the
      // renderer reports back are checked before its reading is accepted.
      await assertFetchableSourceUrl(url, lookup);
      const rendered = await fetcher(options.renderUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url: url.toString(),
          maxRedirects: MAX_SOURCE_REDIRECTS,
        }),
        signal: controller.signal,
      });
      if (!rendered.ok) {
        throw new ItineraryImportStageError(
          "content-read",
          "ITINERARY_SOURCE_RENDER_FAILED",
          "The page could not be rendered for reading",
          502,
        );
      }
      const payload = await rendered.json().catch(() => null) as RenderedReply | null;
      if (!payload || typeof payload !== "object") {
        throw new ItineraryImportStageError(
          "content-read",
          "ITINERARY_SOURCE_RENDER_FAILED",
          "The rendering service answered with something unreadable",
          502,
        );
      }
      const finalUrl = assertRenderedHops(payload, url);
      const body = typeof payload.html === "string"
        ? payload.html
        : typeof payload.text === "string"
          ? payload.text
          : "";
      return {
        finalUrl,
        contentType: typeof payload.html === "string" ? "text/html" : "text/plain",
        text: decodeBounded(new TextEncoder().encode(body), options.maxBytes),
        readVia: "render",
      };
    }

    let current = url;
    for (let hop = 0; hop <= MAX_SOURCE_REDIRECTS; hop += 1) {
      const verified = await assertFetchableSourceUrl(current, lookup);
      const response = await transport({
        url: current,
        // The connection may go to the addresses just checked and nowhere else.
        lookup: createPinnedLookup(verified),
        timeoutMs: options.timeoutMs,
        maxBytes: options.maxBytes,
        signal: controller.signal,
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.location ?? null;
        if (!location) {
          throw new ItineraryImportStageError(
            "source-access",
            "ITINERARY_SOURCE_UNREACHABLE",
            "The link redirected without saying where",
            502,
          );
        }
        // Resolved against the hop that answered, then checked like any other.
        current = new URL(location, current);
        continue;
      }

      if (response.status < 200 || response.status >= 300) {
        throw new ItineraryImportStageError(
          "source-access",
          "ITINERARY_SOURCE_UNREACHABLE",
          `The link answered ${response.status} from here`,
          502,
        );
      }

      return {
        finalUrl: current.toString(),
        contentType: response.headers["content-type"] ?? "text/html",
        text: decodeBounded(response.body, options.maxBytes),
        readVia: "http",
      };
    }

    throw new ItineraryImportStageError(
      "source-access",
      "ITINERARY_SOURCE_UNREACHABLE",
      "The link redirected more times than this deployment follows",
      502,
    );
  } catch (error) {
    if (controller.signal.aborted) {
      throw new ItineraryImportStageError(
        "source-access",
        "ITINERARY_SOURCE_TIMEOUT",
        `The link did not answer within ${options.timeoutMs}ms`,
        504,
      );
    }
    if (error instanceof ItineraryImportStageError) throw error;
    // A transport fault. Still a fact about reach, not about the link.
    throw new ItineraryImportStageError(
      "source-access",
      "ITINERARY_SOURCE_UNREACHABLE",
      "The link could not be read from here",
      502,
    );
  } finally {
    clearTimeout(timer);
  }
}

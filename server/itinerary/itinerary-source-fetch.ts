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
 */

import { lookup as dnsLookup } from "node:dns/promises";
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
 * Check one hop before it is requested.
 *
 * Scheme, port and credentials are checked on the URL; the destination is
 * checked on every address the hostname resolves to, not just the first, so a
 * name answering one public and one private address cannot pass by ordering.
 */
export async function assertFetchableSourceUrl(
  url: URL,
  lookup: AddressLookup,
): Promise<void> {
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    refuse("ITINERARY_SOURCE_UNSUPPORTED", "Only an http or https link can be read");
  }
  if (url.username || url.password) {
    refuse("ITINERARY_SOURCE_UNSUPPORTED", "A link carrying credentials is not read");
  }
  if (url.port && url.port !== "80" && url.port !== "443") {
    refuse("ITINERARY_SOURCE_UNSUPPORTED", "Only the standard web ports are read");
  }

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
}

export const defaultAddressLookup: AddressLookup = (hostname) =>
  dnsLookup(hostname, { all: true });

export type ItinerarySourceFetchOptions = {
  driver: ItinerarySourceDriver;
  /** The bounded rendering service, required by the `render` driver. */
  renderUrl: string | null;
  timeoutMs: number;
  maxBytes: number;
  fetcher?: typeof fetch;
  lookup?: AddressLookup;
};

async function readBounded(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > maxBytes) {
    throw new ItineraryImportStageError(
      "content-read",
      "ITINERARY_SOURCE_TOO_LARGE",
      "The page is larger than this deployment reads",
      413,
    );
  }
  return new TextDecoder("utf-8").decode(buffer);
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
      // The member's link is still checked before it is handed on, so the
      // renderer is not turned into the request forgery this guard prevents.
      await assertFetchableSourceUrl(url, lookup);
      const rendered = await fetcher(options.renderUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: url.toString() }),
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
      return {
        finalUrl: url.toString(),
        contentType: rendered.headers.get("content-type") ?? "text/html",
        text: await readBounded(rendered, options.maxBytes),
        readVia: "render",
      };
    }

    let current = url;
    for (let hop = 0; hop <= MAX_SOURCE_REDIRECTS; hop += 1) {
      await assertFetchableSourceUrl(current, lookup);
      const response = await fetcher(current.toString(), {
        method: "GET",
        redirect: "manual",
        headers: { accept: "text/html,application/xhtml+xml,application/json" },
        signal: controller.signal,
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
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

      if (!response.ok) {
        throw new ItineraryImportStageError(
          "source-access",
          "ITINERARY_SOURCE_UNREACHABLE",
          `The link answered ${response.status} from here`,
          502,
        );
      }

      return {
        finalUrl: current.toString(),
        contentType: response.headers.get("content-type") ?? "text/html",
        text: await readBounded(response, options.maxBytes),
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

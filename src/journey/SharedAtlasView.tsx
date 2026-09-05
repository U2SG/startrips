import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { IconRoute, IconWorld } from "@tabler/icons-react";
import { StartripsBrandLoader } from "../brand/StartripsBrandMark";
import { usePersistentEarth } from "../scene/LivingAtlasGlobe";
import {
  AtlasViewProvider,
  GUEST_ATLAS_VIEW_CAPABILITIES,
  type AtlasView,
} from "./atlasView";
import { LivingAtlasApp } from "./LivingAtlasApp";
import {
  SharedAtlasError,
  createSharedAtlasClient,
  sharedAtlasJourneys,
  sharedAtlasRecheckDelayMs,
  sharedAtlasScopeIsClosed,
  sharedAtlasStatusForFailure,
  shareToken,
  type SharedAtlasClient,
} from "./sharedAtlas";
import type { Journey } from "./types";
import "../styles/shared-atlas.css";

/**
 * What the guest viewer is showing.
 *
 * `unavailable` and `empty` are two different product states and #200 is
 * explicit about not merging them: a dead link is `这条分享链接已失效`, while a
 * live link whose journeys are all gone is `这些旅程目前不可查看`. `error` is
 * the retryable transport case, which must not be dressed up as an expiry the
 * recipient can do nothing about.
 */
export type SharedAtlasStatus =
  | "loading"
  | "ready"
  | "empty"
  | "unavailable"
  | "error";

/**
 * Keep the shared document out of search results and out of `Referer`.
 *
 * The guest API responses already carry `X-Robots-Tag` and `Referrer-Policy`,
 * but this is the HTML document a crawler would index and the page whose URL a
 * third-party request would leak, and it is served by the static file handler
 * rather than the API. `index.html` is shared with the owner app, so the tags
 * are added here — only on the shared route — and removed on unmount.
 */
function usePrivateDocumentHeaders(): void {
  useEffect(() => {
    const tags = [
      { name: "robots", content: "noindex, nofollow" },
      { name: "referrer", content: "no-referrer" },
    ].map(({ name, content }) => {
      const meta = document.createElement("meta");
      meta.name = name;
      meta.content = content;
      document.head.append(meta);
      return meta;
    });
    return () => tags.forEach((meta) => meta.remove());
  }, []);
}

type SharedAtlasState = {
  status: SharedAtlasStatus;
  message: string;
  /** The grant expiry the last successful read reported, in epoch ms. */
  expiresAt: number | null;
  /**
   * How many successful grant reads have happened. The expiry check below
   * depends on it, so a read that succeeds because this browser's clock ran
   * ahead of the server re-arms the timer instead of being the last one: the
   * expiry and the status are both unchanged in that case, and without a
   * distinct value React would keep the stale timer and never look again.
   */
  reads: number;
};

const LOADING_STATE: SharedAtlasState = {
  status: "loading",
  message: "",
  expiresAt: null,
  reads: 0,
};

/**
 * #200 phase D: `/share#<token>` as a read-only product mode.
 *
 * This is the only place the guest capability set is provided, and it wraps
 * the same `LivingAtlasApp` the owner sees. The difference is the value, not
 * the component tree: with `mutations: null` there is no client under any
 * surface that could write, so the composer, the delete paths and the media
 * management surface are never constructed rather than hidden.
 *
 * The grant is re-validated by the server on every read, and this component
 * owns what that means for the session. A dead link discovered mid-session —
 * the grant expiring while the page is open, or the owner revoking it — takes
 * over the whole view; one withdrawn asset does not.
 */
export function SharedAtlasView({
  createClient = createSharedAtlasClient,
  readToken = shareToken,
}: {
  createClient?: (token: string) => SharedAtlasClient;
  readToken?: () => string | null;
} = {}) {
  usePrivateDocumentHeaders();
  const persistentEarth = usePersistentEarth();
  const [state, setState] = useState<SharedAtlasState>(LOADING_STATE);
  const [attempt, setAttempt] = useState(0);
  // Resolved once per mount from a holder that itself reads the fragment once
  // per document, and held only in this closure from here on.
  const token = useMemo(() => readToken(), [readToken]);
  const client = useMemo(
    () => (token ? createClient(token) : null),
    [token, createClient],
  );
  const statusRef = useRef(state.status);
  statusRef.current = state.status;
  // The boot read below decides the state, and the atlas then asks for the
  // same journeys on its first mount. Handing that first call the payload the
  // boot read already validated avoids a duplicate request without letting the
  // atlas render before the grant was resolved. Every later refresh is a real
  // request, so the grant is re-checked on each one.
  const primed = useRef<Journey[] | null>(null);

  /**
   * Escalate a guest failure to the session, then let the caller keep its own
   * error handling. A retryable network failure inside an open session stays
   * with `LivingAtlasApp`, which already shows a load error; only a dead link
   * replaces the view.
   */
  const reportFailure = useCallback((error: unknown) => {
    if (!(error instanceof SharedAtlasError)) return;
    const next = sharedAtlasStatusForFailure(error.failure);
    if (!next) return;
    if (next === "error" && statusRef.current !== "loading") return;
    setState((current) => ({ ...current, status: next, message: error.message }));
  }, []);

  const readSharedJourneys = useCallback(async (): Promise<Journey[]> => {
    if (!client) throw new SharedAtlasError("link-unavailable", "分享链接无效");
    try {
      const view = await client.getJourneys();
      if (!sharedAtlasScopeIsClosed(view)) {
        throw new SharedAtlasError(
          "link-unavailable",
          "这条分享链接的内容无法校验",
        );
      }
      const expiresAt = Date.parse(view.share.expiresAt);
      setState((current) => ({
        status: view.journeys.length === 0 ? "empty" : "ready",
        message: "",
        expiresAt: Number.isFinite(expiresAt) ? expiresAt : null,
        reads: current.reads + 1,
      }));
      return sharedAtlasJourneys(view);
    } catch (error) {
      reportFailure(error);
      throw error;
    }
  }, [client, reportFailure]);

  const listJourneys = useCallback(async (): Promise<Journey[]> => {
    const alreadyRead = primed.current;
    if (alreadyRead) {
      primed.current = null;
      return alreadyRead;
    }
    return readSharedJourneys();
  }, [readSharedJourneys]);

  const readMedia = useCallback(async (assetId: string) => {
    if (!client) throw new SharedAtlasError("link-unavailable", "分享链接无效");
    try {
      return await client.getMediaRead(assetId);
    } catch (error) {
      reportFailure(error);
      throw error;
    }
  }, [client, reportFailure]);

  const atlasView = useMemo<AtlasView>(() => ({
    capabilities: GUEST_ATLAS_VIEW_CAPABILITIES,
    listJourneys,
    readMedia,
    mutations: null,
  }), [listJourneys, readMedia]);

  useEffect(() => {
    if (!client) {
      setState({ status: "unavailable", message: "这条分享链接已失效", expiresAt: null, reads: 0 });
      return;
    }
    let cancelled = false;
    void readSharedJourneys().then(
      (journeys) => {
        if (!cancelled) primed.current = journeys;
      },
      () => undefined,
    );
    return () => { cancelled = true; };
  }, [client, readSharedJourneys, attempt]);

  // The globe lives in the persistent earth host, which only renders its scene
  // once a stage has been declared. `AuthGateway` normally does that, and it
  // does not mount here — without this the shared viewer would render the whole
  // Atlas shell around an empty space where the globe belongs. There is no
  // login and no handoff on this route, so the stage goes straight to `atlas`
  // once the grant resolves, and back to `idle` for the gate states so no globe
  // sits behind the unavailable panel.
  useEffect(() => {
    persistentEarth.setStage(state.status === "ready" ? "atlas" : "idle");
  }, [persistentEarth, state.status]);

  // #200: expiry must not be enforced only at page load, and the client clock
  // must not be the authority either. When the reported expiry passes with the
  // viewer still open, re-read the grant: the server answers the generic 404
  // and the session ends, or — if this browser's clock ran fast — it answers
  // with the current payload, `reads` advances, and this re-arms for another
  // pass rather than giving up after one wrong guess about the time.
  useEffect(() => {
    if (state.expiresAt === null) return;
    if (state.status !== "ready" && state.status !== "empty") return;
    const timer = window.setTimeout(
      () => void readSharedJourneys().catch(() => undefined),
      sharedAtlasRecheckDelayMs(state.expiresAt, Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [state.expiresAt, state.status, state.reads, readSharedJourneys]);

  if (state.status === "unavailable" || state.status === "error") {
    const unavailable = state.status === "unavailable";
    return (
      <main className="shared-atlas-gate" data-shared-atlas-state={state.status}>
        <section className="shared-atlas-gate__panel">
          <p>SHARED JOURNEYS</p>
          <IconWorld size={34} stroke={1.05} aria-hidden="true" />
          <h1>{unavailable ? "这条分享链接已失效" : "暂时打不开这条分享链接"}</h1>
          <p>{unavailable
            ? "请联系分享者获取新的链接。"
            : "网络看起来不太稳定，稍后可以再试一次。"}</p>
          {unavailable ? null : (
            <button
              type="button"
              data-shared-atlas-retry="true"
              onClick={() => {
                setState(LOADING_STATE);
                setAttempt((current) => current + 1);
              }}
            >重新加载</button>
          )}
        </section>
      </main>
    );
  }

  if (state.status === "empty") {
    return (
      <main className="shared-atlas-gate" data-shared-atlas-state="empty">
        <section className="shared-atlas-gate__panel">
          <p>SHARED JOURNEYS</p>
          <IconRoute size={34} stroke={1.05} aria-hidden="true" />
          <h1>这些旅程目前不可查看</h1>
          <p>分享链接仍然有效，但其中的旅程已经不在图谱里了。</p>
        </section>
      </main>
    );
  }

  if (state.status === "loading") {
    return (
      <main className="shared-atlas-gate" data-shared-atlas-state="loading" aria-busy="true">
        <StartripsBrandLoader message="正在打开分享的旅程…" />
      </main>
    );
  }

  return (
    <AtlasViewProvider value={atlasView}>
      <LivingAtlasApp />
    </AtlasViewProvider>
  );
}

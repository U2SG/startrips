import { createRoot } from "react-dom/client";
import { JourneyBook3dReader } from "../../../src/journey/JourneyBook3d";
import { journeyBookPageRoutePointId, type BookJourney, type JourneyBookPage } from "../../../src/journey/journeyBookPages";
import "../../../src/styles/tokens.css";
import "./book3d.css";

type Snapshot = {
  journey: Omit<BookJourney, "media"> & {
    media: (Omit<BookJourney["media"][number], "routePointId" | "createdAt"> & { routePointId?: string })[];
  };
  routePointId?: string;
  assetId?: string;
};

type BookMessage =
  | { kind: "picture" | "video"; assetId: string }
  | { kind: "position"; routePointId: string | null; assetId: string | null; isCover: boolean }
  | { kind: "ready" | "fallback" | "close" };

type BookWindow = Window & {
  webkit?: { messageHandlers?: { storyBook?: { postMessage: (body: BookMessage) => Promise<unknown> } } };
};

const host = window as BookWindow;
const root = createRoot(document.getElementById("root")!);
async function send(body: BookMessage) {
  const bridge = host.webkit?.messageHandlers?.storyBook;
  if (!bridge) throw new Error("Story Book bridge unavailable");
  return bridge.postMessage(body);
}

function notify(body: BookMessage) {
  void send(body).catch(() => undefined);
}

const embedded = {
  async picture(assetId: string) {
    const jpeg = await send({ kind: "picture", assetId });
    if (typeof jpeg !== "string" || !jpeg) throw new Error("Picture unavailable");
    return `data:image/jpeg;base64,${jpeg}`;
  },
  playVideo: (assetId: string) => notify({ kind: "video", assetId }),
  position: (page: JourneyBookPage) => {
    if (page.kind === "blank" || page.kind === "end") return;
    notify({
      kind: "position",
      routePointId: journeyBookPageRoutePointId(page),
      assetId: page.kind === "media" ? page.asset.id : null,
      isCover: page.kind === "cover",
    });
  },
};

function fallback() {
  notify({ kind: "fallback" });
}

function renderBook({ journey, routePointId, assetId }: Snapshot) {
  // A missing routePointId denotes Journey-level media in the native projection.
  const bookJourney = {
    ...journey,
    media: journey.media.map((asset) => ({
      ...asset,
      routePointId: asset.routePointId ?? null,
      createdAt: "",
    })),
  };
  root.render(
    <JourneyBook3dReader
      journeys={[bookJourney]}
      journeyId={journey.id}
      routePointId={routePointId}
      initialAssetId={assetId}
      embedded={embedded}
      readMedia={async () => { throw new Error("The embedded book reads pictures through native Story"); }}
      onClose={() => notify({ kind: "close" })}
      onOpenClassic={fallback}
      recoverPresentation={fallback}
    />,
  );
}

void send({ kind: "ready" }).then((json) => {
  if (typeof json !== "string") throw new Error("Story Book snapshot unavailable");
  renderBook(JSON.parse(json));
}).catch(() => {
  root.render(
    <main className="story-book-loading">
      <p role="status">立体之书暂时无法打开。</p>
      <button type="button" className="journey-book__text-action" onClick={fallback}>改用旅程之书</button>
    </main>,
  );
});

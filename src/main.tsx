import { StrictMode, Suspense, lazy, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { AuthGateway } from "./auth/AuthGateway";
import { authClient } from "./auth/auth-client";
import { StartripsNotFound } from "./brand/StartripsNotFound";
import { StartripsBrandLoader } from "./brand/StartripsBrandMark";
import { LivingAtlasApp } from "./journey/LivingAtlasApp";
import { SharedAtlasView } from "./journey/SharedAtlasView";
import { isSharedAtlasPathname } from "./journey/sharedAtlas";
import {
  EarthExperiencePreferenceProvider,
  useEarthExperiencePreference,
} from "./journey/EarthExperienceProvider";
import { PersistentEarthProvider } from "./scene/LivingAtlasGlobe";
import "./styles/tokens.css";
import "./app.css";
import "./styles/auth-gate.css";
import "./styles/brand-mark.css";
import "./styles/living-atlas.css";
import "./styles/journey-playback.css";
import "./styles/globe-time-scrubber.css";
import "./styles/starlight-experience.css";

/**
 * #332: the stored Earth experience preference, bound to the real session.
 *
 * Mounted around `AuthGateway` rather than inside it, so the one read is keyed
 * by the stable user and not by the Atlas: `WorkspaceGate` remounts whenever
 * the active organization changes, and switching Atlas must not re-read or
 * reset a personal preference. `/share#<token>` is mounted outside this
 * provider entirely, so a guest tree has no reader and issues no request.
 */
function SessionEarthExperienceProvider({ children }: { children: ReactNode }) {
  const session = authClient.useSession();
  return (
    <EarthExperiencePreferenceProvider
      accountKey={session.data?.user.id ?? null}
      sessionResolved={!session.isPending}
    >
      {children}
    </EarthExperiencePreferenceProvider>
  );
}

/**
 * #332: the product Atlas, reading the person's stored Earth experience.
 *
 * This is the only place the saved preference becomes the `#331` policy. It is
 * a wrapper rather than a prop threaded from the render root because the value
 * is resolved inside the provider mounted around `AuthGateway`, one tree above
 * the gate that decides whether an Atlas renders at all.
 */
function OwnerLivingAtlasApp() {
  const { policy } = useEarthExperiencePreference();
  return <LivingAtlasApp earthExperiencePolicy={policy} />;
}

/**
 * #200 phase D: `/share#<token>` is a read-only product mode, not a state of
 * the owner app.
 *
 * It is mounted OUTSIDE `AuthGateway` on purpose. A recipient has no account,
 * and the gateway's first act is to list the viewer's organizations and read
 * `/api/atlases/current`; running that for a guest would mean two failing
 * requests and a login gate in front of a link that is already authorized.
 * Mounting the shared view here instead means the guest tree never contains
 * an owner atlas, an owner capability provider, or an account surface.
 */
const shared = isSharedAtlasPathname(window.location.pathname);
const knownAppPath = ["/", "/reset-password", "/accept-invitation"].includes(window.location.pathname);
const localDemo = import.meta.env.DEV
  && window.location.pathname === "/"
  && new URLSearchParams(window.location.search).get("demo") === "1";
const ExperienceDemo = import.meta.env.DEV ? lazy(() => import("./preview/ExperienceDemo")) : null;

// Resolve development fixtures before mounting so their loading cannot remount
// the product's persistent globe, session provider or guest boundary.
async function mountApp() {
  const params = new URLSearchParams(window.location.search);
  const sharedQa = import.meta.env.DEV && shared && params.get("qaRoutePointContext") === "1";
  const previewRequested = import.meta.env.DEV && !localDemo && (
    sharedQa || (!shared && knownAppPath && Boolean(params.get("qaState")))
  );
  const previews = import.meta.env.DEV && previewRequested ? await import("./preview/qaEntry") : null;
  const Experience = previews?.QaExperience ?? OwnerLivingAtlasApp;

  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <PersistentEarthProvider>
        {localDemo && ExperienceDemo ? (
          <Suspense fallback={<main className="auth-gate auth-gate--brand-loading"><StartripsBrandLoader message="正在打开示例图谱…" /></main>}>
            <ExperienceDemo />
          </Suspense>
        ) : !shared && !knownAppPath ? <StartripsNotFound /> : shared ? (
          <SharedAtlasView
            GlobeComponent={
              sharedQa ? previews?.LivingAtlasGlobeChromeQa : undefined
            }
          />
        ) : (
          <SessionEarthExperienceProvider>
            <AuthGateway>
              <Experience />
            </AuthGateway>
          </SessionEarthExperienceProvider>
        )}
      </PersistentEarthProvider>
    </StrictMode>,
  );
}

void mountApp();

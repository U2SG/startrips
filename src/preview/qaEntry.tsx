import type { ComponentType } from "react";
import type { LivingAtlasGlobeProps } from "../scene/LivingAtlasGlobe";

type QaPreview = {
  QaExperience: ComponentType;
  LivingAtlasGlobeChromeQa?: ComponentType<LivingAtlasGlobeProps>;
};

const PRODUCT_QA_STATES = new Set([
  "journey-composer", "journey-story", "journey-playback",
  "globe-controls", "globe-controls-gateway", "earth-dive",
  "living-atlas", "atlas-gateway", "brand-signature-motion",
  "recovery-surfaces", "final-acceptance", "login-v3", "login-gateway",
]);

// Resolve the requested family before createRoot. A fixture never replaces the
// already-mounted session or persistent globe while its module is loading.
export async function resolveQaExperience(
  params: URLSearchParams,
  sharedQa: boolean,
): Promise<QaPreview> {
  const qaState = params.get("qaState") ?? "";
  if (sharedQa || PRODUCT_QA_STATES.has(qaState)) {
    return import("./ProductQaPreview");
  }
  if (qaState === "journey-routes") {
    const { JourneyRoutesQaPreview } = await import("./RouteQaPreview");
    return { QaExperience: JourneyRoutesQaPreview };
  }
  if (qaState === "cover-reveal") {
    const { CoverRevealQaPreview } = await import("../reveal/CoverRevealQaPreview");
    return { QaExperience: CoverRevealQaPreview };
  }
  // Keep legacy state ids and the existing unknown-state/live fallback. The
  // legacy QA command uses qaState=legacy-live to request the interactive App.
  return import("./LegacyQaPreview");
}

import { StartripsWordmark } from "./StartripsBrandMark";
import { StartripsRecoverySurface } from "./StartripsRecoverySurface";
import { canUseStartripsRecoveryBack } from "./recoverySurfaces";

export function StartripsNotFound() {
  const canGoBack = canUseStartripsRecoveryBack({
    historyLength: window.history.length,
    referrer: document.referrer,
    origin: window.location.origin,
  });

  return (
    <main className="startrips-not-found">
      <StartripsWordmark size={36} companion={false} />
      <StartripsRecoverySurface
        kind="not-found"
        onSecondaryAction={canGoBack ? () => window.history.back() : undefined}
      />
      <small>同一片星空，还有故事等你。</small>
    </main>
  );
}

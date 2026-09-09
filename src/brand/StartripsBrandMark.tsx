import type { CSSProperties } from "react";
import { STARTRIPS_V12_MARK_MARKUP, STARTRIPS_V12_MARK_VIEWBOX } from "./startripsV12Mark";

export type StartripsBrandState = "waiting" | "travel" | "arrived" | "rest";

type StartripsBrandMarkProps = {
  className?: string;
  loading?: boolean;
  size?: number;
  state?: StartripsBrandState;
  title?: string;
};

const V12_WORDMARK = "/brand/startrips-v12-wordmark.svg";
const V12_WORDMARK_ONLY = "/brand/startrips-v12-wordmark-only.svg";

/**
 * Kept as a compatibility export for older call sites. v12 deliberately has
 * one four-point star only (the wordmark i-dot), so the legacy particle ring
 * no longer renders another competing brand signal.
 */
export function StartripsLoadingPoints() {
  return null;
}

/**
 * Compact v12 identity: the approved articulated mountain-goat silhouette and
 * the same four-point star geometry used by the wordmark study.
 */
export function StartripsLamb({
  className = "",
  state = "rest",
  title,
}: {
  className?: string;
  state?: StartripsBrandState;
  title?: string;
}) {
  return (
    <span
      className={`startrips-v12-mark is-${state} ${className}`}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      data-brand-version="12"
      data-brand-state={state}
    >
      <svg
        className="startrips-v12-mark__svg"
        viewBox={STARTRIPS_V12_MARK_VIEWBOX}
        aria-hidden="true"
        focusable="false"
        dangerouslySetInnerHTML={{ __html: STARTRIPS_V12_MARK_MARKUP }}
      />
    </span>
  );
}

export function StartripsBrandMark({
  className = "",
  loading = false,
  size = 64,
  state,
  title,
}: StartripsBrandMarkProps) {
  const brandState = state ?? (loading ? "waiting" : "rest");
  return (
    <span
      className={`startrips-brand-mark startrips-v12-mark is-${brandState}${loading ? " is-loading" : ""} ${className}`}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      data-brand-version="12"
      data-brand-state={brandState}
      style={{ "--startrips-mark-size": `${size}px` } as CSSProperties}
    >
      <svg
        className="startrips-v12-mark__svg"
        viewBox={STARTRIPS_V12_MARK_VIEWBOX}
        aria-hidden="true"
        focusable="false"
        dangerouslySetInnerHTML={{ __html: STARTRIPS_V12_MARK_MARKUP }}
      />
    </span>
  );
}

/**
 * v12 wordmark uses the authored SVG letter outlines rather than a runtime
 * font. The only four-point star remains the i-dot; companion=false uses the
 * same geometry without the goat lockup.
 */
export function StartripsWordmark({
  className = "",
  size = 32,
  intro = false,
  loading = false,
  companion = true,
  state,
}: {
  className?: string;
  size?: number;
  intro?: boolean;
  loading?: boolean;
  companion?: boolean;
  state?: StartripsBrandState;
}) {
  const wordmarkState = state ?? (loading ? "waiting" : intro ? "travel" : "rest");
  return (
    <span
      className={`startrips-wordmark startrips-v12-wordmark${intro ? " is-intro" : ""}${loading ? " is-loading" : ""}${companion ? " has-companion" : " is-wordmark-only"} is-${wordmarkState} ${className}`}
      role="img"
      aria-label="Startrips"
      data-brand-version="12"
      data-brand-state={wordmarkState}
      style={{ "--startrips-wordmark-size": `${size}px` } as CSSProperties}
    >
      <img
        className="startrips-v12-wordmark__art"
        src={companion ? V12_WORDMARK : V12_WORDMARK_ONLY}
        alt=""
        draggable={false}
      />
    </span>
  );
}

export function StartripsJourneyCue({ state = "rest", size = 64, className = "" }: {
  state?: StartripsBrandState;
  size?: number;
  className?: string;
}) {
  return (
    <StartripsBrandMark
      className={`startrips-journey-cue is-${state} ${className}`}
      loading={state === "waiting"}
      state={state}
      size={size}
    />
  );
}

export function StartripsBrandLoader({ message }: { message: string }) {
  return (
    <div className="startrips-brand-loader" role="status" aria-live="polite" aria-busy="true">
      <StartripsWordmark size={52} loading />
      <div className="startrips-brand-loader__copy">
        <span>{message}</span>
      </div>
    </div>
  );
}

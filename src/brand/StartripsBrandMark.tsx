import type { CSSProperties } from "react";
import { IconSparkle } from "@tabler/icons-react";

export type StartripsBrandState = "waiting" | "travel" | "arrived" | "rest";

type StartripsLambProps = {
  className?: string;
  state?: StartripsBrandState;
  title?: string;
};

type LoadingPoint = {
  cluster: readonly [number, number];
  ring: readonly [number, number];
};

// One fixed batch of points changes its distance from the centre. Keeping the
// identities stable makes the waiting state read as a living signal instead
// of a new spinner being mounted for every phase.
const STARTRIPS_LOADING_POINTS: readonly LoadingPoint[] = [
  { cluster: [-8, -6], ring: [0, -17] },
  { cluster: [-3, -8], ring: [5.3, -16.2] },
  { cluster: [2, -7], ring: [10, -13.8] },
  { cluster: [7, -5], ring: [13.8, -10] },
  { cluster: [-10, -2], ring: [16.2, -5.3] },
  { cluster: [-5, -3], ring: [17, 0] },
  { cluster: [0, -2], ring: [16.2, 5.3] },
  { cluster: [5, -2], ring: [13.8, 10] },
  { cluster: [10, -1], ring: [10, 13.8] },
  { cluster: [-8, 3], ring: [5.3, 16.2] },
  { cluster: [-3, 3], ring: [0, 17] },
  { cluster: [2, 2], ring: [-5.3, 16.2] },
  { cluster: [7, 3], ring: [-10, 13.8] },
  { cluster: [-6, 7], ring: [-13.8, 10] },
  { cluster: [-1, 7], ring: [-16.2, 5.3] },
  { cluster: [4, 7], ring: [-17, 0] },
  { cluster: [-10, 8], ring: [-16.2, -5.3] },
  { cluster: [9, 7], ring: [-13.8, -10] },
  { cluster: [-4, 10], ring: [-10, -13.8] },
  { cluster: [4, 10], ring: [-5.3, -16.2] },
];

export function StartripsLoadingPoints({ className = "" }: { className?: string }) {
  return (
    <svg
      className={`startrips-loading-points ${className}`}
      viewBox="0 0 48 48"
      aria-hidden="true"
      focusable="false"
    >
      {STARTRIPS_LOADING_POINTS.map((point, index) => (
        <circle
          className="startrips-loading-points__point"
          data-point-index={index}
          key={index}
          cx="24"
          cy="24"
          r={index % 3 === 0 ? 1.1 : 0.82}
          style={{
            "--point-cluster-x": `${point.cluster[0]}px`,
            "--point-cluster-y": `${point.cluster[1]}px`,
            "--point-ring-x": `${point.ring[0]}px`,
            "--point-ring-y": `${point.ring[1]}px`,
          } as CSSProperties}
        />
      ))}
    </svg>
  );
}

/**
 * The small travelling companion is deliberately made from a few stable
 * layers. The body, head and legs can move as one silhouette while the
 * wordmark remains a separate continuity anchor.
 */
export function StartripsLamb({ className = "", state = "rest", title }: StartripsLambProps) {
  const labelled = Boolean(title);
  return (
    <svg
      className={`startrips-lamb is-${state} ${className}`}
      viewBox="0 0 120 96"
      role={labelled ? "img" : undefined}
      aria-label={title}
      aria-hidden={labelled ? undefined : true}
      focusable="false"
    >
      <g className="startrips-lamb__motion">
        <g className="startrips-lamb__legs-motion">
          <g className="startrips-lamb__leg-motion startrips-lamb__leg-motion--rear">
            <path
              className="startrips-lamb__legs"
              d="M27 57h8v22c0 2-2 3-4 3s-4-1-4-3Z"
            />
          </g>
          <g className="startrips-lamb__leg-motion startrips-lamb__leg-motion--middle">
            <path
              className="startrips-lamb__legs"
              d="M53 59h8v20c0 2-2 3-4 3s-4-1-4-3Z"
            />
          </g>
          <g className="startrips-lamb__leg-motion startrips-lamb__leg-motion--front">
            <path
              className="startrips-lamb__legs"
              d="M75 57h8v22c0 2-2 3-4 3s-4-1-4-3Z"
            />
          </g>
        </g>
        <g className="startrips-lamb__body-motion">
          <path
            className="startrips-lamb__body"
            d="M18 51c0-10 8-17 20-18 7-8 21-8 30-1 10-3 20 2 23 10 8 3 10 11 5 16-5 6-15 7-23 3-10 6-23 5-31 0-10 3-21 0-24-10Z"
          />
        </g>
        <g className="startrips-lamb__head-motion">
          <path
            className="startrips-lamb__ear"
            d="M87 29c0-7 4-12 10-14 1 6-1 11-5 15Z"
          />
          <path
            className="startrips-lamb__head"
            d="M70 49c3-10 10-18 20-21 6-2 11 1 15 4l10 5c3 2 3 5 0 6l-10 2-5 5c-7 4-16 4-22 1Z"
          />
        </g>
      </g>
    </svg>
  );
}

type StartripsBrandMarkProps = {
  className?: string;
  loading?: boolean;
  size?: number;
  state?: StartripsBrandState;
  title?: string;
};

/** A small companion travelling toward the star at the top-right. */
export function StartripsBrandMark({
  className = "",
  loading = false,
  size = 64,
  state,
  title,
}: StartripsBrandMarkProps) {
  const brandState = state ?? (loading ? "waiting" : "rest");
  const isWaiting = brandState === "waiting" || loading;
  return (
    <span
      className={`startrips-brand-mark is-${brandState}${isWaiting ? " is-loading" : ""} ${className}`}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      data-brand-state={brandState}
      style={{ "--startrips-mark-size": `${size}px` } as CSSProperties}
    >
      <StartripsLamb
        className="startrips-brand-mark__lamb"
        state={brandState}
      />
      <StartripsLoadingPoints className="startrips-brand-mark__loading-points" />
      <span className="startrips-brand-mark__orbit" aria-hidden="true" />
      <IconSparkle className="startrips-brand-mark__star" size={16} stroke={1.25} fill="currentColor" aria-hidden="true" />
    </span>
  );
}

/** The destination is the sparkle sitting on the i; accessible text remains Startrips. */
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
  const firstLetters = ["s", "t", "a", "r", "t", "r"];
  return (
    <span
      className={`startrips-wordmark${intro ? " is-intro" : ""}${loading ? " is-loading" : ""} is-${wordmarkState} ${className}`}
      role="img"
      aria-label="Startrips"
      data-brand-state={wordmarkState}
      style={{ "--startrips-wordmark-size": `${size}px` } as CSSProperties}
    >
      <span className="startrips-wordmark__letters" aria-hidden="true">
        {firstLetters.map((letter, index) => (
          <span className="startrips-wordmark__letter" data-letter-index={index} key={`${letter}-${index}`}>
            {letter}
          </span>
        ))}
        <span className="startrips-wordmark__i" data-letter-index="6">
          ı
          <IconSparkle className="startrips-wordmark__star" stroke={1.25} fill="currentColor" aria-hidden="true" />
          <StartripsLoadingPoints className="startrips-wordmark__loading-points" />
          <span className="startrips-wordmark__wait-orbit" aria-hidden="true" />
        </span>
        <span className="startrips-wordmark__letter" data-letter-index="7">p</span>
        <span className="startrips-wordmark__letter" data-letter-index="8">s</span>
      </span>
      {companion ? (
        <StartripsLamb
          className="startrips-wordmark__lamb"
          state={wordmarkState}
        />
      ) : null}
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

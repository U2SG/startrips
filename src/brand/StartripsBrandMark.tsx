import type { CSSProperties } from "react";

type StartripsBrandMarkProps = {
  className?: string;
  loading?: boolean;
  size?: number;
  title?: string;
};

export function StartripsBrandMark({
  className = "",
  loading = false,
  size = 64,
  title,
}: StartripsBrandMarkProps) {
  const label = title ?? "Startrips";
  const style = { "--startrips-mark-size": `${size}px` } as CSSProperties;
  return (
    <svg
      className={`startrips-brand-mark${loading ? " is-loading" : ""}${className ? ` ${className}` : ""}`}
      viewBox="0 0 64 64"
      role={title ? "img" : undefined}
      aria-label={title ? label : undefined}
      aria-hidden={title ? undefined : true}
      style={style}
    >
      {title ? <title>{label}</title> : null}
      <path
        className="startrips-brand-mark__planet"
        pathLength="1"
        d="M42.6 49.3A20.3 20.3 0 1 0 42.6 14.7"
      />
      <path
        className="startrips-brand-mark__journey"
        pathLength="1"
        d="M41.8 46.2C35 45.8 31.7 40.5 32.2 34.6C32.7 28.4 37.4 25.7 39.6 21.3C41 18.5 43.7 17.4 47.4 17.9"
      />
      <circle className="startrips-brand-mark__waypoint" cx="33.9" cy="36.1" r="2.45" />
      <path
        className="startrips-brand-mark__star"
        d="M48.1 14.7L49.05 16.95L51.3 17.9L49.05 18.85L48.1 21.1L47.15 18.85L44.9 17.9L47.15 16.95Z"
      />
    </svg>
  );
}

export function StartripsBrandLoader({ message }: { message: string }) {
  return (
    <div className="startrips-brand-loader" role="status" aria-live="polite">
      <StartripsBrandMark loading size={72} />
      <div className="startrips-brand-loader__copy">
        <strong>STARTRIPS</strong>
        <span>{message}</span>
      </div>
    </div>
  );
}
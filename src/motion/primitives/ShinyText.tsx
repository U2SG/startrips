import type { CSSProperties, ReactNode } from "react";
import { prefersReducedMotion } from "../preferences";

type ShinyTextProps = {
  children: ReactNode;
  className?: string;
  /** Full sweep duration in milliseconds. */
  duration?: number;
};

/**
 * ML-13 ShinyText (React Bits adaptation).
 *
 * A soft highlight sweeps across the text while its base color stays
 * currentColor. Reduced-motion users get a static, fully readable render.
 */
export function ShinyText({ children, className, duration = 3600 }: ShinyTextProps) {
  const reduced = prefersReducedMotion();
  const style: CSSProperties = {
    backgroundImage:
      "linear-gradient(120deg, currentColor 40%, rgba(255,255,255,0.9) 50%, currentColor 60%)",
    backgroundSize: "220% 100%",
    backgroundPosition: reduced ? "0% 0%" : "140% 0%",
    backgroundClip: "text",
    WebkitBackgroundClip: "text",
    WebkitTextFillColor: "transparent",
    animation: reduced
      ? undefined
      : `shinyTextSweep ${duration}ms ease-in-out infinite`,
  };
  return (
    <span className={className} style={style} data-shiny-text>
      {children}
    </span>
  );
}

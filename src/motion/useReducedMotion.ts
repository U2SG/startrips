import { useEffect, useState } from "react";
import {
  MOTION_REDUCED_QUERY,
  onMotionPreferenceChange,
  prefersReducedMotion,
} from "./preferences";

/**
 * React hook over the unified reduced-motion preference (#17 Motion Language).
 *
 * Tier 2/3 effects must degrade to a crossfade or an instant state under
 * reduced motion; continuous particle drift / route pulse / soundtrack strip
 * flow stops. Use this hook (or `prefersReducedMotion()` for one-shot reads)
 * instead of scattering `matchMedia` calls.
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => prefersReducedMotion());
  useEffect(() => onMotionPreferenceChange(setReduced), []);
  return reduced;
}

export { MOTION_REDUCED_QUERY };

import { useEffect, useState } from "react";

export const COMPACT_MOBILE_MEDIA_QUERY = "(max-width: 760px), (max-width: 960px) and (max-height: 480px) and (any-pointer: coarse)";

/**
 * #194: the query above is the ONE definition of compact mobile mode and it is
 * never copied into a stylesheet. Every product surface that needs to style
 * itself for that mode carries this attribute, set from the resolved boolean,
 * and its CSS keys off the attribute. A stylesheet therefore cannot drift from
 * the contract, because it no longer states a breakpoint at all.
 */
export const COMPACT_MOBILE_LAYOUT_ATTRIBUTE = "data-mobile-v2";

export function compactMobileLayoutMarker(compact: boolean) {
  return compact ? "on" : "off";
}

export function useCompactMobileLayout() {
  const [mobile, setMobile] = useState(() => (
    globalThis.matchMedia?.(COMPACT_MOBILE_MEDIA_QUERY).matches ?? false
  ));

  useEffect(() => {
    const media = globalThis.matchMedia?.(COMPACT_MOBILE_MEDIA_QUERY);
    if (!media) return;
    const update = () => setMobile(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  return mobile;
}

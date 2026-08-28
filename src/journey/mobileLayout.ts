import { useEffect, useState } from "react";

export const COMPACT_MOBILE_MEDIA_QUERY = "(max-width: 760px), (max-height: 480px) and (any-pointer: coarse)";

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

import { useSyncExternalStore } from "react";

/** Browser-local layout trials, independent of the author's media presentation. */
export const MOBILE_CLASSIC_VIEWS = [
  { id: "light", letter: "A", label: "轻量经典" },
  { id: "thumb", letter: "B", label: "单手操作" },
  { id: "photo", letter: "C", label: "照片优先" },
  { id: "earth", letter: "D", label: "地球优先" },
] as const;
export type MobileClassicView = typeof MOBILE_CLASSIC_VIEWS[number]["id"];
export const MOBILE_CLASSIC_VIEW_KEY = "startrips.mobile-classic-view.v1";

export function parseMobileClassicView(value: unknown): MobileClassicView {
  return MOBILE_CLASSIC_VIEWS.find((view) => view.id === value)?.id ?? "light";
}
export function nextMobileClassicView(value: unknown): MobileClassicView {
  const index = MOBILE_CLASSIC_VIEWS.findIndex((view) => view.id === parseMobileClassicView(value));
  return MOBILE_CLASSIC_VIEWS[(index + 1) % MOBILE_CLASSIC_VIEWS.length].id;
}

// A blocked storage adapter still supports switching for this visit.
export function createMobileClassicPreference(storage: Pick<Storage, "getItem" | "setItem"> | null) {
  let current: MobileClassicView = "light";
  try { current = parseMobileClassicView(storage?.getItem(MOBILE_CLASSIC_VIEW_KEY)); } catch { /* Private storage. */ }
  return {
    read: () => current,
    select(value: unknown) {
      current = parseMobileClassicView(value);
      try { storage?.setItem(MOBILE_CLASSIC_VIEW_KEY, current); } catch { /* Keep the in-session choice. */ }
      return current;
    },
    receive(value: unknown) { current = parseMobileClassicView(value); },
  };
}

let preference: ReturnType<typeof createMobileClassicPreference> | undefined;
const listeners = new Set<() => void>();
function getPreference() {
  if (!preference) {
    let storage: Storage | null = null;
    try { if (typeof window !== "undefined") storage = window.localStorage; } catch { /* Storage denied. */ }
    preference = createMobileClassicPreference(storage);
  }
  return preference;
}
function read() { return getPreference().read(); }
function subscribe(notify: () => void) {
  listeners.add(notify);
  const onStorage = (event: StorageEvent) => {
    if (event.key !== MOBILE_CLASSIC_VIEW_KEY && event.key !== null) return;
    getPreference().receive(event.newValue);
    for (const listener of listeners) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => { listeners.delete(notify); window.removeEventListener("storage", onStorage); };
}
export function useMobileClassicView() {
  const view = useSyncExternalStore(subscribe, read, () => "light" as const);
  const cycle = () => {
    getPreference().select(nextMobileClassicView(read()));
    for (const listener of listeners) listener();
  };
  return [view, cycle] as const;
}

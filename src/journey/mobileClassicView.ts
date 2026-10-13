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
  let storedValue: string | null = null;
  let sessionOnly = false;
  try {
    storedValue = storage?.getItem(MOBILE_CLASSIC_VIEW_KEY) ?? null;
    current = parseMobileClassicView(storedValue);
  } catch { /* Private storage. */ }
  return {
    read: () => current,
    // Story may have been unmounted when another tab changed the preference.
    // A failed write remains authoritative in this visit until storage actually
    // changes; a successful stale read must not discard that in-session choice.
    refresh() {
      if (!storage) return;
      try {
        const next = storage.getItem(MOBILE_CLASSIC_VIEW_KEY);
        if (!sessionOnly || next !== storedValue) {
          current = parseMobileClassicView(next);
          sessionOnly = false;
        }
        storedValue = next;
      } catch { /* Retain the current choice while storage is unavailable. */ }
    },
    select(value: unknown) {
      current = parseMobileClassicView(value);
      sessionOnly = true;
      try {
        if (storage) {
          storage.setItem(MOBILE_CLASSIC_VIEW_KEY, current);
          storedValue = current;
          sessionOnly = false;
        }
      } catch { /* Keep the in-session choice. */ }
      return current;
    },
    receive(value: string | null) {
      storedValue = value;
      current = parseMobileClassicView(value);
      sessionOnly = false;
    },
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
  const previous = read();
  getPreference().refresh();
  if (read() !== previous) for (const listener of listeners) listener();
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

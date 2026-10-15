import { useLayoutEffect, useRef, type RefObject } from "react";
import { clampPhoto, fitPhoto, panPhoto, pinchPhoto, zoomPhotoAt, PHOTO_FIT, type PhotoPoint, type PhotoTransform } from "./photoViewport";

type Options = {
  root: RefObject<HTMLDivElement | null>;
  image: () => HTMLImageElement | null;
  enabled: boolean;
  identity: string;
  cancelPageGesture: () => void;
  onHolding: (holding: boolean) => void;
  onConsumed: () => void;
};

/** Owns only a photo's local transform; the existing stage owns media and paging. */
export function usePhotoPanZoom(options: Options) {
  const latest = useRef(options);
  latest.current = options;
  const actions = useRef({ reset: () => {} });

  useLayoutEffect(() => {
    const root = options.root.current;
    const image = options.image();
    if (!options.enabled || !root || !image) return;
    const page = image.parentElement;
    if (!page) return;
    let value: PhotoTransform = { ...PHOTO_FIT };
    let alive = true;
    let owned = false;
    let holding = false;
    let swallowClick = false;
    const pointers = new Map<number, PhotoPoint>();
    const captures = new Set<number>();
    let gesture: { origin: PhotoTransform; anchor: PhotoPoint; distance: number } | null = null;
    const previousTransform = image.style.transform;
    const previousTouchAction = root.style.touchAction;
    root.style.touchAction = "none";
    root.dataset.photoZoomEnabled = "true";

    const bounds = () => fitPhoto({ width: page.clientWidth, height: page.clientHeight },
      { width: image.naturalWidth, height: image.naturalHeight });
    const point = (x: number, y: number): PhotoPoint => {
      const rect = page.getBoundingClientRect();
      return { x: x - rect.left - rect.width / 2, y: y - rect.top - rect.height / 2 };
    };
    const interactive = (target: EventTarget | null) => target instanceof Element
      && Boolean(target.closest("button, input, select, textarea, a, video, [contenteditable], [role='button']:not(img)"));
    const updateHold = () => {
      const next = owned || value.scale > 1;
      if (next === holding) return;
      holding = next;
      latest.current.onHolding(next);
    };
    const paint = (next: PhotoTransform) => {
      value = next;
      image.style.transform = next.scale === 1 ? previousTransform
        : `translate3d(${next.x}px, ${next.y}px, 0) scale(${next.scale})`;
      root.dataset.photoZoomed = String(next.scale > 1);
      root.dataset.photoZoomScale = String(next.scale);
      if (next.scale > 1) delete root.dataset.clickDirection;
      updateHold();
    };
    const release = () => {
      owned = false;
      gesture = null;
      const ids = [...captures];
      captures.clear();
      pointers.clear();
      delete root.dataset.photoPanning;
      for (const id of ids) {
        try { if (root.hasPointerCapture(id)) root.releasePointerCapture(id); } catch { /* Already cancelled. */ }
      }
      updateHold();
    };
    const reset = () => { release(); paint({ ...PHOTO_FIT }); };
    const zoom = (scale: number, anchor: PhotoPoint = { x: 0, y: 0 }) => {
      const box = bounds();
      if (!alive || !box) return;
      latest.current.cancelPageGesture();
      release();
      paint(zoomPhotoAt(value, scale, anchor, box));
      latest.current.onConsumed();
    };
    const baseline = () => {
      const [a, b] = [...pointers.values()];
      if (!a) { gesture = null; return; }
      gesture = { origin: { ...value },
        anchor: b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : a,
        distance: b ? Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)) : 0 };
    };
    const claim = () => {
      latest.current.cancelPageGesture();
      owned = true;
      swallowClick = true;
      latest.current.onConsumed();
      for (const id of pointers.keys()) {
        try { root.setPointerCapture(id); captures.add(id); } catch { /* The matching cancel cleans up. */ }
      }
      root.dataset.photoPanning = "true";
      baseline();
      updateHold();
    };
    const consume = (event: Event) => { if (event.cancelable) event.preventDefault(); event.stopPropagation(); };
    const down = (event: PointerEvent) => {
      if (interactive(event.target) || (event.pointerType !== "touch" && event.button !== 0)) return;
      if (pointers.size === 0) swallowClick = false;
      if (pointers.size >= 2) { if (owned) consume(event); return; }
      pointers.set(event.pointerId, point(event.clientX, event.clientY));
      if (value.scale > 1 || pointers.size === 2) { claim(); consume(event); }
      // At fit scale a single pointer is still owned by the existing swipe.
    };
    const move = (event: PointerEvent) => {
      if (!pointers.has(event.pointerId)) return;
      pointers.set(event.pointerId, point(event.clientX, event.clientY));
      if (!owned || !gesture) return;
      const box = bounds();
      if (!box) { reset(); return; }
      const [a, b] = [...pointers.values()];
      if (b && gesture.distance > 0) {
        paint(pinchPhoto(gesture.origin, gesture.anchor, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
          gesture.origin.scale * Math.hypot(b.x - a.x, b.y - a.y) / gesture.distance, box));
      } else paint(panPhoto(gesture.origin, { x: a.x - gesture.anchor.x, y: a.y - gesture.anchor.y }, box));
      consume(event);
    };
    const up = (event: PointerEvent) => {
      if (!pointers.has(event.pointerId)) return;
      const wasOwned = owned;
      if (!wasOwned) { pointers.delete(event.pointerId); return; }
      move(event);
      pointers.delete(event.pointerId);
      if (captures.delete(event.pointerId)) {
        try { if (root.hasPointerCapture(event.pointerId)) root.releasePointerCapture(event.pointerId); } catch { /* Released. */ }
      }
      if (pointers.size) baseline();
      else release();
      if (wasOwned) consume(event);
    };
    const cancel = (event: PointerEvent) => {
      if (!pointers.has(event.pointerId)) return;
      if (event.type === "lostpointercapture" && (event.target !== root || root.hasPointerCapture(event.pointerId))) return;
      const wasOwned = owned;
      if (!wasOwned) { pointers.delete(event.pointerId); return; }
      release();
      if (wasOwned) { swallowClick = true; latest.current.onConsumed(); consume(event); }
    };
    const leave = (event: PointerEvent) => {
      if (!owned && !root.hasPointerCapture(event.pointerId)) pointers.delete(event.pointerId);
    };
    const click = (event: MouseEvent) => {
      if (interactive(event.target)) return;
      if (value.scale > 1 || (swallowClick && event.detail !== 0)) {
        swallowClick = false;
        latest.current.onConsumed();
        consume(event);
      }
    };
    const wheel = (event: WheelEvent) => {
      // Ctrl/Meta wheel is browser accessibility zoom, not a photo command.
      if (event.ctrlKey || event.metaKey || interactive(event.target) || !event.deltaY) return;
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? page.clientHeight : 1);
      zoom(value.scale * Math.exp(-Math.max(-240, Math.min(240, delta)) / 400), point(event.clientX, event.clientY));
      consume(event);
    };
    const key = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey || interactive(event.target)) return;
      if (event.key === "+" || event.key === "=") zoom(value.scale * 1.5);
      else if (event.key === "-") zoom(value.scale / 1.5);
      else if (event.key === "0") reset();
      else return;
      consume(event);
    };
    const resize = () => {
      if (!alive) return;
      const box = bounds();
      if (!box) { reset(); return; }
      release();
      paint(clampPhoto(value, box));
    };
    const hide = () => { if (document.hidden) reset(); };
    const pointerEvents = { pointerdown: down, pointermove: move, pointerup: up, pointercancel: cancel,
      lostpointercapture: cancel, pointerleave: leave };
    for (const [name, handler] of Object.entries(pointerEvents)) root.addEventListener(name, handler as EventListener, true);
    root.addEventListener("click", click, true);
    root.addEventListener("keydown", key, true);
    root.addEventListener("wheel", wheel, { passive: false });
    window.addEventListener("blur", reset);
    document.addEventListener("visibilitychange", hide);
    const observer = new ResizeObserver(resize);
    observer.observe(page);
    image.addEventListener("load", resize);
    paint({ ...PHOTO_FIT });
    actions.current = { reset };
    return () => {
      alive = false;
      for (const [name, handler] of Object.entries(pointerEvents)) root.removeEventListener(name, handler as EventListener, true);
      root.removeEventListener("click", click, true);
      root.removeEventListener("keydown", key, true);
      root.removeEventListener("wheel", wheel);
      window.removeEventListener("blur", reset);
      document.removeEventListener("visibilitychange", hide);
      observer.disconnect();
      image.removeEventListener("load", resize);
      release();
      image.style.transform = previousTransform;
      root.style.touchAction = previousTouchAction;
      delete root.dataset.photoZoomEnabled;
      delete root.dataset.photoZoomed;
      delete root.dataset.photoZoomScale;
      if (holding) { holding = false; latest.current.onHolding(false); }
      actions.current = { reset: () => {} };
    };
  }, [options.enabled, options.identity, options.root]);

  return { reset: () => actions.current.reset() };
}

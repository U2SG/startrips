export type ScrollMetrics = { scrollTop: number; scrollHeight: number; clientHeight: number };
export type ScrollEdges = { before: boolean; after: boolean };

/** Fractional positions and elastic overscroll never invent another edge. */
export function scrollEdges({ scrollTop, scrollHeight, clientHeight }: ScrollMetrics): ScrollEdges {
  if (![scrollTop, scrollHeight, clientHeight].every(Number.isFinite) || clientHeight <= 0) return { before: false, after: false };
  const maximum = Math.max(0, scrollHeight - clientHeight);
  if (maximum <= 1) return { before: false, after: false };
  const position = Math.max(0, Math.min(maximum, scrollTop));
  return { before: position > 1, after: maximum - position > 1 };
}

/** Bounded DOM observation; no polling, no component renders on scroll. */
export function observeScrollEdges(element: HTMLElement): () => void {
  const previous = { before: element.getAttribute("data-scroll-before"), after: element.getAttribute("data-scroll-after") };
  let frame = 0;
  let alive = true;
  const publish = () => {
    frame = 0;
    if (!alive) return;
    const edges = scrollEdges(element);
    for (const key of ["before", "after"] as const) {
      const name = `data-scroll-${key}`;
      const value = String(edges[key]);
      if (element.getAttribute(name) !== value) element.setAttribute(name, value);
    }
  };
  const schedule = () => { if (alive && !frame) frame = requestAnimationFrame(publish); };
  const resize = new ResizeObserver(schedule);
  const observeContent = () => {
    if (!alive) return;
    resize.disconnect();
    resize.observe(element);
    // A fixed viewport can remain unchanged while an auto-sized child grows.
    for (const child of Array.from(element.children)) resize.observe(child);
    schedule();
  };
  const mutation = new MutationObserver(observeContent);
  mutation.observe(element, { childList: true, subtree: true, characterData: true });
  element.addEventListener("scroll", schedule, { passive: true });
  observeContent();
  // Keep the scheduled first measurement cancellable during immediate unmount.
  return () => {
    alive = false;
    if (frame) cancelAnimationFrame(frame);
    element.removeEventListener("scroll", schedule);
    resize.disconnect();
    mutation.disconnect();
    for (const key of ["before", "after"] as const) {
      const name = `data-scroll-${key}`;
      if (previous[key] === null) element.removeAttribute(name);
      else element.setAttribute(name, previous[key]!);
    }
  };
}

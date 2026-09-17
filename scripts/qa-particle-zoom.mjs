/** Establish fixture zoom with one real DOM wheel event, not a stale host snapshot.
 * The focus flight can advance between Playwright round trips. Read the current
 * zoom, bounds and dispatch together; then observe rendered frames without
 * repeating input or increasing a timeout. Native-wheel tests stay separate.
 */
export async function setParticleZoom(page, targetZoom, anchor = null) {
  if (!Number.isFinite(targetZoom) || targetZoom <= 0) {
    throw new Error("Particle QA zoom target must be finite and positive");
  }
  return page.locator('canvas[data-three-scene="particle-earth"]').evaluate(
    async (node, { targetZoom, anchor }) => {
      const read = () => window.__particleEarthDebug?.() ?? null;
      const before = read();
      if (!before || !Number.isFinite(before.zoom) || before.zoom <= 0) {
        throw new Error("Particle Earth debug zoom is unavailable");
      }
      const bounds = node.getBoundingClientRect();
      if (!node.isConnected || bounds.width <= 0 || bounds.height <= 0) {
        throw new Error("Particle Earth canvas has no connected bounds");
      }
      let point = anchor;
      if (anchor?.kind === "focus") {
        // A named-place fixture must keep zooming on that PLACE, not the canvas
        // centre after the first wheel has claimed manual camera ownership.
        // Read geographic identity and its projected point in this same callback.
        const data = node.closest(".particle-earth-scene")?.dataset;
        const values = [data?.personalPointX, data?.personalPointY, data?.focusPointLat, data?.focusPointLon];
        if (values.some((value) => value == null || value.trim() === "" || !Number.isFinite(Number(value)))
            || !Number.isFinite(anchor.lat) || !Number.isFinite(anchor.lon)
            || Math.abs(Number(values[2]) - anchor.lat) > 0.001
            || Math.abs(Number(values[3]) - anchor.lon) > 0.001) {
          throw new Error("Particle QA focus anchor is missing or belongs to another place");
        }
        // The scene publishes personalPoint in canvas-local CSS coordinates.
        point = { x: bounds.x + Number(values[0]), y: bounds.y + Number(values[1]) };
        if (point.x < bounds.x || point.x > bounds.x + bounds.width
            || point.y < bounds.y || point.y > bounds.y + bounds.height) {
          throw new Error("Particle QA focus anchor is outside the canvas");
        }
      }
      point ??= { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
        throw new Error("Particle QA zoom anchor must be finite");
      }
      // Even a zero-delta event must claim manual ownership so an in-flight
      // focus animation cannot move a fixture which happened to start at target.
      const event = new WheelEvent("wheel", {
        bubbles: true, cancelable: true, clientX: point.x, clientY: point.y,
        deltaY: -Math.log(targetZoom / before.zoom) / 0.0012,
      });
      node.dispatchEvent(event);
      const applied = read();
      if (!event.defaultPrevented || !applied || !Number.isFinite(applied.zoom)
          || Math.abs(applied.zoom - targetZoom) > 0.03) {
        throw new Error(`Particle QA wheel was not applied exactly: ${JSON.stringify({ targetZoom, before, applied })}`);
      }
      await new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      });
      const after = read();
      if (!after || !Number.isFinite(after.zoom) || Math.abs(after.zoom - targetZoom) > 0.03) {
        throw new Error(`Particle QA zoom changed after input: ${JSON.stringify({ targetZoom, applied, after })}`);
      }
      return after;
    },
    { targetZoom, anchor },
  );
}

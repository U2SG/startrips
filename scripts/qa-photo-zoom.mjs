import assert from "node:assert/strict";

/** Real input against the existing full-screen Story, not a replacement viewer. */
export async function assertPhotoZoom(page, touch = false) {
  const selector = ".journey-story-fullscreen [data-story-media-pages]";
  const stage = page.locator(selector);
  await page.waitForFunction((selector) => document.querySelector(selector)?.dataset.photoZoomEnabled === "true",
    selector, { polling: "raf", timeout: 3_000 });
  await page.locator('[data-shared-element-clone^="story-fullscreen"]').waitFor({ state: "detached", timeout: 3_000 });
  const read = () => stage.evaluate((root) => {
    const owner = root.querySelector('[data-media-presented="true"]');
    const image = owner.querySelector("img");
    const cssTransform = getComputedStyle(image).transform;
    const transform = new DOMMatrixReadOnly(cssTransform === "none" ? undefined : cssTransform);
    const rect = owner.getBoundingClientRect();
    const fit = Math.min(owner.clientWidth / image.naturalWidth, owner.clientHeight / image.naturalHeight);
    return { id: owner.dataset.mediaPresentationId, scale: transform.a, x: transform.e, y: transform.f,
      centre: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
      width: owner.clientWidth, height: owner.clientHeight,
      fittedWidth: image.naturalWidth * fit, fittedHeight: image.naturalHeight * fit,
      panning: root.dataset.photoPanning, zoomed: root.dataset.photoZoomed };
  });
  const initial = await read();
  const activate = async (name) => {
    const button = stage.getByRole("button", { name, exact: true });
    const rect = await button.boundingBox();
    assert.ok(rect && rect.width >= 44 && rect.height >= 44, `${name} needs a full touch target`);
    if (touch) await button.tap(); else await button.click();
  };
  if (touch) {
    const session = await page.context().newCDPSession(page);
    try {
      const { x, y } = initial.centre;
      await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [
        { x: x - 30, y, id: 1 }, { x: x + 30, y, id: 2 },
      ] });
      await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [
        { x: x - 40, y: y + 5, id: 1 }, { x: x + 60, y: y + 5, id: 2 },
      ] });
      const pinched = await read();
      assert.ok(Math.abs(pinched.scale - 100 / 60) < .02, "Pinch scale must use the initial two-pointer distance");
      assert.equal(pinched.id, initial.id, "Pinching must not select another media page");
      // Lift one finger, pan with the remaining one, then cancel the real touch stream.
      await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [{ x: x - 40, y: y + 5, id: 1 }] });
      await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x - 30, y: y + 15, id: 1 }] });
      await session.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
      assert.equal((await read()).panning, undefined, "Cancellation releases photo pointer ownership");
      assert.equal((await read()).id, initial.id, "A remaining pinch finger must not become a page swipe");
    } finally { await session.detach(); }
  } else {
    const anchor = { x: initial.fittedWidth * .08, y: initial.fittedHeight * .08 };
    await page.mouse.move(initial.centre.x + anchor.x, initial.centre.y + anchor.y);
    await page.mouse.wheel(0, -160);
    await page.waitForFunction((selector) => Number(document.querySelector(selector)?.dataset.photoZoomScale) > 1,
      selector, { polling: "raf", timeout: 3_000 });
    const zoomed = await read();
    const limit = (axis, scale) => Math.max(0, ((axis === "x" ? initial.fittedWidth : initial.fittedHeight) * scale
      - (axis === "x" ? initial.width : initial.height)) / 2);
    const clamp = (value, maximum) => Math.max(-maximum, Math.min(maximum, value));
    for (const axis of ["x", "y"]) assert.ok(Math.abs(zoomed[axis] - clamp(anchor[axis] * (1 - zoomed.scale), limit(axis, zoomed.scale))) < .5,
      `Wheel zoom must preserve its ${axis} anchor within actual image bounds`);
    await page.mouse.move(initial.centre.x, initial.centre.y);
    await page.mouse.down();
    await page.mouse.move(initial.centre.x + 5, initial.centre.y + 5);
    await page.mouse.move(initial.centre.x + 10, initial.centre.y + 10);
    const panned = await read();
    for (const axis of ["x", "y"]) assert.ok(Math.abs(panned[axis] - clamp(zoomed[axis] + 10, limit(axis, zoomed.scale))) < .5,
      `Pan ${axis} must use a fixed pointer-down origin, not accumulated total deltas`);
    await page.mouse.up();
    assert.equal((await read()).id, initial.id, "Photo pan must not navigate or dismiss");
  }
  await activate("还原照片");
  const reset = await read();
  assert.equal(reset.scale, 1);
  assert.equal(reset.x, 0);
  assert.equal(reset.y, 0);
  assert.equal(reset.id, initial.id);
  await activate("放大照片");
  assert.ok((await read()).scale > 1, "Accessible controls zoom independently of pointer gestures");
  await activate("还原照片");
  assert.ok(await page.locator(".journey-story-fullscreen").isVisible());
  console.log(JSON.stringify({ name: touch ? "story-photo-pinch-cancel" : "story-photo-zoom-anchor-pan", id: initial.id, reset }));
}

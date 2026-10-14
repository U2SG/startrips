import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { decodeCloneFrameStamp, encodeCloneFrameStamp } from './qa-clone-frame-stamp.mjs';
import { installCloneScreenProbe } from './qa-clone-screen-capture.mjs';

const NAME = 'story-fullscreen-fixture';
const RUN_ID = 0x9a73c5e1;
const SELECTOR = '[data-shared-element-clone]';
const plain = (value) => JSON.parse(JSON.stringify(value));

// Only the DOM, raster, animation and scheduling primitives used by the injected
// installer are faked. The production installer and stamp codec run unchanged.
// Mutations are delivered separately from RAF, at the simulated paint's
// microtask checkpoint, so detach tests cannot accidentally pass via a new RAF.
function fixture({ stationary = false, width = 360, height = 240,
  deviceScaleFactor = 1, viewportScale = 1, iframe = false } = {}) {
  const observers = new Set();
  const rafs = new Map();
  const canvases = [];
  let nextRaf = 0;
  let time = 0;
  let body;
  const enqueue = (record) => {
    for (const observer of observers) {
      if (!observer.active) continue;
      if (record.type === 'attributes'
        && !observer.options.attributeFilter.includes(record.attributeName)) continue;
      observer.records.push(record);
    }
  };
  class FakeElement {
    constructor(tagName = 'div') {
      this.tagName = tagName;
      this.parentElement = null;
      this.children = [];
      this.attributes = new Map();
      this.style = {};
      Object.defineProperty(this.style, 'cssText', {
        set(text) {
          for (const declaration of text.split(';')) {
            const [property, value] = declaration.split(':');
            if (property && value) this[property.trim()] = value.trim();
          }
        },
      });
      this.rect = { x: 80, y: 40, width: 160, height: 120 };
      this.animations = [];
    }
    get isConnected() { return this === body || Boolean(this.parentElement?.isConnected); }
    setAttribute(name, value) {
      this.attributes.set(name, String(value));
      if (this.isConnected) enqueue({ type: 'attributes', target: this, attributeName: name });
    }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    removeAttribute(name) {
      this.attributes.delete(name);
      if (this.isConnected) enqueue({ type: 'attributes', target: this, attributeName: name });
    }
    matches(selector) { return selector === SELECTOR && this.attributes.has('data-shared-element-clone'); }
    querySelectorAll(selector) {
      return this.children.flatMap((child) => [
        ...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector),
      ]);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
    append(child) {
      child.remove();
      child.parentElement = this;
      this.children.push(child);
      if (this.isConnected) enqueue({ type: 'childList', target: this, addedNodes: [child], removedNodes: [] });
    }
    remove() {
      const parent = this.parentElement;
      if (!parent) return;
      const wasConnected = this.isConnected;
      parent.children.splice(parent.children.indexOf(this), 1);
      this.parentElement = null;
      if (wasConnected) enqueue({ type: 'childList', target: parent, addedNodes: [], removedNodes: [this] });
    }
    getBoundingClientRect() { return { ...this.rect }; }
    getAnimations() { return this.animations.slice(); }
  }
  class FakeCanvas extends FakeElement {
    constructor() {
      super('canvas');
      this._width = 300;
      this._height = 150;
      this._pixels = null;
      const canvas = this;
      this.context = {
        fillStyle: '#000',
        fillRect(x, y, width, height) {
          const hex = this.fillStyle.slice(1);
          const rgb = hex.length === 3 ? [...hex].map((digit) => parseInt(digit + digit, 16))
            : [0, 2, 4].map((start) => parseInt(hex.slice(start, start + 2), 16));
          for (let row = y; row < y + height; row += 1) {
            for (let column = x; column < x + width; column += 1) {
              canvas.pixels.set([...rgb, 255], (row * canvas.width + column) * 4);
            }
          }
        },
        drawImage(source, x, y) {
          // Copy bytes, never retain a reference to the source canvas pixels.
          for (let row = 0; row < source.height; row += 1) {
            for (let column = 0; column < source.width; column += 1) {
              const from = (row * source.width + column) * 4;
              const to = ((row + y) * canvas.width + column + x) * 4;
              canvas.pixels.set(source.pixels.subarray(from, from + 4), to);
            }
          }
        },
        getImageData() { return { data: new Uint8ClampedArray(canvas.pixels) }; },
      };
    }
    get width() { return this._width; }
    set width(value) { this._width = value; this._pixels = null; }
    get height() { return this._height; }
    set height(value) { this._height = value; this._pixels = null; }
    get pixels() { return this._pixels ??= new Uint8ClampedArray(this.width * this.height * 4); }
    getContext(type) { return type === '2d' ? this.context : null; }
  }
  class FakeMutationObserver {
    constructor(callback) { this.callback = callback; this.records = []; this.active = false; }
    observe(target, options) {
      assert.equal(target, body);
      assert.equal(options.subtree, true);
      assert.equal(options.childList, true);
      assert.equal(options.attributes, true);
      this.options = options;
      this.active = true;
      observers.add(this);
    }
    disconnect() { this.active = false; this.records = []; }
  }
  body = new FakeElement('body');
  const document = {
    body,
    createElement(tag) {
      const element = tag === 'canvas' ? new FakeCanvas() : new FakeElement(tag);
      if (tag === 'canvas') canvases.push(element);
      return element;
    },
    querySelectorAll: (selector) => body.querySelectorAll(selector),
  };
  const window = {};
  window.top = iframe ? {} : window;
  const globals = {
    document, window, Element: FakeElement, HTMLCanvasElement: FakeCanvas,
    MutationObserver: FakeMutationObserver,
    performance: { timeOrigin: 1_700_000_000_000, now: () => ++time },
    devicePixelRatio: deviceScaleFactor, visualViewport: { scale: viewportScale },
    innerWidth: width, innerHeight: height,
    getComputedStyle: (element) => Object.fromEntries(['transform', 'translate', 'rotate', 'scale']
      .map((property) => [property, element.style[property] ?? 'none'])),
    requestAnimationFrame: (callback) => { rafs.set(++nextRaf, callback); return nextRaf; },
    cancelAnimationFrame: (id) => rafs.delete(id),
  };
  const context = vm.createContext(globals);
  const flushMutations = () => {
    for (const observer of observers) {
      if (!observer.active || observer.records.length === 0) continue;
      const records = observer.records.splice(0);
      observer.callback(records);
    }
  };
  const api = {
    document, globals, rafs, canvases, flushMutations,
    get probe() { return window.__qaCloneScreen; },
    get marker() { return canvases.find((canvas) => canvas.getAttribute('aria-hidden') === 'true'); },
    animation(clone, { progress = 0.4, duration = 1000, keyframes } = {}) {
      return {
        playState: 'running',
        currentTime: progress * duration,
        effect: {
          target: clone,
          getTiming: () => ({ duration }),
          getKeyframes: () => keyframes ?? [
            { offset: 0, left: '80px', top: '40px', width: '160px', height: '120px', borderRadius: '8px' },
            { offset: 1, left: '20px', top: '20px', width: '300px', height: '200px', borderRadius: '0px' },
          ],
        },
      };
    },
    clone({ name = NAME, progress = 0.4, animated = !stationary, parent = body, rect } = {}) {
      const clone = document.createElement('canvas');
      clone.width = 8; clone.height = 6;
      clone.setAttribute('data-shared-element-clone', name);
      if (rect) clone.rect = { ...rect };
      clone.context.fillStyle = '#2b7fbd';
      clone.context.fillRect(0, 0, clone.width, clone.height);
      clone.animations = animated ? [api.animation(clone, { progress })] : [];
      if (parent) parent.append(clone);
      return clone;
    },
    start() {
      vm.runInContext(`(${installCloneScreenProbe.toString()})(${JSON.stringify({ name: NAME, stationary, runId: RUN_ID })}, (${encodeCloneFrameStamp.toString()}))`, context);
      return api.probe;
    },
    raf() {
      const callbacks = [...rafs.values()];
      rafs.clear();
      for (const callback of callbacks) callback(time);
    },
    paint() {
      flushMutations();
      const image = { width, height, channels: 4, data: new Uint8Array(width * height * 4).fill(113) };
      for (let index = 3; index < image.data.length; index += 4) image.data[index] = 255;
      const marker = api.marker;
      if (marker?.isConnected && marker.style.visibility === 'visible') {
        const x = Number.parseFloat(marker.style.left), y = Number.parseFloat(marker.style.top);
        for (let row = 0; row < marker.height; row += 1) {
          const start = row * marker.width * 4;
          image.data.set(marker.pixels.subarray(start, start + marker.width * 4), ((row + y) * width + x) * 4);
        }
      }
      return image;
    },
  };
  return api;
}

function assertUnstamped(harness, message) {
  assert.notEqual(harness.marker.style.visibility, 'visible', message);
  assert.deepEqual(decodeCloneFrameStamp(harness.paint(), RUN_ID), [], message);
}

test('the standalone installer retains the same usable bitmap and stamped observation after detach and stop', () => {
  const harness = fixture();
  const clone = harness.clone();
  const originalPixels = new Uint8ClampedArray(clone.pixels);
  const probe = harness.start();
  const bitmap = probe.bitmap;
  const history = probe.observations;
  const image = harness.paint();
  const [stamp] = decodeCloneFrameStamp(image, RUN_ID);
  assert.ok(stamp);
  assert.equal(stamp.observationId, 0);
  assert.equal(probe.clone, clone);
  assert.notEqual(bitmap, clone);
  assert.equal(bitmap.width, clone.width);
  assert.equal(bitmap.height, clone.height);
  assert.deepEqual(bitmap.pixels, originalPixels);
  assert.deepEqual(plain(history[stamp.observationId].position), stamp.position);
  assert.deepEqual(plain(probe.events).map(({ kind }) => kind), ['attached']);

  // Destroy the detached source's pixels; the capture must remain a deep copy.
  clone.remove();
  clone.width = 1; clone.height = 1;
  harness.flushMutations();
  assertUnstamped(harness, 'the next paint cannot contain the old stamp');
  assert.deepEqual(plain(probe.events).map(({ kind }) => kind), ['attached', 'detached']);
  probe.stop();
  assert.equal(probe.running, false);
  assert.equal(probe.observer.active, false);
  assert.equal(harness.rafs.size, 0);
  assert.equal(harness.marker.isConnected, false);
  assert.equal(probe.bitmap, bitmap);
  assert.equal(probe.observations, history);
  assert.equal(history.length, 1);
  assert.deepEqual(decodeCloneFrameStamp(image, RUN_ID), [stamp], 'already-painted frame stays valid');
  const readback = harness.document.createElement('canvas');
  readback.width = bitmap.width; readback.height = bitmap.height;
  readback.getContext('2d').drawImage(bitmap, 0, 0);
  assert.deepEqual(readback.getContext('2d').getImageData().data, originalPixels);
  harness.raf();
  assert.equal(history.length, 1);
});

for (const remove of ['clone', 'ancestor', 'attribute']) {
  test(`${remove} removal clears the witness at the mutation checkpoint before any future RAF`, () => {
    const harness = fixture();
    const wrapper = harness.document.createElement('div');
    harness.document.body.append(wrapper);
    const clone = harness.clone({ parent: wrapper });
    const probe = harness.start();
    assert.equal(harness.marker.style.visibility, 'visible');
    const pendingRaf = probe.raf;
    if (remove === 'clone') clone.remove();
    else if (remove === 'ancestor') wrapper.remove();
    else clone.removeAttribute('data-shared-element-clone');
    const nextPaint = harness.paint();
    assert.equal(probe.raf, pendingRaf, 'clearing must not depend on a new animation frame');
    assert.equal(probe.observations.length, 1);
    assert.equal(harness.marker.style.visibility, 'hidden');
    assert.deepEqual(decodeCloneFrameStamp(nextPaint, RUN_ID), []);
  });
}

test('only a connected, explicitly marked clone can create an observation', () => {
  const harness = fixture();
  const detached = harness.clone({ parent: null });
  const destination = harness.document.createElement('canvas');
  destination.setAttribute('data-shared-element', NAME);
  harness.document.body.append(destination);
  const probe = harness.start();
  assert.equal(probe.bitmap, null);
  assert.equal(probe.observations.length, 0);
  assertUnstamped(harness);
  harness.document.body.append(detached);
  harness.flushMutations();
  assert.equal(probe.clone, detached);
  assert.equal(probe.observations.length, 1);
  assert.equal(decodeCloneFrameStamp(harness.paint(), RUN_ID).length, 1);
});

for (const invalid of ['wrong name', 'extra matching clone', 'extra wrong clone', 'non-canvas']) {
  test(`${invalid} fails closed without publishing a frame`, () => {
    const harness = fixture();
    if (invalid === 'wrong name') harness.clone({ name: 'story-fullscreen-other' });
    else if (invalid === 'non-canvas') {
      const element = harness.document.createElement('div');
      element.setAttribute('data-shared-element-clone', NAME);
      harness.document.body.append(element);
    } else {
      harness.clone();
      harness.clone({ name: invalid === 'extra wrong clone' ? 'story-fullscreen-other' : NAME });
    }
    const probe = harness.start();
    assert.match(probe.fatal, /wrong, extra or non-canvas clone/);
    assert.equal(probe.observations.length, 0);
    assertUnstamped(harness);
  });
}

for (const change of ['replace', 'extra', 'rename']) {
  test(`${change} after a valid observation clears the old marker and remains fatal`, () => {
    const harness = fixture();
    const original = harness.clone();
    const probe = harness.start();
    const bitmap = probe.bitmap;
    if (change === 'replace') { original.remove(); harness.clone(); }
    else if (change === 'extra') harness.clone();
    else original.setAttribute('data-shared-element-clone', 'story-fullscreen-other');
    harness.flushMutations();
    assert.match(probe.fatal, change === 'replace' ? /clone generation changed/ : /wrong, extra or non-canvas clone/);
    assert.equal(probe.bitmap, bitmap);
    assert.equal(probe.observations.length, 1);
    assertUnstamped(harness);
    harness.raf();
    assert.equal(probe.observations.length, 1);
    assertUnstamped(harness);
  });
}

for (const progress of [0, 0.249999, 0.25, 0.4, 0.65, 0.650001, 1, NaN, Infinity, -Infinity]) {
  test(`animation progress ${progress} is ${progress >= 0.25 && progress <= 0.65 ? 'eligible' : 'ineligible'}`, () => {
    const harness = fixture();
    harness.clone({ progress });
    const probe = harness.start();
    const eligible = progress >= 0.25 && progress <= 0.65;
    assert.equal(probe.fatal, null);
    assert.equal(probe.observations.length, eligible ? 1 : 0);
    assert.equal(decodeCloneFrameStamp(harness.paint(), RUN_ID).length, eligible ? 1 : 0);
    if (eligible) assert.equal(probe.observations[0].progress, progress);
  });
}

test('leaving the eligible progress window clears an earlier valid witness', () => {
  const harness = fixture();
  const clone = harness.clone();
  const probe = harness.start();
  clone.animations[0].currentTime = 651;
  harness.raf();
  assert.equal(probe.observations.length, 1);
  assertUnstamped(harness);
});

for (const invalid of ['no animation', 'other target', 'null time', 'zero duration', 'non-numeric duration',
  'extra clone animation', 'extra unrelated animation', 'paused', 'finished', 'idle']) {
  test(`an animated probe rejects ${invalid}`, () => {
    const harness = fixture();
    const clone = harness.clone();
    if (invalid === 'no animation') clone.animations = [];
    else if (invalid === 'other target') clone.animations[0].effect.target = harness.document.body;
    else if (invalid === 'null time') clone.animations[0].currentTime = null;
    else if (invalid.startsWith('extra')) {
      clone.animations.push(harness.animation(invalid === 'extra clone animation' ? clone : harness.document.body));
    } else if (['paused', 'finished', 'idle'].includes(invalid)) clone.animations[0].playState = invalid;
    else clone.animations[0].effect.getTiming = () => ({ duration: invalid === 'zero duration' ? 0 : 'auto' });
    const probe = harness.start();
    assert.equal(probe.observations.length, 0);
    assertUnstamped(harness);
  });
}

test('stationary mode requires an attached actual clone and no animations', () => {
  const harness = fixture({ stationary: true });
  const clone = harness.clone({ parent: null });
  const settledDestination = harness.document.createElement('canvas');
  settledDestination.setAttribute('data-shared-element', NAME);
  harness.document.body.append(settledDestination);
  const probe = harness.start();
  assert.equal(probe.observations.length, 0);
  assertUnstamped(harness);
  harness.document.body.append(clone);
  harness.flushMutations();
  assert.equal(probe.observations.length, 1);
  assert.equal(probe.observations[0].stationary, true);
  assert.equal(probe.observations[0].progress, null);
  clone.remove();
  harness.flushMutations();
  assert.equal(probe.observations.length, 1);
  assertUnstamped(harness, 'a settled destination cannot become stationary clone evidence');
});

for (const target of ['clone', 'other element']) {
  test(`stationary mode rejects an animation targeting the ${target}`, () => {
    const harness = fixture({ stationary: true });
    const clone = harness.clone({ animated: true });
    if (target === 'other element') clone.animations[0].effect.target = harness.document.body;
    const probe = harness.start();
    assert.equal(probe.observations.length, 0);
    assertUnstamped(harness);
  });
}

for (const property of ['opacity', 'transform', 'filter', 'clipPath']) {
  test(`non-layout ${property} animation cannot witness clone pixels`, () => {
    const harness = fixture();
    const clone = harness.clone();
    clone.animations = [harness.animation(clone, { keyframes: [{ offset: 0, [property]: 'fixture' }] })];
    const probe = harness.start();
    assert.match(probe.fatal, /not the observed layout-only morph/);
    assert.equal(probe.observations.length, 0);
    assertUnstamped(harness);
  });
}

for (const [label, rect, expected] of [
  ['interior', { x: 80, y: 40, width: 160, height: 120 }, { x: 0, y: 0 }],
  ['top-left occupied', { x: 0, y: 0, width: 200, height: 100 }, { x: 232, y: 0 }],
  ['both upper corners occupied', { x: 0, y: 0, width: 360, height: 100 }, { x: 0, y: 236 }],
  ['both left corners occupied', { x: 0, y: 0, width: 200, height: 240 }, { x: 232, y: 0 }],
  ['all corners occupied', { x: 0, y: 0, width: 360, height: 240 }, null],
  ['touching all corner edges', { x: 128, y: 4, width: 104, height: 232 }, null],
]) {
  test(`marker never overlaps measured media: ${label}`, () => {
    const harness = fixture();
    harness.clone({ rect });
    const probe = harness.start();
    assert.equal(probe.observations.length, expected ? 1 : 0);
    if (!expected) { assertUnstamped(harness); return; }
    const { position, box } = plain(probe.observations[0]);
    assert.deepEqual(position, { ...expected, width: 128, height: 4 });
    assert.ok(position.x + position.width < box.x || position.x > box.x + box.width
      || position.y + position.height < box.y || position.y > box.y + box.height);
    assert.deepEqual(decodeCloneFrameStamp(harness.paint(), RUN_ID), [{ observationId: 0, position }]);
  });
}

for (const viewport of [{ width: 100, height: 240 }, { width: 360, height: 3 }]) {
  test(`a ${viewport.width}x${viewport.height} viewport cannot publish a clipped marker`, () => {
    const harness = fixture(viewport);
    // There is room away from the clone, but no room for all 128x4 stamp pixels.
    harness.clone({ rect: { x: 20, y: 40, width: 60, height: 120 } });
    const probe = harness.start();
    assert.equal(probe.observations.length, 0);
    assertUnstamped(harness);
  });
}

for (const dimensions of [{ width: 0, height: 100 }, { width: 100, height: 0 }]) {
  test(`zero-size ${JSON.stringify(dimensions)} clone is not evidence`, () => {
    const harness = fixture();
    harness.clone({ rect: { x: 80, y: 40, ...dimensions } });
    const probe = harness.start();
    assert.equal(probe.observations.length, 0);
    assertUnstamped(harness);
  });
}

for (const options of [{ deviceScaleFactor: 2 }, { viewportScale: 1.25 }, { iframe: true }]) {
  test(`unsupported viewport ${JSON.stringify(options)} fails closed`, () => {
    const harness = fixture(options);
    harness.clone();
    const probe = harness.start();
    assert.match(probe.fatal, /top-level, unscaled deviceScaleFactor=1 viewport/);
    assert.equal(probe.observations.length, 0);
    assertUnstamped(harness);
  });
}

for (const scale of ['devicePixelRatio', 'visualViewport']) {
  test(`changing ${scale} clears an already-visible stamp`, () => {
    const harness = fixture();
    harness.clone();
    const probe = harness.start();
    if (scale === 'devicePixelRatio') harness.globals.devicePixelRatio = 2;
    else harness.globals.visualViewport.scale = 1.25;
    harness.raf();
    assert.equal(probe.observations.length, 1);
    assertUnstamped(harness);
  });
}

for (const target of ['clone', 'ancestor']) {
  for (const [property, value] of [['transform', 'matrix(1, 0, 0, 1, 2, 3)'],
    ['translate', '2px 3px'], ['rotate', '1deg'], ['scale', '1.2']]) {
    test(`${property} on the ${target} fails closed`, () => {
      const harness = fixture();
      const wrapper = harness.document.createElement('div');
      harness.document.body.append(wrapper);
      const clone = harness.clone({ parent: wrapper });
      (target === 'clone' ? clone : wrapper).style[property] = value;
      const probe = harness.start();
      assert.match(probe.fatal, /transformed clone or ancestor/);
      assert.equal(probe.observations.length, 0);
      assertUnstamped(harness);
    });
  }
}

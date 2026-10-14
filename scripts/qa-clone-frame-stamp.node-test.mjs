import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import vm from 'node:vm';
import { decodeCloneFrameStamp, encodeCloneFrameStamp } from './qa-clone-frame-stamp.mjs';

const RUN_ID = 0x9a73c5e1;
const OBSERVATION_ID = 0x2468;

function rawImage(width = 360, height = 240, channels = 4) {
  const data = new Uint8Array(width * height * channels).fill(113);
  if (channels === 4) {
    for (let index = 3; index < data.length; index += 4) data[index] = 255;
  }
  return { data, width, height, channels };
}

function corner(image, name, stampWidth = 128, stampHeight = 4) {
  return {
    x: name.endsWith('right') ? image.width - stampWidth : 0,
    y: name.startsWith('bottom') ? image.height - stampHeight : 0,
  };
}

function paintPixel(image, x, y, value, alpha = 255) {
  const offset = (y * image.width + x) * image.channels;
  image.data[offset] = image.data[offset + 1] = image.data[offset + 2] = value;
  if (image.channels === 4) image.data[offset + 3] = alpha;
}

function paintStamp(image, name, runId = RUN_ID, observationId = OBSERVATION_ID, options = {}) {
  const { scaleX = 1, scaleY = 1, bits = encodeCloneFrameStamp(runId, observationId) } = options;
  const position = corner(image, name, 128 * scaleX, 4 * scaleY);
  for (let bit = 0; bit < bits.length; bit += 1) {
    for (let y = 0; y < 4 * scaleY; y += 1) {
      for (let x = 0; x < 2 * scaleX; x += 1) {
        paintPixel(image, position.x + bit * 2 * scaleX + x, position.y + y, bits[bit] * 255);
      }
    }
  }
  return { ...position, width: 128, height: 4 };
}

for (const name of ['top-left', 'top-right', 'bottom-left', 'bottom-right']) {
  for (const channels of [3, 4]) {
    test(`round trips an exact ${channels}-channel stamp in ${name}`, () => {
      const image = rawImage(360, 240, channels);
      const position = paintStamp(image, name);
      assert.deepEqual(decodeCloneFrameStamp(image, RUN_ID), [{ observationId: OBSERVATION_ID, position }]);
    });
  }
}

test('round trips independently generated uint32 nonces and boundary observation ids', () => {
  const runIds = [0, 1, 0x7fffffff, 0x80000000, 0xffffffff];
  for (let index = 0; index < 16; index += 1) runIds.push(randomBytes(4).readUInt32BE());
  for (const runId of runIds) {
    for (const observationId of [0, 1, 0x7fff, 0xffff]) {
      const image = rawImage();
      const position = paintStamp(image, 'bottom-right', runId, observationId);
      assert.deepEqual(decodeCloneFrameStamp(image, runId), [{ observationId, position }]);
    }
  }
});

test('encoder is standalone when serialized for browser injection', () => {
  const encode = vm.runInNewContext(`(${encodeCloneFrameStamp.toString()})`);
  const actual = Array.from(encode(RUN_ID, OBSERVATION_ID));
  assert.deepEqual(actual, Array.from(encodeCloneFrameStamp(RUN_ID, OBSERVATION_ID)));
  assert.equal(actual.length, 64);
  assert.ok(actual.every((bit) => bit === 0 || bit === 1));
});

test('zero payload has the known CCITT-FALSE checksum and MSB-first layout', () => {
  const bits = encodeCloneFrameStamp(0, 0);
  assert.deepEqual(Array.from(bits.slice(0, 48)), Array(48).fill(0));
  assert.equal(Array.from(bits.slice(48)).join(''), '0000111000010000');
  assert.equal(Array.from(encodeCloneFrameStamp(0x80000001, 0x8001).slice(0, 48)).join(''),
    '100000000000000000000000000000011000000000000001');
});

test('invalid, fractional, negative, and overflowing ids cannot wrap into a valid stamp', () => {
  const invalid = [-1, 0.5, NaN, Infinity, -Infinity, '1', null, undefined, 1n];
  for (const runId of [...invalid, 0x100000000, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => encodeCloneFrameStamp(runId, 0), RangeError);
    assert.deepEqual(decodeCloneFrameStamp(rawImage(), runId), []);
  }
  for (const observationId of [...invalid, 0x10000, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => encodeCloneFrameStamp(0, observationId), RangeError);
  }
});

test('rejects a wrong run nonce', () => {
  const image = rawImage();
  paintStamp(image, 'top-left');
  assert.deepEqual(decodeCloneFrameStamp(image, (RUN_ID ^ 1) >>> 0), []);
});

test('rejects every one-bit payload or checksum corruption even with uniform binary cells', () => {
  for (let index = 0; index < 64; index += 1) {
    const image = rawImage();
    const bits = encodeCloneFrameStamp(RUN_ID, OBSERVATION_ID);
    bits[index] ^= 1;
    paintStamp(image, 'top-left', RUN_ID, OBSERVATION_ID, { bits });
    assert.deepEqual(decodeCloneFrameStamp(image, RUN_ID), [], `corrupted bit ${index}`);
  }
});

test('rejects nonuniform, antialiased, colored, and transparent marker pixels', () => {
  for (const mutation of [
    (image) => paintPixel(image, 1, 3, image.data[0] === 255 ? 0 : 255),
    (image) => paintPixel(image, 1, 3, 127),
    (image) => { image.data[(3 * image.width + 1) * 4 + 1] = 21; },
    (image) => { image.data[(3 * image.width + 1) * 4 + 3] = 254; },
  ]) {
    const image = rawImage();
    paintStamp(image, 'top-left');
    mutation(image);
    assert.deepEqual(decodeCloneFrameStamp(image, RUN_ID), []);
  }
});

test('returns no matches for images with no marker, including solid black and white', () => {
  for (const value of [0, 113, 255]) {
    const image = rawImage();
    for (let y = 0; y < image.height; y += 1) {
      for (let x = 0; x < image.width; x += 1) paintPixel(image, x, y, value);
    }
    assert.deepEqual(decodeCloneFrameStamp(image, 0), []);
    assert.deepEqual(decodeCloneFrameStamp(image, 0xffffffff), []);
  }
});

test('returns every match so the caller can reject ambiguous observations', () => {
  const image = rawImage();
  const names = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
  const expected = names.map((name, index) => ({
    observationId: index + 1,
    position: paintStamp(image, name, RUN_ID, index + 1),
  }));
  assert.deepEqual(decodeCloneFrameStamp(image, RUN_ID), expected);
});

test('duplicate observation ids in different corners remain ambiguous', () => {
  const image = rawImage();
  const expected = ['top-left', 'bottom-right'].map((name) => ({
    observationId: OBSERVATION_ID,
    position: paintStamp(image, name),
  }));
  assert.deepEqual(decodeCloneFrameStamp(image, RUN_ID), expected);
});

test('coincident corner coordinates in a minimum-size image are inspected once', () => {
  const image = rawImage(128, 4);
  const position = paintStamp(image, 'top-left');
  assert.deepEqual(decodeCloneFrameStamp(image, RUN_ID), [{ observationId: OBSERVATION_ID, position }]);
});

for (const name of ['top-left', 'top-right', 'bottom-left', 'bottom-right']) {
  for (const [scaleX, scaleY] of [[2, 1], [1, 2], [2, 2], [1.5, 1], [1, 1.5]]) {
    test(`rejects ${scaleX}×${scaleY} resized stamps in ${name}`, () => {
      const image = rawImage();
      paintStamp(image, name, RUN_ID, OBSERVATION_ID, { scaleX, scaleY });
      assert.deepEqual(decodeCloneFrameStamp(image, RUN_ID), []);
    });
  }
}

test('rejects a partially resized or clipped stamp', () => {
  const image = rawImage();
  paintStamp(image, 'top-left');
  // Losing a single row must not be rescued by thresholding or resampling.
  for (let x = 0; x < 128; x += 1) paintPixel(image, x, 3, 113);
  assert.deepEqual(decodeCloneFrameStamp(image, RUN_ID), []);
});

test('ignores complete valid markers away from the viewport corners', () => {
  const image = rawImage();
  const bits = encodeCloneFrameStamp(RUN_ID, OBSERVATION_ID);
  for (let bit = 0; bit < 64; bit += 1) {
    for (let y = 0; y < 4; y += 1) {
      for (let x = 0; x < 2; x += 1) paintPixel(image, 12 + bit * 2 + x, 12 + y, bits[bit] * 255);
    }
  }
  assert.deepEqual(decodeCloneFrameStamp(image, RUN_ID), []);
});

test('malformed images fail closed without searching or allocating by claimed dimensions', () => {
  const valid = rawImage();
  const images = [
    null, undefined, 1, [], {},
    { ...valid, width: 127 }, { ...valid, height: 3 },
    { ...valid, width: 360.5 }, { ...valid, height: NaN },
    { ...valid, width: Infinity }, { ...valid, width: Number.MAX_SAFE_INTEGER },
    { ...valid, height: Number.MAX_SAFE_INTEGER },
    { ...valid, channels: 1 }, { ...valid, channels: 2 }, { ...valid, channels: 5 },
    { ...valid, channels: '4' }, { ...valid, data: [] }, { ...valid, data: null },
    { ...valid, data: new Uint16Array(valid.data.length) },
    { ...valid, data: new DataView(valid.data.buffer) },
    { ...valid, data: valid.data.subarray(1) },
    { ...valid, data: new Uint8Array(valid.data.length + 1) },
  ];
  for (const image of images) assert.deepEqual(decodeCloneFrameStamp(image, RUN_ID), []);
});

test('accepts byte-offset Buffer and clamped-array inputs without reading outside the view', () => {
  const original = rawImage();
  const position = paintStamp(original, 'bottom-left');
  const storage = Buffer.alloc(original.data.length + 34, 255);
  const data = storage.subarray(17, 17 + original.data.length);
  data.set(original.data);
  for (const pixels of [data, new Uint8ClampedArray(original.data)]) {
    assert.deepEqual(decodeCloneFrameStamp({ ...original, data: pixels }, RUN_ID),
      [{ observationId: OBSERVATION_ID, position }]);
  }
});

test('screenshot delivery timestamps cannot change the observed frame identity', () => {
  const image = rawImage();
  const position = paintStamp(image, 'top-right');
  const expected = [{ observationId: OBSERVATION_ID, position }];
  for (const deliveryTimestamp of [-1, 0, 1, Number.MAX_SAFE_INTEGER, Infinity, NaN]) {
    assert.deepEqual(decodeCloneFrameStamp({ ...image, deliveryTimestamp, timestamp: deliveryTimestamp }, RUN_ID), expected);
  }
  const missing = rawImage();
  assert.deepEqual(decodeCloneFrameStamp({ ...missing, timestamp: OBSERVATION_ID }, RUN_ID), []);
});

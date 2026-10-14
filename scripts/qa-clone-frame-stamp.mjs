/**
 * Encode the per-run nonce and observation id as a 128 × 4 physical-pixel stamp.
 * Bits are MSB-first: uint32 nonce, uint16 observation, then CRC-16/CCITT-FALSE
 * over the preceding six bytes. A zero bit is black, a one bit is white, and
 * each bit occupies exactly two opaque pixels horizontally and four vertically.
 *
 * Keep this function self-contained: the browser installer serializes it.
 */
export function encodeCloneFrameStamp(runId, observationId) {
  if (!Number.isInteger(runId) || runId < 0 || runId > 0xffffffff) {
    throw new RangeError('Clone frame runId must be a uint32');
  }
  if (!Number.isInteger(observationId) || observationId < 0 || observationId > 0xffff) {
    throw new RangeError('Clone frame observationId must be a uint16');
  }

  const bytes = [
    runId >>> 24,
    (runId >>> 16) & 0xff,
    (runId >>> 8) & 0xff,
    runId & 0xff,
    observationId >>> 8,
    observationId & 0xff,
  ];
  let checksum = 0xffff;
  for (const byte of bytes) {
    checksum ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      checksum = ((checksum << 1) ^ ((checksum & 0x8000) ? 0x1021 : 0)) & 0xffff;
    }
  }
  bytes.push(checksum >>> 8, checksum & 0xff);

  const bits = new Uint8Array(64);
  for (let index = 0; index < bits.length; index += 1) {
    bits[index] = (bytes[index >>> 3] >>> (7 - (index & 7))) & 1;
  }
  return bits;
}

/**
 * Decode lossless, unscaled corner stamps from already-decoded RGB/RGBA pixels.
 * Malformed images and invalid nonces fail closed. Only four fixed candidates
 * are inspected; image dimensions never control an unbounded pixel search.
 *
 * Returns all distinct matches, including ambiguous observations. The caller
 * must require exactly one match and look its observationId up in the browser
 * observation registry. Screenshot delivery time is deliberately not an input.
 */
export function decodeCloneFrameStamp(image, runId) {
  if (!Number.isInteger(runId) || runId < 0 || runId > 0xffffffff) return [];
  if (image === null || typeof image !== 'object') return [];
  const { data, width, height, channels } = image;
  if (
    !Number.isSafeInteger(width) || width < 128 ||
    !Number.isSafeInteger(height) || height < 4 ||
    (channels !== 3 && channels !== 4) ||
    !(data instanceof Uint8Array || data instanceof Uint8ClampedArray)
  ) return [];
  const byteLength = width * height * channels;
  if (!Number.isSafeInteger(byteLength) || data.length !== byteLength) return [];

  const stampWidth = 128;
  const stampHeight = 4;
  const matches = [];
  const visited = new Set();
  const corners = [
    [0, 0],
    [width - stampWidth, 0],
    [0, height - stampHeight],
    [width - stampWidth, height - stampHeight],
  ];
  const isPixel = (x, y, value) => {
    const offset = (y * width + x) * channels;
    return data[offset] === value && data[offset + 1] === value &&
      data[offset + 2] === value && (channels === 3 || data[offset + 3] === 255);
  };

  for (const [x, y] of corners) {
    const key = `${x},${y}`;
    if (visited.has(key)) continue;
    visited.add(key);
    const bits = new Uint8Array(64);
    let valid = true;
    for (let bit = 0; bit < bits.length && valid; bit += 1) {
      const value = data[(y * width + x + bit * 2) * channels];
      if (value !== 0 && value !== 255) {
        valid = false;
        break;
      }
      bits[bit] = value === 255 ? 1 : 0;
      for (let dy = 0; dy < stampHeight && valid; dy += 1) {
        for (let dx = 0; dx < 2; dx += 1) {
          if (!isPixel(x + bit * 2 + dx, y + dy, value)) {
            valid = false;
            break;
          }
        }
      }
    }
    if (!valid) continue;

    let decodedRunId = 0;
    let observationId = 0;
    for (let bit = 0; bit < 32; bit += 1) decodedRunId = decodedRunId * 2 + bits[bit];
    if (decodedRunId !== runId) continue;
    for (let bit = 32; bit < 48; bit += 1) observationId = observationId * 2 + bits[bit];
    const expected = encodeCloneFrameStamp(runId, observationId);
    if (bits.some((bit, index) => bit !== expected[index])) continue;

    // An integer vertical resize can leave the first four rows lossless. Reject
    // any stamp that continues beyond its four-pixel boundary. This also fails
    // closed for indistinguishable adjacent duplicate stamps in tiny images.
    const outsideY = y === 0 ? stampHeight : y - 1;
    if (outsideY >= 0 && outsideY < height) {
      let continues = true;
      for (let dx = 0; dx < stampWidth && continues; dx += 1) {
        continues = isPixel(x + dx, outsideY, bits[dx >>> 1] * 255);
      }
      if (continues) continue;
    }
    matches.push({ observationId, position: { x, y, width: stampWidth, height: stampHeight } });
  }
  return matches;
}

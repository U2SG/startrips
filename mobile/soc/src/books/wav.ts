/** Qwen's complete HTTP downloads can retain the streaming writer's size markers. */
function inspectWav(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (bytes.length < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('语音文件格式不正确');
  const riffSize = view.getUint32(4, true);
  let byteRate = 0, blockAlign = 0, dataSize = 0;
  const repairs: { at: number; size: number }[] = [];
  for (let at = 12; at + 8 <= bytes.length;) {
    let size = view.getUint32(at + 4, true);
    if (at + 8 + size > bytes.length) {
      const streaming = tag(at) === 'data' && ((riffSize === 0x7fffffbf && size === 0x7fffff9b)
        || (riffSize === 0xffffffff && size === 0xffffffff));
      if (!streaming || !blockAlign || (bytes.length - at - 8) % blockAlign) throw new Error('语音文件不完整');
      size = bytes.length - at - 8;
      repairs.push({ at: at + 4, size }, { at: 4, size: bytes.length - 8 });
    }
    if (tag(at) === 'fmt ' && size >= 16) {
      byteRate = view.getUint32(at + 16, true);
      blockAlign = view.getUint16(at + 20, true);
    }
    if (tag(at) === 'data') dataSize += size;
    at += 8 + size + (size % 2);
  }
  if (!byteRate || !dataSize) throw new Error('语音文件没有可播放内容');
  return { duration: dataSize / byteRate, repairs };
}

export function wavDuration(bytes: Uint8Array): number { return inspectWav(bytes).duration; }
export function normalizeWav(bytes: Uint8Array): Uint8Array {
  const { repairs } = inspectWav(bytes);
  if (!repairs.length) return bytes;
  const fixed = Uint8Array.from(bytes);
  const view = new DataView(fixed.buffer, fixed.byteOffset, fixed.byteLength);
  for (const repair of repairs) view.setUint32(repair.at, repair.size, true);
  return fixed;
}

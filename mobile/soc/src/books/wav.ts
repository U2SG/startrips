/** Read the actual duration, including WAV files with extra RIFF chunks. */
export function wavDuration(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (bytes.length < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('语音文件格式不正确');
  let byteRate = 0, dataSize = 0;
  for (let at = 12; at + 8 <= bytes.length;) {
    const size = view.getUint32(at + 4, true);
    if (at + 8 + size > bytes.length) throw new Error('语音文件不完整');
    if (tag(at) === 'fmt ' && size >= 16) byteRate = view.getUint32(at + 16, true);
    if (tag(at) === 'data') dataSize += size;
    at += 8 + size + (size % 2);
  }
  if (!byteRate || !dataSize) throw new Error('语音文件没有可播放内容');
  return dataSize / byteRate;
}

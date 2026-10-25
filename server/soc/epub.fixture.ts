// Small deterministic stored ZIPs for import behavior and hostile-archive tests.
export function epubFixture(extra: Record<string, string> = {}, overrides: { size?: number } = {}) {
  const contents = {
    mimetype: "application/epub+zip",
    "META-INF/container.xml": '<container><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>',
    "OPS/book.opf": '<package><manifest><item id="one" href="one.xhtml" media-type="application/xhtml+xml"/><item id="two" href="two.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="two"/><itemref idref="one"/></spine></package>',
    "OPS/one.xhtml": '<html><head><title>Hidden title</title></head><body><h1>第一章</h1><p>理解 &amp; 推理</p><script>secret()</script></body></html>',
    "OPS/two.xhtml": '<html><body><p>第二章先读</p></body></html>',
    ...extra,
  };
  const records: Buffer[] = [], directory: Buffer[] = [];
  let offset = 0;
  for (const [name, value] of Object.entries(contents)) {
    const filename = Buffer.from(name), bytes = Buffer.from(value);
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(bytes.length, 18); header.writeUInt32LE(overrides.size ?? bytes.length, 22); header.writeUInt16LE(filename.length, 26);
    records.push(header, filename, bytes);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(bytes.length, 20); central.writeUInt32LE(overrides.size ?? bytes.length, 24);
    central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(offset, 42);
    directory.push(central, filename); offset += header.length + filename.length + bytes.length;
  }
  const index = Buffer.concat(directory), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(Object.keys(contents).length, 8); end.writeUInt16LE(Object.keys(contents).length, 10);
  end.writeUInt32LE(index.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...records, index, end]);
}

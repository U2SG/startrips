import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

// Run on the server against a private, already transferred copy. No DB writes.
const [sourceArgument, rootArgument, userId] = process.argv.slice(2);
if (!sourceArgument || !rootArgument || !userId || process.argv.length !== 5) {
  throw new Error('Usage: node scripts/import-soc-data.mjs SOURCE_DATA_ROOT SOC_DATA_ROOT AUTHENTICATED_USER_ID');
}
const source = path.resolve(sourceArgument);
const root = path.resolve(rootArgument);
const owner = createHash('sha256').update(userId).digest('hex');
const target = path.join(root, owner);
const staging = path.join(root, `.import-${randomUUID()}`);

async function copyTree(from, to) {
  const info = await fs.lstat(from);
  if (info.isSymbolicLink()) throw new Error('Source contains a symbolic link; import refused');
  if (info.isDirectory()) {
    await fs.mkdir(to, { recursive: true, mode: 0o700 });
    for (const entry of await fs.readdir(from)) {
      if (entry.startsWith('.') || entry.includes('.tmp-')) continue;
      await copyTree(path.join(from, entry), path.join(to, entry));
    }
  } else if (info.isFile()) {
    await fs.copyFile(from, to, fs.constants.COPYFILE_EXCL);
    await fs.chmod(to, 0o600);
  } else throw new Error('Source contains an unsupported file type');
}

await fs.access(path.join(source, 'project-data'));
await fs.access(path.join(source, 'rules.md'));
await fs.access(path.join(source, 'llm-config.json'));
const modelConfig = JSON.parse(await fs.readFile(path.join(source, 'llm-config.json'), 'utf8'));
if (!Array.isArray(modelConfig.profiles)) throw new Error('Invalid model configuration');
await fs.mkdir(root, { recursive: true, mode: 0o700 });
try {
  await fs.lstat(target);
  throw new Error('Target user directory already exists; back it up and reconcile manually before importing');
} catch (error) { if (error.code !== 'ENOENT') throw error; }
try {
  await fs.mkdir(staging, { mode: 0o700 });
  for (const entry of ['project-data', 'rules.md', 'llm-config.json']) await copyTree(path.join(source, entry), path.join(staging, entry));
  await fs.rename(staging, target);
  console.log(`Imported study data for user directory ${owner}. Source unchanged.`);
} catch (error) {
  await fs.rm(staging, { recursive: true, force: true });
  throw error;
}

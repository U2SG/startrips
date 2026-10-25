import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, open, readdir, readFile, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";

export class SocError extends Error {
  constructor(readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 429 | 503, readonly code: string, message: string) {
    super(message);
  }
}

export function socUserDirectory(root: string, userId: string) {
  return path.join(path.resolve(root), createHash("sha256").update(userId).digest("hex"));
}

export function validateSocPath(relative: string, list = false) {
  if (list && (!relative || relative === "project-data")) return relative;
  if (relative === "rules.md") return relative;
  if (!relative.startsWith("project-data/") || relative.length > 1024
    || relative.split("/").some((part) => !part || part === "." || part === ".." || part.startsWith("."))
    || /[\\:\x00-\x1f]/.test(relative)) {
    throw new SocError(403, "STUDY_PATH_DENIED", "无法访问这个学习文件");
  }
  return relative;
}

export function contentTag(bytes: Uint8Array) {
  return `"${createHash("sha256").update(bytes).digest("hex")}"`;
}

const pending = new Map<string, Promise<unknown>>();
async function serialize<T>(file: string, task: () => Promise<T>): Promise<T> {
  const previous = pending.get(file) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(task);
  pending.set(file, next);
  try { return await next; } finally { if (pending.get(file) === next) pending.delete(file); }
}

export class SocFiles {
  readonly root: string;
  constructor(root: string, userId: string) { this.root = socUserDirectory(root, userId); }

  async resolve(relative: string, list = false) {
    validateSocPath(relative, list);
    const target = path.join(this.root, relative);
    // The API never creates links. Reject links in imported data as well.
    let current = this.root;
    for (const part of ["", ...relative.split("/").filter(Boolean)]) {
      current = path.join(current, part);
      try {
        if ((await lstat(current)).isSymbolicLink()) throw new SocError(403, "STUDY_PATH_DENIED", "不支持链接文件");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return target;
  }

  async read(relative: string) {
    const target = await this.resolve(relative);
    try {
      const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await file.stat();
        if (!info.isFile()) throw new SocError(400, "STUDY_NOT_FILE", "请选择文件");
        if (info.size > 128 * 1024 * 1024) throw new SocError(413, "STUDY_FILE_TOO_LARGE", "文件超过 128 MB");
        return await file.readFile();
      } finally { await file.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new SocError(404, "STUDY_FILE_NOT_FOUND", "学习文件不存在");
      throw error;
    }
  }

  async list(relative: string) {
    const target = await this.resolve(relative, true);
    try {
      const entries = await readdir(target, { withFileTypes: true });
      const result = [];
      for (const entry of entries) {
        if (entry.isSymbolicLink() || entry.name.startsWith(".")) continue;
        if (!relative && entry.name !== "project-data" && entry.name !== "rules.md") continue;
        const info = await stat(path.join(target, entry.name));
        result.push({ name: entry.name, dir: entry.isDirectory(), size: info.size, mtime: info.mtimeMs });
      }
      return result;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async write(relative: string, body: Buffer, expected: string | null, createOnly: boolean) {
    const target = await this.resolve(relative);
    if (!/\.(?:json|md|txt|pdf|png|jpe?g)$/i.test(relative)) throw new SocError(400, "STUDY_FILE_TYPE", "不支持这个文件类型");
    return serialize(target, async () => {
      let old: Buffer | null = null;
      try { old = await this.read(relative); } catch (error) { if (!(error instanceof SocError && error.status === 404)) throw error; }
      if (old && (createOnly || !expected || contentTag(old) !== expected)) {
        throw new SocError(409, "STUDY_FILE_CHANGED", "内容已在另一台设备更新，请刷新后重试");
      }
      if (!old && expected) throw new SocError(409, "STUDY_FILE_CHANGED", "文件已变化，请刷新后重试");
      await this.atomicWrite(target, body);
      return contentTag(body);
    });
  }

  async append(relative: string, body: Buffer) {
    if (!/\.(?:md|txt)$/.test(relative)) throw new SocError(400, "STUDY_FILE_TYPE", "只能追加文本");
    const target = await this.resolve(relative);
    return serialize(target, async () => {
      let old: Buffer = Buffer.alloc(0);
      try { old = await this.read(relative); } catch (error) { if (!(error instanceof SocError && error.status === 404)) throw error; }
      if (old.length + body.length > 8 * 1024 * 1024) throw new SocError(413, "STUDY_FILE_TOO_LARGE", "学习记录过大，请拆分文件");
      const bytes = Buffer.concat([old, body]);
      await this.atomicWrite(target, bytes);
      return contentTag(bytes);
    });
  }

  private async atomicWrite(target: string, body: Buffer) {
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const temporary = path.join(path.dirname(target), `.write-${randomUUID()}`);
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(body);
      await file.sync();
      await file.close();
      await rename(temporary, target);
    } catch (error) {
      await file.close().catch(() => {});
      await unlink(temporary).catch(() => {});
      throw error;
    }
  }

  async modelConfig(): Promise<SocModelConfig> {
    const file = path.join(this.root, "llm-config.json");
    try {
      await access(file);
      if ((await lstat(file)).isSymbolicLink()) throw new Error("Invalid model configuration link");
      const value = JSON.parse(await readFile(file, "utf8")) as SocModelConfig;
      if (!Array.isArray(value.profiles)) throw new Error("Invalid model configuration");
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { active: "", profiles: [] };
      throw new SocError(503, "STUDY_MODELS_UNAVAILABLE", "模型配置无法读取，请检查服务器配置");
    }
  }
}

export type SocModel = { name: string; baseURL: string; apiKey: string; model: string };
export type SocModelConfig = { active: string; profiles: SocModel[] };

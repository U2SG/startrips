import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { contentTag, SocFiles, socUserDirectory } from "./files";

const temporary: string[] = [];
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "startrips-soc-"));
  temporary.push(root);
  return { root, alice: new SocFiles(root, "alice"), bob: new SocFiles(root, "bob") };
}
afterEach(async () => { await Promise.all(temporary.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("personal study files", () => {
  it("keeps the same relative file private to the session user", async () => {
    const { alice, bob } = await fixture();
    await alice.write("project-data/chats/lesson.json", Buffer.from('{"private":true}'), null, true);
    await expect(bob.read("project-data/chats/lesson.json")).rejects.toMatchObject({ status: 404 });
    await bob.write("project-data/chats/lesson.json", Buffer.from('{"private":"bob"}'), null, true);
    expect((await alice.read("project-data/chats/lesson.json")).toString()).toContain('"private":true');
  });
  it.each(["llm-config.json", ".env", "../rules.md", "project-data/../llm-config.json", "project-data/../../outside", "project-data/a\\b", "project-data/C:/file", "project-data/.hidden/key"])("refuses credentials and traversal: %s", async (relative) => {
    const { alice } = await fixture();
    await expect(alice.read(relative)).rejects.toMatchObject({ status: 403 });
    await expect(alice.write(relative, Buffer.from("x"), null, true)).rejects.toMatchObject({ status: 403 });
  });
  it("rejects links in imported data and doesn't expose them in listings", async () => {
    const { root, alice } = await fixture();
    await mkdir(path.join(alice.root, "project-data"), { recursive: true });
    const outside = path.join(root, "private.json");
    await writeFile(outside, "secret");
    await symlink(outside, path.join(alice.root, "project-data/link.json"));
    await expect(alice.read("project-data/link.json")).rejects.toMatchObject({ status: 403 });
    expect(await alice.list("project-data")).toEqual([]);
  });
  it("rejects a stale write instead of losing a change from another device", async () => {
    const { alice } = await fixture();
    const file = "project-data/progress.md";
    const first = await alice.write(file, Buffer.from("page 1"), null, true);
    await alice.write(file, Buffer.from("page 2"), first, false);
    await expect(alice.write(file, Buffer.from("page 3"), first, false)).rejects.toMatchObject({ status: 409 });
    expect((await alice.read(file)).toString()).toBe("page 2");
  });
  it("serializes appends without losing concurrent notes", async () => {
    const { alice } = await fixture();
    await Promise.all([alice.append("project-data/progress.md", Buffer.from("a\n")), alice.append("project-data/progress.md", Buffer.from("b\n"))]);
    expect((await alice.read("project-data/progress.md")).toString()).toBe("a\nb\n");
  });
  it("keeps configuration out of the file listing", async () => {
    const { root, alice } = await fixture();
    await mkdir(alice.root, { recursive: true });
    await writeFile(path.join(alice.root, "llm-config.json"), '{"active":"private","profiles":[{"apiKey":"not-for-clients"}]}');
    await alice.write("rules.md", Buffer.from("rules"), null, true);
    expect((await alice.list("")).map((entry) => entry.name)).toEqual(["rules.md"]);
    expect(socUserDirectory(root, "../alice")).not.toBe(alice.root);
    expect(contentTag(Buffer.from("rules"))).toMatch(/^"[a-f0-9]{64}"$/);
  });
});

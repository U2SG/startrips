import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { session, configuration } = vi.hoisted(() => ({ session: vi.fn(), configuration: { socDataRoot: "", appOrigin: "http://127.0.0.1:5173" } }));
vi.mock("../auth", () => ({ auth: { api: { getSession: session } } }));
vi.mock("../config", () => ({ serverConfig: configuration }));
import { socRoutes, studyModelEndpoint } from "../routes/soc";
import { SocFiles } from "./files";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "soc-route-"));
  configuration.socDataRoot = root;
  session.mockResolvedValue({ user: { id: "alice", name: "Alice", email: "alice@example.test" } });
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

describe("study authentication and provider boundary", () => {
  it("refuses every unauthenticated file and paid API call", async () => {
    session.mockResolvedValue(null);
    for (const [method, url] of [["GET", "/session"], ["GET", "/file?path=rules.md"], ["POST", "/llm"], ["POST", "/voice"]]) {
      expect((await socRoutes.request(url, { method })).status).toBe(401);
    }
  });
  it("uses the session user even when a client supplies another user's id", async () => {
    const alice = new SocFiles(root, "alice");
    const bob = new SocFiles(root, "bob");
    await alice.write("rules.md", Buffer.from("alice only"), null, true);
    await bob.write("rules.md", Buffer.from("bob only"), null, true);
    const response = await socRoutes.request("/file?path=rules.md&userId=bob");
    expect(await response.text()).toBe("alice only");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("etag")).toBeTruthy();
  });
  it("refuses requests from other browser origins", async () => {
    const response = await socRoutes.request("/session", { headers: { origin: "https://other.example.test" } });
    expect(response.status).toBe(403);
  });
  it("refuses an old tab's write after the shared cookie changes accounts", async () => {
    const alice = new SocFiles(root, "alice"), bob = new SocFiles(root, "bob");
    await alice.write("rules.md", Buffer.from("alice only"), null, true);
    session.mockResolvedValue({ user: { id: "bob", name: "Bob", email: "bob@example.test" } });
    const stale = await socRoutes.request("/file?path=rules.md", { method: "PUT", headers: { "X-Soc-User": "alice", "If-None-Match": "*" }, body: "old tab data" });
    expect(stale.status).toBe(401);
    expect((await stale.json()).error).toBe("STUDY_ACCOUNT_CHANGED");
    await expect(bob.read("rules.md")).rejects.toMatchObject({ status: 404 });
    const current = await socRoutes.request("/file?path=rules.md", { method: "PUT", headers: { "X-Soc-User": "bob", "If-None-Match": "*" }, body: "bob only" });
    expect(current.status).toBe(200);
    expect((await alice.read("rules.md")).toString()).toBe("alice only");
    expect((await bob.read("rules.md")).toString()).toBe("bob only");
  });
  it("returns model names without keys or endpoints and controls the upstream model", async () => {
    const files = new SocFiles(root, "alice");
    await mkdir(files.root, { recursive: true });
    await writeFile(path.join(files.root, "llm-config.json"), JSON.stringify({ active: "qwen", profiles: [{ name: "qwen", model: "qwen-plus", baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1", apiKey: "test-server-key" }] }));
    const config = await socRoutes.request("/models");
    expect(await config.json()).toEqual({ active: "qwen", profiles: [{ name: "qwen", model: "qwen-plus" }] });
    const upstream = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response('{"choices":[]}'));
    const response = await socRoutes.request("/llm", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ profile: "qwen", model: "attacker-model", url: "http://127.0.0.1", messages: [{ role: "user", content: "hello" }] }) });
    expect(response.status).toBe(200);
    expect(String(upstream.mock.calls[0][0])).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions");
    expect(JSON.parse(String(upstream.mock.calls[0][1]?.body)).model).toBe("qwen-plus");
    expect((upstream.mock.calls[0][1]?.headers as Record<string, string>).Authorization).toBe("Bearer test-server-key");
    expect((await socRoutes.request("/file?path=llm-config.json")).status).toBe(403);
  });
  it("does not leak provider error bodies", async () => {
    const files = new SocFiles(root, "alice");
    await mkdir(files.root, { recursive: true });
    await writeFile(path.join(files.root, "llm-config.json"), JSON.stringify({ active: "model", profiles: [{ name: "model", model: "test", baseURL: "https://api.openai.com/v1", apiKey: "test-private-key" }] }));
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("test-private-key", { status: 401 }));
    const response = await socRoutes.request("/llm", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ profile: "model", messages: [{ role: "user", content: "test" }] }) });
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("test-private-key");
  });
  it.each(["http://api.openai.com/v1", "https://api.openai.com.evil.test/v1", "https://127.0.0.1/v1", "https://user:pass@api.openai.com/v1"])("rejects an unsafe provider: %s", (baseURL) => {
    expect(() => studyModelEndpoint({ name: "test", model: "test", apiKey: "test", baseURL })).toThrow();
  });
});

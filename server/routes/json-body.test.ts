import { describe, expect, it } from "vitest";
import { readJsonObject } from "./json-body";

/**
 * The thunk shape is what lets a route keep Hono's cached `context.req.json()`
 * while a test hands in a plain `Request`.
 */
function jsonBody(body: string) {
  const request = new Request("http://127.0.0.1/api/test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  return () => request.json() as Promise<unknown>;
}

describe("readJsonObject", () => {
  it("returns the parsed object for a JSON object body", async () => {
    await expect(readJsonObject(jsonBody('{"title":"Kyushu"}'))).resolves
      .toEqual({ title: "Kyushu" });
    await expect(readJsonObject(jsonBody("{}"))).resolves.toEqual({});
  });

  it("answers null for a malformed body instead of throwing a SyntaxError", async () => {
    // Without the catch the route would leave by the global INVALID_JSON 400.
    await expect(readJsonObject(jsonBody('{"title": '))).resolves.toBeNull();
    await expect(readJsonObject(jsonBody(""))).resolves.toBeNull();
    await expect(readJsonObject(jsonBody("not json at all"))).resolves.toBeNull();
  });

  it("answers null for a well-formed body that is not an object", async () => {
    await expect(readJsonObject(jsonBody("null"))).resolves.toBeNull();
    await expect(readJsonObject(jsonBody('"journey"'))).resolves.toBeNull();
    await expect(readJsonObject(jsonBody("42"))).resolves.toBeNull();
    await expect(readJsonObject(jsonBody("true"))).resolves.toBeNull();
  });

  it("answers null for an array, which reads as every property omitted", async () => {
    await expect(readJsonObject(jsonBody("[]"))).resolves.toBeNull();
    await expect(readJsonObject(jsonBody('[{"title":"Kyushu"}]'))).resolves.toBeNull();
  });

  it("answers null when the read itself rejects", async () => {
    await expect(
      readJsonObject(() => Promise.reject(new Error("stream closed"))),
    ).resolves.toBeNull();
  });
});

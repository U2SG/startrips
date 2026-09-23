import { describe, expect, it } from "vitest";
import {
  REDACTED_LINK,
  minimizeRecognitionText,
  pageRecognitionDocument,
  sourceOriginForRecognition,
} from "./recognition-document";

/**
 * #512: the material a fetched page is allowed to contribute to a recognition
 * request. A share link's signature and the page's own links must not be in
 * it; the plan a person would read must survive intact.
 */

const SIGNED = "https://plans.example/tripmap/routePlan?sid=99&sig=ab12cd34&uid=7";

describe("recognition document", () => {
  it("keeps only the origin of a signed share link", () => {
    expect(sourceOriginForRecognition(SIGNED)).toBe("https://plans.example");
    expect(sourceOriginForRecognition(`${SIGNED}#anchor`)).toBe(
      "https://plans.example",
    );
    expect(sourceOriginForRecognition("not a url")).toBeNull();
  });

  it("reads a page as visible text and drops every link it printed", () => {
    const html = [
      "<html><head><title>行程</title>",
      `<link rel="canonical" href="${SIGNED}">`,
      "<script>var share = \"" + SIGNED + "\";</script>",
      "<style>.a{color:red}</style></head><body>",
      `<a href="${SIGNED}&day=1" data-token="ab12cd34">第 1 天 · 上海</a>`,
      "<p>外滩 The Bund</p><p>订单 " + SIGNED + "</p>",
      "</body></html>",
    ].join("");

    const text = minimizeRecognitionText(html, "text/html; charset=utf-8");

    expect(text).toContain("第 1 天 · 上海");
    expect(text).toContain("外滩 The Bund");
    // Nothing from the address survives: not the query, not the signature,
    // not the member id, and not the bare host inside an attribute.
    expect(text).not.toContain("sig=ab12cd34");
    expect(text).not.toContain("uid=7");
    expect(text).not.toContain("routePlan");
    expect(text).not.toContain("href");
    expect(text).not.toContain("var share");
    expect(text).toContain(REDACTED_LINK);
  });

  it("leaves a non-markup reading its own shape and only removes its links", () => {
    const text = minimizeRecognitionText(
      `第 1 天\n上海 外滩\n来源 ${SIGNED}\n`,
      "text/plain",
    );
    expect(text).toBe(`第 1 天\n上海 外滩\n来源 ${REDACTED_LINK}\n`);
  });

  it("removes a protocol-relative link as well as an absolute one", () => {
    expect(minimizeRecognitionText("见 //plans.example/x?sig=1", "text/plain"))
      .toBe(`见 ${REDACTED_LINK}`);
  });

  it("builds a page document that carries no address at all", () => {
    const document = pageRecognitionDocument({
      finalUrl: SIGNED,
      text: `<body><p>第 1 天 上海</p><a href="${SIGNED}">分享</a></body>`,
      contentType: "text/html",
    });

    expect(document).toEqual({
      kind: "page",
      sourceOrigin: "https://plans.example",
      text: "第 1 天 上海\n分享",
    });
    expect(JSON.stringify(document)).not.toContain("sig=");
    expect(JSON.stringify(document)).not.toContain("routePlan");
  });

  it("reports a page whose markup carried no readable text as empty", () => {
    const document = pageRecognitionDocument({
      finalUrl: SIGNED,
      text: "<html><head><script>var plan = 1;</script></head><body> </body></html>",
      contentType: "text/html",
    });
    expect(document.text.trim()).toBe("");
  });
});

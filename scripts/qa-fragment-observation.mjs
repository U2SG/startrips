// QA synchronization follows the real Everyday Fragment HTTP contract.
// A 204 write is complete at response headers; unlike a 200 PUT it has no body.
export async function releaseFragmentReply(page, release, expectedStatus) {
  const request = release?.request;
  if (!request || !["PUT", "DELETE"].includes(request.method())) {
    throw new Error("Expected an exact held fragment write request");
  }
  const reply = page.waitForResponse((response) => response.request() === request);
  await release();
  const response = await reply;
  if (response.request() !== request || response.status() !== expectedStatus) {
    throw new Error(`Unexpected ${request.method()} fragment response: ${response.status()}`);
  }
  if (expectedStatus === 204) {
    if (request.method() !== "DELETE") throw new Error("Only fragment DELETE may return 204");
    // Do not wait on Playwright Response.finished(): the delayed routed 204 in
    // this fixture can publish headers without settling that transport promise.
    // journeyApi.requestJson likewise returns immediately on response.status 204.
    return null;
  }
  return response.json();
}

export async function waitForFragmentReadback(row, expectedNote) {
  // Textarea content is draft text, not proof that a PUT committed. The form
  // unmounts only after save; then assert the actual rendered note paragraph.
  await row.getByRole("form").waitFor({ state: "detached" });
  const note = row.locator("p.everyday-fragments__note");
  await note.waitFor({ state: "visible" });
  const actual = await note.innerText();
  if (actual !== expectedNote) {
    throw new Error(`Fragment note readback mismatch: expected ${JSON.stringify(expectedNote)}, got ${JSON.stringify(actual)}`);
  }
}

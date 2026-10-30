import { describe, expect, it } from "vitest";
import { createJournalRequestSlot } from "./journalRequest";

describe("journal operation lifetime", () => {
  it("starts only one request even before the busy render", () => {
    const slot = createJournalRequestSlot();
    const first = slot.begin()!;
    expect(slot.begin()).toBeNull();
    expect(first.current()).toBe(true);
    expect(first.finish()).toBe(true);
    expect(first.current()).toBe(false);
    expect(slot.begin()).not.toBeNull();
  });

  it("ignores late progress, success, failure and cleanup after cancel and retry", async () => {
    const slot = createJournalRequestSlot();
    const old = slot.begin()!;
    const displayed: string[] = [];
    let deliver!: () => void;
    const oldResponse = new Promise<void>(resolve => { deliver = resolve; }).then(() => {
      for (const message of ["progress", "success", "error"]) {
        if (old.current()) displayed.push(message);
      }
      expect(old.finish()).toBe(false);
    });
    slot.cancel();
    const next = slot.begin()!;
    deliver();
    await oldResponse;
    expect(old.signal.aborted).toBe(true);
    expect(displayed).toEqual([]);
    expect(next.current()).toBe(true);
    expect(slot.begin()).toBeNull();
    expect(next.finish()).toBe(true);
  });

  it("invalidates on leaving the panel or changing journey/account scope", () => {
    const slot = createJournalRequestSlot();
    const previous = slot.begin()!;
    slot.cancel();
    slot.cancel();
    expect(previous.signal.aborted).toBe(true);
    expect(previous.current()).toBe(false);
    const fresh = slot.begin()!;
    expect(previous.finish()).toBe(false);
    expect(fresh.current()).toBe(true);
  });
});

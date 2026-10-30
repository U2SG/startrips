/** One active operation per panel. Cancellation invalidates every late callback. */
export function createJournalRequestSlot() {
  let active: AbortController | null = null;
  return {
    begin() {
      if (active) return null;
      const controller = new AbortController();
      active = controller;
      return {
        signal: controller.signal,
        current: () => active === controller && !controller.signal.aborted,
        finish: () => {
          if (active !== controller) return false;
          active = null;
          return true;
        },
      };
    },
    cancel() {
      const controller = active;
      active = null;
      controller?.abort();
    },
  };
}

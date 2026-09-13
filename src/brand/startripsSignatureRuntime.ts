import { getStartripsSignatureClip, sampleStartripsSignaturePose, type StartripsSignatureClipName, type StartripsSignaturePose } from "./startripsSignatureTimeline";

export type StartripsSignatureRuntimeState = {
  status: "running" | "suspended" | "interrupted" | "reduced" | "settled";
  elapsedMs: number;
  cycle: number;
  driverCount: 0 | 1;
};

type Scheduler = {
  now: () => number;
  requestFrame: (callback: (now: number) => void) => number;
  cancelFrame: (id: number) => void;
};

export function createStartripsSignatureRuntime({
  clip,
  reduced,
  scheduler,
  onPose,
  onState,
}: {
  clip: StartripsSignatureClipName;
  reduced: boolean;
  scheduler: Scheduler;
  onPose: (pose: StartripsSignaturePose) => void;
  onState: (state: StartripsSignatureRuntimeState) => void;
}) {
  const definition = getStartripsSignatureClip(clip);
  let disposed = false;
  let interrupted = false;
  let suspended = false;
  let reducedMode = reduced;
  let raf = 0;
  let elapsedMs = reduced ? definition.durationMs : 0;
  let lastNow = scheduler.now();
  let cycles = 0;

  const publish = (status: StartripsSignatureRuntimeState["status"], driverCount: 0 | 1) => {
    onState({ status, elapsedMs, cycle: cycles, driverCount });
  };

  const cancel = () => {
    if (raf) scheduler.cancelFrame(raf);
    raf = 0;
  };

  const settle = (status: "interrupted" | "reduced" | "settled") => {
    if (status === "interrupted") interrupted = true;
    cancel();
    elapsedMs = definition.durationMs;
    onPose(sampleStartripsSignaturePose(clip, definition.durationMs));
    publish(status, 0);
  };

  const tick = (now: number) => {
    raf = 0;
    if (disposed || interrupted || reducedMode) return;
    if (suspended) {
      publish("suspended", 0);
      return;
    }
    const delta = Math.max(0, now - lastNow);
    lastNow = now;
    elapsedMs += delta;
    if (elapsedMs >= definition.durationMs) {
      cycles += 1;
      if (definition.loop) elapsedMs %= definition.durationMs;
      else {
        settle("settled");
        return;
      }
    }
    onPose(sampleStartripsSignaturePose(clip, elapsedMs));
    publish("running", 1);
    schedule();
  };

  function schedule() {
    if (disposed || interrupted || reducedMode || suspended || raf) return;
    raf = scheduler.requestFrame(tick);
  }

  const start = () => {
    if (disposed) return;
    if (reducedMode) {
      settle("reduced");
      return;
    }
    lastNow = scheduler.now();
    onPose(sampleStartripsSignaturePose(clip, elapsedMs));
    if (suspended) {
      publish("suspended", 0);
      return;
    }
    publish("running", 1);
    schedule();
  };

  return {
    start,
    interrupt() {
      if (!disposed && !reducedMode) settle("interrupted");
    },
    setSuspended(value: boolean) {
      if (disposed || suspended === value) return;
      suspended = value;
      lastNow = scheduler.now();
      if (suspended) {
        cancel();
        publish("suspended", 0);
      } else {
        schedule();
      }
    },
    setReduced(value: boolean) {
      if (disposed || reducedMode === value) return;
      reducedMode = value;
      if (reducedMode) {
        settle("reduced");
      } else if (!interrupted) {
        elapsedMs = 0;
        lastNow = scheduler.now();
        start();
      }
    },
    dispose() {
      disposed = true;
      cancel();
    },
  };
}

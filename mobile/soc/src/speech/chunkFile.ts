type ChunkOperations = {
  synthesize: (signal: AbortSignal) => Promise<string>;
  cache: (url: string, name: string, signal: AbortSignal) => Promise<string>;
  remove: (uri: string) => void;
  signal: AbortSignal;
};
let attemptSequence = 0;

export async function fetchChunkFile(name: string, operations: ChunkOperations, timeoutMs = 30000, retryDelayMs = 600): Promise<string | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (operations.signal.aborted) return null;
    const controller = new AbortController();
    const attemptName = `${name.replace(/\.wav$/, '')}-${++attemptSequence}.wav`;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancel = () => {};
    const cancelled = new Promise<never>((_, reject) => {
      cancel = () => { controller.abort(); reject(new Error('tts fetch cancelled')); };
      timer = setTimeout(cancel, timeoutMs);
      operations.signal.addEventListener('abort', cancel, { once: true });
    });
    const work = (async () => {
      const url = await operations.synthesize(controller.signal);
      if (controller.signal.aborted) throw new Error('tts fetch cancelled');
      const uri = await operations.cache(url, attemptName, controller.signal);
      if (controller.signal.aborted) { operations.remove(uri); throw new Error('tts fetch cancelled'); }
      return uri;
    })();
    try {
      const uri = await Promise.race([work, cancelled]);
      if (controller.signal.aborted) { operations.remove(uri); return null; }
      return uri;
    } catch {
      controller.abort();
      if (operations.signal.aborted) return null;
    } finally {
      clearTimeout(timer);
      operations.signal.removeEventListener('abort', cancel);
    }
    if (attempt === 0 && retryDelayMs > 0) {
      await new Promise<void>((resolve) => {
        const done = () => { clearTimeout(delay); operations.signal.removeEventListener('abort', done); resolve(); };
        const delay = setTimeout(done, retryDelayMs);
        operations.signal.addEventListener('abort', done, { once: true });
        if (operations.signal.aborted) done();
      });
    }
  }
  return null;
}

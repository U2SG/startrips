export type ModelCancellation = AbortSignal | AbortSignal[];

/** Own the fetch and its reader for the entire model call, including deadlines. */
export async function modelRequest(
  fetchResponse: (signal: AbortSignal) => Promise<Response>,
  stream: boolean,
  onDelta?: (delta: string, full: string) => void,
  cancellation?: ModelCancellation,
): Promise<string> {
  const parents = Array.isArray(cancellation) ? cancellation : cancellation ? [cancellation] : [];
  if (parents.some((signal) => signal.aborted)) throw new Error('LLM 请求已取消');
  const controller = new AbortController();
  let response: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let finished = false;
  let bodyClosed = false;
  let reason = new Error('LLM 请求已取消');
  let rejectAbort: (error: Error) => void = () => {};
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  void aborted.catch(() => {});
  const closeBody = () => {
    if (bodyClosed) return;
    bodyClosed = true;
    if (reader) void reader.cancel().catch(() => {});
    else if (response?.body) void response.body.cancel().catch(() => {});
  };
  const cancel = (error: Error) => {
    if (controller.signal.aborted) return;
    reason = error;
    controller.abort();
    closeBody();
    rejectAbort(error);
  };
  const onAbort = () => cancel(new Error('LLM 请求已取消'));
  parents.forEach((signal) => signal.addEventListener('abort', onAbort, { once: true }));
  const assertActive = () => { if (controller.signal.aborted) throw reason; };
  async function deadline<T>(operation: Promise<T>, ms: number, message: string): Promise<T> {
    const timer = setTimeout(() => cancel(new Error(message)), ms);
    try {
      const result = await Promise.race([operation, aborted]);
      assertActive();
      return result;
    } finally { clearTimeout(timer); }
  }
  const pendingResponse = Promise.resolve().then(() => {
    assertActive();
    return fetchResponse(controller.signal);
  }).then((result) => {
    if (controller.signal.aborted || finished) {
      void result.body?.cancel().catch(() => {});
      throw reason;
    }
    response = result;
    return result;
  });
  try {
    const result = await deadline(pendingResponse, 60000, 'LLM 连接超时');
    if (!result.body) throw new Error('LLM 未返回响应内容');
    reader = result.body.getReader();
    const readText = async () => {
      const decoder = new TextDecoder();
      let text = '';
      for (;;) {
        const chunk = await reader!.read();
        assertActive();
        if (chunk.done) return text + decoder.decode();
        text += decoder.decode(chunk.value, { stream: true });
      }
    };
    if (!result.ok) {
      const text = await deadline(readText(), 180000, 'LLM 响应超时');
      throw new Error(`LLM HTTP ${result.status}: ${text.slice(0, 300)}`);
    }
    if (!stream) {
      const text = await deadline(readText(), 180000, 'LLM 响应超时');
      return JSON.parse(text).choices?.[0]?.message?.content ?? '';
    }
    const decoder = new TextDecoder();
    let buffer = '', full = '';
    for (;;) {
      const { done, value } = await deadline(reader.read(), 45000, 'LLM 流式响应停滞，已中断');
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop()!;
      for (const line of lines) {
        assertActive();
        if (!line.trim().startsWith('data:')) continue;
        const payload = line.trim().slice(5).trim();
        if (payload === '[DONE]') return full;
        let delta: unknown;
        try { delta = JSON.parse(payload).choices?.[0]?.delta?.content; } catch { continue; }
        if (typeof delta === 'string' && delta) {
          assertActive();
          full += delta;
          onDelta?.(delta, full);
        }
      }
    }
    return full;
  } finally {
    finished = true;
    parents.forEach((signal) => signal.removeEventListener('abort', onAbort));
    controller.abort();
    closeBody();
    try { reader?.releaseLock(); } catch {}
  }
}

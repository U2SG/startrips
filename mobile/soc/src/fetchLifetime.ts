/** Connection deadline ends at headers; the caller owns body consumption. */
export async function fetchWithLifetime(
  fetchResponse: (signal: AbortSignal) => Promise<Response>,
  owner: AbortSignal,
  pending: Set<AbortController>,
): Promise<Response> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const finish = () => {
    clearTimeout(deadline);
    pending.delete(controller);
    owner.removeEventListener('abort', abort);
    controller.signal.removeEventListener('abort', finish);
  };
  const deadline = setTimeout(abort, 180000);
  pending.add(controller);
  controller.signal.addEventListener('abort', finish, { once: true });
  owner.addEventListener('abort', abort, { once: true });
  if (owner.aborted) abort();
  try {
    if (controller.signal.aborted) throw new Error('请求已取消');
    const response = await fetchResponse(controller.signal);
    clearTimeout(deadline);
    if (controller.signal.aborted) {
      void response.body?.cancel().catch(() => {});
      throw new Error('请求已取消');
    }
    return response;
  } catch (error) {
    controller.abort();
    finish();
    throw error;
  }
}

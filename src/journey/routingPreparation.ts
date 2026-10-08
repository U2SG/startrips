// Road graphs may be prepared on demand: the API answers 202 with a phase
// until the graph is ready. This helper re-issues the same request, visibly.

export type RoutingPreparationPhase = "queued" | "fetching" | "building";
export type RoutingPreparing = { status: "preparing"; phase: RoutingPreparationPhase; retryAfterMs: number };

export const ROUTING_PREPARATION_TIMEOUT_MS = 4 * 60_000;
const MIN_RETRY_MS = 1_000;
const MAX_RETRY_MS = 5_000;

export class RoutingPreparationTimeoutError extends Error {
  readonly code = "ROUTING_PREPARING_TIMEOUT";
  constructor() {
    super(FAILURE_COPY.ROUTING_PREPARING_TIMEOUT);
    this.name = "RoutingPreparationTimeoutError";
  }
}

export function isRoutingPreparing(value: unknown): value is RoutingPreparing {
  const candidate = value as Partial<RoutingPreparing> | null;
  return Boolean(candidate) && typeof candidate === "object" && candidate!.status === "preparing"
    && ["queued", "fetching", "building"].includes(String(candidate!.phase));
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const timer = setTimeout(() => { signal.removeEventListener("abort", stop); resolve(); }, ms);
    function stop() { clearTimeout(timer); reject(signal.reason); }
    signal.addEventListener("abort", stop, { once: true });
  });
}

/**
 * Repeats `attempt` while it reports preparation, waiting the server's hint
 * clamped to 1-5 s, until a real result arrives, the signal aborts, or four
 * minutes pass.
 */
export async function pollWhileRoutingPrepares<T>(
  attempt: () => Promise<T | RoutingPreparing>,
  {
    signal,
    onPreparing,
    sleep = abortableSleep,
    now = Date.now,
    timeoutMs = ROUTING_PREPARATION_TIMEOUT_MS,
  }: {
    signal: AbortSignal;
    onPreparing?: (phase: RoutingPreparationPhase) => void;
    sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
    now?: () => number;
    timeoutMs?: number;
  },
): Promise<T> {
  const started = now();
  for (;;) {
    const result = await attempt();
    if (!isRoutingPreparing(result)) return result;
    onPreparing?.(result.phase);
    const hint = Number.isFinite(result.retryAfterMs) ? result.retryAfterMs : MAX_RETRY_MS;
    const wait = Math.min(MAX_RETRY_MS, Math.max(MIN_RETRY_MS, hint));
    if (now() - started + wait > timeoutMs) throw new RoutingPreparationTimeoutError();
    await sleep(wait, signal);
  }
}

export function routingPreparationCopy(phase: RoutingPreparationPhase): string {
  return phase === "building" ? "正在生成路网…" : "正在获取这段路线周边的道路…";
}

const FAILURE_COPY: Record<string, string> = {
  ROUTING_DATA_UNAVAILABLE: "暂时无法获取这段路线周边的道路数据，请稍后重试。原路线已保留。",
  ROUTING_AREA_TOO_LARGE: "这段路线覆盖的范围太大，无法准备道路数据。原路线已保留。",
  ROUTING_NO_ROADS: "这段路线周边没有找到所选方式可通行的道路。可以换一种方式，或保留大致路线。",
  ROUTING_GRAPH_BUILD_FAILED: "路网生成失败，请稍后重试。原路线已保留。",
  ROUTING_PREPARING_TIMEOUT: "道路数据准备时间过长，请稍后重试。原路线已保留。",
};

/** Specific copy for an on-demand road graph failure, or null for other errors. */
export function routingFailureMessage(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? FAILURE_COPY[code] ?? null : null;
}

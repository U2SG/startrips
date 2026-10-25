// 统一异步资源加载：替代各屏手写的 useEffect + setBusy + setError 三件套，
// 让 Tailscale 断连等失败在所有屏有一致的呈现与重试语义。
// busy 是状态文案（'' = 空闲）；竞态用序号防旧响应覆盖新响应。
import { DependencyList, useCallback, useEffect, useRef, useState } from 'react';

export function useResource<T>(
  fetcher: () => Promise<T>,
  deps: DependencyList,
  opts: { enabled?: boolean; busyText?: string } = {},
): {
  data: T | null;
  busy: string;
  error: string;
  reload: () => Promise<void>;
  setData: React.Dispatch<React.SetStateAction<T | null>>;
} {
  const { enabled = true, busyText = '读取中…' } = opts;
  const [data, setData] = useState<T | null>(null);
  const [busy, setBusy] = useState(enabled ? busyText : '');
  const [error, setError] = useState('');
  const seq = useRef(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const reload = useCallback(async () => {
    if (!enabled) return;
    const my = ++seq.current;
    setBusy(busyText);
    try {
      const d = await fetcherRef.current();
      if (my !== seq.current) return;
      setData(d);
      setError('');
    } catch (e: any) {
      if (my !== seq.current) return;
      setError(String(e?.message || e));
    } finally {
      if (my === seq.current) setBusy('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, busyText, ...deps]);

  useEffect(() => {
    if (enabled) reload();
    else { seq.current += 1; setBusy(''); }
  }, [reload, enabled]);

  return { data, busy, error, reload, setData };
}

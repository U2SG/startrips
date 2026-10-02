import { useEffect, useRef, useState } from "react";
import { requestRoutePointSuggestions, routeCandidateAvailability } from "../journey/journeyApi";
import type { RoadProfile, RoutePointSuggestion, RoutingPoint } from "../journey/types";

const MODES = [{ profile: "driving", label: "驾车" }, { profile: "walking", label: "步行" }, { profile: "cycling", label: "骑行" }] as const;
export function nearbyPointDistance(meters: number) {
  return meters < 1_000 ? `${Math.round(meters)} 米` : `${(meters / 1_000).toFixed(1)} 公里`;
}

export function NearbyRoutePointPicker({ coordinate, neighbors, profile, allowFerries = false, disabled = false, onChoose, onDismiss, onSuggestionsChange }: {
  coordinate: RoutingPoint;
  neighbors: { before?: RoutingPoint; after?: RoutingPoint };
  profile?: RoadProfile | "";
  allowFerries?: boolean;
  disabled?: boolean;
  onChoose: (point: RoutePointSuggestion) => void;
  onDismiss: () => void;
  onSuggestionsChange?: (points: RoutePointSuggestion[]) => void;
}) {
  const [ownProfile, setOwnProfile] = useState<RoadProfile | "">("");
  const [available, setAvailable] = useState<RoadProfile[]>([]);
  const [availabilityLoading, setAvailabilityLoading] = useState(profile === undefined);
  const [retry, setRetry] = useState(0);
  const mode = profile ?? ownProfile;
  const neighborsKey = JSON.stringify({
    ...(neighbors.before ? { before: { lat: neighbors.before.lat, lon: neighbors.before.lon } } : {}),
    ...(neighbors.after ? { after: { lat: neighbors.after.lat, lon: neighbors.after.lon } } : {}),
  });
  const key = JSON.stringify([coordinate.lat, coordinate.lon, neighborsKey, mode, allowFerries, retry]);
  const [result, setResult] = useState<{ key: string; pending: boolean; points: RoutePointSuggestion[]; error: string } | null>(null);
  const callbackRef = useRef(onSuggestionsChange);
  callbackRef.current = onSuggestionsChange;
  useEffect(() => {
    if (profile !== undefined) return;
    let current = true;
    void routeCandidateAvailability().then((profiles) => { if (current) setAvailable(profiles); })
      .catch(() => { if (current) setAvailable([]); })
      .finally(() => { if (current) setAvailabilityLoading(false); });
    return () => { current = false; };
  }, [profile]);
  useEffect(() => {
    callbackRef.current?.([]);
    if (!mode || disabled) return;
    const controller = new AbortController();
    setResult({ key, pending: true, points: [], error: "" });
    void requestRoutePointSuggestions({ coordinate: { lat: coordinate.lat, lon: coordinate.lon },
      neighbors: JSON.parse(neighborsKey), profile: mode, allowFerries }, controller.signal)
      .then((points) => {
        if (controller.signal.aborted) return;
        setResult({ key, pending: false, points, error: "" });
        callbackRef.current?.(points);
      }).catch(() => {
        if (!controller.signal.aborted) setResult({ key, pending: false, points: [], error: "附近道路暂时查询失败，可以重试或保留原点。" });
      });
    return () => { controller.abort(); callbackRef.current?.([]); };
  }, [allowFerries, coordinate.lat, coordinate.lon, disabled, key, mode, neighborsKey]);
  const current = result?.key === key ? result : null;
  return (
    <section className="nearby-route-points" aria-label="附近可达点">
      <strong>附近可达点</strong>
      <p>大概位置即可。建议来自所选方式的路网，选择后仍可调整。</p>
      {profile === undefined ? (
        <div className="nearby-route-points__modes" role="group" aria-label="附近点的交通方式">
          {MODES.map((entry) => <button key={entry.profile} type="button" aria-pressed={mode === entry.profile}
            disabled={disabled || availabilityLoading || !available.includes(entry.profile)} onClick={() => setOwnProfile(entry.profile)}>{entry.label}</button>)}
        </div>
      ) : null}
      {!mode ? <p role="status">{availabilityLoading ? "正在检查道路服务…" : profile === undefined && available.length === 0
        ? "当前道路服务不可用，可以保留原点。" : "选择一种交通方式，查看附近建议。"}</p> : null}
      {mode && (!current || current.pending) && !disabled ? <p role="status">正在寻找附近能接上路线的点…</p> : null}
      {current?.points.length ? <ul>
        {current.points.map((point) => <li key={point.id}><button type="button" disabled={disabled} onClick={() => onChoose(point)}>
          <strong>{point.label || "附近可通行道路"}</strong>
          <span>距选点 {nearbyPointDistance(point.distanceMeters)}{point.connected ? " · 可接上前后路段" : " · 附近道路"}</span>
          <small>{point.coordinate.lat.toFixed(4)}, {point.coordinate.lon.toFixed(4)}</small>
        </button></li>)}
      </ul> : null}
      {current && !current.pending && !current.error && current.points.length === 0 ? <p role="status">附近暂未找到能接上这一段的点。可以换一种方式，或保留大致路线。</p> : null}
      {current?.error ? <><p role="status">{current.error}</p><button type="button" disabled={disabled} onClick={() => setRetry((value) => value + 1)}>重试附近建议</button></> : null}
      <button type="button" disabled={disabled} onClick={onDismiss}>使用原点</button>
    </section>
  );
}

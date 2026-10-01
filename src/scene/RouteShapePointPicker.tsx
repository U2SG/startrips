import { useEffect, useRef, useState, type FormEvent } from "react";
import { JourneyApiError, searchLocations } from "../journey/journeyApi";
import { journeyLocationSearchErrorMessage } from "../journey/journeyLocationSearchError";
import { parseCoordinateInput } from "../journey/routeDraft";
import type { LocationSearchResponse, LocationSearchResult } from "../journey/types";

export function RouteShapePointPicker({ disabled, focus, onAdd }: {
  disabled: boolean;
  focus: { latitude: number; longitude: number };
  onAdd: (point: { lat: number; lon: number; label?: string }) => void;
}) {
  const [query, setQuery] = useState("");
  const [latitude, setLatitude] = useState("");
  const [longitude, setLongitude] = useState("");
  const [results, setResults] = useState<LocationSearchResult[]>([]);
  const [attribution, setAttribution] = useState<LocationSearchResponse["attribution"]>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const epochRef = useRef(0);
  useEffect(() => () => { epochRef.current += 1; }, []);
  useEffect(() => {
    if (disabled) {
      epochRef.current += 1;
      setPending(false);
      setResults([]);
      setAttribution(null);
    }
  }, [disabled]);

  function clearSearch() {
    epochRef.current += 1;
    setPending(false);
    setResults([]);
    setAttribution(null);
    setError("");
  }

  async function search(event: FormEvent) {
    event.preventDefault();
    if (disabled) return;
    clearSearch();
    if (query.trim().length < 2) {
      setError("至少输入两个字符再搜索。");
      return;
    }
    const epoch = epochRef.current;
    setPending(true);
    try {
      const response = await searchLocations(query, fetch, { focus });
      if (epochRef.current !== epoch) return;
      setResults(response.results);
      setAttribution(response.attribution);
      if (!response.results.length) setError("没有找到地点；可以试试英文名或输入坐标。");
    } catch (cause) {
      if (epochRef.current !== epoch) return;
      setError(cause instanceof JourneyApiError && cause.code === "LOCATION_SEARCH_UNAVAILABLE"
        ? "地点搜索暂时不可用；可以输入经纬度，或在地图上选点。"
        : journeyLocationSearchErrorMessage(cause));
    } finally {
      if (epochRef.current === epoch) setPending(false);
    }
  }

  function add(point: { lat: number; lon: number; label?: string }) {
    if (disabled) return;
    clearSearch();
    onAdd(point);
    setQuery("");
    setLatitude("");
    setLongitude("");
  }

  function addCoordinates(event: FormEvent) {
    event.preventDefault();
    const lat = parseCoordinateInput(latitude, -90, 90);
    const lon = parseCoordinateInput(longitude, -180, 180);
    if (lat === null || lon === null) {
      setError("请填写有效的纬度（-90 到 90）和经度（-180 到 180）。");
      return;
    }
    add({ lat, lon });
  }

  return (
    <div className="route-shape-picker">
      <form onSubmit={search}>
        <label>搜索经过的地点
          <input value={query} maxLength={120} disabled={disabled} placeholder="地名、道路或公园入口"
            onChange={(event) => { clearSearch(); setQuery(event.target.value); }} />
        </label>
        <button type="submit" disabled={disabled || pending}>{pending ? "搜索中…" : "搜索"}</button>
      </form>
      {results.length ? (
        <ul className="route-shape-picker__results">
          {results.map((result) => (
            <li key={result.id}><button type="button" disabled={disabled} onClick={() => add({
              lat: result.latitude, lon: result.longitude,
              label: result.labelLocal && /\p{Script=Han}/u.test(result.labelLocal) ? result.labelLocal : result.label,
            })}>
              <strong>{result.label}</strong>
              <small>{result.context} · {result.countryCode}</small>
              <span>添加到这段路线</span>
            </button></li>
          ))}
        </ul>
      ) : null}
      {results.length && attribution ? (
        <a href={attribution.url} target="_blank" rel="noreferrer">地点数据 {attribution.label}</a>
      ) : null}
      <details>
        <summary>输入经纬度</summary>
        <form onSubmit={addCoordinates}>
          <label>纬度<input inputMode="decimal" value={latitude} disabled={disabled} onChange={(event) => setLatitude(event.target.value)} /></label>
          <label>经度<input inputMode="decimal" value={longitude} disabled={disabled} onChange={(event) => setLongitude(event.target.value)} /></label>
          <button type="submit" disabled={disabled}>添加这组坐标</button>
        </form>
      </details>
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Marker, type Map as MapLibreMap, type GeoJSONSource } from "maplibre-gl";
import type { FeatureCollection, LineString } from "geojson";
import {
  requestRouteCandidates,
  routeCandidateAvailability,
  saveRouteSegment,
  type SignedRouteCandidate,
} from "../journey/journeyApi";
import { routeSegmentSourceKey } from "../journey/journeyModel";
import type { JourneyRoute, RoadProfile, RouteSegmentRecord, RouteShapePoint } from "../journey/types";
import { RouteShapePointPicker } from "./RouteShapePointPicker";

const SOURCE_ID = "startrips-road-candidate-preview";
const LAYER_ID = "startrips-road-candidate-preview-lines";

export function RouteCandidateEditor({ map, route, active, onSaved, onEditModeChange }: {
  map: MapLibreMap | null;
  route: JourneyRoute | null;
  active: boolean;
  onSaved: (journeyId: string, record: RouteSegmentRecord) => void;
  onEditModeChange: (editing: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [adding, setAdding] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [profile, setProfile] = useState<RoadProfile | "">("");
  const [availableProfiles, setAvailableProfiles] = useState<RoadProfile[]>([]);
  const [availabilityLoading, setAvailabilityLoading] = useState(false);
  const [draftShapes, setDraftShapes] = useState<RouteShapePoint[]>([]);
  const [candidates, setCandidates] = useState<SignedRouteCandidate[]>([]);
  const [candidateIndex, setCandidateIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [editor, setEditor] = useState<HTMLDivElement | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const requestEpochRef = useRef(0);
  const cancelCandidateRequest = useCallback(() => {
    requestEpochRef.current += 1;
    const pending = requestRef.current;
    pending?.abort();
    requestRef.current = null;
    if (pending) setBusy(false);
    setCandidates([]);
    setCandidateIndex(0);
  }, []);
  const selected = route?.points[selectedIndex];
  const next = route?.points[selectedIndex + 1];
  const sourceKey = route ? routeSegmentSourceKey(route.points, selectedIndex) : null;
  const record = route?.routeSegments?.[selectedIndex] ?? null;
  const revision = record?.revision ?? 0;
  const journeyId = route?.id ?? null;
  const fromId = selected?.id ?? null;
  const toId = next?.id ?? null;
  const candidate = candidates[candidateIndex] ?? null;
  const addShapePoint = useCallback((point: { lat: number; lon: number; label?: string }) => {
    setDraftShapes((current) => current.length >= 16 ? current : [...current, {
      id: crypto.randomUUID(), ...point,
      ...(point.label ? { label: point.label.slice(0, 120) } : {}),
    }]);
    setCandidates([]);
  }, []);

  function moveShapePoint(index: number, direction: -1 | 1) {
    setDraftShapes((current) => {
      const target = index + direction;
      if (target < 0 || target >= current.length) return current;
      const reordered = [...current];
      [reordered[index], reordered[target]] = [reordered[target], reordered[index]];
      return reordered;
    });
  }

  useLayoutEffect(() => {
    if (!active || !map || !editor) return;
    const host = map.getContainer();
    const atlas = editor.closest<HTMLElement>(".living-atlas");
    if (!atlas) return;
    const selectors = {
      left: ".living-atlas__journey-rail",
      right: ".living-atlas__active, .living-atlas__route-point-context, .living-atlas__home-base-context",
      top: ".living-atlas__header, .mobile-v2__header",
      bottom: ".globe-time-scrubber, .mobile-v2__chrome",
    };
    const resizeObserver = new ResizeObserver(place);
    const observed = new Set<HTMLElement>();
    function place() {
      const bounds = host.getBoundingClientRect();
      const gap = 12;
      let left = bounds.left + gap;
      let right = Math.min(bounds.right, window.innerWidth) - gap;
      let top = Math.max(bounds.top, 0) + gap;
      let bottom = Math.min(bounds.bottom, window.innerHeight) - gap;
      for (const [side, selector] of Object.entries(selectors)) {
        for (const element of atlas!.querySelectorAll<HTMLElement>(selector)) {
          const style = getComputedStyle(element);
          // Reserve chrome space even while its entrance animation fades in.
          if (style.display === "none" || style.visibility === "hidden") continue;
          const rect = element.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) continue;
          if (side === "left") {
            if (rect.width < bounds.width / 2) left = Math.max(left, rect.right + gap);
            else top = Math.max(top, rect.bottom + gap);
          } else if (side === "right") {
            if (rect.width < bounds.width / 2) right = Math.min(right, rect.left - gap);
            else bottom = Math.min(bottom, rect.top - gap);
          } else if (side === "top") top = Math.max(top, rect.bottom + gap);
          else bottom = Math.min(bottom, rect.top - gap);
        }
      }
      editor!.style.left = `${left - bounds.left}px`;
      editor!.style.bottom = `${bounds.bottom - bottom}px`;
      editor!.style.width = `${Math.max(0, Math.min(340, right - left))}px`;
      editor!.style.setProperty("--route-editor-max-height", `${Math.max(0, bottom - top)}px`);
      editor!.dataset.routeEditorPositioned = "true";
    }
    function observeChrome() {
      const current = new Set([host, ...atlas!.querySelectorAll<HTMLElement>(Object.values(selectors).join(","))]);
      for (const element of observed) if (!current.has(element)) resizeObserver.unobserve(element);
      for (const element of current) if (!observed.has(element)) resizeObserver.observe(element);
      observed.clear();
      for (const element of current) observed.add(element);
      place();
    }
    // Watch only Atlas chrome and renderer size, never the map's frame-by-frame DOM.
    const chromeObserver = new MutationObserver(observeChrome);
    chromeObserver.observe(atlas, { childList: true, attributes: true, attributeFilter: ["class"] });
    observeChrome();
    window.addEventListener("resize", place);
    return () => {
      resizeObserver.disconnect();
      chromeObserver.disconnect();
      window.removeEventListener("resize", place);
      delete editor.dataset.routeEditorPositioned;
    };
  }, [active, editor, fromId, journeyId, map, toId]);

  useEffect(() => {
    if (!active || !open) return;
    let current = true;
    setAvailabilityLoading(true);
    void routeCandidateAvailability().then((profiles) => {
      if (current) {
        setAvailableProfiles(profiles);
        setProfile((selected) => selected && profiles.includes(selected) ? selected : "");
      }
    }).catch(() => {
      if (current) {
        setAvailableProfiles([]);
        setProfile("");
      }
    }).finally(() => {
      if (current) setAvailabilityLoading(false);
    });
    return () => { current = false; };
  }, [active, open]);

  useEffect(() => {
    setSelectedIndex(0);
    setOpen(false);
    setEditMode(false);
  }, [journeyId]);

  useEffect(() => {
    const segmentCount = Math.max(0, (route?.points.length ?? 0) - 1);
    setSelectedIndex((current) => segmentCount === 0 ? 0 : Math.min(current, segmentCount - 1));
  }, [route?.points.length]);

  useEffect(() => {
    cancelCandidateRequest();
    setBusy(false);
    setDraftShapes(record?.shapePoints ?? []);
    setAdding(false);
  }, [cancelCandidateRequest, journeyId, sourceKey, revision, selectedIndex]);

  useEffect(() => {
    cancelCandidateRequest();
  }, [active, cancelCandidateRequest, open, profile]);

  useEffect(() => {
    if (!active || !open || !editMode) setAdding(false);
  }, [active, editMode, open]);

  useEffect(() => {
    onEditModeChange(active && open && editMode);
    return () => onEditModeChange(false);
  }, [active, editMode, onEditModeChange, open]);

  useEffect(() => () => {
    requestEpochRef.current += 1;
    requestRef.current?.abort();
    requestRef.current = null;
  }, []);

  const previewData = useMemo<FeatureCollection<LineString, { color: string; selected: boolean }>>(() => ({
    type: "FeatureCollection",
    features: active && open ? candidates.map((entry, index) => ({
      type: "Feature",
      geometry: { type: "LineString", coordinates: entry.candidate.geometry },
      properties: { color: route?.color ?? "#a4c4b8", selected: index === candidateIndex },
    })) : [],
  }), [active, candidateIndex, candidates, open, route?.color]);

  useEffect(() => {
    if (!map) return;
    map.getContainer().dataset.routeCandidatePreviewCount = String(previewData.features.length);
    let applied = false;
    const apply = () => {
      if (applied) return;
      const source = map.getSource(SOURCE_ID) as GeoJSONSource | undefined;
      // The style document is sufficient for addSource/addLayer. isStyleLoaded
      // also waits for every other source/tile and can strand this preview.
      if (!source && !map.getStyle()) return;
      if (source) source.setData(previewData);
      else map.addSource(SOURCE_ID, { type: "geojson", data: previewData });
      if (!map.getLayer(LAYER_ID)) map.addLayer({
        id: LAYER_ID,
        type: "line",
        source: SOURCE_ID,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": ["get", "color"],
          "line-width": ["case", ["get", "selected"], 4, 2],
          "line-opacity": ["case", ["get", "selected"], 0.78, 0.32],
          "line-dasharray": [1, 2],
        },
      });
      applied = true;
    };
    const reload = () => { applied = false; apply(); };
    apply();
    map.on("style.load", reload);
    map.on("render", apply);
    return () => { map.off("style.load", reload); map.off("render", apply); };
  }, [map, previewData]);

  useEffect(() => {
    if (!map || !active || !open || !editMode) return;
    const markers = draftShapes.map((point, index) => {
      const element = document.createElement("button");
      element.type = "button";
      element.className = "route-shape-handle";
      element.setAttribute("aria-label", `拖动第 ${index + 1} 个修正点`);
      element.addEventListener("click", (event) => event.stopPropagation());
      const marker = new Marker({ element, draggable: !busy })
        .setLngLat([point.lon, point.lat]).addTo(map);
      marker.on("dragend", () => {
        const position = marker.getLngLat();
        setDraftShapes((current) => current.map((entry) => entry.id === point.id
          ? { ...entry, lat: position.lat, lon: position.lng }
          : entry));
        setCandidates([]);
      });
      return marker;
    });
    return () => markers.forEach((marker) => marker.remove());
  }, [active, busy, draftShapes, editMode, map, open]);

  useEffect(() => {
    if (!map || !active || !open || !editMode || !adding || busy || draftShapes.length >= 16) return;
    const add = (event: { lngLat: { lat: number; lng: number } }) => {
      addShapePoint({ lat: event.lngLat.lat, lon: event.lngLat.lng });
    };
    map.on("click", add);
    return () => { map.off("click", add); };
  }, [active, addShapePoint, adding, busy, draftShapes.length, editMode, map, open]);

  async function generate() {
    if (!journeyId || !fromId || !toId || !sourceKey || !profile) return;
    const epoch = ++requestEpochRef.current;
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setBusy(true);
    setMessage("");
    try {
      const response = await requestRouteCandidates(journeyId, fromId, toId, sourceKey, revision, profile, controller.signal);
      if (epoch !== requestEpochRef.current || controller.signal.aborted) return;
      setCandidates(response.candidates);
      setCandidateIndex(0);
      if (response.candidates.length === 0) setMessage("没有找到可靠的道路候选。可调整经过位置或核对起终点坐标；原路线已保留。");
    } catch (error) {
      if (epoch !== requestEpochRef.current || controller.signal.aborted) return;
      setMessage(error instanceof Error ? error.message : "路线请求失败，原路线已保留。");
    } finally {
      if (epoch === requestEpochRef.current) {
        requestRef.current = null;
        setBusy(false);
      }
    }
  }

  async function save(action: "shape" | "none" | "confirm") {
    if (!journeyId || !fromId || !toId || !sourceKey) return;
    setBusy(true);
    setMessage("");
    try {
      const saved = await saveRouteSegment(journeyId, fromId, toId, {
        sourceKey, expectedRevision: revision, action,
        ...(action === "shape" ? { shapePoints: draftShapes } : {}),
        ...(action === "confirm" && candidate ? { selected: candidate } : {}),
      });
      onSaved(journeyId, saved);
      setCandidates([]);
      setEditMode(false);
      setMessage(action === "confirm" ? "已确认并保存这一段路线。" : action === "none"
        ? "已保留原来的大致路线。" : "修正点已保存，请重新生成候选。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存失败，请重试。");
    } finally {
      setBusy(false);
    }
  }

  if (!active || !map || !route || route.points.length < 2 || !sourceKey || !fromId || !toId) return null;
  return (
    <div ref={setEditor} className="route-candidate-editor" data-route-editor-open={open} data-route-edit-mode={editMode}>
      {!open ? (
        <button type="button" onClick={() => { setAvailabilityLoading(true); setOpen(true); }}>贴合道路</button>
      ) : (
        <div className="route-candidate-editor__panel">
          <div className="route-candidate-editor__head">
            <strong>这一段怎么走</strong>
            <button type="button" onClick={() => { cancelCandidateRequest(); setOpen(false); setEditMode(false); setDraftShapes(record?.shapePoints ?? []); }}>关闭</button>
          </div>
          <label>
            路段
            <select value={selectedIndex} onChange={(event) => { setSelectedIndex(Number(event.target.value)); setEditMode(false); }}>
              {route.points.slice(0, -1).map((point, index) => (
                <option key={`${point.id ?? index}-${route.points[index + 1]?.id ?? index + 1}`} value={index}>
                  {point.label || `地点 ${index + 1}`} → {route.points[index + 1]?.label || `地点 ${index + 2}`}
                </option>
              ))}
            </select>
          </label>
          <label>
            交通方式
            <select value={profile} onChange={(event) => { cancelCandidateRequest(); setProfile(event.target.value as RoadProfile | ""); }}>
              <option value="">请选择</option>
              {availableProfiles.includes("driving") ? <option value="driving">驾车</option> : null}
            </select>
          </label>
          {availabilityLoading ? <p role="status">正在检查道路服务…</p> : availableProfiles.length === 0
            ? <p>当前没有配置道路服务，原路线继续显示。</p> : null}
          <div className="route-candidate-editor__actions">
            <button type="button" disabled={busy || availabilityLoading || !profile || !availableProfiles.includes(profile) || editMode} onClick={() => void generate()}>
              {busy ? "处理中…" : "查看候选"}
            </button>
            <button type="button" disabled={busy} onClick={() => {
              if (editMode) setDraftShapes(record?.shapePoints ?? []);
              setEditMode((value) => !value);
              setCandidates([]);
            }}>
              {editMode ? "退出调整" : "调整经过位置"}
            </button>
          </div>
          {editMode ? (
            <div className="route-candidate-editor__shapes">
              <p>可连续添加多个修正点，按经过顺序排列。它们只调整这一段，不会成为旅程地点。</p>
              <RouteShapePointPicker key={`${sourceKey}:${revision}`} disabled={busy || draftShapes.length >= 16}
                focus={{ latitude: selected!.lat, longitude: selected!.lon }} onAdd={addShapePoint} />
              <button type="button" disabled={busy || (!adding && draftShapes.length >= 16)} onClick={() => setAdding((value) => !value)}>
                {adding ? "结束地图选点" : "在地图上连续选点"}
              </button>
              {adding && draftShapes.length < 16 ? <p role="status">在地图上依次点选经过位置，完成后结束选点。</p> : null}
              <p>{draftShapes.length} / 16 个修正点</p>
              {draftShapes.map((point, index) => (
                <div key={point.id} className="route-candidate-editor__shape" data-route-shape-id={point.id}>
                  <span><strong>修正点 {index + 1}{point.label ? ` · ${point.label}` : ""}</strong>
                    <small>{point.lat.toFixed(4)}, {point.lon.toFixed(4)}</small></span>
                  <div className="route-candidate-editor__actions">
                    <button type="button" aria-label={`上移第 ${index + 1} 个修正点`} disabled={busy || index === 0} onClick={() => moveShapePoint(index, -1)}>上移</button>
                    <button type="button" aria-label={`下移第 ${index + 1} 个修正点`} disabled={busy || index === draftShapes.length - 1} onClick={() => moveShapePoint(index, 1)}>下移</button>
                    <button type="button" aria-label={`移除第 ${index + 1} 个修正点`} disabled={busy} onClick={() => setDraftShapes((current) => current.filter((entry) => entry.id !== point.id))}>移除</button>
                  </div>
                </div>
              ))}
              <button type="button" disabled={busy} onClick={() => void save("shape")}>保存修正点</button>
            </div>
          ) : null}
          {candidates.length > 0 ? (
            <div className="route-candidate-editor__candidates">
              <p>仅供比较，尚未记为实际走过的路。</p>
              <div className="route-candidate-editor__actions">
                {candidates.map((entry, index) => (
                  <button key={entry.candidate.id} type="button" aria-pressed={candidateIndex === index}
                    onClick={() => setCandidateIndex(index)}>
                    路线 {index + 1}
                  </button>
                ))}
              </div>
              <p>{Math.round(candidate?.candidate.distanceMeters ?? 0) / 1000} km · 约 {Math.round((candidate?.candidate.durationSeconds ?? 0) / 60)} 分钟</p>
              {candidate?.candidate.snapping.waypoints.some((point) => point.distanceMeters > 750) ? (
                <div className="route-candidate-editor__offsets">
                  <p>部分地点离可驾车道路较远，请核对候选接到的道路位置。原地点坐标保持不变。</p>
                  <ul>{candidate.candidate.snapping.waypoints.map((point, index, waypoints) => point.distanceMeters > 750 ? (
                    <li key={index}>{index === 0 ? selected?.label || "起点" : index === waypoints.length - 1
                      ? next?.label || "终点" : record?.shapePoints[index - 1]?.label || `修正点 ${index}`}：
                      距道路 {(point.distanceMeters / 1000).toFixed(1)} 公里</li>
                  ) : null)}</ul>
                </div>
              ) : null}
              <div className="route-candidate-editor__actions">
                <button type="button" disabled={busy} onClick={() => void save("confirm")}>就是这条</button>
                <button type="button" disabled={busy} onClick={() => void save("none")}>都不是／不记得</button>
              </div>
            </div>
          ) : null}
          {message ? <p role="status">{message}</p> : null}
        </div>
      )}
    </div>
  );
}

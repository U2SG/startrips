import { createDetailedEarthLabelExpression, isDetailedEarthNameLabel } from "../../../src/scene/detailedEarthModel";
import type { LabelPreferences } from "./bridge";

// iPhone-only overrides for the zoomed detail map (MapLibre). The shared
// DetailedEarthMap keeps its Web behaviour; this bundle patches the MapLibre
// prototype it loads so labels follow native Settings and low-vision sizing.
//
// The overrides piggyback on DetailedEarthMap's own label calls (addLayer and
// its per-style-load language pass). They never listen to `styledata`: writing
// style properties on every style event keeps MapLibre's style "changed", so
// the detail surface never settles and the dive from the particle globe never
// completes (the "globe stops zooming" regression).

/** The Journey Route Point label layer DetailedEarthMap adds at runtime. */
export const JOURNEY_LABEL_LAYER = "startrips-active-journey-labels";
export const MIN_LABEL_SIZE = 15;

type Layer = { id: string; type: string; layout?: Record<string, unknown>; paint?: Record<string, unknown> };
type MapLike = {
  getStyle(): { layers?: Layer[] } | undefined;
  getLayoutProperty(id: string, name: string): unknown;
  getPaintProperty(id: string, name: string): unknown;
  setLayoutProperty(id: string, name: string, value: unknown): unknown;
  setPaintProperty(id: string, name: string, value: unknown): unknown;
};

let preferences: LabelPreferences = { language: "zh", showPlaceNames: false };
const maps = new Set<MapLike>();
let applying = false;

const isZoomCurve = (value: unknown): value is unknown[] => Array.isArray(value)
  && (value[0] === "interpolate" || value[0] === "step")
  && JSON.stringify(value[value[0] === "step" ? 1 : 2]) === "[\"zoom\"]";

/**
 * At least 15pt. MapLibre only allows `["zoom"]` as the input of a top-level
 * interpolate/step, so a zoom curve keeps its shape and has its outputs raised;
 * other expressions get a `max` floor; anything unreadable becomes 15.
 */
export function minimumTextSize(size: unknown): unknown {
  if (typeof size === "number") return Math.max(MIN_LABEL_SIZE, size);
  if (isZoomCurve(size)) {
    const first = size[0] === "step" ? 2 : 3;
    return size.map((value, index) => {
      const output = size[0] === "step" ? (index - first) % 2 === 0 : (index - first) % 2 === 1;
      return index >= first && output ? minimumTextSize(value) : value;
    });
  }
  if (Array.isArray(size) && !JSON.stringify(size).includes("\"zoom\"")) return ["max", MIN_LABEL_SIZE, size];
  return MIN_LABEL_SIZE;
}

/** The detail map's name expression for a language, with the English line at full size. */
export function placeNameField(language: LabelPreferences["language"]): unknown {
  return JSON.parse(JSON.stringify(createDetailedEarthLabelExpression(language)).replaceAll("\"font-scale\":0.74", "\"font-scale\":1"));
}

/** Opaque, haloed, >= 15pt; applied to the Journey label layer before MapLibre adds it. */
export function legibleJourneyLabels<T extends Layer>(layer: T): T {
  if (layer.id !== JOURNEY_LABEL_LAYER) return layer;
  return { ...layer,
    layout: { ...layer.layout, "text-size": minimumTextSize(layer.layout?.["text-size"]) },
    paint: { ...layer.paint, "text-color": "#f2f4f8", "text-halo-color": "#07090f", "text-halo-width": 2.4 } };
}

const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

/** Writes only values that differ, so a settled style is never marked changed again. */
function legiblePlaceNames(map: MapLike, id: string) {
  const layout: [string, unknown][] = [
    ["text-field", placeNameField(preferences.language)],
    ["text-size", minimumTextSize(map.getLayoutProperty(id, "text-size"))],
  ];
  for (const [name, value] of layout) {
    if (!same(map.getLayoutProperty(id, name), value)) map.setLayoutProperty(id, name, value);
  }
  for (const [name, value] of [["text-halo-width", 2], ["text-halo-color", "#07090f"]] as const) {
    if (!same(map.getPaintProperty(id, name), value)) map.setPaintProperty(id, name, value);
  }
}

function restyle(map: MapLike) {
  applying = true;
  try {
    for (const layer of map.getStyle()?.layers ?? []) {
      if (layer.type === "symbol" && isDetailedEarthNameLabel(layer.layout?.["text-field"])) legiblePlaceNames(map, layer.id);
    }
  } catch {
    // A style mid-load is restyled by DetailedEarthMap's next language pass.
  } finally { applying = false; }
}

/** Patch once; DetailedEarthMap's own language calls become the native choice. */
export function installDetailMapOverrides(prototype: {
  addLayer: (...args: never[]) => unknown;
  setLayoutProperty: (...args: never[]) => unknown;
  remove: (...args: never[]) => unknown;
}) {
  const marker = prototype as { __startripsNative?: boolean };
  if (marker.__startripsNative) return;
  marker.__startripsNative = true;
  const addLayer = prototype.addLayer as unknown as (this: MapLike, layer: Layer, before?: string) => unknown;
  const setLayout = prototype.setLayoutProperty as unknown as (this: MapLike, id: string, name: string, value: unknown) => unknown;
  const remove = prototype.remove as unknown as (this: MapLike) => unknown;
  (prototype as Record<string, unknown>).addLayer = function (this: MapLike, layer: Layer, before?: string) {
    maps.add(this);
    return addLayer.call(this, legibleJourneyLabels(layer), before);
  };
  (prototype as Record<string, unknown>).setLayoutProperty = function (this: MapLike, id: string, name: string, value: unknown) {
    if (applying || name !== "text-field" || !isDetailedEarthNameLabel(value)) return setLayout.call(this, id, name, value);
    // DetailedEarthMap's language pass (once per style load): apply every override to this layer.
    maps.add(this);
    applying = true;
    try { legiblePlaceNames(this, id); } finally { applying = false; }
    return this;
  };
  (prototype as Record<string, unknown>).remove = function (this: MapLike) {
    maps.delete(this);
    return remove.call(this);
  };
}

export function setDetailLabelPreferences(next: LabelPreferences) {
  if (same(next, preferences)) return;
  preferences = next;
  maps.forEach(restyle);
}

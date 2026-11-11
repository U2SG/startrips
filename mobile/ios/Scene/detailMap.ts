import { createDetailedEarthLabelExpression, isDetailedEarthNameLabel } from "../../../src/scene/detailedEarthModel";
import type { LabelPreferences } from "./bridge";

// iPhone-only overrides for the zoomed detail map (MapLibre). The shared
// DetailedEarthMap keeps its Web behaviour; this bundle patches the MapLibre
// prototype it loads so labels follow native Settings and low-vision sizing.

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
  on(type: string, listener: () => void): unknown;
};

let preferences: LabelPreferences = { language: "zh", showPlaceNames: false };
const maps = new Set<MapLike>();
let applying = false;

/** At least 15pt: constants are raised; zoom expressions get a floor. */
export function minimumTextSize(size: unknown): unknown {
  if (typeof size === "number") return Math.max(MIN_LABEL_SIZE, size);
  if (Array.isArray(size)) return ["max", MIN_LABEL_SIZE, size];
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

function restyle(map: MapLike) {
  const layers = map.getStyle()?.layers ?? [];
  applying = true;
  try {
    for (const layer of layers) {
      if (layer.type !== "symbol" || !isDetailedEarthNameLabel(layer.layout?.["text-field"])) continue;
      const updates: [string, unknown][] = [
        ["text-field", placeNameField(preferences.language)],
        ["text-size", minimumTextSize(map.getLayoutProperty(layer.id, "text-size"))],
      ];
      for (const [name, value] of updates) {
        if (!same(map.getLayoutProperty(layer.id, name), value)) map.setLayoutProperty(layer.id, name, value);
      }
      for (const [name, value] of [["text-halo-width", 2], ["text-halo-color", "#07090f"]] as const) {
        if (!same(map.getPaintProperty(layer.id, name), value)) map.setPaintProperty(layer.id, name, value);
      }
    }
  } catch {
    // The style can be mid-load; the next styledata event applies the overrides.
  } finally { applying = false; }
}

function track(map: MapLike) {
  if (maps.has(map)) return;
  maps.add(map);
  map.on("styledata", () => { if (!applying) restyle(map); });
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
    track(this);
    return addLayer.call(this, legibleJourneyLabels(layer), before);
  };
  (prototype as Record<string, unknown>).setLayoutProperty = function (this: MapLike, id: string, name: string, value: unknown) {
    track(this);
    const replaced = !applying && name === "text-field" && isDetailedEarthNameLabel(value) ? placeNameField(preferences.language) : value;
    return setLayout.call(this, id, name, replaced);
  };
  (prototype as Record<string, unknown>).remove = function (this: MapLike) {
    maps.delete(this);
    return remove.call(this);
  };
}

export function setDetailLabelPreferences(next: LabelPreferences) {
  preferences = next;
  maps.forEach(restyle);
}

import { describe, expect, it } from "vitest";
import { createDetailedEarthLabelExpression } from "../../../src/scene/detailedEarthModel";
import { installDetailMapOverrides, JOURNEY_LABEL_LAYER, legibleJourneyLabels, minimumTextSize, placeNameField, setDetailLabelPreferences } from "./detailMap";

describe("iPhone detail map labels", () => {
  it("never draws a label under 15pt", () => {
    expect(minimumTextSize(11)).toBe(15);
    expect(minimumTextSize(18)).toBe(18);
    const zoom = ["interpolate", ["linear"], ["zoom"], 4, 10, 12, 16];
    expect(minimumTextSize(zoom)).toEqual(["max", 15, zoom]);
    expect(minimumTextSize({ stops: [[4, 10]] })).toBe(15);
    expect(minimumTextSize(undefined)).toBe(15);
  });

  it("makes only the Journey label layer opaque, haloed and large", () => {
    const layer = { id: JOURNEY_LABEL_LAYER, type: "symbol", layout: { "text-size": 11, "text-field": ["get", "label"] },
      paint: { "text-color": "rgba(241, 247, 248, 0.92)", "text-halo-width": 1.3 } };
    const legible = legibleJourneyLabels(layer);
    expect(legible.layout).toMatchObject({ "text-size": 15, "text-field": ["get", "label"] });
    expect(legible.paint).toMatchObject({ "text-color": "#f2f4f8", "text-halo-width": 2.4 });
    const other = { id: "roads", type: "line" };
    expect(legibleJourneyLabels(other)).toBe(other);
  });

  it("uses the shared name expression, with the bilingual line at full size", () => {
    expect(placeNameField("zh")).toEqual(createDetailedEarthLabelExpression("zh"));
    const bilingual = JSON.stringify(placeNameField("bilingual"));
    expect(bilingual).toContain("\"font-scale\":1");
    expect(bilingual).not.toContain("0.74");
  });

  it("routes the detail map's own language calls and Settings changes through native preferences", () => {
    const calls: [string, string, unknown][] = [];
    const style = { layers: [
      { id: "place", type: "symbol", layout: { "text-field": createDetailedEarthLabelExpression("zh"), "text-size": 12 } as Record<string, unknown> },
      { id: JOURNEY_LABEL_LAYER, type: "symbol", layout: { "text-field": ["get", "label"] } as Record<string, unknown> },
    ] };
    const added: unknown[] = [];
    class FakeMap {
      listeners: (() => void)[] = [];
      getStyle() { return style; }
      getLayoutProperty(id: string, name: string) { return style.layers.find((layer) => layer.id === id)?.layout[name]; }
      getPaintProperty() { return undefined; }
      setPaintProperty(id: string, name: string, value: unknown) { calls.push([id, name, value]); }
      on(_type: string, listener: () => void) { this.listeners.push(listener); }
      addLayer(layer: unknown) { added.push(layer); }
      setLayoutProperty(id: string, name: string, value: unknown) {
        calls.push([id, name, value]);
        const layer = style.layers.find((candidate) => candidate.id === id);
        if (layer) layer.layout[name] = value;
      }
      remove() {}
    }
    installDetailMapOverrides(FakeMap.prototype as never);
    installDetailMapOverrides(FakeMap.prototype as never); // idempotent
    const map = new FakeMap();
    map.addLayer({ id: JOURNEY_LABEL_LAYER, type: "symbol", layout: { "text-size": 11 } });
    expect(added[0]).toMatchObject({ layout: { "text-size": 15 } });

    setDetailLabelPreferences({ language: "bilingual", showPlaceNames: true });
    expect(style.layers[0].layout["text-field"]).toEqual(placeNameField("bilingual"));
    expect(style.layers[0].layout["text-size"]).toBe(15);
    expect(style.layers[1].layout["text-field"]).toEqual(["get", "label"]);

    // DetailedEarthMap re-applies its own "zh" choice after a style reload.
    map.setLayoutProperty("place", "text-field", createDetailedEarthLabelExpression("zh"));
    expect(style.layers[0].layout["text-field"]).toEqual(placeNameField("bilingual"));

    calls.length = 0;
    map.listeners.forEach((listener) => listener());
    expect(calls.filter(([, name]) => name === "text-field")).toEqual([]);
    setDetailLabelPreferences({ language: "zh", showPlaceNames: false });
    expect(style.layers[0].layout["text-field"]).toEqual(createDetailedEarthLabelExpression("zh"));
  });
});

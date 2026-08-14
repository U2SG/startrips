import { describe, expect, it } from "vitest";
import type { JourneyRoute } from "../journey/types";
import {
  buildDetailedEarthData,
  createDetailedEarthStyle,
} from "./detailedEarthModel";

describe("detailedEarthModel", () => {
  it("preserves journey and route point identities in GeoJSON", () => {
    const routes: JourneyRoute[] = [{
      id: "journey-1",
      color: "#77c8c2",
      points: [
        { id: "point-1", lat: 22.5431, lon: 114.0579, isStop: true, label: "Shenzhen" },
        { id: "point-2", lat: 23.1291, lon: 113.2644, isStop: true, label: "Guangzhou" },
      ],
    }];

    const data = buildDetailedEarthData(routes);
    expect(data.routeLines.features[0].geometry.coordinates).toEqual([
      [114.0579, 22.5431],
      [113.2644, 23.1291],
    ]);
    expect(data.routePoints.features.map((feature) => feature.properties)).toEqual([
      expect.objectContaining({ journeyId: "journey-1", routePointId: "point-1" }),
      expect.objectContaining({ journeyId: "journey-1", routePointId: "point-2" }),
    ]);
  });

  it("uses a globe projection with separate imagery and detail sources", () => {
    const style = createDetailedEarthStyle();
    expect(style.projection).toEqual({ type: "globe" });
    expect(style.sources).toHaveProperty("blue-marble");
    expect(style.sources).toHaveProperty("detail-map");
  });
});

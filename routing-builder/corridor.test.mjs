import { describe, expect, it } from "vitest";
import { buildCorridorQuery, graphId, parseGraphRequest } from "./corridor.mjs";
import { classifyOverpassBody, createOverpassScanner } from "./overpass.mjs";

const auckland = { lat: -36.8485, lon: 174.7633 };
const hamilton = { lat: -37.787, lon: 175.2793 };
const nearby = { lat: -36.86, lon: 174.78 };

describe("corridor query", () => {
  it("adds full road detail within the nearby-point search radius and a radius-scaled corridor per leg", () => {
    const query = buildCorridorQuery("driving", [auckland, nearby]);
    expect(query.startsWith("[out:xml][timeout:180][maxsize:536870912];")).toBe(true);
    expect(query).toContain('way(around:25000,-36.85,174.76)[highway~"^(motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|unclassified|residential|living_street|service|road)$"];');
    // A 2 km leg uses the 5 km minimum corridor radius with full classes.
    expect(query).toMatch(/way\(around:5000,-36\.85,174\.76,-36\.86,174\.78\)\[highway~"\^\(motorway\|.*\|road\)\$"\];/);
    expect(query).toContain("rel(bw.roads)[type=restriction]");
    expect(query.trim().endsWith("(._; >;);\nout;")).toBe(true);
  });

  it("keeps the roads that join rural towns along long driving legs and keeps legs independent", () => {
    const query = buildCorridorQuery("driving", [auckland, hamilton, { lat: -37.79, lon: 175.3 }]);
    const legs = query.split("\n").filter((line) => /around:\d+,[-\d.]+,[-\d.]+,[-\d.]+,[-\d.]+\)\[highway/.test(line));
    expect(legs).toHaveLength(2);
    // ~110 km -> 15% = a 10-20 km radius, through tertiary and unclassified.
    expect(legs[0]).toMatch(/around:1\d{4},/);
    expect(legs[0]).toContain('highway~"^(motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|unclassified)$"');
    expect(legs[1]).toContain("around:5000,");
    expect(legs[1]).toContain("residential");
  });

  it("builds an extended tier with full profile classes along a wider corridor and its own identity", () => {
    const driving = buildCorridorQuery("driving", [auckland, hamilton], "extended");
    const leg = driving.split("\n").find((line) => /around:\d+,[-\d.]+,[-\d.]+,[-\d.]+,[-\d.]+\)\[highway/.test(line));
    // ~110 km -> 20% = a 20-30 km radius with every driving class.
    expect(leg).toMatch(/around:2\d{4},/);
    expect(leg).toContain("unclassified|residential|living_street|service|road");
    expect(buildCorridorQuery("driving", [auckland, nearby], "extended")).toContain("around:8000,-36.85,174.76,-36.86,174.78");
    expect(buildCorridorQuery("driving", [{ lat: 0, lon: 0 }, { lat: 0, lon: 3 }], "extended")).toContain("around:40000,0.00,0.00,0.00,3.00");
    const walking = buildCorridorQuery("walking", [auckland, hamilton], "extended");
    expect(walking.split("\n").filter((line) => line.includes("[highway]"))).toHaveLength(3);
    expect(walking).not.toContain("cycleway|path|track");
    const standard = buildCorridorQuery("driving", [auckland, hamilton]);
    expect(graphId("driving", standard)).not.toBe(graphId("driving", standard, "extended"));
  });

  it("lets walking and cycling profiles decide access except motorways, with a long-leg class set", () => {
    const short = buildCorridorQuery("walking", [auckland, nearby]);
    expect(short).toContain('[highway][highway!~"^(motorway|motorway_link)$"]');
    const long = buildCorridorQuery("cycling", [auckland, hamilton]);
    const leg = long.split("\n").find((line) => /around:1\d{4},/.test(line));
    expect(leg).toContain("cycleway|path|track");
    expect(leg).not.toContain("motorway");
  });

  it("includes ferry routes along every leg for every profile", () => {
    for (const profile of ["driving", "walking", "cycling"]) {
      const query = buildCorridorQuery(profile, [auckland, hamilton, nearby]);
      const ferries = query.split("\n").filter((line) => line.includes("[route=ferry]"));
      expect(ferries).toHaveLength(2);
      expect(ferries[0]).toMatch(/way\(around:1\d{4},-36\.85,174\.76,-37\.79,175\.28\)\[route=ferry\];/);
    }
  });

  it("clamps the corridor radius at 30 km and rejects corridors beyond 400 km", () => {
    const query = buildCorridorQuery("driving", [{ lat: 0, lon: 0 }, { lat: 0, lon: 3 }]);
    expect(query).toContain("around:30000,0.00,0.00,0.00,3.00");
    expect(() => buildCorridorQuery("driving", [{ lat: 0, lon: 0 }, { lat: 0, lon: 4 }])).toThrow(expect.objectContaining({ code: "ROUTING_AREA_TOO_LARGE" }));
  });

  it("quantizes points so small drags share one graph identity", () => {
    const a = buildCorridorQuery("walking", [auckland, nearby]);
    const b = buildCorridorQuery("walking", [{ lat: -36.8471, lon: 174.7611 }, { lat: -36.8611, lon: 174.7789 }]);
    expect(b).toBe(a);
    expect(graphId("walking", a)).toBe(graphId("walking", b));
    expect(graphId("cycling", a)).not.toBe(graphId("walking", a));
    expect(graphId("walking", a)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("graph request validation", () => {
  it.each([
    null, [], {}, { profile: "driving" },
    { profile: "flying", points: [auckland] },
    { profile: "driving", points: [] },
    { profile: "driving", points: Array.from({ length: 19 }, () => auckland) },
    { profile: "driving", points: [{ lat: 91, lon: 0 }] },
    { profile: "driving", points: [{ lat: "0", lon: 0 }] },
    { profile: "driving", points: [{ lat: 0, lon: 0, atlasId: "x" }] },
    { profile: "driving", points: [auckland], extra: true },
    { profile: "driving", points: [auckland], detail: "maximal" },
  ])("rejects %j", (body) => {
    expect(() => parseGraphRequest(body)).toThrow(expect.objectContaining({ code: "INVALID_GRAPH_REQUEST" }));
  });
  it("accepts a bounded point list with an optional detail tier", () => {
    expect(parseGraphRequest({ profile: "cycling", points: [auckland, nearby] })).toEqual({ profile: "cycling", points: [auckland, nearby], detail: "standard" });
    expect(parseGraphRequest({ profile: "driving", points: [auckland], detail: "extended" }).detail).toBe("extended");
  });
});

describe("Overpass body classification", () => {
  const scan = (...chunks) => { const scanner = createOverpassScanner(); chunks.forEach((chunk) => scanner.push(chunk)); return scanner.result(); };
  it("finds markers split across chunks", () => {
    const result = scan('<osm><node id="1"/><wa', 'y id="2"></way></os', "m>");
    expect(result).toEqual({ remark: null, sawWay: true, sawEnd: true });
    expect(classifyOverpassBody(result)).toBeNull();
  });
  it("maps a 200 runtime error remark to a specific code", () => {
    expect(classifyOverpassBody(scan("<osm><remark> runtime error: Query run out of memory using about 512 MB of RAM. </remark></osm>")).code).toBe("ROUTING_AREA_TOO_LARGE");
    expect(classifyOverpassBody(scan("<osm><remark>runtime error: Query timed out in \"query\" at line 3 after 181 seconds.</remark></osm>")).code).toBe("ROUTING_DATA_UNAVAILABLE");
    expect(classifyOverpassBody(scan('<osm><remark>runtime remark: informational</remark><way id="1"></way></osm>'))).toBeNull();
  });
  it("treats an empty extract as no roads", () => {
    expect(classifyOverpassBody(scan("<osm></osm>")).code).toBe("ROUTING_NO_ROADS");
  });
});

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LivingAtlasGlobe, LivingAtlasGlobeControls, PersistentEarthProvider, particleAnchorFramesEqual, resolveLivingAtlasHomeBaseLayer } from "./LivingAtlasGlobe";
import { getRouteFocusPhase } from "./ParticleEarthScene";
import type { HomeBasePeriod } from "../journey/homeBase";
import { resolveHomeBasePresence } from "../journey/homeBasePresence";
import { readFileSync } from "node:fs";

function markup(storedAmbience: string | null) {
  // A stored preference must not be able to remove the ambience layer, so the
  // globe is rendered with the old "off" value still present in storage.
  const previous = (globalThis as { localStorage?: unknown }).localStorage;
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: () => storedAmbience,
    setItem: () => undefined,
  };
  try {
    return renderToStaticMarkup(createElement(
      PersistentEarthProvider,
      null,
      createElement(LivingAtlasGlobe, {
        journeyRoutes: [],
        onJourneyRouteActivate: () => undefined,
        onJourneyRoutePointActivate: () => undefined,
      }),
    ));
  } finally {
    (globalThis as { localStorage?: unknown }).localStorage = previous;
  }
}

describe("LivingAtlasGlobe ambience", () => {
  it("renders the ambience field on first paint with no toggle", () => {
    const rendered = markup(null);
    expect(rendered).toContain("living-atlas-ambience");
    expect(rendered).toContain("living-atlas-ambience__blob-a");
    expect(rendered).toContain('data-ambience="on"');
    expect(rendered).not.toContain("data-ambience-toggle");
    expect(rendered).not.toContain("开启氛围效果");
    expect(rendered).not.toContain("关闭氛围效果");
  });

  it("ignores a stored preference that used to disable the ambience", () => {
    expect(markup("off")).toContain("living-atlas-ambience__blob-c");
    expect(markup("off")).toContain('data-ambience="on"');
  });
});


describe("Semantic Earth Dive renderer ownership", () => {
  it("publishes Particle Earth backend degradation on the persistent host", () => {
    const globe = readFileSync(new URL("./LivingAtlasGlobe.tsx", import.meta.url), "utf8");
    expect(globe).toContain('data-particle-earth-backend={particleEarthBackend}');
    expect(globe).toContain('onBackendChange={setParticleEarthBackend}');
    expect(globe).toContain('useState<ParticleEarthBackend | "pending">("pending")');
  });

  it("does not re-arm the Dive scheduler for an unchanged published particle frame", () => {
    const frame = {
      anchor: { lat: 31.2, lon: 121.5 },
      screen: { x: 720, y: 512 },
      pxPerDegreeLat: 10.4,
      zoom: 4.2,
    };
    expect(particleAnchorFramesEqual(frame, {
      anchor: { ...frame.anchor },
      screen: { ...frame.screen },
      pxPerDegreeLat: frame.pxPerDegreeLat,
      zoom: frame.zoom,
    })).toBe(true);
    expect(particleAnchorFramesEqual(frame, {
      ...frame,
      screen: { ...frame.screen, x: frame.screen.x + 1 },
    })).toBe(false);
    expect(particleAnchorFramesEqual(frame, null)).toBe(false);

    const globe = readFileSync(new URL("./LivingAtlasGlobe.tsx", import.meta.url), "utf8");
    const start = globe.indexOf("const handleParticleAnchorFrame =");
    const end = globe.indexOf("const handleHomeBasePresenceFrame =", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const handler = globe.slice(start, end);
    const dedup = handler.indexOf("if (particleAnchorFramesEqual(previousFrame, frame)) return;");
    const wake = handler.indexOf("scheduleDiveTick();");
    expect(dedup).toBeGreaterThanOrEqual(0);
    expect(wake).toBeGreaterThan(dedup);
  });

  it("mounts detail non-interactive and only enables particle hold after detail owns input", () => {
    const globe = readFileSync(new URL("./LivingAtlasGlobe.tsx", import.meta.url), "utf8");
    const detail = readFileSync(new URL("./DetailedEarthMap.tsx", import.meta.url), "utf8");
    const particle = readFileSync(new URL("./ParticleEarthScene.tsx", import.meta.url), "utf8");
    expect(globe).toContain('cameraHold={Boolean(atlas) && atlas?.inputOwner === "detail"}');
    expect(globe).toContain('if (diveRef.current.owner === "detail") return;');
    expect(particle).toMatch(/!cameraHeldByDetail[\s\S]*?getGlobeIdleRotationDelta/);
    expect(detail).toContain("interactive: false");
    expect(detail).toContain('const owns = diveOwner === "detail";');
    expect(detail).toContain("canvas.tabIndex = 0");
    expect(detail).toContain("canvas.tabIndex = -1");
    expect(detail).toContain("map.boxZoom.enable()");
    expect(detail).toContain("map.boxZoom.disable()");
    expect(detail).toContain("map.touchPitch.enable()");
    expect(detail).toContain("map.touchPitch.disable()");
    expect(detail).toContain("map.scrollZoom.enable()");
    expect(detail).toContain("map.scrollZoom.disable()");
  });

  it("hands user zoom back at the return threshold without accepting programmatic zoom", () => {
    const detail = readFileSync(new URL("./DetailedEarthMap.tsx", import.meta.url), "utf8");
    expect(detail).toMatch(/const userZoomHandlerActive = \(\) => \([\s\S]*?map\.scrollZoom\.isActive\(\)[\s\S]*?map\.touchZoomRotate\.isActive\(\)[\s\S]*?map\.keyboard\.isActive\(\)/);
    expect(detail).toMatch(/map\.on\("zoom", \(\) => \{[\s\S]*?!userZoomHandlerActive\(\)[\s\S]*?shouldReturnToParticleEarth\(map\.getZoom\(\)\)/);
    expect(detail).not.toContain("userZoomGestureActive");
    expect(detail).not.toContain("markUserWheelZoom");
  });

  it("reconciles fully-settled readiness on the terminal camera edge", () => {
    const detail = readFileSync(new URL("./DetailedEarthMap.tsx", import.meta.url), "utf8");
    expect(detail).toMatch(/map\.on\("moveend", \(\) => \{[\s\S]*?!map\.isMoving\(\)[\s\S]*?reconcileFullySettled\(\)/);
  });

  it("does not block Journey readiness on unrelated basemap tile churn", () => {
    const detail = readFileSync(new URL("./DetailedEarthMap.tsx", import.meta.url), "utf8");
    const start = detail.indexOf("const reconcileFullySettled = () => {");
    const end = detail.indexOf("const syncJourneyOverlay = () => {", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const reconcile = detail.slice(start, end);
    expect(reconcile).toContain("paintedJourneyOverlayRevision !== journeyOverlayRef.current.revision");
    expect(reconcile).toContain("map.isMoving()");
    expect(reconcile).not.toContain("map.isStyleLoaded()");
    expect(reconcile).not.toContain("map.areTilesLoaded()");
  });

  it("keeps per-frame handoff calibration on the imperative publish path", () => {
    const globe = readFileSync(new URL("./LivingAtlasGlobe.tsx", import.meta.url), "utf8");
    const detail = readFileSync(new URL("./DetailedEarthMap.tsx", import.meta.url), "utf8");
    expect(globe).toContain('detailCalibrationRef.current?.(frame, "sync")');
    expect(globe).toContain('detailCalibrationRef.current?.(particleFrameRef.current, "retry")');
    expect(detail).toContain('mode: "sync" | "retry" = "sync"');
    expect(detail).toContain('const newParticleFrame = mode === "sync" && isNewParticleCalibrationFrame(particle)');
    expect(detail).toMatch(/if \(newParticleFrame\) \{[\s\S]*?cameraIntentRevisionRef\.current \+= 1;[\s\S]*?map\.jumpTo\(\{ center: frame\.center \}\);/);
    expect(detail).toContain("CALIBRATION_RETRY_PASSES = 2");
    expect(detail).toContain("[diveOwner, diveStage, focusPoint, focusRoute]");
    expect(detail).not.toContain("[diveOwner, diveSnapshot, diveStage, focusPoint, focusRoute, particleFrame]");
  });

  it("keeps the resolver mirror and release latch on committed Dive presentation state", () => {
    const globe = readFileSync(new URL("./LivingAtlasGlobe.tsx", import.meta.url), "utf8");
    expect(globe).toMatch(/useEffect\(\(\) => \{\s*diveRef\.current = dive;[\s\S]*?\}, \[dive, scheduleDiveTick\]\);/);
    expect(globe).not.toContain("diveRef.current = next;");
    expect(globe).toMatch(/if \(\s*releaseRequestedRef\.current\s*&& \(previous\.stage === "prewarm" \|\| previous\.stage === "particle"\)\s*\) \{\s*releaseRequestedRef\.current = false;/);
    expect(globe).not.toContain(
      'if (next.stage === "prewarm" || next.stage === "particle") releaseRequestedRef.current = false;',
    );
  });

  it("checks hard renderer policy before preload, mount and ownership", () => {
    const globe = readFileSync(new URL("./LivingAtlasGlobe.tsx", import.meta.url), "utf8");
    const detail = readFileSync(new URL("./DetailedEarthMap.tsx", import.meta.url), "utf8");
    expect(globe).toContain('if (earthExperiencePolicy !== "default") return;');
    expect(globe).toContain(
      'const showDetail = earthExperiencePolicy === "default" && effectiveDive.stage !== "particle";',
    );
    expect(globe).toContain("policy: earthExperiencePolicyRef.current");
    expect(globe).toContain("entryAllowed: policyEntryArmedRef.current");
    expect(globe).toContain("onCameraObservation={handleDetailCameraObservation}");
    expect(detail).toContain("__detailedEarthMapConstructionCount");
    expect(detail).toContain("__detailedEarthMapRemovalCount");
    expect(detail).toContain("onCameraObservationRef.current?.(");
  });

  it("requires a post-policy intent instead of rearming from a stale semantic snapshot", () => {
    const globe = readFileSync(new URL("./LivingAtlasGlobe.tsx", import.meta.url), "utf8");
    const semanticHandler = globe.match(
      /const handleSemanticZoomSnapshot = useCallback\(\(snapshot: SemanticZoomSnapshot\) => \{[\s\S]*?\}, \[onSemanticZoomChange, scheduleDiveTick, syncDetailSpatialReveal\]\);/,
    )?.[0] ?? "";
    expect(semanticHandler).not.toBe("");
    expect(semanticHandler).not.toContain("policyEntryArmedRef.current = true");
    expect(globe).toContain('if (earthExperiencePolicyRef.current === "default") policyEntryArmedRef.current = true;');
    expect(globe).toContain("nextFocusRevision !== policyFocusRevisionRef.current");
    expect(globe).toMatch(/policyEntryArmedRef\.current = true;\s+if \(diveRef\.current\.stage !== "particle"\)/);
  });
});

describe("Semantic Earth Dive accessibility fallback (#308)", () => {
  it("keeps the intent mounted when optional detail utilities are suppressed", () => {
    const rendered = renderToStaticMarkup(createElement(LivingAtlasGlobeControls, {
      diveStage: "detail",
      detailLanguage: "zh",
      onDiveIntent: () => undefined,
      onDetailLanguageChange: () => undefined,
      onPickRequest: () => undefined,
      showDiveIntent: true,
      showDetailControls: false,
    }));

    expect(rendered).toContain('data-earth-dive-intent="true"');
    expect(rendered).toContain('aria-label="返回远景"');
    expect(rendered).not.toContain("living-atlas-globe__language");
    expect(rendered).not.toContain("living-atlas-globe__pick");
    expect(rendered).not.toMatch(/真实地图|REGION MAP|ART GLOBE|particle|detail/i);
  });

  it("keeps ordinary compact layout Dive ownership independent from detail chrome", () => {
    const source = readFileSync(new URL("./LivingAtlasGlobe.tsx", import.meta.url), "utf8");
    expect(source).toContain("const showDiveIntent = !globeFocusMode && !cinematicActive;");
    expect(source).toContain("{showControls || showDiveIntent ? (");
    expect(source).toContain("showDiveIntent={showDiveIntent}");
    expect(source).toContain("showDetailControls={showControls}");
  });
});
describe("route focus choreography phase", () => {
  it("derives flying and settled from route ownership", () => {
    expect(getRouteFocusPhase(true, true, false)).toBe("flying");
    expect(getRouteFocusPhase(true, false, false)).toBe("settled");
  });

  it("keeps zoom release distinct from the idle state", () => {
    expect(getRouteFocusPhase(false, false, true)).toBe("releasing");
    expect(getRouteFocusPhase(false, false, false)).toBe("idle");
  });
});


describe("Home Base presence projection (ST-056)", () => {
  const period: HomeBasePeriod = {
    id: "home-shenzhen", label: "Shenzhen", latitude: 22.5431, longitude: 114.0579,
    startedOn: "2026-01-01", endedOn: null, source: "manual",
  };

  it("turns the typed Home prop into one drawable and leaves an absent prop empty", () => {
    const resolved = resolveHomeBasePresence({
      periods: [period], semanticZoom: "regional", timeline: { kind: "ordinary", date: "2026-09-10" },
    });
    const layer = resolveLivingAtlasHomeBaseLayer({ resolved, periods: [period], effectiveDate: "2026-09-10" });
    expect(layer).toHaveLength(1);
    expect(layer[0].anchor).toBe(resolved[0].anchor);
    expect(resolveLivingAtlasHomeBaseLayer(undefined)).toEqual([]);
  });

  it("keeps projection and manual ownership inside the existing particle scene authority", () => {
    const source = readFileSync(new URL("./ParticleEarthScene.tsx", import.meta.url), "utf8");
    expect(source).toContain("projectLocalPoint(");
    expect(source).toContain("descriptor.anchor.x");
    expect(source).toMatch(/visible:\s*visible\s*&&\s*isProjectedPointInsideViewport\(\s*homeBaseProjectionPoint\.x,/);
    expect(source).toContain("latestOnManualCameraInteraction.current?.()");
    expect(source).toContain("claimManualInteraction(false)");
  });
  it("updates projected Home overlays outside React render cadence", () => {
    const source = readFileSync(new URL("./LivingAtlasGlobe.tsx", import.meta.url), "utf8");
    expect(source).not.toContain("setHomeBaseFrames");
    expect(source).toContain("element.hidden = !visible");
    expect(source).toContain('element.style.display = visible ? "" : "none"');
    expect(source).toContain("element.tabIndex = visible ? 0 : -1");
    expect(source).toContain("element.style.left = `${frame.x}px`");
    expect(source).toContain("element.style.top = `${frame.y}px`");
  });
  it("keeps initial Home camera seeding separate from semantic focus ownership", () => {
    const globeSource = readFileSync(new URL("./LivingAtlasGlobe.tsx", import.meta.url), "utf8");
    const particleSource = readFileSync(new URL("./ParticleEarthScene.tsx", import.meta.url), "utf8");
    expect(globeSource).toContain("focusPoint={atlas?.focusPoint}");
    expect(globeSource).toContain("initialCameraAnchor={atlas?.initialCameraAnchor}");
    expect(globeSource).not.toContain("focusPoint={atlas?.focusPoint ?? atlas?.initialCameraAnchor}");
    expect(particleSource).toContain("initialCameraAnchorNow");
    expect(particleSource).toContain("const initialCameraRotation = focusSolverOwnsState && initialCameraAnchorNow");
    expect(particleSource).toContain("solveFocusRotationForViewport(");
    expect(particleSource).toContain("nearestEquivalentRotation(interactiveRotationX, initialCameraRotation.x)");
    expect(particleSource).toContain("nearestEquivalentRotation(baseRotationY, initialCameraRotation.y)");
    expect(particleSource).toContain("if (initialCameraAnchorNow && activePointers.size === 0)");
    expect(particleSource).toContain("interactiveRotationX = interpolate(interactiveRotationX, targetRotationX)");
    expect(particleSource).toMatch(/resolveParticleDiveAnchor\(\s*routeFocusFrame,\s*latestFocusPoint\.current,\s*initialCameraAnchorNow,/);
  });
  it("keeps Home presence on the particle owner through prewarm/blend and off the detail owner", () => {
    const source = readFileSync(new URL("./LivingAtlasGlobe.tsx", import.meta.url), "utf8");
    expect(source).toContain('const homeBaseInteractive = effectiveDive.owner !== "detail"');
    expect(source).toContain('onHomeBaseActivate: homeBaseInteractive ? onHomeBaseActivate : undefined');
  });
  it("yields the Home hit target completely while globe point-picking owns pointer input", () => {
    const source = readFileSync(new URL("./LivingAtlasGlobe.tsx", import.meta.url), "utf8");
    expect(source).toContain('const homeBaseInteractive = effectiveDive.owner !== "detail"');
    expect(source).toContain('onHomeBaseActivate: homeBaseInteractive ? onHomeBaseActivate : undefined');
  });

  it("wakes the persistent particle renderer when async Home presence and its fresh-Atlas camera seed arrive", () => {
    const source = readFileSync(new URL("./ParticleEarthScene.tsx", import.meta.url), "utf8");
    expect(source).toContain('setInitialCameraAnchor(anchor: ParticleEarthSceneProps["initialCameraAnchor"])');
    expect(source).toContain("setHomeBasePresence(presence: readonly HomeBasePresenceDrawable[])");
    expect(source).toContain("focusFlightActive: focusFlightActive || initialCameraAnchorSettling");
    expect(source).toContain("controllerRef.current?.setHomeBasePresence(homeBasePresence)");
  });

  it("projects Home from the current globe matrix even when no route vector layer is visible", () => {
    const source = readFileSync(new URL("./ParticleEarthScene.tsx", import.meta.url), "utf8");
    const homeProjection = source.slice(
      source.indexOf("if (latestOnHomeBasePresenceFrame.current)"),
      source.indexOf("if (latestCenterFocusPoint.current && spatialFocusPoint)"),
    );
    expect(homeProjection).toContain("globe.updateWorldMatrix(true, false);");
    expect(homeProjection.indexOf("globe.updateWorldMatrix(true, false);"))
      .toBeLessThan(homeProjection.indexOf("updateGeoProjectionFrame("));
  });

  it("ST-065 keeps the visible Home button as a keyboard target while pointer gestures stay renderer-owned", () => {
    const source = readFileSync(new URL("./LivingAtlasGlobe.tsx", import.meta.url), "utf8");
    const css = readFileSync(new URL("../styles/living-atlas.css", import.meta.url), "utf8");
    const start = css.indexOf(".living-atlas-globe__home-base {");
    const rule = css.slice(start, css.indexOf("}", start));
    expect(start).toBeGreaterThanOrEqual(0);
    expect(rule).toContain("pointer-events: none;");
    expect(source).toContain('type="button"');
    expect(source).toContain("element.tabIndex = visible ? 0 : -1");
    expect(source).toContain("onClick={() => onHomeBaseActivate?.(descriptor.periodId)}");
    expect(source).toContain('aria-controls={activeHomeBaseContextPeriodId === descriptor.periodId ? "home-base-context" : undefined}');
  });
});


describe("ST-065 Home / Route Point pointer ownership", () => {
  it("resolves globe pick, Route Point, then Home through the renderer's one pointer authority", () => {
    const globeSource = readFileSync(new URL("./LivingAtlasGlobe.tsx", import.meta.url), "utf8");
    const particleSource = readFileSync(new URL("./ParticleEarthScene.tsx", import.meta.url), "utf8");
    expect(globeSource).not.toContain("onRoutePointPointerResolver");
    expect(particleSource).toContain("personalRaycaster.params.Points = { threshold: 0.18 }");
    expect(particleSource).toContain("homeBaseTargetFromPointer");
    expect(particleSource).toContain("latestOnHomeBaseActivate.current?.(homeBasePeriodId)");
    const pick = particleSource.indexOf("if (canPickGlobe) {");
    const journey = particleSource.indexOf("if (canActivateJourney) {", pick);
    const home = particleSource.indexOf("const homeBasePeriodId = homeBaseTargetFromPointer", journey);
    expect(pick).toBeGreaterThanOrEqual(0);
    expect(journey).toBeGreaterThan(pick);
    expect(home).toBeGreaterThan(journey);
  });

  it("routes city-label contacts through that same renderer pointer authority", () => {
    const particleSource = readFileSync(new URL("./ParticleEarthScene.tsx", import.meta.url), "utf8");
    expect(particleSource).not.toContain('entry.element.addEventListener("pointerup"');
    expect(particleSource).toContain('cityVectorLayer.addEventListener("pointerdown", onCityLayerPointerDown)');
    expect(particleSource).toContain('cityVectorLayer.addEventListener("pointerup", onCityLayerPointerUp)');
    expect(particleSource).toContain('cityVectorLayer.addEventListener("pointercancel", onCityLayerPointerCancel)');
    expect(particleSource).toContain('cityVectorLayer.addEventListener("wheel", onCityLayerWheel, { passive: false })');
    expect(particleSource).toContain("onPointerDown(event);");
    expect(particleSource).toContain("onPointerUp(event, cityPickFromEventTarget(event.target));");
    expect(particleSource).toContain("cityPointerPicks.set(event.pointerId, cityPick)");
    expect(particleSource).toContain("explicitGlobePick ?? cityPointerPicks.get(event.pointerId)");
    expect(particleSource).toContain("onPointerCancel(event);");
    expect(particleSource).toContain("onWheel(event);");
    const css = readFileSync(new URL("../styles/living-atlas.css", import.meta.url), "utf8");
    const cityStart = css.indexOf(".particle-earth-city {");
    const cityRule = css.slice(cityStart, css.indexOf("}", cityStart));
    expect(cityStart).toBeGreaterThanOrEqual(0);
    expect(cityRule).toContain("pointer-events: auto;");
    expect(cityRule).toContain("touch-action: none;");
  });
});

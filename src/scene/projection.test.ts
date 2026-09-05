import { Group, Matrix4, PerspectiveCamera, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import {
  GEOGRAPHIC_SURFACE_RADIUS,
  ROUTE_ANCHOR_RADIUS,
  latLonToVector3,
  rotationXForLatitude,
  rotationYForLongitude,
  routePointAnchor,
} from "./geo";
import {
  composeGlobeModelMatrix,
  createGeoProjectionFrame,
  isLocalPointInsideClipViewport,
  isSphericalPointVisible,
  projectGeographicAnchor,
  projectGeographicAnchorToViewport,
  projectLocalPoint,
  projectLocalPointToViewport,
  updateGeoProjectionFrame,
} from "./projection";

const VIEWPORT = { width: 1280, height: 800 };

// #237 QA vicinity: the Pearl River Delta, framed the way the scene frames a
// focused place. The rotation is DERIVED from the framing helpers the app uses
// rather than picked, so which places land on the near side is a stated
// consequence instead of a lucky constant.
const FRAMED = { lat: 22.54554, lon: 114.0683 };

/** The globe placement the scene actually produces: off-centre, tilted, zoomed. */
function buildScene() {
  const camera = new PerspectiveCamera(38, VIEWPORT.width / VIEWPORT.height, 0.1, 100);
  camera.position.set(0, 0, 5.4);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);

  const globe = new Group();
  globe.position.set(0.18, -0.12, 0);
  globe.rotation.set(
    rotationXForLatitude(FRAMED.lat),
    rotationYForLongitude(FRAMED.lon),
    0,
  );
  globe.scale.setScalar(2.4);
  globe.updateWorldMatrix(true, false);

  const frame = updateGeoProjectionFrame(
    createGeoProjectionFrame(),
    camera,
    globe.matrixWorld,
    VIEWPORT.width,
    VIEWPORT.height,
  );
  return { camera, globe, frame };
}

// Spread across the framed cap, plus places on the far side of the planet so
// the horizon gate is exercised rather than merely available.
const PLACES = [
  { name: "Shenzhen", lat: FRAMED.lat, lon: FRAMED.lon },
  { name: "Tokyo", lat: 35.6895, lon: 139.6917 },
  { name: "Manila", lat: 14.5995, lon: 120.9842 },
  { name: "Singapore", lat: 1.28967, lon: 103.85007 },
  { name: "Reykjavik", lat: 64.13548, lon: -21.89541 },
  { name: "Denver", lat: 39.73915, lon: -104.9847 },
];

describe("single projection space (#237)", () => {
  it("gives one latitude/longitude one screen coordinate for every consumer", () => {
    const { frame } = buildScene();
    let visibleCount = 0;

    for (const place of PLACES) {
      // The Place Label / Route Point path: an anchor vector, then the frame.
      const anchor = routePointAnchor(place.lat, place.lon);
      const routePath = { x: 0, y: 0 };
      const routeVisible = projectLocalPoint(
        frame,
        anchor.x,
        anchor.y,
        anchor.z,
        routePath,
      );

      // The Journey connector path: the same helper, spelled with the surface
      // radius the connector names rather than the route anchor alias.
      const connectorAnchor = latLonToVector3(
        place.lat,
        place.lon,
        GEOGRAPHIC_SURFACE_RADIUS,
      );
      const connectorPath = { x: 0, y: 0 };
      const connectorVisible = projectLocalPoint(
        frame,
        connectorAnchor.x,
        connectorAnchor.y,
        connectorAnchor.z,
        connectorPath,
      );

      // The focus signal and coastline QA anchor path: latitude/longitude in,
      // screen anchor out, without restating the radius at the call site.
      const anchorPath = { x: 0, y: 0 };
      const anchorVisible = projectGeographicAnchor(
        frame,
        place.lat,
        place.lon,
        anchorPath,
      );

      if (anchorVisible) visibleCount += 1;
      expect(routeVisible).toBe(anchorVisible);
      expect(connectorVisible).toBe(anchorVisible);
      // Byte-identical, not merely close: every consumer is a reader of one
      // projection rather than an algebraically-equal copy of it.
      expect(Object.is(routePath.x, anchorPath.x)).toBe(true);
      expect(Object.is(routePath.y, anchorPath.y)).toBe(true);
      expect(Object.is(connectorPath.x, anchorPath.x)).toBe(true);
      expect(Object.is(connectorPath.y, anchorPath.y)).toBe(true);
    }

    // An occluded place makes every comparison above trivially true, so the
    // framing has to actually put places on the near side for this to mean
    // anything.
    expect(visibleCount).toBeGreaterThanOrEqual(2);
  });

  it("keeps ROUTE_ANCHOR_RADIUS an alias of the geographic surface", () => {
    expect(ROUTE_ANCHOR_RADIUS).toBe(GEOGRAPHIC_SURFACE_RADIUS);
    expect(GEOGRAPHIC_SURFACE_RADIUS).toBe(1.39);
  });

  it("composes the candidate globe matrix the way Object3D does", () => {
    const { globe } = buildScene();
    const composed = composeGlobeModelMatrix(new Matrix4(), {
      rotationX: globe.rotation.x,
      rotationY: globe.rotation.y,
      rotationZ: globe.rotation.z,
      scale: globe.scale.x,
      positionX: globe.position.x,
      positionY: globe.position.y,
      positionZ: globe.position.z,
    });
    // Stated as a precondition of the identity below: if three ever changed how
    // Object3D.updateMatrix composes, this line says so instead of leaving a
    // bare "coordinates differ".
    globe.matrixWorld.elements.forEach((value, index) => {
      expect(Object.is(composed.elements[index], value)).toBe(true);
    });
  });

  it("makes the focus rotation solver read the same projection as the labels", () => {
    const { camera, globe, frame } = buildScene();
    const candidateFrame = updateGeoProjectionFrame(
      createGeoProjectionFrame(),
      camera,
      composeGlobeModelMatrix(new Matrix4(), {
        rotationX: globe.rotation.x,
        rotationY: globe.rotation.y,
        rotationZ: globe.rotation.z,
        scale: globe.scale.x,
        positionX: globe.position.x,
        positionY: globe.position.y,
        positionZ: globe.position.z,
      }),
      VIEWPORT.width,
      VIEWPORT.height,
    );

    for (const place of PLACES) {
      const labelPath = { x: 0, y: 0 };
      const visible = projectGeographicAnchor(frame, place.lat, place.lon, labelPath);
      const solverPath = { x: 0, y: 0 };
      projectGeographicAnchorToViewport(
        candidateFrame,
        place.lat,
        place.lon,
        solverPath,
      );
      // The solver deliberately skips the horizon gate, so only a place the
      // label layer would have drawn is compared - for the rest the point of
      // the solver is that it still answers.
      if (!visible) {
        expect(Number.isFinite(solverPath.x)).toBe(true);
        continue;
      }
      expect(Object.is(solverPath.x, labelPath.x)).toBe(true);
      expect(Object.is(solverPath.y, labelPath.y)).toBe(true);
    }
  });

  it("separates the transform from the horizon judgement", () => {
    const { frame } = buildScene();
    // Derived from the frame rather than named: the point directly under the
    // camera is on the near side and its antipode is behind the globe in ANY
    // framing, so this states the horizon rule instead of a fixture's luck.
    const towardCamera = frame.cameraLocal.clone().normalize();
    const front = towardCamera.clone().multiplyScalar(GEOGRAPHIC_SURFACE_RADIUS);
    const behind = towardCamera.clone().multiplyScalar(-GEOGRAPHIC_SURFACE_RADIUS);
    expect(isSphericalPointVisible(frame.cameraLocal, front)).toBe(true);
    expect(isSphericalPointVisible(frame.cameraLocal, behind)).toBe(false);

    // The gated call refuses the far-side point; the ungated one still answers,
    // which is what keeps the focus solver's search from stalling on a
    // candidate rotation that happens to face away.
    const gated = { x: 0, y: 0 };
    expect(projectLocalPoint(frame, behind.x, behind.y, behind.z, gated)).toBe(false);
    const ungated = { x: 0, y: 0 };
    projectLocalPointToViewport(frame, behind.x, behind.y, behind.z, ungated);
    expect(Number.isFinite(ungated.x)).toBe(true);
    expect(Number.isFinite(ungated.y)).toBe(true);

    const nearGated = { x: 0, y: 0 };
    expect(projectLocalPoint(frame, front.x, front.y, front.z, nearGated)).toBe(true);
  });

  it("maps normalised device coordinates onto the frame's own viewport", () => {
    const { camera, globe } = buildScene();
    const centred = new Group();
    centred.updateWorldMatrix(true, false);
    const frame = updateGeoProjectionFrame(
      createGeoProjectionFrame(),
      camera,
      centred.matrixWorld,
      VIEWPORT.width,
      VIEWPORT.height,
    );
    const origin = { x: 0, y: 0 };
    projectLocalPointToViewport(frame, 0, 0, 0, origin);
    expect(origin.x).toBeCloseTo(VIEWPORT.width / 2, 6);
    expect(origin.y).toBeCloseTo(VIEWPORT.height / 2, 6);

    // A second frame at a different viewport must not leak the first one's.
    const half = updateGeoProjectionFrame(
      createGeoProjectionFrame(),
      camera,
      globe.matrixWorld,
      640,
      400,
    );
    expect(half.viewport).toEqual({ width: 640, height: 400 });
  });

  it("agrees with the cheap clip-space scan the place-label tier uses", () => {
    const { frame } = buildScene();
    // The scan and the projection now read the SAME matrix, so a place the
    // scan admits is a place the projection can place.
    for (const place of PLACES) {
      const anchor = routePointAnchor(place.lat, place.lon);
      const inside = isLocalPointInsideClipViewport(
        frame.clip.elements,
        anchor.x,
        anchor.y,
        anchor.z,
      );
      const projectedPoint = { x: 0, y: 0 };
      projectLocalPointToViewport(
        frame,
        anchor.x,
        anchor.y,
        anchor.z,
        projectedPoint,
      );
      if (!inside) continue;
      expect(projectedPoint.x).toBeGreaterThanOrEqual(0);
      expect(projectedPoint.x).toBeLessThanOrEqual(VIEWPORT.width);
      expect(projectedPoint.y).toBeGreaterThanOrEqual(0);
      expect(projectedPoint.y).toBeLessThanOrEqual(VIEWPORT.height);
    }
  });

  it("puts the camera-local position where the globe transform says it is", () => {
    const { camera, globe, frame } = buildScene();
    const expected = globe.worldToLocal(new Vector3().copy(camera.position));
    expect(frame.cameraLocal.x).toBeCloseTo(expected.x, 10);
    expect(frame.cameraLocal.y).toBeCloseTo(expected.y, 10);
    expect(frame.cameraLocal.z).toBeCloseTo(expected.z, 10);
  });
});

import { Euler, Matrix4, Quaternion, Vector3 } from "three";
import { GEOGRAPHIC_SURFACE_RADIUS, latLonToVector3 } from "./geo";

/**
 * #237 Phase B - the Single Projection Space invariant.
 *
 * One geographic point has exactly one world position, and every layer that
 * represents that point projects it through the same frame. Before this module
 * each consumer re-derived the transform: the Place Label / Route Point path
 * applied `globe.matrixWorld` then `camera.project()`, the focus rotation
 * solver applied an Euler and a scalar by hand, and the focus signal
 * instrumentation used `globe.localToWorld` plus a third copy of the
 * viewport mapping. Those three spellings agree to within floating point, and
 * "within floating point" is exactly the kind of tolerance that grows into
 * visible drift once a later change touches one of them and not the others.
 *
 * Visual priority is therefore never expressed as a radius. A layer that has to
 * read above another gets depth, render order or a screen-space pixel offset -
 * see GLOBE_RENDER_ORDER and the coastline depth policy in ParticleEarthScene.
 */
export type GeoProjectionFrame = {
  /** Globe-local -> clip space: projection * viewInverse * globe.matrixWorld. */
  readonly clip: Matrix4;
  /** Camera position expressed in globe-local space, for horizon occlusion. */
  readonly cameraLocal: Vector3;
  /** CSS pixel viewport the frame maps normalised device coordinates onto. */
  readonly viewport: { width: number; height: number };
};

export type ProjectedScreenPoint = { x: number; y: number };

/** The globe placement a frame projects through. */
export type GlobeProjectionState = {
  rotationX: number;
  rotationY: number;
  rotationZ: number;
  scale: number;
  positionX: number;
  positionY: number;
  positionZ: number;
};

export type ProjectionCamera = {
  projectionMatrix: Matrix4;
  matrixWorldInverse: Matrix4;
  position: Vector3;
};

const modelInverse = new Matrix4();
const stateQuaternion = new Quaternion();
const stateEuler = new Euler();
const statePosition = new Vector3();
const stateScale = new Vector3();
const projected = new Vector3();

export function createGeoProjectionFrame(): GeoProjectionFrame {
  return {
    clip: new Matrix4(),
    cameraLocal: new Vector3(),
    viewport: { width: 0, height: 0 },
  };
}

/**
 * Point a frame at a camera and a globe model matrix. `model` is
 * `globe.matrixWorld` for the live frame; the focus solver composes a
 * candidate one through composeGlobeModelMatrix so both paths consume the
 * identical matrix pipeline rather than two spellings of the same algebra.
 */
export function updateGeoProjectionFrame(
  frame: GeoProjectionFrame,
  camera: ProjectionCamera,
  model: Matrix4,
  width: number,
  height: number,
): GeoProjectionFrame {
  frame.clip
    .multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
    .multiply(model);
  frame.cameraLocal
    .copy(camera.position)
    .applyMatrix4(modelInverse.copy(model).invert());
  frame.viewport.width = width;
  frame.viewport.height = height;
  return frame;
}

/**
 * The same composition Object3D.updateMatrix performs, so a candidate globe
 * placement and the live `globe.matrixWorld` are the same matrix rather than
 * two nearly-equal ones. The globe is a root object, so its world matrix is
 * its local matrix.
 */
export function composeGlobeModelMatrix(
  target: Matrix4,
  state: GlobeProjectionState,
): Matrix4 {
  stateEuler.set(state.rotationX, state.rotationY, state.rotationZ);
  stateQuaternion.setFromEuler(stateEuler);
  statePosition.set(state.positionX, state.positionY, state.positionZ);
  stateScale.set(state.scale, state.scale, state.scale);
  return target.compose(statePosition, stateQuaternion, stateScale);
}

/**
 * The transform itself: globe-local point -> CSS pixels, with no visibility
 * judgement. Split out because the focus rotation solver has to project
 * CANDIDATE rotations that may put the point behind the globe - it is searching
 * for the rotation that brings the point to a screen position, so a gate that
 * refused to answer for far-side candidates would stall the search.
 */
export function projectLocalPointToViewport(
  frame: GeoProjectionFrame,
  x: number,
  y: number,
  z: number,
  target: ProjectedScreenPoint,
): ProjectedScreenPoint {
  projected.set(x, y, z).applyMatrix4(frame.clip);
  target.x = ((projected.x + 1) * frame.viewport.width) / 2;
  target.y = ((1 - projected.y) * frame.viewport.height) / 2;
  return target;
}

/**
 * Project a globe-local point to CSS pixels. Returns false when the point is
 * behind the globe's own horizon or outside the depth range, which is what
 * keeps an annotation from being drawn on the far side of the planet.
 */
export function projectLocalPoint(
  frame: GeoProjectionFrame,
  x: number,
  y: number,
  z: number,
  target: ProjectedScreenPoint,
): boolean {
  projected.set(x, y, z);
  if (!isSphericalPointVisible(frame.cameraLocal, projected)) return false;
  projectLocalPointToViewport(frame, x, y, z, target);
  if (
    !Number.isFinite(target.x)
    || !Number.isFinite(target.y)
    || projected.z < -1
    || projected.z > 1
  ) {
    return false;
  }
  return true;
}

/**
 * #237: the one way to turn a latitude/longitude into a screen anchor. Place
 * Labels, Route Points, the Journey connector, the focus signal and the
 * coastline QA anchor all arrive here, so one geographic point yields one
 * screen coordinate for every layer that names it.
 */
export function projectGeographicAnchor(
  frame: GeoProjectionFrame,
  lat: number,
  lon: number,
  target: ProjectedScreenPoint,
  radius = GEOGRAPHIC_SURFACE_RADIUS,
): boolean {
  const anchor = latLonToVector3(lat, lon, radius);
  return projectLocalPoint(frame, anchor.x, anchor.y, anchor.z, target);
}

/** The same anchor without the horizon gate - see projectLocalPointToViewport. */
export function projectGeographicAnchorToViewport(
  frame: GeoProjectionFrame,
  lat: number,
  lon: number,
  target: ProjectedScreenPoint,
  radius = GEOGRAPHIC_SURFACE_RADIUS,
): ProjectedScreenPoint {
  const anchor = latLonToVector3(lat, lon, radius);
  return projectLocalPointToViewport(frame, anchor.x, anchor.y, anchor.z, target);
}

/**
 * #193/#196: whether a globe-local point is on the near side of the sphere the
 * globe occludes with. Moved here in #237 because horizon visibility is part of
 * the projection frame, not of any one consumer.
 */
export function isSphericalPointVisible(
  camera: Vector3,
  point: Vector3,
  occluderRadius = GEOGRAPHIC_SURFACE_RADIUS,
) {
  const directionX = point.x - camera.x;
  const directionY = point.y - camera.y;
  const directionZ = point.z - camera.z;
  const directionLengthSquared =
    directionX * directionX
    + directionY * directionY
    + directionZ * directionZ;
  if (directionLengthSquared === 0) return true;
  const closestProgress = -(
    camera.x * directionX
    + camera.y * directionY
    + camera.z * directionZ
  ) / directionLengthSquared;
  if (closestProgress <= 0 || closestProgress >= 1) return true;
  const closestX = camera.x + directionX * closestProgress;
  const closestY = camera.y + directionY * closestProgress;
  const closestZ = camera.z + directionZ * closestProgress;
  return (
    closestX * closestX
    + closestY * closestY
    + closestZ * closestZ
  ) >= occluderRadius * occluderRadius;
}

/**
 * Scalar clip-space containment against a precomputed local -> clip matrix.
 * The all-tier place scan can reach ~15k candidates per frame, so it stays a
 * flat arithmetic test over the frame's own matrix rather than a per-candidate
 * projection.
 */
export function isLocalPointInsideClipViewport(
  matrixElements: readonly number[],
  x: number,
  y: number,
  z: number,
): boolean {
  if (matrixElements.length < 16) return false;
  const clipX = matrixElements[0] * x
    + matrixElements[4] * y
    + matrixElements[8] * z
    + matrixElements[12];
  const clipY = matrixElements[1] * x
    + matrixElements[5] * y
    + matrixElements[9] * z
    + matrixElements[13];
  const clipZ = matrixElements[2] * x
    + matrixElements[6] * y
    + matrixElements[10] * z
    + matrixElements[14];
  const clipW = matrixElements[3] * x
    + matrixElements[7] * y
    + matrixElements[11] * z
    + matrixElements[15];
  return Number.isFinite(clipX)
    && Number.isFinite(clipY)
    && Number.isFinite(clipZ)
    && Number.isFinite(clipW)
    && clipW > 0
    && clipX >= -clipW
    && clipX <= clipW
    && clipY >= -clipW
    && clipY <= clipW
    && clipZ >= -clipW
    && clipZ <= clipW;
}

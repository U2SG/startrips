/** Missing observations must fail, rather than passing through NaN comparisons. */
export function matchesCameraHandback(observed, handback) {
  if (!Array.isArray(observed) || observed.length !== 2 || !observed.every(Number.isFinite)
    || !Number.isFinite(handback?.cameraHandbackLat) || !Number.isFinite(handback?.cameraHandbackLon)) return false;
  const [longitude, latitude] = observed;
  return Math.abs(handback.cameraHandbackLat - latitude) <= 0.0001
    && Math.abs(handback.cameraHandbackLon - longitude) <= 0.0001;
}

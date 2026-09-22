export type GlobeMode =
  | "particleSphere"
  | "archiveBurst"
  | "surfaceEarth"
  | "focusPoint";

export const GLOBE_MODE_CONFIG: Record<
  GlobeMode,
  {
    x: number;
    y: number;
    scale: number;
    burst: number;
    particleOpacity: number;
    shellOpacity: number;
    haloOpacity: number;
    surfaceOpacity: number;
    signalOpacity: number;
    clusterOpacity: number;
    personalOpacity: number;
    rotationY: number;
    wireOpacity: number;
    coastlineOpacity: number;
  }
> = {
  particleSphere: {
    x: 0.05,
    y: 0.04,
    scale: 0.93,
    burst: 0,
    particleOpacity: 0.12,
    shellOpacity: 1,
    haloOpacity: 0.55,
    surfaceOpacity: 0,
    signalOpacity: 0.8,
    clusterOpacity: 0,
    personalOpacity: 0.72,
    rotationY: 0,
    wireOpacity: 0.025,
    coastlineOpacity: 0.12,
  },
  archiveBurst: {
    x: 0.25,
    y: 0.02,
    scale: 0.98,
    burst: 0.15,
    particleOpacity: 0.66,
    shellOpacity: 0.18,
    haloOpacity: 0.03,
    surfaceOpacity: 0,
    signalOpacity: 1,
    clusterOpacity: 0.16,
    personalOpacity: 1,
    rotationY: -1.92,
    wireOpacity: 0.022,
    coastlineOpacity: 0.18,
  },
  surfaceEarth: {
    x: 0.12,
    y: -0.12,
    scale: 1.15,
    burst: 0,
    particleOpacity: 0.025,
    shellOpacity: 0.005,
    haloOpacity: 0,
    surfaceOpacity: 1,
    signalOpacity: 0.16,
    clusterOpacity: 0,
    personalOpacity: 0,
    rotationY: -1.92,
    wireOpacity: 0,
    coastlineOpacity: 0.42,
  },
  focusPoint: {
    x: 0.7,
    y: -0.23,
    scale: 1.15,
    burst: 0,
    particleOpacity: 0.62,
    shellOpacity: 0.18,
    haloOpacity: 0.05,
    surfaceOpacity: 0.22,
    signalOpacity: 0.72,
    clusterOpacity: 0,
    personalOpacity: 1,
    rotationY: -1.57,
    wireOpacity: 0.018,
    coastlineOpacity: 0.3,
  },
};

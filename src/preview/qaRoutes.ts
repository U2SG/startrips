import type { JourneyRoute } from "../journey/types";

export const globeQaRoutes: JourneyRoute[] = [
  {
    id: "qa-route-night-train",
    color: "#77c8c2",
    lightEffect: "aurora",
    points: [
      { id: "qa-p-1", lat: 31.2304, lon: 121.4737, isStop: true, label: "Shanghai" },
      { id: "qa-p-2", lat: 34.7466, lon: 113.6254, isStop: true, label: "Zhengzhou" },
      { id: "qa-p-3", lat: 39.9042, lon: 116.4074, isStop: true, label: "Beijing" },
      { id: "qa-p-4", lat: 43.8256, lon: 87.6168, isStop: false, label: "Ürümqi" },
    ],
  },
  {
    id: "qa-route-sea-breeze",
    color: "#e8a87c",
    lightEffect: "rainbow",
    points: [
      { id: "qa-p-5", lat: 35.6762, lon: 139.6503, isStop: true, label: "Tokyo" },
      { id: "qa-p-6", lat: 34.6937, lon: 135.5023, isStop: true, label: "Osaka" },
      { id: "qa-p-7", lat: 33.5904, lon: 130.4017, isStop: true, label: "Fukuoka" },
    ],
  },
  {
    id: "qa-route-rhine",
    color: "#9fd356",
    lightEffect: "sunset",
    points: [
      { id: "qa-p-8", lat: 52.3676, lon: 4.9041, isStop: true, label: "Amsterdam" },
      { id: "qa-p-9", lat: 50.9375, lon: 6.9603, isStop: true, label: "Cologne" },
      { id: "qa-p-10", lat: 50.1109, lon: 8.6821, isStop: false, label: "Frankfurt" },
    ],
  },
  {
    id: "qa-route-southern-summer",
    color: "#b39ddb",
    lightEffect: "nebula",
    points: [
      { id: "qa-p-11", lat: -36.8509, lon: 174.7645, isStop: true, label: "Auckland" },
      { id: "qa-p-12", lat: -37.8136, lon: 144.9631, isStop: true, label: "Melbourne" },
      { id: "qa-p-13", lat: -33.8688, lon: 151.2093, isStop: false, label: "Sydney" },
    ],
  },
  {
    // #193 fixture: the reported US Southwest reproduction. Los Angeles and
    // Yosemite are the pair whose route visibly detached under wheel zoom.
    id: "qa-route-southwest",
    color: "#f4ce73",
    points: [
      { id: "qa-p-15", lat: 34.0522, lon: -118.2437, isStop: true, label: "Los Angeles" },
      { id: "qa-p-16", lat: 37.8651, lon: -119.5383, isStop: true, label: "Yosemite" },
      { id: "qa-p-17", lat: 36.1699, lon: -115.1398, isStop: true, label: "Las Vegas" },
      { id: "qa-p-18", lat: 35.1894, lon: -114.053, isStop: false, label: "Kingman" },
      { id: "qa-p-19", lat: 36.9147, lon: -111.4558, isStop: true, label: "Page" },
      { id: "qa-p-20", lat: 34.0522, lon: -118.2437, isStop: true, label: "Los Angeles" },
    ],
  },
  {
    // #478 fixture: mixed adjacent-leg lengths around the Route Points that
    // exposed the post-#361 whisker/hook regression. Keep this route separate
    // from qa-route-southwest because #193/#219 optics assertions pin that
    // older fixture's point identities and focus semantics.
    id: "qa-route-southwest-whisker",
    color: "#f4ce73",
    points: [
      { id: "qa-whisker-1", lat: 34.0522, lon: -118.2437, isStop: true, label: "Los Angeles" },
      { id: "qa-whisker-2", lat: 36.1699, lon: -115.1398, isStop: true, label: "Las Vegas" },
      { id: "qa-whisker-3", lat: 35.1894, lon: -114.0530, isStop: false, label: "Kingman" },
      { id: "qa-whisker-4", lat: 36.9147, lon: -111.4558, isStop: true, label: "Page" },
      { id: "qa-whisker-5", lat: 36.1069, lon: -112.1129, isStop: true, label: "Grand Canyon" },
    ],
  },
  {
    // #242 fixture: a SYNTHETIC chain of eight evenly spaced ~0.5 degree legs,
    // generated from one origin and a constant step rather than taken from any
    // real itinerary. Short legs are where the old sqrt lift policy stood
    // tallest relative to the leg it decorated, so this is the shape that read
    // as a row of raised sawteeth when the globe rotated it toward the limb.
    id: "qa-route-short-legs",
    color: "#8fd0c4",
    points: Array.from({ length: 8 }, (_, index) => ({
      id: `qa-p-3${index}`,
      lat: 12 + (index * 0.35),
      lon: 8 + (index * 0.4),
      isStop: index === 0 || index === 7,
      label: `Synthetic stop ${index + 1}`,
    })),
  },
  {
    id: "qa-route-alone-at-sea",
    color: "#ffd166",
    points: [
      { id: "qa-p-14", lat: 1.290256, lon: 103.851471, isStop: true, label: "Singapore" },
    ],
  },
];

/**
 * #374 fixture: SYNTHETIC label-competition topology, not an itinerary. It
 * carries the three shapes the collision policy has to separate - a Route Point
 * whose label repeats a real Place Label, two records at the SAME coordinates,
 * and two records that share a label at DIFFERENT coordinates - plus a
 * pass-through point and an intermediate Stop for density.
 */

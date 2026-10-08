export const BUILD_ERROR_CODES = [
  "ROUTING_DATA_UNAVAILABLE",
  "ROUTING_AREA_TOO_LARGE",
  "ROUTING_GRAPH_BUILD_FAILED",
  "ROUTING_NO_ROADS",
];

export class BuildError extends Error {
  constructor(code, message) {
    super(message);
    this.code = BUILD_ERROR_CODES.includes(code) ? code : "ROUTING_GRAPH_BUILD_FAILED";
  }
}

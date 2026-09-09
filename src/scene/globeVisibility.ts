export type GlobeVisibilityInput = {
  documentVisible: boolean;
  opaqueMediaCover: boolean;
  coverTransitionActive: boolean;
  focusFlightActive: boolean;
  interactionActive: boolean;
  earthDiveOverlapActive: boolean;
};

export type GlobeRenderState = "rendering" | "covered" | "hidden";

export function resolveGlobeRenderState(input: GlobeVisibilityInput): GlobeRenderState {
  if (!input.documentVisible) return "hidden";
  if (
    input.opaqueMediaCover
    && !input.coverTransitionActive
    && !input.focusFlightActive
    && !input.interactionActive
    && !input.earthDiveOverlapActive
  ) return "covered";
  return "rendering";
}

export function globeRenderStateRunsScene(state: GlobeRenderState) {
  return state === "rendering";
}

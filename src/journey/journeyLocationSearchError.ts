import { JourneyApiError } from "./journeyApi";

export const LOCATION_SEARCH_UNAVAILABLE_COPY =
  "当前部署未启用地点搜索。你仍可直接在地球上取点，或展开「精确位置」手动输入纬度和经度。";

export function journeyLocationSearchErrorMessage(error: unknown) {
  if (error instanceof JourneyApiError && error.code === "LOCATION_SEARCH_UNAVAILABLE") {
    return LOCATION_SEARCH_UNAVAILABLE_COPY;
  }
  return error instanceof Error ? error.message : "地点搜索暂时不可用";
}

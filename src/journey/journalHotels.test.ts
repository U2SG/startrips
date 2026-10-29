import { describe, expect, it } from "vitest";
import { hasExplicitHotelStay } from "./journalHotels";

describe("hotel stay attribution", () => {
  it.each([
    ["实际：我们在深圳入住星桥酒店，晚餐去了山谷酒店。", "星桥酒店", "山谷酒店"],
    ["实际：在山谷酒店拍照后入住星桥酒店。", "星桥酒店", "山谷酒店"],
    ["We stayed at Starbridge Hotel in Fiction City and ate dinner at Valley Hotel.", "Starbridge Hotel", "Valley Hotel"],
    ["We photographed Valley Hotel, then checked in at Starbridge Hotel.", "Starbridge Hotel", "Valley Hotel"],
  ])("binds the stay in %s", (source, stayed, visited) => {
    expect(hasExplicitHotelStay(source, stayed)).toBe(true);
    expect(hasExplicitHotelStay(source, visited)).toBe(false);
  });
  it.each([
    ["入住星桥酒店和山谷酒店，吃饭拍照。", "山谷酒店"],
    ["We stayed at Starbridge Hotel and Valley Hotel for dinner.", "Starbridge Hotel"],
    ["We stayed at Valley Hotel for dinner, then checked in at Starbridge Hotel.", "Valley Hotel"],
    ["We stayed at Valley Hotel for a drink, then checked in at Starbridge Hotel.", "Valley Hotel"],
    ["We stayed at Valley Hotel for taking photos, then checked in at Starbridge Hotel.", "Valley Hotel"],
    ["We stayed at Valley Hotel for two nights.", "Valley Hotel"],
    ["We never actually stayed at Valley Hotel.", "Valley Hotel"],
    ["We ｎｅｖｅｒ actually stayed at Valley Hotel.", "Valley Hotel"],
    ["We stayed at Starbridge Hotel and Valley Hotel for dinner.", "Valley Hotel"],
    ["We stayed at Starbridge Hotel Annex.", "Starbridge Hotel"],
    ["入住星桥酒店旁的民宿。", "星桥酒店"],
    ["入住星桥酒店的餐厅。", "星桥酒店"],
  ])("leaves ambiguous object %s unconfirmed", (source, name) => {
    expect(hasExplicitHotelStay(source, name)).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { distanceKm, hasExplicitHotelStay, hasExplicitHotelStayAt, hotelContextMatchesArea, isHotelEligible, isLodgingCategory, similarHotelName } from "./journalHotels";

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

describe("hotel stay geography", () => {
  it.each([
    ["实际：在虚构城入住星桥酒店。下午到远方城。", "星桥酒店", "虚构城", "远方城"],
    ["实际：在远方城拍照，在虚构城入住星桥酒店。", "星桥酒店", "虚构城", "远方城"],
    ["In Fiction City we stayed at Starbridge Hotel. Later we went to Other City.", "Starbridge Hotel", "Fiction City", "Other City"],
    ["We photographed Other City then checked in at Starbridge Hotel in Fiction City.", "Starbridge Hotel", "Fiction City", "Other City"],
  ])("binds the geography to the stay in %s", (source, name, correct, wrong) => {
    expect(hasExplicitHotelStayAt(source, name, correct)).toBe(true);
    expect(hasExplicitHotelStayAt(source, name, wrong)).toBe(false);
  });
  it.each([
    ["她在虚构城山谷酒店拍照后入住星桥酒店。", "星桥酒店", "虚构城"],
    ["In Fiction City we photographed Valley Hotel then checked in at Starbridge Hotel.", "Starbridge Hotel", "Fiction City"],
    ["虚构城：入住星桥酒店。", "星桥酒店", "虚构城"],
    ["入住星桥酒店。", "星桥酒店", "虚构城"],
  ])("does not infer location from another activity or heading: %s", (source, name, area) => {
    expect(hasExplicitHotelStayAt(source, name, area)).toBe(false);
  });
});


describe("whole address components", () => {
  it.each([
    ["New York, USA", "York", false], ["Yorkshire, UK", "York", false],
    ["Main Street, York, UK", "York", true], ["New York, USA", "New York", true],
    ["虚构城，中心路", "虚构城", true], ["虚构城中心路", "虚构城", false],
    ["North Fiction City, ZZ", "Fiction City", false],
  ])("matches %s to %s conservatively", (context, area, expected) => {
    expect(hotelContextMatchesArea(context, area)).toBe(expected);
  });
});

describe("labelled lodging lines", () => {
  it.each([
    ["住宿：星桥酒店", "星桥酒店", true],
    ["- 住宿：星桥酒店", "星桥酒店", true],
    ["Hotel: Starbridge Hotel", "Starbridge Hotel", true],
    ["住宿： 返程航班，无酒店", "返程航班", false],
    ["住宿：星桥酒店旁的民宿", "星桥酒店", false],
    ["住宿： 拉斯维加斯枫丹白露酒店（Fontainebleau Las Vegas）", "拉斯维加斯枫丹白露酒店", true],
    ["住宿：星桥酒店，次日取消", "星桥酒店", false],
    ["住宿：山谷酒店", "星桥酒店", false],
    ["今天住宿：星桥酒店", "星桥酒店", false],
  ])("%s -> %s is %s", (source, name, expected) => {
    expect(hasExplicitHotelStay(source, name)).toBe(expected);
  });
  it("makes labelled lines eligible even when planned, and cancelled events never", () => {
    expect(isHotelEligible({ status: "actual", source: "入住星桥酒店" })).toBe(true);
    expect(isHotelEligible({ status: "uncertain", source: "入住星桥酒店" })).toBe(true);
    expect(isHotelEligible({ status: "planned", source: "住宿：星桥酒店" })).toBe(true);
    expect(isHotelEligible({ status: "planned", source: "- 酒店: Starbridge Hotel" })).toBe(true);
    expect(isHotelEligible({ status: "planned", source: "入住星桥酒店" })).toBe(false);
    expect(isHotelEligible({ status: "cancelled", source: "住宿：星桥酒店" })).toBe(false);
  });
});

describe("hotel name similarity and lodging categories", () => {
  it.each([
    ["Best Western Plus Carmel Bay View Inn", "Carmel Bay View Inn", true],
    ["Fontainebleau Miami Beach", "Fontainebleau Resort", true],
    ["星桥酒店", "星桥酒店 虚构城", true],
    ["Hilton Garden Inn", "Marriott Garden Inn", false],
    ["星桥酒店", "山谷酒店", false],
    ["Starbridge Hotel", "Valley Hotel", false],
  ])("%s ~ %s is %s", (a, b, expected) => {
    expect(similarHotelName(a, b)).toBe(expected);
    expect(similarHotelName(b, a)).toBe(expected);
  });
  it("accepts lodging features and unclassified results only", () => {
    expect(isLodgingCategory(undefined)).toBe(false);
    for (const category of ["tourism:hotel", "tourism:guest_house", "building:hotel", "leisure:resort"]) expect(isLodgingCategory(category)).toBe(true);
    for (const category of ["highway:bus_stop", "amenity:restaurant", "tourism:attraction"]) expect(isLodgingCategory(category)).toBe(false);
  });
  it("measures great-circle distance in kilometres", () => {
    expect(distanceKm({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 0 })).toBe(0);
    expect(distanceKm({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 1 })).toBeCloseTo(111.19, 0);
  });
});

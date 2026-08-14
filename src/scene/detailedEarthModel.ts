import type { ExpressionSpecification } from "maplibre-gl";

export type DetailedEarthLanguage = "zh" | "bilingual";

export const DEFAULT_DETAILED_EARTH_STYLE_URL = "https://tiles.openfreemap.org/styles/fiord";

const CHINESE_NAME: ExpressionSpecification = [
  "coalesce",
  ["get", "name:zh-Hans"],
  ["get", "name:zh"],
  ["get", "name"],
  ["get", "name:nonlatin"],
  ["get", "name:en"],
  ["get", "name_en"],
  "",
];

const ENGLISH_NAME: ExpressionSpecification = [
  "coalesce",
  ["get", "name:en"],
  ["get", "name_en"],
  ["get", "name:latin"],
  ["get", "name"],
  "",
];

export function getDetailedEarthStyleUrl() {
  return import.meta.env.VITE_ATLAS_MAP_STYLE_URL?.trim()
    || DEFAULT_DETAILED_EARTH_STYLE_URL;
}

export function createDetailedEarthLabelExpression(
  language: DetailedEarthLanguage,
): ExpressionSpecification {
  if (language === "zh") return CHINESE_NAME;

  return [
    "format",
    CHINESE_NAME,
    {},
    [
      "case",
      [
        "all",
        ["!=", ENGLISH_NAME, ""],
        ["!=", CHINESE_NAME, ENGLISH_NAME],
      ],
      ["concat", "\n", ENGLISH_NAME],
      "",
    ],
    { "font-scale": 0.74 },
  ];
}

export function isDetailedEarthNameLabel(textField: unknown) {
  if (typeof textField === "string") return textField.includes("name");
  return JSON.stringify(textField)?.includes("\"name") ?? false;
}

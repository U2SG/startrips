export const LIGHT_COLORS = [
  "#f4ce73",
  "#e99578",
  "#77c8c2",
  "#8ca8df",
  "#c49bd8",
];

export const LIGHT_EFFECTS = [
  { id: "rainbow", label: "彩虹" },
  { id: "aurora", label: "极光" },
  { id: "sunset", label: "日落" },
  { id: "nebula", label: "星云" },
] as const;

export type LightEffectId = (typeof LIGHT_EFFECTS)[number]["id"];

type HslColor = {
  hue: number;
  saturation: number;
  lightness: number;
};

function clampLightValue(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function normalizeBaseColor(color: string) {
  return /^#[0-9a-fA-F]{6}$/.test(color) ? color : LIGHT_COLORS[0];
}

function hexToHsl(hex: string): HslColor {
  const normalized = hex.replace("#", "");
  const red = Number.parseInt(normalized.slice(0, 2), 16) / 255;
  const green = Number.parseInt(normalized.slice(2, 4), 16) / 255;
  const blue = Number.parseInt(normalized.slice(4, 6), 16) / 255;
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  const lightness = (maximum + minimum) / 2;
  const delta = maximum - minimum;
  let hue = 0;
  let saturation = 0;

  if (delta !== 0) {
    saturation = lightness > 0.5
      ? delta / (2 - maximum - minimum)
      : delta / (maximum + minimum);
    if (maximum === red) {
      hue = ((green - blue) / delta + (green < blue ? 6 : 0)) / 6;
    } else if (maximum === green) {
      hue = ((blue - red) / delta + 2) / 6;
    } else {
      hue = ((red - green) / delta + 4) / 6;
    }
  }

  return {
    hue: hue * 360,
    saturation: saturation * 100,
    lightness: lightness * 100,
  };
}

function hslVariant(
  base: HslColor,
  hueOffset: number,
  saturationScale = 1,
  lightnessOffset = 0,
) {
  const hue = (base.hue + hueOffset + 360) % 360;
  const saturation = clampLightValue(base.saturation * saturationScale, 22, 100);
  const lightness = clampLightValue(base.lightness + lightnessOffset, 18, 88);
  return `hsl(${Math.round(hue)} ${Math.round(saturation)}% ${Math.round(lightness)}%)`;
}

export function isLightEffectId(value: unknown): value is LightEffectId {
  return typeof value === "string"
    && LIGHT_EFFECTS.some((effect) => effect.id === value);
}

export function getLightEffectPalette(
  effectId: LightEffectId | null | undefined,
  baseColor: string,
) {
  const baseColorValue = normalizeBaseColor(baseColor);
  if (!effectId) return [baseColorValue];

  const base = hexToHsl(baseColorValue);
  const variant = (hueOffset: number, saturationScale = 1, lightnessOffset = 0) =>
    hslVariant(base, hueOffset, saturationScale, lightnessOffset);

  switch (effectId) {
    case "rainbow":
      return [
        variant(-150, 0.88, 4),
        variant(-90, 1, 8),
        variant(-30),
        variant(30, 1, 4),
        variant(90, 0.94, 8),
        variant(150, 0.86),
        variant(210, 0.88, 4),
      ];
    case "aurora":
      return [
        variant(148, 0.82, 12),
        variant(46, 1, 6),
        variant(0),
        variant(-52, 1, 4),
        variant(-112, 0.78, 10),
      ];
    case "sunset":
      return [
        variant(34, 1.04, 16),
        variant(10, 1.02, 7),
        variant(-18, 0.96, -4),
        variant(-58, 0.82, 8),
      ];
    case "nebula":
      return [
        variant(22, 0.9, 14),
        variant(-14),
        variant(82, 1.04, -8),
        variant(174, 0.86, 10),
      ];
  }
}

export function getLightEffectGradient(
  effectId: LightEffectId | null | undefined,
  baseColor: string,
) {
  const palette = getLightEffectPalette(effectId, baseColor);
  if (palette.length === 1) {
    return `linear-gradient(135deg, ${palette[0]}, ${palette[0]})`;
  }
  if (effectId === "rainbow") {
    return `conic-gradient(from 210deg, ${palette.join(", ")})`;
  }
  return `linear-gradient(135deg, ${palette.join(", ")})`;
}

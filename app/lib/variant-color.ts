import catalog from "./color-catalog/names.json";

type Attribute = Readonly<{dimension: string; value: string; labelZh?: string}>;
export type VariantColor = Readonly<{
  kind: "single" | "multi" | "unknown" | "transparent";
  colors: readonly string[];
  background: string;
  textColor: string;
  label: string;
  original: string;
  approximate: boolean;
}>;

const basics: ReadonlyArray<readonly [string, string, string]> = [
  ["black", "#000000", "黑色"], ["white", "#ffffff", "白色"],
  ["blue", "#0000ff", "蓝色"], ["red", "#ff0000", "红色"],
  ["green", "#008000", "绿色"], ["yellow", "#ffff00", "黄色"],
  ["orange", "#ffa500", "橙色"], ["purple", "#800080", "紫色"],
  ["pink", "#ffc0cb", "粉色"], ["brown", "#a52a2a", "棕色"],
  ["gray", "#808080", "灰色"], ["silver", "#c0c0c0", "银色"],
  ["gold", "#ffd700", "金色"], ["beige", "#f5f5dc", "米色"],
  ["navy", "#000080", "藏蓝色"], ["teal", "#008080", "青绿色"],
  ["cyan", "#00ffff", "青色"], ["aqua", "#00ffff", "水蓝色"],
];
const basicMap = new Map(basics.flatMap(([name, hex, label]) => [[name, {hex, label}], [label, {hex, label}]]));
basicMap.set("grey", basicMap.get("gray")!);
const commonLabels = new Map([["aqua blue", "水蓝色"], ["lime green", "青柠绿"], ["light blue", "浅蓝色"], ["dark blue", "深蓝色"]]);
const normalize = (value: string) => value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
export const isColorDimension = (dimension: string) => /^(color|colour|color_name|colour_name|颜色|色彩|顏色)$/.test(normalize(dimension));
export const variantColorNote = "色块按颜色名称近似示意；双色不代表实物配色面积。";

function rgb(hex: string) {
  return [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16) / 255);
}

function contrastingText(hex: string) {
  const [r, g, b] = rgb(hex).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  const luminance = r! * 0.2126 + g! * 0.7152 + b! * 0.0722;
  return luminance > 0.179 ? "#000000" : "#ffffff";
}

// These are color families, not purported translations of marketing names.
function familyLabel(hex: string) {
  const [r, g, b] = rgb(hex) as [number, number, number];
  const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
  const lightness = (max + min) / 2;
  if (max < 0.15) return "黑色";
  if (min > 0.9) return "白色";
  if (delta < 0.1) return "灰色";
  const hue = ((max === r ? (g - b) / delta : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4) * 60 + 360) % 360;
  if (hue < 45 && hue >= 10 && lightness < 0.45) return "棕色";
  if (hue < 15 || hue >= 345) return lightness > 0.65 ? "粉色" : "红色";
  if (hue < 45) return "橙色";
  if (hue < 70) return "黄色";
  if (hue < 165) return "绿色";
  if (hue < 205) return "青蓝色";
  if (hue < 265) return "蓝色";
  if (hue < 300) return "紫色";
  return "粉紫色";
}

function unknown(original: string): VariantColor {
  return {kind: "unknown", colors: [], background: "repeating-linear-gradient(135deg,#e2e8f0 0 4px,#f8fafc 4px 8px)", textColor: "#000000", label: original || "颜色待确认", original, approximate: true};
}

function single(original: string, hex: string, label?: string): VariantColor {
  return {kind: "single", colors: [hex], background: hex, textColor: contrastingText(hex), label: label ?? `近似${familyLabel(hex)}（${original.trim()}）`, original, approximate: !label};
}

export function resolveColorName(original: string): VariantColor {
  const value = normalize(original);
  const basic = basicMap.get(value);
  if (basic) return single(original, basic.hex, basic.label);
  if (/^#[\da-f]{6}$/.test(value)) return single(original, value);
  if (/^#[\da-f]{3}$/.test(value)) return single(original, "#" + [...value.slice(1)].map(char => char + char).join(""));
  if (/^(clear|transparent|透明|透明色)$/.test(value)) return {...unknown(original), kind: "transparent", background: "repeating-conic-gradient(#dbe1e8 0% 25%,#ffffff 0% 50%) 0 0 / 8px 8px", label: "透明色", approximate: false};

  const catalogKey = [value, value.replace(/(?<=[a-z])-(?=[a-z])/g, " ")].find(key => Object.hasOwn(catalog, key));
  if (catalogKey) return single(original, (catalog as Record<string, string>)[catalogKey]!, commonLabels.get(catalogKey));

  const parts = value.split(/\s*(?:[\/&+、与]|\band\b|\s+-\s+|(?<=[a-z])-(?=[a-z]))\s*/);
  if (parts.length > 1) {
    // Never silently discard an unrecognized half of a compound color.
    if (parts.length > 4 || parts.some(part => !part)) return unknown(original);
    const resolved = parts.map(resolveColorName);
    if (resolved.some(part => part.kind !== "single")) return unknown(original);
    const colors = resolved.flatMap(part => part.colors);
    const stops = colors.map((color, index) => `${color} ${index / colors.length * 100}% ${(index + 1) / colors.length * 100}%`).join(",");
    return {kind: "multi", colors, background: `linear-gradient(135deg,${stops})`, textColor: "#000000", label: `${resolved.map(part => part.label).join(" / ")}（${original.trim()}）`, original, approximate: resolved.some(part => part.approximate)};
  }

  // Word-boundary matching avoids inventing a color from substrings like blueberry.
  const matches = basics.filter(([name, , label]) => new RegExp(`\\b${name}\\b`).test(value) || value === label.replace(/色$/, ""));
  if (matches.length === 1) return {...single(original, matches[0]![1]), label: `近似${matches[0]![2]}（${original.trim()}）`};
  return unknown(original);
}

export function resolveVariantColor(attributes: readonly Attribute[]): VariantColor {
  const values = attributes.filter(attribute => isColorDimension(attribute.dimension));
  if (!values.length) return unknown("");
  // Conflicting duplicate color dimensions must not change with attribute ordering.
  if (new Set(values.map(attribute => normalize(attribute.value))).size > 1) return unknown("颜色属性冲突");
  const attribute = values[0]!;
  const resolved = resolveColorName(attribute.value);
  const chinese = values.map(value => value.labelZh?.trim()).filter((value): value is string => Boolean(value && /[\u3400-\u9fff]/.test(value))).sort()[0];
  return chinese ? {...resolved, label: chinese} : resolved;
}

import { isColorDimension, resolveVariantColor } from "./lib/variant-color";

export type XydcVariantDisplayAttribute = Readonly<{
  dimension: string;
  value: string;
  labelZh?: string;
}>;

const colorLabels = new Map<string, string>([
  ["amber", "琥珀色"],
  ["walnut", "胡桃木色"],
  ["pink", "粉色"],
  ["clear", "透明色"],
  ["green", "绿色"],
  ["purple", "紫色"],
  ["red gold", "红金色"],
  ["green gold", "绿金色"],
  ["blue purple", "蓝紫色"],
  ["blue red", "蓝红色"],
  ["red green", "红绿色"],
  ["silver gray", "银灰色"],
  ["creamy white", "奶白色"],
  ["crystal black", "水晶黑"],
  ["black", "黑色"],
  ["black dimmable", "黑色（可调光款）"],
  ["black remote control", "黑色（遥控款）"],
  ["black rgb", "黑色（RGB款）"],
  ["black shade", "黑色（灯罩款）"],
  ["brown", "棕色"],
  ["gold", "金色"],
  ["gray", "灰色"],
  ["nickel", "镍色"],
  ["sand black", "砂黑色"],
  ["silver", "银色"],
  ["white", "白色"],
]);

const compoundColorLabels: Readonly<Record<string, string>> = {
  "brown and gold": "棕色与金色",
  "grayish and black": "浅灰色与黑色",
  "grayish and dark brown": "浅灰色与深棕色",
  "yellowish and brown": "淡黄色与棕色",
};

const shapeLabels = new Map<string, string>([["arc", "弧形"]]);

function normalized(value: string) {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function colorLabel(value: string) {
  const normalizedValue = normalized(value);
  const exactLabel = colorLabels.get(normalizedValue);
  if (exactLabel) return exactLabel;

  const compound = normalizedValue.match(/^(22|26)\s*["“”″]\s*-\s*(brown and gold|grayish and black|grayish and dark brown|yellowish and brown)$/);
  if (!compound) return value;
  return `${compound[1]} 英寸 - ${compoundColorLabels[compound[2]!]}`;
}

function sizeLabel(value: string) {
  const size = normalized(value).match(/^(22|26)\s*(?:["“”″]|in|inch|inches)$/);
  return size ? `${size[1]} 英寸` : value;
}

export function xydcVariantAttributeLabel(attribute: XydcVariantDisplayAttribute) {
  if (attribute.labelZh?.trim() && /[\u3400-\u9fff]/.test(attribute.labelZh)) return attribute.labelZh.trim();
  const dimension = normalized(attribute.dimension);
  const known = isColorDimension(dimension) ? colorLabel(attribute.value)
    : dimension === "shape" ? shapeLabels.get(normalized(attribute.value)) ?? attribute.value
    : dimension === "size" ? sizeLabel(attribute.value) : attribute.value;
  if (known !== attribute.value) return known;
  return isColorDimension(dimension) ? resolveVariantColor([attribute]).label : attribute.labelZh || attribute.value;
}

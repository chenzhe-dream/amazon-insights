/** 将卖家精灵 overviews 规范为 competitor-data 前 7 个 ASIN 的中文规格格式 */

const keyZhMap = {
  Brand: null,
  Color: null,
  "Model Name": null,
  "Frame Material": null,
  "Age Range (Description)": "适用年龄",
  "Age Range": "适用年龄",
  "Special Feature": "特殊功能",
  "Weight Limit": "最大承重",
  "Product Dimensions": "产品尺寸",
  "Number of Wheels": "轮子数量",
  "Wheel Material": "轮子材质",
  "Item Weight": "包装重量",
};

const scooterFeatureZhMap = {
  "adjustable handlebar height": "车把高度可调",
  "light up wheels": "发光轮",
  "light-up wheels": "发光轮",
  "non slip deck": "防滑宽踏板",
  "non-slip deck": "防滑宽踏板",
  "lean-to-steer": "Lean-to-Steer 倾斜转向",
  "extra-wide wheels": "加宽轮",
  "extra wide wheels": "加宽轮",
  "led light": "LED 发光",
  "removable seat": "可拆座椅",
};

const lightingFeatureZhMap = {
  "color temperature": "色温可调",
  "3 color": "三色温",
  "pull chain": "拉绳开关",
  "usb charging": "USB 充电口",
  "linen shade": "布艺灯罩",
  "storage shelf": "置物层板",
};

const sharedFeatureZhMap = {
  foldable: "可折叠",
  lightweight: "轻量化",
};

const lightingKeyZhMap = {
  "Number of Shelves": "层板数量",
  "Shade Material": "灯罩材质",
  "Shade Material Type": "灯罩材质",
  "Light Source Type": "光源类型",
  "Power Source": "供电方式",
  "Lamp Type": "灯具类型",
  "Switch Style": "开关类型",
  "Finish Type": "表面处理",
  "Room Type": "适用房间",
  "Special Feature": "特殊功能",
  "Product Dimensions": "产品尺寸",
  "Item Weight": "包装重量",
  "Weight Limit": "最大承重",
};

function featureMapFor(family) {
  if (family === "scooter") return { ...sharedFeatureZhMap, ...scooterFeatureZhMap };
  if (family === "lighting") return { ...sharedFeatureZhMap, ...lightingFeatureZhMap };
  return sharedFeatureZhMap;
}

const materialZhMap = {
  polyurethane: "聚氨酯（PU）",
  pp: "聚丙烯（PP）",
  aluminum: "铝合金",
  plastic: "塑料",
};

function formatDimensions(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return raw;
  const lwh = raw.match(/([\d.]+)"?\s*L\s*x\s*([\d.]+)"?\s*W\s*x\s*([\d.]+)"?\s*H/i);
  if (lwh) return `长${lwh[1]} × 宽${lwh[2]} × 高${lwh[3]} 英寸`;
  const generic = raw.match(/([\d.]+)\s*x\s*([\d.]+)\s*x\s*([\d.]+)/i);
  if (generic) return `长${generic[1]} × 宽${generic[2]} × 高${generic[3]} 英寸`;
  return raw;
}

function formatWeight(text) {
  const match = String(text ?? "").match(/([\d.]+)\s*(?:pounds|lbs?|lb)/i);
  if (match) return `${match[1]} 磅`;
  return String(text ?? "").trim();
}

function localizeAge(value) {
  const text = String(value ?? "").trim();
  if (!text) return text;
  if (/[\u4e00-\u9fff]/.test(text)) return text;
  const ages = text.match(/ages?\s*([\d]+)\s*[-–—to]+\s*([\d]+)/i);
  if (ages) return `${ages[1]}–${ages[2]}岁`;
  if (/toddler/i.test(text)) return "幼儿";
  if (/kid|child/i.test(text)) return "儿童";
  return text.replace(/^Ages?\s*/i, "").replace(/years?\s*old/i, "岁").trim();
}

function localizeFeatures(value, family = "generic") {
  const parts = String(value ?? "")
    .split(/[,，;；/|]+/)
    .map(item => item.trim())
    .filter(Boolean);
  const map = featureMapFor(family);
  const mapped = parts.map(part => {
    const lower = part.toLowerCase();
    for (const [key, zh] of Object.entries(map)) {
      if (lower.includes(key)) return zh;
    }
    if (family === "scooter") {
      if (/light.?up wheel|发光轮/i.test(part)) return "发光轮";
      if (/\bled\b/i.test(part) && /wheel|scooter/i.test(part)) return "发光轮";
      if (/\bled\b/i.test(part)) return "LED 发光";
      if (/adjust/i.test(part) && /handle/i.test(part)) return "车把高度可调";
    } else if (family === "lighting") {
      if (/\bled\b/i.test(part)) return "LED 照明";
      if (/shade|lampshade/i.test(part)) return "灯罩柔光";
      if (/shelf|storage/i.test(part)) return "置物层板";
    } else if (/\bled\b/i.test(part)) {
      return "LED";
    }
    if (/fold/i.test(part)) return "可折叠";
    return part;
  });
  return [...new Set(mapped)].join("、");
}

function localizeMaterial(value) {
  const lower = String(value ?? "").trim().toLowerCase();
  for (const [key, zh] of Object.entries(materialZhMap)) {
    if (lower.includes(key)) return zh;
  }
  return String(value ?? "").trim();
}

function localizeWheelCount(value) {
  const num = String(value ?? "").match(/\d+/)?.[0];
  return num ? `${num}个` : String(value ?? "").trim();
}

function localizeOverviewEntry(key, value, family = "generic") {
  const label = family === "lighting" && lightingKeyZhMap[key] ? lightingKeyZhMap[key] : keyZhMap[key];
  if (label === null) return null;
  if (!label) return null;
  const text = String(value ?? "").trim();
  if (!text) return null;

  switch (label) {
    case "适用年龄":
      return `${label}：${localizeAge(text)}`;
    case "特殊功能":
      return `${label}：${localizeFeatures(text, family)}`;
    case "最大承重":
      return `${label}：${formatWeight(text)}`;
    case "产品尺寸":
      return `${label}：${formatDimensions(text)}`;
    case "轮子数量":
      return family === "scooter" ? `${label}：${localizeWheelCount(text)}` : null;
    case "轮子材质":
      return family === "scooter" ? `${label}：${localizeMaterial(text)}` : null;
    case "包装重量":
      return `${label}：${formatWeight(text)}`;
    default:
      return `${label}：${text}`;
  }
}

const preferredOrderByFamily = {
  scooter: ["适用年龄", "特殊功能", "最大承重", "产品尺寸", "轮子数量", "轮子材质"],
  lighting: ["特殊功能", "光源类型", "灯罩材质", "层板数量", "产品尺寸", "最大承重", "供电方式"],
  generic: ["特殊功能", "产品尺寸", "最大承重", "包装重量"],
};

export function localizeSpecifications(detail, family = "generic") {
  const parsed = {};
  if (detail?.overviews) {
    try {
      Object.assign(parsed, JSON.parse(detail.overviews));
    } catch {
      // ignore malformed overviews
    }
  }

  const rows = new Map();
  for (const [key, value] of Object.entries(parsed)) {
    const row = localizeOverviewEntry(key, value, family);
    if (!row) continue;
    const label = row.split("：")[0];
    rows.set(label, row);
  }

  if (!rows.has("产品尺寸") && detail?.dimensions) {
    rows.set("产品尺寸", `产品尺寸：${formatDimensions(detail.dimensions)}`);
  }

  const preferredOrder = preferredOrderByFamily[family] ?? preferredOrderByFamily.generic;
  const ordered = preferredOrder.map(label => rows.get(label)).filter(Boolean);
  if (!ordered.length && detail?.dimensions) {
    ordered.push(`产品尺寸：${formatDimensions(detail.dimensions)}`);
  }
  if (!ordered.length && detail?.weight) {
    ordered.push(`包装重量：${formatWeight(detail.weight)}`);
  }

  return ordered.length ? ordered.slice(0, 6) : ["等待 Listing 内容同步后补充"];
}

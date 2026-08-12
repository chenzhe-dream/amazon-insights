type VocSummaryDimension =
  | "attention"
  | "positives"
  | "negatives"
  | "unmet"
  | "audiences"
  | "scenarios"
  | "motives";

type MergeRule = {
  canonical: string;
  dimensions?: VocSummaryDimension[];
  patterns: RegExp[];
};

const MERGE_RULES: MergeRule[] = [
  {
    canonical: "Lean-to-steer 转向体验",
    dimensions: ["unmet", "attention", "negatives"],
    patterns: [/lean[- ]?to[- ]?steer/i, /倾斜转向/, /转向说明/, /转向更灵活/, /转向.*掌握/, /操控灵活/, /转弯半径/, /转向\/骑行/, /turnability/i],
  },
  {
    canonical: "LED 发光轮与亮灯表现",
    patterns: [/led/i, /发光轮/, /发光\/灯光/, /亮灯/, /灯光效果/, /超宽.*发光/, /luminous/i, /lighting/i, /flashin/i],
  },
  {
    canonical: "耐用性 / 结构强度",
    patterns: [/耐用/, /耐久/, /durability/i, /断裂/, /耐摔/, /轮轴/, /连接件/, /使用寿命/, /结构稳固/, /结构强度/, /品控改进/],
  },
  {
    canonical: "备件与售后渠道",
    dimensions: ["unmet", "negatives"],
    patterns: [/备件/, /备用轮/, /换件/, /售后/, /质保/, /联系.*厂/, /注册 url/i, /缺件/, /补件/],
  },
  {
    canonical: "承重与适龄说明",
    dimensions: ["unmet", "attention"],
    patterns: [/承重/, /适用年龄/, /适龄标注/, /体型/, /120.*132/, /110.*磅/],
  },
  {
    canonical: "路况适应与减震",
    dimensions: ["unmet"],
    patterns: [/减震/, /路况/, /砂石/, /草地/, /非铺装/, /pu.*减震/i, /smooth ride/i],
  },
  {
    canonical: "包装完整与出厂质控",
    dimensions: ["unmet", "negatives"],
    patterns: [/包装/, /零件完整/, /组装孔位/, /螺丝质控/, /出厂.*质控/, /质控问题/],
  },
  {
    canonical: "低龄独立蹬地 / 踏板高度",
    dimensions: ["unmet"],
    patterns: [/踏板/, /deck/i, /蹬地/, /2\s*岁.*起步/],
  },
  {
    canonical: "刹车部件耐用性",
    dimensions: ["unmet", "negatives"],
    patterns: [/刹车/],
  },
  {
    canonical: "产品质量",
    dimensions: ["positives", "attention"],
    patterns: [/产品质量/, /品质/, /^质量$/, /做工/, /well made/i, /great quality/i],
  },
  {
    canonical: "安装便捷",
    dimensions: ["positives", "unmet"],
    patterns: [/安装便捷/, /安装方便/, /组装简单/, /易组装/, /免工具/, /easy assembly/i],
  },
  {
    canonical: "折叠便携",
    dimensions: ["positives", "attention", "scenarios"],
    patterns: [/折叠/, /fold/i, /便携/, /travel/i],
  },
  {
    canonical: "礼物 / 节日赠礼",
    dimensions: ["scenarios", "motives", "audiences"],
    patterns: [/生日/, /节日/, /圣诞/, /礼物/, /赠礼/, /gift/i],
  },
  {
    canonical: "户外 / 社区骑行",
    dimensions: ["scenarios"],
    patterns: [/户外/, /社区/, /邻里/, /outdoor/i, /neighborhood/i, /日常骑/],
  },
  {
    canonical: "室内使用",
    dimensions: ["scenarios"],
    patterns: [/室内/, /indoor/i],
  },
  {
    canonical: "第一辆滑板车",
    dimensions: ["scenarios", "motives"],
    patterns: [/第一辆/, /starter scooter/i, /入门/],
  },
  {
    canonical: "平衡 / 发育训练",
    dimensions: ["scenarios", "motives"],
    patterns: [/平衡/, /发育/, /learning to balance/i],
  },
  {
    canonical: "礼物购买动机",
    dimensions: ["motives"],
    patterns: [/礼物购买/, /送礼/],
  },
  {
    canonical: "孩子喜欢",
    dimensions: ["motives", "positives"],
    patterns: [/孩子喜欢/, /孩子.*爱/, /kids love/i],
  },
  {
    canonical: "新手稳定性",
    dimensions: ["motives", "positives"],
    patterns: [/新手稳定/, /稳定性/, /易上手/, /稳定.*骑/],
  },
  {
    canonical: "可调节性",
    dimensions: ["motives", "positives"],
    patterns: [/可调节/, /可调手把/, /调把/, /adjustable/i],
  },
  {
    canonical: "轮子表现 / 故障",
    dimensions: ["negatives", "positives", "unmet"],
    patterns: [/轮子表现/, /轮子故障/, /轮子.*坏/, /wheel/i, /后轮/],
  },
  {
    canonical: "转向困难",
    dimensions: ["negatives"],
    patterns: [/转向困难/, /不能正常旋转/, /转向问题/],
  },
  {
    canonical: "手把强度",
    dimensions: ["negatives", "unmet"],
    patterns: [/手把/, /handlebar/i],
  },
  {
    canonical: "功能表现 / 可靠性",
    dimensions: ["negatives", "unmet", "positives"],
    patterns: [/功能表现/, /功能可靠/, /functionality/i],
  },
  {
    canonical: "性价比",
    dimensions: ["positives", "motives"],
    patterns: [/性价比/, /value/i],
  },
  {
    canonical: "外观颜值",
    dimensions: ["positives", "attention"],
    patterns: [/外观/, /颜值/, /配色/, /appearance/i],
  },
  {
    canonical: "适龄性",
    dimensions: ["positives", "attention"],
    patterns: [/适龄/, /age appropri/i],
  },
  {
    canonical: "骑行顺滑",
    dimensions: ["positives", "unmet"],
    patterns: [/骑行顺滑/, /顺滑/, /流畅/],
  },
  {
    canonical: "女儿 / 女孩",
    dimensions: ["audiences"],
    patterns: [/^女儿$/, /孙女/, /外孙女/, /女孩/, /daughter/i, /granddaughter/i],
  },
  {
    canonical: "儿子 / 男孩",
    dimensions: ["audiences"],
    patterns: [/^儿子$/, /孙子/, /外孙/, /男孩/, /son/i, /grandson/i],
  },
  {
    canonical: "多孩家庭",
    dimensions: ["audiences", "scenarios"],
    patterns: [/多孩/, /兄弟姐妹/, /sibling/i],
  },
];

function cleanLabel(label: string) {
  return label
    .replace(/^\d+\.\s*/, "")
    .replace(/^希望/, "")
    .replace(/[【】]/g, "")
    .trim();
}

function normalizeKey(text: string) {
  return text.replace(/\s+/g, "").replace(/[（(].*[)）]/g, "").toLowerCase();
}

export function canonicalTheme(label: string, dimension: VocSummaryDimension): { key: string; label: string } {
  const cleaned = cleanLabel(label);
  if (!cleaned) return { key: "", label: "" };

  for (const rule of MERGE_RULES) {
    if (rule.dimensions && !rule.dimensions.includes(dimension)) continue;
    if (rule.patterns.some(pattern => pattern.test(cleaned))) {
      return { key: normalizeKey(rule.canonical), label: rule.canonical };
    }
  }

  return { key: normalizeKey(cleaned), label: cleaned };
}

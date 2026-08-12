/** 评论分析标签与摘要中文化 */

const labelZhMap = {
  daughter: "女儿",
  son: "儿子",
  granddaughter: "孙女/外孙女",
  grandson: "孙子/外孙",
  niece: "侄女/外甥女",
  nephew: "侄子/外甥",
  birthday: "生日相关",
  Christmas: "圣诞相关",
  park: "公园/户外",
  "ride scooter": "骑行使用",
  "assemble scooter": "组装使用",
  "outdoor play": "户外玩耍",
  "childhood development": "平衡/发育训练",
  "first scooter": "第一辆滑板车",
  "birthday gift": "生日礼物",
  "Christmas gift": "圣诞礼物",
  "indoor use": "室内使用",
  "durable brake": "刹车耐用性",
  "stronger handlebar": "手把强度",
  "improved hardware": "硬件升级",
  "better quality control": "品控改进",
  "flatter foot plate": "脚踏板高度",
  "light up wheels": "发光轮",
  "adjustable handlebar": "可调手把",
  "sturdy construction": "结构稳固",
  "easy assembly": "安装便捷",
  "bright colors": "外观配色",
  "smooth ride": "骑行顺滑",
  "broken brake": "刹车损坏",
  "handlebar breaking": "手把断裂",
  "poor quality control": "品控问题",
  "plastic components": "塑料部件",
  "short lifespan": "使用寿命短",
  "wheel failure": "轮子故障",
  "steering difficulty": "转向困难",
  "gift purchase": "礼物购买",
  "child's interest": "孩子喜欢",
  "affordable price": "性价比",
  "light-up feature": "发光功能",
  adjustability: "可调节性",
  "stability for beginners": "新手稳定性",
  quality: "产品质量",
  Quality: "产品质量",
  Assembly: "安装便捷",
  Sturdiness: "结构稳固",
  Durability: "耐用性",
  Turnability: "转向灵活性",
  Lighting: "发光/灯光",
  Wheels: "轮子表现",
  Gift: "礼物属性",
  Appearance: "外观颜值",
  Stability: "稳定性",
  Functionality: "功能表现",
  Maneuverability: "操控灵活性",
  Suitability: "幼儿适用性",
  "Suitability For Toddlers": "幼儿适用性",
  "Age Appropriate": "适龄性",
  "Ease Of Assembly": "安装便捷",
  "Value For Money": "性价比",
  "Smooth Ride": "骑行顺滑",
};

const keywordZhMap = {
  quality: "产品质量",
  turnability: "转向灵活性",
  assembly: "安装便捷",
  sturdiness: "结构稳固",
  durability: "耐用性",
  lighting: "发光/灯光",
  wheels: "轮子表现",
  gift: "礼物属性",
  functionality: "功能表现",
  maneuverability: "操控灵活性",
  stability: "稳定性",
  appearance: "外观颜值",
  value: "性价比",
  age: "适龄性",
  toddler: "幼儿适用",
  fun: "使用乐趣",
  adjust: "可调节性",
  ease: "使用便捷",
};

function normalizeKey(value) {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

export function translateReviewLabel(label) {
  if (!label) return label;
  if (/[\u4e00-\u9fff]/.test(label)) return label;
  if (labelZhMap[label]) return labelZhMap[label];
  const lower = normalizeKey(label);
  for (const [key, zh] of Object.entries(labelZhMap)) {
    if (normalizeKey(key) === lower) return zh;
  }
  const underscored = lower.replace(/\s+/g, "_");
  if (keywordZhMap[underscored]) return keywordZhMap[underscored];
  for (const [key, zh] of Object.entries(keywordZhMap)) {
    if (lower.includes(key)) return zh;
  }
  return label
    .split(/[\s_-]+/)
    .map(part => keywordZhMap[part.toLowerCase()] ?? part)
    .join("")
    .replace(/For/g, "")
    .replace(/Of/g, "")
    .replace(/The/g, "") || label;
}

function translatePhrase(text) {
  let result = text.trim();

  const templates = [
    [
      /^Customers find the kick scooter easy to assemble, with some mentioning it comes pre-assembled\.?$/i,
      "顾客认为该滑板车安装方便，部分买家提到出厂时已预装。",
    ],
    [
      /^Customers find the kick scooter sturdy and durable, with one customer noting it can hold up to 130lbs\.?$/i,
      "顾客认为该滑板车结实耐用，有买家提到可承受约 130 磅重量。",
    ],
    [
      /^Customers find the kick scooter suitable for toddlers, particularly 5-year-olds, and appreciate that it works well for multiple ages\.?$/i,
      "顾客认为该滑板车适合幼儿使用，尤其 5 岁左右儿童，多个年龄段均可使用。",
    ],
    [
      /^Customers like the scooter[’']s lighting features, particularly the awesome wheels that light up and flash\.?$/i,
      "顾客喜欢该滑板车的灯光功能，尤其轮子发光闪烁效果。",
    ],
    [
      /^Customers find the scooter to be of good quality, describing it as a great first scooter\.?$/i,
      "顾客认为该滑板车品质良好，非常适合作为儿童的第一辆滑板车。",
    ],
    [
      /^Customers find the scooter to be of good quality, describing it as amazing and a great choice for children\.?$/i,
      "顾客认为该滑板车品质出色，非常适合儿童使用。",
    ],
    [
      /^Customers report significant issues with the scooter[’']s maneuverability, noting that the handlebar and front wheels don[’']t rotate properly\.?$/i,
      "顾客反馈转向存在问题，手把与前轮不能正常旋转。",
    ],
    [
      /^Customers find the kick scooter durable, with one customer noting it can withstand 5-7 mile days through Europe, while another mentions it has survived some spills\.?$/i,
      "顾客认为该滑板车耐用，有买家反馈长途使用或经摔后仍表现稳定。",
    ],
    [
      /^Customers find the kick scooter age-appropriate, particularly suitable for toddlers and young children, with several mentioning it[’']s great for 2-year-olds and active toddlers\.?$/i,
      "顾客认为该滑板车适龄，尤其适合幼儿和好动的低龄儿童。",
    ],
    [
      /^Customers like the scooter[’']s wheels, which light up and work well, with one customer noting that the lights are not just flashy marketing\.?$/i,
      "顾客喜欢该滑板车的轮子，发光效果真实可用，并非噱头。",
    ],
    [
      /^Customers find the kick scooter easy to assemble, with one mentioning that everything fits together smoothly\.?$/i,
      "顾客认为该滑板车安装方便，部件衔接顺畅。",
    ],
  ];

  for (const [pattern, replacement] of templates) {
    if (pattern.test(result)) return replacement;
  }

  result = result
    .replace(/^Customers find the kick scooter /i, "顾客认为该滑板车")
    .replace(/^Customers find the scooter to be /i, "顾客认为该滑板车")
    .replace(/^Customers find the scooter /i, "顾客认为该滑板车")
    .replace(/^Customers find /i, "顾客认为")
    .replace(/^Customers report /i, "顾客反馈")
    .replace(/^Customers like the scooter[’']s /i, "顾客喜欢该滑板车的")
    .replace(/^Customers like /i, "顾客喜欢")
    .replace(/^Customers note /i, "顾客提到")
    .replace(/describing it as /gi, "，评价为")
    .replace(/particularly /gi, "尤其")
    .replace(/with one customer noting /gi, "，有顾客提到")
    .replace(/with some mentioning /gi, "，部分顾客提到")
    .replace(/while another mentions /gi, "，另有顾客提到")
    .replace(/and appreciate that it works well for multiple ages\.?/gi, "，多个年龄段均可使用。")
    .replace(/it comes pre-assembled\.?/gi, "出厂时已预装。")
    .replace(/good quality/gi, "品质良好")
    .replace(/great first scooter/gi, "非常适合作为第一辆滑板车")
    .replace(/easy to assemble/gi, "安装方便")
    .replace(/sturdy and durable/gi, "结实耐用")
    .replace(/suitable for toddlers/gi, "适合幼儿使用")
    .replace(/light up and flash/gi, "会发光闪烁")
    .replace(/lighting features/gi, "灯光功能")
    .replace(/awesome wheels/gi, "轮子效果")
    .replace(/age-appropriate/gi, "适龄")
    .replace(/young children/gi, "低龄儿童")
    .replace(/active toddlers/gi, "好动的幼儿")
    .replace(/works well/gi, "表现良好")
    .replace(/fits together smoothly/gi, "组装顺畅")
    .replace(/amazing/gi, "很棒")
    .replace(/great choice for children/gi, "很适合儿童")
    .replace(/multiple ages/gi, "多个年龄段")
    .replace(/5-year-olds/gi, "5 岁左右儿童")
    .replace(/2-year-olds/gi, "2 岁左右儿童")
    .replace(/maneuverability/gi, "操控/转向")
    .replace(/\bof\b/gi, "")
    .replace(/\bfor\b/gi, "")
    .replace(/\band\b/gi, "，")
    .replace(/\bthe\b/gi, "")
    .replace(/\bit\b/gi, "")
    .replace(/\ba\b/gi, "")
    .replace(/scooter/gi, "滑板车")
    .replace(/kick scooter/gi, "滑板车")
    .replace(/\s{2,}/g, " ")
    .replace(/,\s*，/g, "，")
    .replace(/,\s*/g, "，")
    .trim();

  return result.endsWith("。") ? result : `${result.replace(/[.,]\s*$/g, "")}。`;
}

function translateSnippet(text) {
  return translatePhrase(text)
    .replace(/loves? it/gi, "很喜欢")
    .replace(/great (?:buy|gift|toy)/gi, "很值得买")
    .replace(/Grandson thrilled with gift/gi, "孙子收到礼物非常开心")
    .replace(/Granddaughter LOVES/gi, "孙女非常喜欢")
    .replace(/My son loves/gi, "儿子很喜欢")
    .replace(/birthday gift/gi, "生日礼物")
    .replace(/Christmas gift/gi, "圣诞礼物")
    .replace(/easy to assemble/gi, "安装方便")
    .replace(/adjustable/gi, "可调节")
    .replace(/light up wheels/gi, "发光轮")
    .replace(/three wheels/gi, "三轮设计")
    .replace(/well made/gi, "做工不错")
    .replace(/Fast ship/gi, "发货快")
    .replace(/Great quality/gi, "品质很好")
    .replace(/starter scooter/gi, "入门滑板车")
    .replace(/learning to balance/gi, "学习平衡")
    .replace(/outdoor/gi, "户外")
    .replace(/neighborhood/gi, "社区/小区");
}

export function translateReviewReason(label, reason) {
  if (!reason) return "";
  if (/[\u4e00-\u9fff]/.test(reason) && !/[a-zA-Z]{4,}/.test(reason)) return reason;

  let translated = translatePhrase(reason);
  if (/^Customers (find|report|like|note)/i.test(reason)) {
    translated = translatePhrase(reason);
  } else {
    translated = translateSnippet(reason);
  }

  const asciiRatio = (translated.match(/[a-zA-Z]/g)?.length ?? 0) / Math.max(translated.length, 1);
  if (asciiRatio > 0.35) return "";

  return translated.replace(/\s{2,}/g, " ").trim();
}

export function localizeReviewRow(row) {
  return {
    ...row,
    label: translateReviewLabel(row.label),
    reason: translateReviewReason(row.label, row.reason),
  };
}

export function localizeReviewBlocks(blocks) {
  return blocks.map(block => ({
    ...block,
    rows: block.rows.map(localizeReviewRow),
  }));
}

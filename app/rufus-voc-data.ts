export const rufusVocMeta = {
  source: "Alexa for Shopping 对话框",
  capturedAt: "2026-08-12",
  scope: "Customer Review（经 Alexa 整理）· 非 Listing Bullet Point · 非 Customers say 标签页",
  limitation: "6 个 ASIN 已录入 VOC 核心主题矩阵 · 2 个待 Alexa 抓取。",
  prompt:
    "这个产品的顾客关注点是什么，好评点是什么，差评点是什么，未被满足的需求是什么，使用人群是谁，使用场景是什么，核心购买动机是什么。",
} as const;

/** 实际抓取流程（与 Alexa for Shopping 操作一致） */
export const rufusVocWorkflow = [
  { step: "推荐", approach: "竞品概览输入 ASIN →「开始全自动分析」，进度条跑完后页面自动刷新" },
  { step: "手工备选", approach: "商品页提交七问并展开 See more 后，复制全文到下方粘贴录入" },
] as const;

/** Alexa for Shopping 对话报告页眉（与手机端七问回复结构对齐） */
export type AlexaVocReportHeader = {
  title: string;
  asin: string;
  rating: number;
  reviewCount: number;
  starBreakdown?: string;
  prompt: string;
  overallConclusion: string;
  captureNote?: string;
  captureStatus?: "dialog" | "pending";
};

export type RufusVocRecord = {
  attention: string[];
  positives: string[];
  negatives: string[];
  unmet: string[];
  audiences: string[];
  scenarios: string[];
  motives: string[];
  captureStatus?: "dialog" | "pending";
  alexaReport?: AlexaVocReportHeader;
};

const vocPct = (mentions: number, reviews: number) => {
  const value = (mentions / reviews) * 100;
  return value >= 1 ? value.toFixed(1) : value.toFixed(2);
};

const vocPositive = (label: string, mentions: number, reviews: number) =>
  `【${label}】约 ${vocPct(mentions, reviews)}% 评论提及（${mentions.toLocaleString()} 条）`;

const vocNegative = (label: string, mentions: number, reviews: number, mixed = false) =>
  mixed
    ? `【${label}】约 ${vocPct(mentions, reviews)}% 评论提及（Mixed，${mentions.toLocaleString()} 条）`
    : `【${label}】约 ${vocPct(mentions, reviews)}% 评论提及（${mentions.toLocaleString()} 条）`;

const vocAttention = (
  index: number,
  title: string,
  detail: string,
  dimension: string,
  mentions: number,
  reviews: number
) =>
  `${index}. ${title}：${detail}（${dimension} ${mentions.toLocaleString()} 条提及，约 ${vocPct(mentions, reviews)}%）。`;

const dialogVoc = (
  asin: string,
  rating: number,
  reviewCount: number,
  starBreakdown: string,
  overallConclusion: string,
  data: Pick<RufusVocRecord, "attention" | "positives" | "negatives" | "unmet" | "audiences" | "scenarios" | "motives">
): RufusVocRecord => ({
  captureStatus: "dialog",
  alexaReport: {
    title: "顾客评价深度分析",
    asin,
    rating,
    reviewCount,
    starBreakdown,
    prompt: rufusVocMeta.prompt,
    overallConclusion,
    captureNote: `来源：Alexa for Shopping 对话框七问回复（${rufusVocMeta.capturedAt}）`,
    captureStatus: "dialog",
  },
  ...data,
});

const pendingAlexaVoc = (asin: string, rating: number, reviewCount: number): RufusVocRecord => {
  const pendingLine = "待在 Alexa for Shopping 对话框提问七问后，按回复原文录入。";
  return {
    captureStatus: "pending",
    alexaReport: {
      title: "顾客评价深度分析",
      asin,
      rating,
      reviewCount,
      prompt: rufusVocMeta.prompt,
      overallConclusion: pendingLine,
      captureNote: "请在 Amazon App → 商品页 → Alexa for Shopping 对话框提问，将回复截图或原文发回后录入。",
      captureStatus: "pending",
    },
    attention: [pendingLine],
    positives: [pendingLine],
    negatives: [pendingLine],
    unmet: [pendingLine],
    audiences: [pendingLine],
    scenarios: [pendingLine],
    motives: [pendingLine],
  };
};

export const rufusVocData: Record<string, RufusVocRecord> = {
  B07VY9Q95Q: {
    captureStatus: "dialog",
    alexaReport: {
      title: "顾客评价深度分析",
      asin: "B07VY9Q95Q",
      rating: 4.6,
      reviewCount: 20856,
      starBreakdown: "5 星约 77% · 评论 2 万+（Alexa 对话框报告）",
      prompt: rufusVocMeta.prompt,
      overallConclusion:
        "综合 Alexa for Shopping 对 Customer Review 的分析，Hurtle 作为低龄儿童第一辆滑板车整体口碑较好，易组装、结构稳定与 LED 发光轮是核心购买理由；主要改进空间在 Lean-to-steer 转向学习曲线、轮子/结构耐用性与缺件售后。适合作为礼物或社区日常骑行，但买家需预期转向需练习、部分评论反映使用寿命有限。",
      captureNote: "来源：Alexa for Shopping 对话框七问回复（2026-08-04）",
      captureStatus: "dialog",
    },
    attention: [
      vocAttention(1, "产品质量与耐用性", "家长最关注车体是否扎实、能否长期陪伴孩子使用", "Quality", 1264, 20856),
      vocAttention(2, "安装难易度与上手体验", "是否容易组装、孩子能否快速学会", "Assembly", 714, 20856),
      vocAttention(3, "适用年龄与「第一辆滑板车」定位", "是否适合幼儿及 5 岁左右儿童", "Suitability for toddlers", 503, 20856),
      vocAttention(4, "LED 发光轮与外观吸引力", "亮灯轮子与可爱造型是共同关注点", "Lighting", 457, 20856),
      vocAttention(5, "转向 / Lean-to-steer 能力", "前轮能否正常转弯是最大争议点", "Turnability", 306, 20856),
    ],
    positives: [
      vocPositive("质量与耐用性", 1264, 20856),
      vocPositive("组装轻松", 714, 20856),
      vocPositive("LED 发光轮", 457, 20856),
      vocPositive("外观吸引力", 305, 20856),
      vocPositive("适龄 / 第一辆滑板车", 503, 20856),
      vocPositive("易上手", 246, 20856),
      vocPositive("性价比", 234, 20856),
    ],
    negatives: [
      vocNegative("转向能力", 306, 20856),
      "【尺寸与 lean 转向门槛】评论分散提及（2 岁偏大、需更大孩子才能独立转向）",
    ],
    unmet: [
      "1. 希望 Lean-to-steer 转向更灵活，低龄儿童也能独立正常转弯。",
      "2. 希望前轮/连接件材质更耐用，避免使用 1 个月左右即损坏。",
      "3. 希望 LED 灯光效果更持久稳定，减少短期失效。",
      "4. 希望踏板/Deck 高度更适合 2 岁左右儿童独立蹬地起步。",
      "5. 希望包装与零件完整度更高，减少缺件与售后补件等待。",
    ],
    audiences: [
      "人群分类｜特征",
      "幼儿 / 学龄前儿童（1–5 岁）｜Perfect size for young child · sit-stand 过渡",
      "多年龄段儿童（含 5 岁+）｜4 档可调把手 · multiple ages",
      "初学者 / 第一辆滑板车用户｜宽踏板 · 三轮稳定 · great first scooter",
      "祖父母 / 礼物购买者｜Grandson / Granddaughter loves it · 生日礼物",
    ],
    scenarios: [
      "场景｜说明与示例",
      "室内外日常骑行｜社区、车道、公园平路",
      "第一辆滑板车入门训练｜sit-stand 二合一过渡",
      "生日礼物 / 节日赠礼｜Verified Purchase 礼物评论高频",
      "暗光环境展示型骑行｜LED 发光轮 · neighborhood",
    ],
    motives: [
      "动机｜重要性｜说明",
      "产品质量与耐用性｜★★★★★｜Quality 1,264 条 · 约 6.1%",
      "易组装与易上手｜★★★★☆｜Assembly 714 · Ease of use 246",
      "LED 发光轮与外观吸引力｜★★★★☆｜Lighting 457 · Appearance 305",
      "适龄 / 第一辆滑板车｜★★★★☆｜Suitability for toddlers 503",
      "性价比｜★★★☆☆｜Value for money 234",
    ],
  },
  B0BPXRVWYK: dialogVoc(
    "B0BPXRVWYK",
    4.8,
    3629,
    "5 星约 90% · 4 星约 6%（Alexa AI 报告）",
    "besrey 口碑整体偏正面，质量、免工具组装、折叠便携与 LED 发光轮是核心购买理由；主要争议在 Lean-to-steer 学习曲线、后轮耐久与 110 磅承重上限，适合 3–10 岁日常及旅行高强度使用。",
    {
      attention: [
        vocAttention(1, "产品质量与耐用性", "家长最关注车体扎实度与长期高强度使用表现", "Quality", 182, 3629),
        vocAttention(2, "适龄性与幼儿适用", "是否适合 3–10 岁及幼儿日常骑行", "Age-appropriate", 63, 3629),
        vocAttention(3, "LED 发光轮表现", "亮灯持久性与轮子质量是共同关注点", "Wheels", 61, 3629),
        vocAttention(4, "免工具组装与开箱体验", "是否快速上手、无需工具", "Ease of assembly", 59, 3629),
        vocAttention(5, "折叠便携与倾斜转向", "外出携带与 Lean-to-steer 学习曲线", "Foldability", 48, 3629),
      ],
      positives: [
        vocPositive("质量与耐用性", 182, 3629),
        vocPositive("耐用性（长期使用）", 88, 3629),
        vocPositive("适龄设计", 63, 3629),
        vocPositive("发光轮表现", 61, 3629),
        vocPositive("免工具组装", 59, 3629),
        vocPositive("折叠便携", 48, 3629),
        vocPositive("把手可调", 39, 3629),
      ],
      negatives: [
        vocNegative("倾斜转向 / 操控", 39, 3629, true),
        "【后轮耐久隐患】评论分散提及（Q&A 后轮融化 · 需联系制造商）",
        "【承重上限偏低】规格标注 110 磅（低于部分竞品）",
      ],
      unmet: [
        "1. 希望 Lean-to-steer 转向说明更清晰，降低初次使用困惑。",
        "2. 希望后轮/备件可直接购买，而非仅联系制造商。",
        "3. 希望承重与适用年龄上限说明更透明（8–10 岁较大体型）。",
        "4. 希望减震或路况适应能力与宣传预期更一致。",
        "5. 希望零件损坏后售后响应更快、换件渠道更明确。",
      ],
      audiences: [
        "人群分类｜特征",
        "幼儿及 3–10 岁儿童｜Age-appropriate 63 次 · 100% 正面",
        "成长阶段儿童｜4 档可调把手 · 31–63 英寸身高",
        "初学者 / 日常骑行｜三轮稳定 · 快速上手",
        "礼物购买者（家长/祖父母）｜gift · grandson/granddaughter 高频",
        "高强度使用家庭｜欧洲旅行 5–7 mile/day 正面评论",
      ],
      scenarios: [
        "场景｜说明与示例",
        "社区/邻里日常骑行｜zipping around the neighborhood",
        "旅行/外出携带｜一键折叠 · foldability for travel",
        "国际旅行高强度使用｜withstand 5–7 mile days through Europe",
        "夜间/低光环境骑行｜LED 速度越快越亮",
        "生日礼物 / 节日赠礼｜best gift · little adventurer",
      ],
      motives: [
        "动机｜重要性｜说明",
        "产品质量与耐用性｜★★★★★｜Quality 182 · Durability 88",
        "免工具快速组装｜★★★★☆｜Ease of assembly 59",
        "发光轮持久亮、孩子喜欢｜★★★★☆｜Wheels 61",
        "折叠便携、外出好带｜★★★★☆｜Foldability 48",
        "可调把手覆盖成长｜★★★☆☆｜Adjustability 39",
      ],
    }
  ),
  B07DYG1C9B: dialogVoc(
    "B07DYG1C9B",
    4.6,
    6512,
    "5 星约 75% · 4 星约 14%（Alexa AI 报告）",
    "WV WONDER VIEW 以质量、双前轮稳定与 LED 发光轮为主要购买理由，154 磅承重是差异点；最大争议在 Durability（41% 正面），部分反馈 1–4 个月内前轮断裂，且砂石/草地路况适应有限。",
    {
      attention: [
        vocAttention(1, "产品质量与结构稳固度", "评论最高频关注点，双前轮设计受认可", "Quality", 444, 6512),
        vocAttention(2, "LED 发光轮与外观", "亮灯效果与造型吸引力是购买亮点", "Lighting", 246, 6512),
        vocAttention(3, "组装/拆卸简易性", "是否省心上手、5 分钟完成", "Assembly", 147, 6512),
        vocAttention(4, "适龄性与儿童适用", "7 岁、4 岁均有好评", "Suitability for kids", 132, 6512),
        vocAttention(5, "耐用性争议", "部分反馈 1–4 个月内前轮脱落/断裂", "Durability", 201, 6512),
      ],
      positives: [
        vocPositive("质量与耐用性", 444, 6512),
        vocPositive("结构稳固", 300, 6512),
        vocPositive("LED 发光轮", 246, 6512),
        vocPositive("组装/拆卸简单", 147, 6512),
        vocPositive("外观吸引力", 137, 6512),
        vocPositive("适龄 / 儿童适用", 132, 6512),
        vocPositive("双前轮稳定性", 121, 6512),
      ],
      negatives: [
        vocNegative("耐用性 / 前轮", 201, 6512, true),
        vocNegative("Lean-to-steer 学习曲线", 121, 6512, true),
        "【刹车 / 后轮磨损】Q&A 分散提及（下坡硬刹导致磨损）",
        "【砂石 / 草地路况】仅适合光滑路面 · Q&A 集中",
      ],
      unmet: [
        "1. 希望前轮/轮轴更耐用，避免 1–4 个月内断裂或飞脱。",
        "2. 希望质保与换件渠道更可靠，避免「联系不到厂家」。",
        "3. 希望在砂石/草地等非铺装路面仍有可用骑行体验。",
        "4. 希望 Lean-to-steer 对 3–4 岁低龄段更易掌握。",
        "5. 希望 LED 轮侧面也可见、且长期亮灯不熄。",
      ],
      audiences: [
        "人群分类｜特征",
        "4–7 岁儿童（核心）｜Suitability 132 次 · 97% 正面",
        "8 岁及较大体型儿童｜154 磅承重 · 最高档把手仍适用",
        "初学骑行儿童｜双前轮稳定 · 快速建立信心",
        "祖父母 / 礼物购买者｜granddaughters 6½ and 5 等 Q&A",
      ],
      scenarios: [
        "场景｜说明与示例",
        "社区/人行道平路骑行｜works better on concrete · pavement",
        "公园户外休闲｜explore the outdoors",
        "夜间发光轮骑行｜when dark it's really bright",
        "多孩家庭共用｜4 岁与 7 岁均适用",
        "生日礼物 / 节日赠礼｜vivid color · stylish wheels",
      ],
      motives: [
        "动机｜重要性｜说明",
        "产品质量与结构稳固｜★★★★★｜Quality 444 · Sturdiness 300",
        "双前轮稳定感｜★★★★★｜Stability 121 · two wheels in front",
        "LED 发光轮与外观｜★★★★☆｜Lighting 246 · Appearance 137",
        "高承重 / 长期使用｜★★★★☆｜154 lb · 多成长阶段",
        "易组装省心｜★★★☆☆｜Assembly 147",
      ],
    }
  ),
  B07S64PYMM: dialogVoc(
    "B07S64PYMM",
    4.6,
    6340,
    "5 星约 79% · 4 星约 10%（Alexa AI 报告）",
    "Allek B02 礼物属性与发光轮趣味突出，质量与易组装获较多好评；主要争议在 Durability（47% 正面）与 Functionality/LED（44% 正面），轮子断裂与灯不亮是核心改进点。",
    {
      attention: [
        vocAttention(1, "产品质量与做工", "提及量最高，家长首要关注车体扎实度", "Quality", 344, 6340),
        vocAttention(2, "耐久性是否经得起日常", "轮子与结构长期表现争议较大", "Durability", 327, 6340),
        vocAttention(3, "LED 发光轮与功能可靠性", "亮灯效果与功能稳定性分化明显", "Lighting", 128, 6340),
        vocAttention(4, "组装难度与开箱体验", "是否快速上手、省心上手", "Assembly", 155, 6340),
        vocAttention(5, "适龄/包装标注一致性", "Q&A 反映 box 与 listing 年龄标注不一致", "Gift suitability", 116, 6340),
      ],
      positives: [
        vocPositive("质量与做工", 344, 6340),
        vocPositive("组装简单", 155, 6340),
        vocPositive("LED 发光轮", 128, 6340),
        vocPositive("礼物属性", 116, 6340),
        vocPositive("性价比", 83, 6340),
        vocPositive("趣味 / 娱乐性", 54, 6340),
      ],
      negatives: [
        vocNegative("耐用性 / 轮子断裂", 327, 6340, true),
        vocNegative("功能可靠性 / LED", 66, 6340, true),
        "【刹车可靠性】Q&A 分散提及",
        "【包装年龄标注】与 listing 不一致 · Q&A",
      ],
      unmet: [
        "1. 希望轮子连接处更耐摔，避免骑行中断裂。",
        "2. 希望 LED 发光轮长期稳定亮灯，避免短期失效。",
        "3. 希望包装/页面适龄标注一致，减少选购困惑。",
        "4. 希望刹车部件更耐用，避免使用后脱落。",
        "5. 希望备件（尤其后轮/LED 轮）可直接购买。",
      ],
      audiences: [
        "人群分类｜特征",
        "各年龄段儿童（礼物对象）｜Gift 116 · great gift for kids of all ages",
        "4–7 岁儿童（核心）｜Fun 54 · 双前轮建立信心",
        "11 岁左右较大儿童｜Q&A 问是否适合 11 year old · 130 lb 承重",
        "祖父母 / 家长购买者｜grandma/grandpa 场景高频",
      ],
      scenarios: [
        "场景｜说明与示例",
        "生日礼物 / 节日赠礼｜Gift 116 · Christmas/birthday",
        "白天/夜间发光轮骑行｜visible day and night",
        "社区/邻里日常骑行｜neighborhood · sidewalk",
        "多孩家庭共用｜ bought two for house and grandparents",
        "室内/木地板短途｜部分评论提及室内使用",
      ],
      motives: [
        "动机｜重要性｜说明",
        "礼物属性｜★★★★★｜Gift 116 · 节日赠礼首选",
        "发光轮趣味与可见性｜★★★★☆｜Lighting 128",
        "产品质量与组装省心｜★★★★☆｜Quality 344 · Assembly 155",
        "性价比｜★★★☆☆｜Value for money 83",
        "结构耐用预期｜★★★☆☆｜Durability 327 · Mixed",
      ],
    }
  ),
  B08HJ96QJ9: dialogVoc(
    "B08HJ96QJ9",
    4.5,
    2619,
    "5 星约 72% · 4 星约 14%（Alexa AI 报告）",
    "Allek B03 以超宽发光轮、无极调把和稳定结构为卖点，适龄性口碑好；Mixed 维度明显多于 besrey/Hurtle：耐久、LED 寿命、组装质控与转向均需买家有预期。",
    {
      attention: [
        vocAttention(1, "产品质量与做工", "整体口碑偏正面，家长关注车体扎实度", "Quality", 122, 2619),
        vocAttention(2, "耐久性", "前轮支架与连接件是最大争议点", "Durability", 119, 2619),
        vocAttention(3, "LED 发光轮寿命", "超宽发光轮吸引力与寿命分化", "Lighting", 36, 2619),
        vocAttention(4, "组装与出厂质控", "孔位/螺丝质控是 Mixed 维度", "Assembly", 85, 2619),
        vocAttention(5, "操控/转向与备件获取", "转向半径与 spare wheels Q&A 高频", "Maneuverability", 30, 2619),
      ],
      positives: [
        vocPositive("质量与做工", 122, 2619),
        vocPositive("超宽 LED 发光轮", 36, 2619),
        vocPositive("适龄性", 37, 2619),
        vocPositive("稳定性", 26, 2619),
        "【无极调节把手】产品设计亮点（无极调把覆盖 3–12 岁）",
        "【双重锁定 / 全覆盖刹车】A+ 差异化设计",
      ],
      negatives: [
        vocNegative("耐用性 / 前轮支架", 119, 2619, true),
        vocNegative("LED 寿命 / 无备件", 36, 2619, true),
        vocNegative("组装 / 孔位质控", 85, 2619, true),
        vocNegative("操控 / 转向半径", 30, 2619, true),
        "【备件获取困难】Q&A 高频 · 官方不售 spare parts",
      ],
      unmet: [
        "1. 希望可直接购买备用轮（尤其后轮与 LED 轮）。",
        "2. 希望 LED 发光轮更耐久，避免 1 个月内失效。",
        "3. 希望出厂组装孔位/螺丝质控更严格。",
        "4. 希望转向更灵活，转弯半径更小。",
        "5. 希望承重与适用年龄说明更透明（120–132 磅认知差）。",
      ],
      audiences: [
        "人群分类｜特征",
        "4–7 岁初学儿童（核心）｜Age-appropriate 97% 正面",
        "3–12 岁多阶段儿童｜25.5\"–32\" 无极调把",
        "体型偏大儿童｜big for her age 评论",
        "祖父母 / 礼物购买者｜4th birthday gift 场景",
      ],
      scenarios: [
        "场景｜说明与示例",
        "小区/人行道光滑路面｜sidewalk surfing",
        "公园户外探索｜explore the outdoors",
        "夜间/低光安全骑行｜wheels light up day or night",
        "生日礼物开箱｜perfect gift · birthday",
        "无工具拆卸收纳｜one-press disassembly",
      ],
      motives: [
        "动机｜重要性｜说明",
        "安全稳定（首要）｜★★★★★｜三轮 + 全覆盖后刹 + 防滑踏板",
        "超宽 LED 发光轮吸引力｜★★★★★｜4.8\" 大轮 · 孩子主动想要",
        "无极调把 / 长期陪伴｜★★★★☆｜3–12 岁连续可调",
        "礼物场景｜★★★★☆｜birthday · grandson/granddaughter",
        "易组装预期｜★★☆☆☆｜Assembly Mixed 85 分化",
      ],
    }
  ),
  B08T8RY9VK: dialogVoc(
    "B08T8RY9VK",
    4.6,
    2487,
    "5 星约 76% · 4 星约 13%（Alexa AI 报告）",
    "TONBUX 定位低龄第一辆滑板车，质量、结构稳固与 PU 减震是差异化卖点；主要争议在后轮耐久（38% 负面）与 Lean-to-steer 学习曲线，备件与质保渠道不透明。",
    {
      attention: [
        vocAttention(1, "产品质量与做工", "低龄第一辆滑板车定位下口碑较好", "Quality", 164, 2487),
        vocAttention(2, "结构稳固度", "三角结构与宽踏板是核心卖点", "Sturdiness", 102, 2487),
        vocAttention(3, "后轮耐久性", "日常刹车导致磨损是主要争议", "Durability", 58, 2487),
        vocAttention(4, "LED 发光轮", "亮灯效果与幼儿吸引力获好评", "Lighting", 55, 2487),
        vocAttention(5, "转向/骑行流畅度", "Lean-to-steer 学习曲线与 PU 减震表现", "Smooth ride", 52, 2487),
      ],
      positives: [
        vocPositive("质量与做工", 164, 2487),
        vocPositive("结构稳固", 102, 2487),
        vocPositive("组装便利", 71, 2487),
        vocPositive("LED 发光轮", 55, 2487),
        vocPositive("适龄 / 第一辆定位", 49, 2487),
        vocPositive("易上手 / 易操控", 40, 2487),
        "【PU 减震设计】差异化卖点 · 同类产品较少",
      ],
      negatives: [
        vocNegative("后轮耐久 / 磨损", 58, 2487, true),
        vocNegative("骑行顺滑 / 转向", 52, 2487, true),
        "【车轮异响】Q&A 分散提及",
        "【备件 / 质保不透明】无直购后轮 · 质保未明确",
        "【产品注册链接失效】Q&A 反馈",
      ],
      unmet: [
        "1. 希望可直接购买备用后轮，避免 1 个月内磨损后无处替换。",
        "2. 希望后轮材质更耐磨，匹配日常刹车使用强度。",
        "3. 希望官方明确质保期限，不仅依赖 Amazon 30 天退换。",
        "4. 希望 Lean-to-steer 说明更清晰，降低初学者困惑。",
        "5. 希望修复产品注册 URL，完善售后与备件指引。",
      ],
      audiences: [
        "人群分类｜特征",
        "3–6 岁初学幼儿（核心）｜Age-appropriate 90% 正面 · first scooter",
        "7–12 岁扩展年龄段｜4 档把手 25\"–32\"",
        "多孩/多龄家庭｜5–10 岁 grandkids 共用 Q&A",
        "祖父母 / 礼物购买者｜Christmas tree · birthday 场景",
      ],
      scenarios: [
        "场景｜说明与示例",
        "第一辆滑板车入门｜perfect first scooter for toddler",
        "社区/人行道日常骑行｜neighborhood · smooth pavement",
        "轻度不平路面｜shock absorption · PU 轮减震",
        "夜间发光轮骑行｜light-up wheels · magnetic lights",
        "旅行/收纳携带｜fold · two buttons 折叠",
      ],
      motives: [
        "动机｜重要性｜说明",
        "安全稳定（首要）｜★★★★★｜Sturdiness 102 · 三角结构",
        "第一辆滑板车 / 适龄｜★★★★★｜Age-appropriate 49 · 3–6 岁核心",
        "LED 发光轮吸引幼儿｜★★★★☆｜Lighting 55",
        "PU 减震 / 路况适应｜★★★★☆｜Shock Absorption 差异化卖点",
        "易组装 / 礼物属性｜★★★☆☆｜Assembly 71",
      ],
    }
  ),
  B09V5RW2VK: {
    captureStatus: "dialog",
    alexaReport: {
      title: "顾客评价深度分析",
      asin: "B09V5RW2VK",
      rating: 4.8,
      reviewCount: 1442,
      prompt: rufusVocMeta.prompt,
      overallConclusion: "Alexa 七问报告已录入（2026-08-12），总体结论待人工补全。",
      captureNote: "来源：Alexa for Shopping 对话框读取（2026-08-12）",
      captureStatus: "dialog",
    },
    attention:       [
        "1. LED发光轮是否正常工作（lighting 78 条提及，约 5.4%）。",
        "2. 耐久性/承摔能力（durability 73 条提及，约 5.1%）。",
        "3. 是否真正适合3岁幼儿（suitability for toddlers 48 条提及，约 3.3%）。",
        "4. 倾斜转向是否容易掌握（Q&A：\"The front wheels are supposed to turn to the sides?\"；多条评价提及4-5岁孩子存在困难）。",
        "5. 外观颜值与迪士尼IP吸引力（appearance 44 条提及，约 3.1%）。",
        "6. 折叠后尺寸与便携性（Q&A：\"Does it fit within size constraints of a carry-on luggage?\"）。",
        "7. 茎杆灯与轮灯的区别理解（用户易混淆动能轮灯无需电池vs茎杆灯需电池）。",
        "8. 性价比（value for money 23 条提及，约 1.6%）。"
      ],
    positives:       [
        "【适龄性/幼儿适用】约 98% 评论提及（48 条）",
        "【外观颜值】约 100% 评论提及（44 条）",
        "【LED双重灯效】约 85% 评论提及（78 条）",
        "【耐久性】约 82% 评论提及（73 条）",
        "【骑行顺滑度】约 92% 评论提及（25 条）",
        "【易用性】约 93% 评论提及（28 条）",
        "【趣味性】约 100% 评论提及（20 条）",
        "【性价比】约 96% 评论提及（23 条）"
      ],
    negatives:       [
        "【倾斜转向学习曲线】约 0.14% 评论提及（2 条）",
        "【LED轮灯偶发故障】约 0.83% 评论提及（12 条）",
        "【耐久性小问题】约 0.90% 评论提及（13 条）"
      ],
    unmet:       [
        "1. 更直观的转向引导内容：多条评价反映幼儿难以自主学会倾斜转向，需配套视频教程或图解说明书。",
        "2. 茎杆灯与轮灯的清晰区分说明：Q&A中频繁混淆动能轮灯vs电池茎杆灯，两者亟需清晰区分标注。",
        "3. 折叠后精确尺寸数据：Q&A明确询问，官方仅提供未折叠尺寸，折叠后数据完全缺失。",
        "4. 更多男孩IP角色选择：女孩款（Frozen/小美人鱼/公主）更丰富，男孩款仅索尼克/米奇。",
        "5. 备用零件直购渠道：官方无直接备件购买入口，仅引导联系客服。",
        "6. 明确的质保期限说明：规格仅标注\"Limited Warranty\"，无具体期限。"
      ],
    audiences:       [
        "人群分类｜特征",
        "核心年龄｜3-5岁迪士尼IP粉丝；适龄维度98%正面，评价集中于3-5岁",
        "扩展年龄｜6岁及以上；把手可调至31.5英寸，随孩子成长调整",
        "性别｜以女孩为主；Frozen/小美人鱼/公主系列主打女孩，米奇/索尼克面向男孩",
        "骑行经验｜零基础初学者；官方：\"maximum balance as they ride\"",
        "体重上限｜132磅",
        "实际购买者｜父母、祖父母；评价中\"granddaughter / birthday gift / Christmas gift\"高频出现",
        "用户心理｜迪士尼IP粉丝家庭；官方定位：\"perfect first scooter for any budding princess\""
      ],
    scenarios:       [
        "场景｜说明与示例",
        "小区/人行道日常骑行｜规格Rigid（无减震），适合平整路面；评价\"smooth ride\"高频",
        "夏季傍晚/夜间户外骑行｜\"great for summer and night time\"；LED双灯夜间安全可见",
        "生日/圣诞/儿童节礼物开箱｜*\"perfect gift\"*高频；IP外观开箱惊喜感极强",
        "幼儿平衡与协调能力训练｜倾斜转向训练平衡；官方Q&A：\"strengthens their balance while they're having fun\"",
        "迪士尼主题角色扮演游戏｜Elsa甲板+公主配色，融入角色扮演场景",
        "短途代步/社区探索｜官方定位：\"Kid's transportation\"；折叠机制便于存放携带",
        "室内外兼用｜7磅轻量设计，幼儿可自行搬运移动"
      ],
    motives:       [
        "动机｜重要性｜说明",
        "迪士尼IP吸引力（孩子主动想要）｜⭐⭐⭐⭐⭐｜appearance维度100%好评；IP是最大差异化，孩子\"认出Elsa就想要\"",
        "安全稳定（家长首要考量）｜⭐⭐⭐⭐⭐｜三轮三角结构+后轮刹车+防滑踏板；suitability for toddlers 98%正面",
        "LED双重灯效（孩子核心兴奋点）｜⭐⭐⭐⭐⭐｜lighting 78次提及，85%正面；视觉层次超越单一轮灯竞品",
        "亲子互动与户外运动激励｜⭐⭐⭐⭐⭐｜fun维度100%正面；\"she is always asking to go outside\"",
        "礼物赠送的完美性｜⭐⭐⭐⭐｜评价中\"perfect gift\"频繁出现；IP+外观颜值决定开箱体验",
        "性价比与长期使用价值｜⭐⭐⭐⭐｜value for money 96%正面；可调把手支持6-8年成长使用",
        "品牌信任度（Jetson历史）｜⭐⭐⭐｜durability 82%正面；铝合金+动能轮灯技术积累"
      ],
  },
  B0D48BPKRH: {
    captureStatus: "pending",
    alexaReport: {
      title: "顾客评价深度分析",
      asin: "B0D48BPKRH",
      rating: 4.6,
      reviewCount: 1092,
      prompt: rufusVocMeta.prompt,
      overallConclusion: "待在 Alexa for Shopping 对话框提问七问后，按回复原文录入。",
      captureNote: "请在 Amazon App → 商品页 → Alexa for Shopping 对话框提问，将回复截图或原文发回后录入。",
      captureStatus: "pending",
    },
    attention: ["待在 Alexa for Shopping 对话框提问七问后，按回复原文录入。"],
    positives: ["待在 Alexa for Shopping 对话框提问七问后，按回复原文录入。"],
    negatives: ["待在 Alexa for Shopping 对话框提问七问后，按回复原文录入。"],
    unmet: ["待在 Alexa for Shopping 对话框提问七问后，按回复原文录入。"],
    audiences: ["待在 Alexa for Shopping 对话框提问七问后，按回复原文录入。"],
    scenarios: ["待在 Alexa for Shopping 对话框提问七问后，按回复原文录入。"],
    motives: ["待在 Alexa for Shopping 对话框提问七问后，按回复原文录入。"],
  },
  B08Z36X6B4: {
    captureStatus: "pending",
    alexaReport: {
      title: "顾客评价深度分析",
      asin: "B08Z36X6B4",
      rating: 4.7,
      reviewCount: 7433,
      prompt: rufusVocMeta.prompt,
      overallConclusion: "待在 Alexa for Shopping 对话框提问七问后，按回复原文录入。",
      captureNote: "请在 Amazon App → 商品页 → Alexa for Shopping 对话框提问，将回复截图或原文发回后录入。",
      captureStatus: "pending",
    },
    attention: ["待在 Alexa for Shopping 对话框提问七问后，按回复原文录入。"],
    positives: ["待在 Alexa for Shopping 对话框提问七问后，按回复原文录入。"],
    negatives: ["待在 Alexa for Shopping 对话框提问七问后，按回复原文录入。"],
    unmet: ["待在 Alexa for Shopping 对话框提问七问后，按回复原文录入。"],
    audiences: ["待在 Alexa for Shopping 对话框提问七问后，按回复原文录入。"],
    scenarios: ["待在 Alexa for Shopping 对话框提问七问后，按回复原文录入。"],
    motives: ["待在 Alexa for Shopping 对话框提问七问后，按回复原文录入。"],
  },
  B0D77D5WKD: {
    captureStatus: "pending",
    alexaReport: {
      title: "顾客评价深度分析",
      asin: "B0D77D5WKD",
      rating: 4.6,
      reviewCount: 1572,
      prompt: rufusVocMeta.prompt,
      overallConclusion: "待在 Alexa for Shopping 对话框提问七问后，按回复原文录入。",
      captureNote: "请在 Amazon App → 商品页 → Alexa for Shopping 对话框提问，将回复截图或原文发回后录入。",
      captureStatus: "pending",
    },
    attention: ["待在 Alexa for Shopping 对话框提问七问后，按回复原文录入。"],
    positives: ["待在 Alexa for Shopping 对话框提问七问后，按回复原文录入。"],
    negatives: ["待在 Alexa for Shopping 对话框提问七问后，按回复原文录入。"],
    unmet: ["待在 Alexa for Shopping 对话框提问七问后，按回复原文录入。"],
    audiences: ["待在 Alexa for Shopping 对话框提问七问后，按回复原文录入。"],
    scenarios: ["待在 Alexa for Shopping 对话框提问七问后，按回复原文录入。"],
    motives: ["待在 Alexa for Shopping 对话框提问七问后，按回复原文录入。"],
  },
  B0BVFX154J: {
    captureStatus: "pending",
    alexaReport: {
      title: "顾客评价深度分析",
      asin: "B0BVFX154J",
      rating: 4.7,
      reviewCount: 4283,
      prompt: rufusVocMeta.prompt,
      overallConclusion: "待在 Alexa for Shopping 对话框提问七问后，按回复原文录入。",
      captureNote: "请在 Amazon App → 商品页 → Alexa for Shopping 对话框提问，将回复截图或原文发回后录入。",
      captureStatus: "pending",
    },
    attention: ["待在 Alexa for Shopping 对话框提问七问后，按回复原文录入。"],
    positives: ["待在 Alexa for Shopping 对话框提问七问后，按回复原文录入。"],
    negatives: ["待在 Alexa for Shopping 对话框提问七问后，按回复原文录入。"],
    unmet: ["待在 Alexa for Shopping 对话框提问七问后，按回复原文录入。"],
    audiences: ["待在 Alexa for Shopping 对话框提问七问后，按回复原文录入。"],
    scenarios: ["待在 Alexa for Shopping 对话框提问七问后，按回复原文录入。"],
    motives: ["待在 Alexa for Shopping 对话框提问七问后，按回复原文录入。"],
  },
  B09F9B3BCY: {
    captureStatus: "pending",
    alexaReport: {
      title: "顾客评价深度分析",
      asin: "B09F9B3BCY",
      rating: 4.6,
      reviewCount: 3148,
      prompt: rufusVocMeta.prompt,
      overallConclusion: "待在 Alexa for Shopping 对话框提问七问后，按回复原文录入。",
      captureNote: "请在 Amazon App → 商品页 → Alexa for Shopping 对话框提问，将回复截图或原文发回后录入。",
      captureStatus: "pending",
    },
    attention: ["待在 Alexa for Shopping 对话框提问七问后，按回复原文录入。"],
    positives: ["待在 Alexa for Shopping 对话框提问七问后，按回复原文录入。"],
    negatives: ["待在 Alexa for Shopping 对话框提问七问后，按回复原文录入。"],
    unmet: ["待在 Alexa for Shopping 对话框提问七问后，按回复原文录入。"],
    audiences: ["待在 Alexa for Shopping 对话框提问七问后，按回复原文录入。"],
    scenarios: ["待在 Alexa for Shopping 对话框提问七问后，按回复原文录入。"],
    motives: ["待在 Alexa for Shopping 对话框提问七问后，按回复原文录入。"],
  },
  B01NBPHPYF: {
    captureStatus: "pending",
    alexaReport: {
      title: "顾客评价深度分析",
      asin: "B01NBPHPYF",
      rating: 4.6,
      reviewCount: 14754,
      prompt: rufusVocMeta.prompt,
      overallConclusion: "待在 Alexa for Shopping 对话框提问七问后，按回复原文录入。",
      captureNote: "请在 Amazon App → 商品页 → Alexa for Shopping 对话框提问，将回复截图或原文发回后录入。",
      captureStatus: "pending",
    },
    attention: ["待在 Alexa for Shopping 对话框提问七问后，按回复原文录入。"],
    positives: ["待在 Alexa for Shopping 对话框提问七问后，按回复原文录入。"],
    negatives: ["待在 Alexa for Shopping 对话框提问七问后，按回复原文录入。"],
    unmet: ["待在 Alexa for Shopping 对话框提问七问后，按回复原文录入。"],
    audiences: ["待在 Alexa for Shopping 对话框提问七问后，按回复原文录入。"],
    scenarios: ["待在 Alexa for Shopping 对话框提问七问后，按回复原文录入。"],
    motives: ["待在 Alexa for Shopping 对话框提问七问后，按回复原文录入。"],
  },
  B0FSS6C79Z: {
    captureStatus: "pending",
    alexaReport: {
      title: "顾客评价深度分析",
      asin: "B0FSS6C79Z",
      rating: 4.6,
      reviewCount: 268,
      prompt: rufusVocMeta.prompt,
      overallConclusion: "待在 Alexa for Shopping 对话框提问七问后，按回复原文录入。",
      captureNote: "请在 Amazon App → 商品页 → Alexa for Shopping 对话框提问，将回复截图或原文发回后录入。",
      captureStatus: "pending",
    },
    attention: ["待在 Alexa for Shopping 对话框提问七问后，按回复原文录入。"],
    positives: ["待在 Alexa for Shopping 对话框提问七问后，按回复原文录入。"],
    negatives: ["待在 Alexa for Shopping 对话框提问七问后，按回复原文录入。"],
    unmet: ["待在 Alexa for Shopping 对话框提问七问后，按回复原文录入。"],
    audiences: ["待在 Alexa for Shopping 对话框提问七问后，按回复原文录入。"],
    scenarios: ["待在 Alexa for Shopping 对话框提问七问后，按回复原文录入。"],
    motives: ["待在 Alexa for Shopping 对话框提问七问后，按回复原文录入。"],
  },
};

export const rufusVocDimensions: Array<{
  label: string;
  description?: string;
  key: keyof RufusVocRecord;
  verified: boolean;
  formatHint: string;
}> = [
  { label: "顾客关注点", description: "购买时最在意什么、关注哪些方面", key: "attention", verified: true, formatHint: "1–5 编号列表" },
  { label: "好评点", description: "用户满意什么、为什么推荐", key: "positives", verified: true, formatHint: "【分类】+ 提及占比" },
  { label: "差评点", description: "用户抱怨什么、哪里出了问题", key: "negatives", verified: true, formatHint: "【分类】+ 提及占比" },
  { label: "未被满足的需求", description: "用户希望改进什么、缺什么", key: "unmet", verified: true, formatHint: "1–5 编号列表" },
  { label: "使用人群", description: "谁在买、给谁买、什么人群在用", key: "audiences", verified: true, formatHint: "表格式 · 人群分类｜特征" },
  { label: "使用场景", description: "在哪用、什么时候用、怎么用", key: "scenarios", verified: true, formatHint: "表格式 · 场景｜说明" },
  { label: "购买动机", description: "为什么买、什么驱动了购买决策", key: "motives", verified: true, formatHint: "表格式 · 动机｜★★★★★｜说明" },
];

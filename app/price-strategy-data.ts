export type PriceStrategy = {
  anchor: string;
  promotion: string;
  psychology: string;
  evidence: string;
};

export const sellerSpritePriceStrategies: Record<string, PriceStrategy> = {
  "B07VY9Q95Q": {
    anchor: "常用成交价集中在 $54.99，历史售价区间为 $41.40–$74.99，采用多档动态改价。",
    promotion: "卖家精灵返回 22 条固定金额 Coupon 记录，典型折扣约 7%–10%；未返回可核验的 Deal 价格序列。",
    psychology: "用 $54.99 的尾数价降低整数价格感知，再以 $4–$5 金额券制造即时可得的优惠感。",
    evidence: "Keepa 价格轨迹 + Coupon 记录"
  },
  "B0BPXRVWYK": {
    anchor: "长期以 $79.99 作为划线价、$69.99 作为常用售价；当前价格为 $62.98。",
    promotion: "返回 21 条比例 Coupon 记录，折扣主要为 15%–20%，并存在少量 Deal 价格记录。",
    psychology: "高划线价先建立价值锚点，再用两位数百分比折扣强化“省得多”的视觉冲击。",
    evidence: "Keepa 价格轨迹 + Coupon 记录"
  },
  "B07DYG1C9B": {
    anchor: "常用售价为 $55.99，划线价主要为 $69.90，历史售价区间为 $31.99–$69.90。",
    promotion: "卖家精灵未返回 Coupon 记录，仅返回 1 个 Deal 价格点，促销更偏向直接改价。",
    psychology: "通过划线价与实际售价形成可见价差；直接降价减少领券步骤，强调到手价确定性。",
    evidence: "Keepa 价格轨迹；Coupon 暂无数据"
  },
  "B07S64PYMM": {
    anchor: "长期以 $79.98 作为划线价、$69.99 作为常用售价；当前价格为 $62.99。",
    promotion: "返回 283 条比例 Coupon 记录，折扣主要为 5%–6%，并有少量 Deal 价格记录。",
    psychology: "持续保留约 $10 的划线价差，再叠加小额比例券，形成“长期有优惠、现在更划算”的印象。",
    evidence: "Keepa 价格轨迹 + Coupon 记录"
  },
  "B08HJ96QJ9": {
    anchor: "以 $89.99 作为稳定划线价、$75.99 作为常用售价，历史低位约为 $64.59。",
    promotion: "Coupon 以约 5% 比例券为主，同时存在固定金额券；异常极值未纳入策略判断。",
    psychology: "较高划线价强化高配定位，小额券用于降低决策阻力，同时避免长期深折损伤价格形象。",
    evidence: "Keepa 价格轨迹 + Coupon 记录"
  },
  "B08T8RY9VK": {
    anchor: "划线价主要为 $89.99，常用售价约 $69.99；历史售价在 $57.96–$80.00 之间切换。",
    promotion: "返回金额券与比例券两种记录，典型折扣约 6%–19%，并有较多 Deal 价格点。",
    psychology: "高划线价建立品质锚点，灵活券型和阶段性 Deal 制造稀缺感，适合节点促销拉动转化。",
    evidence: "Keepa 价格轨迹 + Coupon 记录"
  }
};

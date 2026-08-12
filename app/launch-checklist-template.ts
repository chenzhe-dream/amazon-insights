export type ComplianceCategoryRow = {
  vertical: string;
  label: string;
  risks: string;
  compliance: string;
  confirmAtLaunch: string;
};

export const complianceCategoryMatrix: ComplianceCategoryRow[] = [
  {
    vertical: "outdoor",
    label: "户外运动",
    risks: "承重、稳定性、跌落、夹伤、锐边、刹车、耐候性",
    compliance: "儿童用品要求、运动防护用品、机械安全、电池/无线要求",
    confirmAtLaunch: "适用年龄、最大承重、动态测试、警告标签、使用环境",
  },
  {
    vertical: "toys",
    label: "玩具",
    risks: "小零件、铅/重金属、邻苯、磁铁、绳带、声响、电池仓",
    compliance: "美国 ASTM F963/CPSIA/CPC；欧盟玩具法规、EN 71 及 CE 等目标站点要求",
    confirmAtLaunch: "年龄分级、适用条款、第三方实验室、追踪标签",
  },
  {
    vertical: "lighting",
    label: "灯具",
    risks: "触电、过热、防火、结构稳定、光生物、户外防水",
    compliance: "电气安全、EMC/FCC、能效、无线、锂电池运输、IP 防护等级",
    confirmAtLaunch: "输入电压、插头、光源/驱动、无线模块、电池、室内/户外",
  },
  {
    vertical: "furniture",
    label: "家具",
    risks: "倾倒、承重、夹伤、结构强度、玻璃、板材释放物",
    compliance: "复合木板甲醛要求；特定储衣家具防倾倒标准；儿童家具要求",
    confirmAtLaunch: "静载/动载、防倾倒、板材证明、安装说明、墙体固定件",
  },
  {
    vertical: "home",
    label: "家居",
    risks: "材料安全、接触场景、阻燃、夹伤、承重",
    compliance: "食品接触、纺织品、儿童用品、电器或化学品要求按功能触发",
    confirmAtLaunch: "使用对象、材料、接触食品/皮肤情况、是否带电或带香料/液体",
  },
  {
    vertical: "water_sports",
    label: "水上运动",
    risks: "溺水、浮力、气密性、阀门、绳带、承重、翻覆",
    compliance: "救生衣/浮力辅助用品审批；充气水上用品、儿童水上用品要求",
    confirmAtLaunch: "是否宣称救生/浮力保护、适用体重、浮力、漏气、警告标签",
  },
  {
    vertical: "garden",
    label: "园艺",
    risks: "锐边、夹伤、承重、耐候、腐蚀、电气、化学品",
    compliance: "户外电器、无线/电池、农药或驱虫宣称、化学品及材料要求",
    confirmAtLaunch: "是否带电、是否接触土壤/水、是否宣称杀虫/驱虫/抑菌、户外寿命",
  },
];

export const launchChecklistVersion = "V1.0";

/** 公司立项线：基准情景平台毛利润率不得低于该值 */
export const companyLaunchMarginThresholdPct = 15;

export const vetoItems = [
  "核心专利高风险，且无规避方案或专业意见支持",
  "合规路径、测试标准或上架资料不明确",
  `基准售价下平台毛利润率低于公司立项线（${companyLaunchMarginThresholdPct}%），且无明确降本方案`,
  "按保守月销量测算，单 SKU MPQ 库存周期超过 3 个月",
  "产品没有明确需求证据或有效差异化，只能依靠低价竞争",
  "关键质量问题未关闭，或供应商无法稳定量产",
  "季节性产品无法在旺季前完成认证、生产、运输和上架",
  "首单资金占用超过产品线预算或现金流承受范围",
];

export const scoreDimensions = [
  { id: "market", label: "市场容量与趋势", weight: 15 },
  { id: "voc", label: "VOC 需求与差异化", weight: 15 },
  { id: "patent", label: "专利风险", weight: 15 },
  { id: "compliance", label: "合规与安全", weight: 15 },
  { id: "margin", label: "售价及利润空间", weight: 15 },
  { id: "mpq", label: "MPQ 与销量匹配", weight: 10 },
  { id: "supply", label: "供应链与质量", weight: 10 },
  { id: "logistics", label: "物流及库存风险", weight: 5 },
];

export const approvalRoles = [
  { role: "产品开发", scope: "市场、VOC、差异化、专利初筛" },
  { role: "运营", scope: "售价、销量、推广、季节性" },
  { role: "品质/合规", scope: "测试、认证、安全、质量标准" },
  { role: "采购/供应链", scope: "MPQ、成本、交期、产能" },
  { role: "物流", scope: "包装、头程、FBA 费用、运输限制" },
  { role: "财务/经管", scope: "平台毛利、现金占用、风险情景" },
  { role: "最终审批人", scope: "综合立项决策" },
];

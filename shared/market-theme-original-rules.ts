import { translateReviewReason } from '../scripts/lib/review-label-zh.mjs';

export function isOriginalThemeFlow(planner: string): boolean {
  return planner === 'market-theme-flow/rules-v3';
}

/** Original positive / negative-or-disputed tabs classify the totals, not reviews. */
export function themeMatchesSentiment(totals: { positive: number; negative: number }, tab: 'positive' | 'negative', original: boolean): boolean {
  if (!original) return totals[tab] > 0;
  const positive = totals.positive > totals.negative * 1.2;
  return tab === 'positive' ? positive : !positive;
}

// Exact entries from the 2026-09-14 reference scripts/lib/review-label-zh.mjs.
// Do not use its substring guesses (for example, "storage" contains "age").
// This dictionary localizes presentation only; grouping retains internal spaces.
const labels: Record<string, string> = {
  daughter: '女儿', son: '儿子', granddaughter: '孙女/外孙女', grandson: '孙子/外孙', niece: '侄女/外甥女', nephew: '侄子/外甥',
  birthday: '生日相关', christmas: '圣诞相关', park: '公园/户外', 'ride scooter': '骑行使用', 'assemble scooter': '组装使用',
  'outdoor play': '户外玩耍', 'childhood development': '平衡/发育训练', 'first scooter': '第一辆滑板车', 'birthday gift': '生日礼物',
  'christmas gift': '圣诞礼物', 'indoor use': '室内使用', 'durable brake': '刹车耐用性', 'stronger handlebar': '手把强度',
  'improved hardware': '硬件升级', 'better quality control': '品控改进', 'flatter foot plate': '脚踏板高度', 'light up wheels': '发光轮',
  'adjustable handlebar': '可调手把', 'sturdy construction': '结构稳固', 'easy assembly': '安装便捷', 'bright colors': '外观配色',
  'smooth ride': '骑行顺滑', 'broken brake': '刹车损坏', 'handlebar breaking': '手把断裂', 'poor quality control': '品控问题',
  'plastic components': '塑料部件', 'short lifespan': '使用寿命短', 'wheel failure': '轮子故障', 'steering difficulty': '转向困难',
  'gift purchase': '礼物购买', "child's interest": '孩子喜欢', 'affordable price': '性价比', 'light-up feature': '发光功能',
  adjustability: '可调节性', 'stability for beginners': '新手稳定性', quality: '产品质量', assembly: '安装便捷', sturdiness: '结构稳固',
  durability: '耐用性', turnability: '转向灵活性', lighting: '照明效果', shadecolor: '灯罩颜色', brightness: '亮度',
  colortemperature: '色温', chargingcapability: '充电能力', lightweight: '轻便', reliability: '可靠性', storage: '收纳空间',
  wobble: '晃动不稳', wheels: '轮子表现', gift: '礼物属性', appearance: '外观颜值', stability: '稳定性', functionality: '功能表现',
  maneuverability: '操控灵活性', suitability: '适用性', 'suitability for toddlers': '幼儿适用性', 'age appropriate': '适龄性',
  'ease of assembly': '安装便捷', 'value for money': '性价比', enjoyment: '使用乐趣', 'suitability for kids': '儿童适用性',
  'ease of use': '使用便捷', 'build quality': '做工品质', 'floor switch': '脚踏开关', 'lighting performance': '照明表现', 'room lighting': '房间照明',
};

export function localizeThemeLabel(keyword: string): string {
  const key = keyword.trim().replace(/[\s_/]+/g, ' ').toLowerCase();
  return Object.hasOwn(labels, key) ? labels[key] : keyword;
}

export function localizeThemeSnippet(keyword: string, content: string): string {
  // Reuse the original pure phrase rules only when they cover the source wording.
  // Unknown or partially translated text, including unhandled negation, stays raw.
  const family = /\b(?:kick )?scooter\b|滑板车/i.test(content) ? 'scooter' : 'generic';
  const translated = translateReviewReason(keyword, content, family);
  return translated && !/[a-zA-Z]/.test(translated) ? translated : content;
}

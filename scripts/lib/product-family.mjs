/** 从标题/类目/卖点识别产品族。未知类目必须回落 generic，禁止默认滑板车。 */

export function detectProductFamily({ title = "", category = "", features = [] } = {}) {
  const text = [title, category, ...(Array.isArray(features) ? features : [])].join(" ").toLowerCase();
  if (/scooter|kick\s*scooter|滑板车/.test(text)) return "scooter";
  if (
    /\bfloor lamps?\b|\bshelf lamps?\b|\btable lamps?\b|\bstanding lamps?\b|\blighting\b|落地灯|台灯|置物架灯/.test(text) ||
    (/\blamps?\b|\blampshade\b|\bbulbs?\b/.test(text) && !/wheel|scooter|deck/.test(text))
  ) {
    return "lighting";
  }
  return "generic";
}

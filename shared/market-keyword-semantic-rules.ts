import type {KeywordCategory} from '../app/keyword-meaning-taxonomy';
export const SCENE_PATTERNS = [
  { label: "客厅", pattern: /\b(?:living room|wohnzimmer|salon|soggiorno|sala)\b/i },
  { label: "卧室", pattern: /\b(?:bedroom|bed room|schlafzimmer|chambre|dormitorio|camera da letto)\b/i },
  { label: "办公室", pattern: /\b(?:office|büro|bureau|ufficio|oficina)\b/i },
  { label: "角落", pattern: /\b(?:corner|ecke|coin|angolo|esquina)\b/i },
  { label: "户外", pattern: /\b(?:outdoor|patio|garden|garten|jardin|giardino|jardín)\b/i },
  { label: "厨房", pattern: /\b(?:kitchen|küche|cuisine|cucina|cocina)\b/i },
  { label: "收纳空间", pattern: /\b(?:closet|wardrobe|schrank|placard|armadio|armario)\b/i },
  { label: "泳池", pattern: /\b(?:pool|schwimmbad|piscine|piscina)\b/i },
] as const;

const BRAND_W2_FALSE_POSITIVE = /\bhi[\s-]?boy\b/i;

export function detectW2Label(keyword: string, category: KeywordCategory): string | null {
  if (category === "brand_competitor") return null;
  const text = keyword.toLowerCase();
  if (BRAND_W2_FALSE_POSITIVE.test(text)) return null;

  const forMatch = text.match(
    /\bfor\s+(kids?|children|child|adults?|adult|teens?|teenagers?|toddlers?|babies|baby|infants?|seniors?|senior|elderly|beginners?|beginner|boys?|girls?|men|women)\b/i,
  );
  if (forMatch) {
    const token = forMatch[1].toLowerCase();
    if (/^(kids?|children|child|toddlers?|babies|baby|infants?)$/.test(token)) return "儿童";
    if (/^(teens?|teenagers?)$/.test(token)) return "青少年";
    if (/^(adults?|adult|erwachsene)$/.test(token)) return "成人";
    if (/^(seniors?|senior|elderly|senioren)$/.test(token)) return "老人";
    if (/^(beginners?|beginner)$/.test(token)) return "初学者";
    if (/^(boys?|men)$/.test(token)) return "男性";
    if (/^(girls?|women)$/.test(token)) return "女性";
  }

  // Bare ranges describe capacity, dimensions or price just as often as age.
  const age = text.match(/(?:\bages?\s*|\balter\s*)(\d+)(?:\s*[-–]\s*(\d+))?\b|\b(\d+)(?:\s*[-–]\s*(\d+))?\s*(?:years? old|jahr(?:e|en)? alt|歳)\b/i);
  if (age) {
    const low=Number(age[1]??age[3]), high=Number(age[2]??age[4]??low);
    if (high < low) return null;
    if (low >= 65) return "老人";
    if (low >= 18) return "成人";
    if (low >= 13 && high < 18) return "青少年";
    if (high < 13) return "儿童";
    return "跨年龄段";
  }


  if (/\b(teens?|teenagers?)\b/.test(text)) return "青少年";
  if (/\b(kids?|children|child|toddlers?|baby|babies|infants?|kinder|niños?|niñas?|ninos?|ninas?)\b/.test(text)) return "儿童";
  if (/\b(adults?|adult|erwachsene)\b/.test(text)) return "成人";
  if (/\b(seniors?|senior|elderly|senioren)\b/.test(text)) return "老人";
  if (/\b(beginners?|beginner)\b/.test(text)) return "初学者";
  if (/\b(women|woman)\b/.test(text) || /\bfor girls?\b/.test(text)) return "女性";
  if (/\bfor boys?\b/.test(text) || (/\b(men|man)\b/.test(text) && !/\b(women|woman)\b/.test(text))) return "男性";

  if (category === "audience") return "其他人群";

  return null;
}

export const W4_FAMILIES = [
 {label:"LED/光源",pattern:/\b(?:led|light[ -]?up|bulbs?)\b/i},
 {label:"调光",pattern:/\b(?:dimmable|dimmer|brightness|touch control|dimmbar|regulable|dimmable|regolabile)\b/i},
 {label:"现代风格",pattern:/\b(?:modern|contemporary|minimalist|mid century|moderne|moderno)\b/i},
 {label:"尺寸结构",pattern:/\b(?:tall|small|large|skinny|arc|tripod|corner|slim|compact|mini|kompakt|klein|groß)\b/i},
 {label:"材质",pattern:/\b(?:wood|wooden|metal|brass|glass|fabric|rattan|bamboo|marble|plastic|holz|metall|glas|kunststoff)\b/i},
 {label:"智能控制",pattern:/\b(?:smart|wi[ -]?fi|bluetooth|app[ -]?(?:control(?:led)?|enabled)|remote control|alexa|fernbedienung|télécommande|telecomando|control remoto)\b/i},
 {label:"便携/折叠",pattern:/\b(?:portable|foldable|folding|collapsible|travel|faltbar|klappbar|pliable|pieghevole|plegable)\b/i},
 {label:"可调节",pattern:/\b(?:adjustable|verstellbar|ajustable|regolabile)\b/i},
 {label:"堆叠",pattern:/\b(?:stackable|stapelbar|empilable|impilabile|apilable)\b/i},
] as const;

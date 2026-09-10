/** 非英语系关键词识别与英译，用于避免误归入「泛需求词」 */

const NON_LATIN_SCRIPTS = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\u0400-\u04ff\u0600-\u06ff]/;

const ACCENTED_LATIN = /[àáâãäåæçèéêëìíîïñòóôõöùúûüýÿœß]/i;

/** 短语优先（长匹配在前） */
const PHRASE_TRANSLATIONS: Array<[RegExp, string]> = [
  [/patinetas para niñas/gi, "scooters for girls"],
  [/patinetas para niños/gi, "scooters for kids"],
  [/monopatines para niños/gi, "scooters for kids"],
  [/monopatín para niños/gi, "scooter for kids"],
  [/monopatin para ninos/gi, "scooter for kids"],
  [/patines para niños/gi, "skates for kids"],
  [/moto para niños de (\d+)\s*años?\s*o\s*m[aá]s/gi, "motorcycle for kids age $1 years or more"],
  [/moto para niños de (\d+)\s*años?/gi, "motorcycle for kids age $1 years"],
  [/para niños de (\d+)\s*a (\d+)\s*años?/gi, "for kids age $1 to $2 years"],
  [/para niños de (\d+)\s*años?/gi, "for kids age $1 years"],
  [/para niñas de (\d+)\s*años?/gi, "for girls age $1 years"],
  [/para niños/gi, "for kids"],
  [/para niñas/gi, "for girls"],
  [/para ninos/gi, "for kids"],
  [/para ninas/gi, "for girls"],
  [/scooter para niños/gi, "scooter for kids"],
  [/lampara de pie/gi, "floor lamp"],
  [/lámpara de pie/gi, "floor lamp"],
  [/lampe sur pied/gi, "floor lamp"],
  [/lampada da terra/gi, "floor lamp"],
  [/stehlampe/gi, "floor lamp"],
  [/trotinette enfant/gi, "kids scooter"],
  [/trottinette enfant/gi, "kids scooter"],
  [/kinderscooter/gi, "kids scooter"],
  [/kinder scooter/gi, "kids scooter"],
  [/roller für kinder/gi, "scooter for kids"],
  [/patinete para crianças/gi, "scooter for kids"],
  [/patinete para criancas/gi, "scooter for kids"],
];

const WORD_TRANSLATIONS: Record<string, string> = {
  patinetas: "scooters",
  patineta: "scooter",
  patinete: "scooter",
  patinetes: "scooters",
  monopatines: "scooters",
  monopatín: "scooter",
  monopatin: "scooter",
  patines: "skates",
  patin: "skate",
  niños: "kids",
  ninos: "kids",
  niñas: "girls",
  ninas: "girls",
  nino: "kid",
  nina: "girl",
  años: "years",
  anos: "years",
  ano: "year",
  edad: "age",
  para: "for",
  con: "with",
  de: "of",
  y: "and",
  juguetes: "toys",
  juguete: "toy",
  lámpara: "lamp",
  lampara: "lamp",
  lampe: "lamp",
  lampada: "lamp",
  stehlampe: "floor lamp",
  tischlampe: "desk lamp",
  kinder: "kids",
  kind: "kid",
  mädchen: "girls",
  maedchen: "girls",
  jungen: "boys",
  enfants: "kids",
  enfant: "kid",
  filles: "girls",
  fille: "girl",
  garçons: "boys",
  garcons: "boys",
  pour: "for",
  avec: "with",
  und: "and",
  mit: "with",
  für: "for",
  fur: "for",
  imfre: "for",
  crianças: "kids",
  criancas: "kids",
  criança: "kid",
  crianca: "kid",
  meninas: "girls",
  menina: "girl",
  meninos: "boys",
  menino: "boy",
  kinderscooter: "kids scooter",
  kinderscooters: "kids scooters",
  trottinette: "scooter",
  monopattino: "scooter",
  exterior: "outdoor",
  interior: "indoor",
  plegable: "foldable",
  recargable: "rechargeable",
  ajustable: "adjustable",
  impermeable: "waterproof",
  ligero: "lightweight",
  ligera: "lightweight",
};

const NON_ENGLISH_TOKEN =
  /\b(para|niños|niñas|ninos|ninas|años|anos|patinet|monopat|patines|juguetes|lampara|lámpara|lampe|lampada|stehlampe|kinder|enfants|pour|für|fur|trotinette|trottinette|plegable|recargable|ajustable|exterior|interior|crianç|crianc|menin)\b/i;

const ENGLISH_DOMINANT =
  /\b(for|with|the|and|scooter|scooters|kids|kid|boys|girls|lamp|light|toy|toys|wheel|foldable|outdoor|indoor|age|years|year|old)\b/i;

export function isNonEnglishKeyword(keyword: string) {
  const text = keyword.trim();
  if (!text) return false;

  if (NON_LATIN_SCRIPTS.test(text)) return true;
  if (ACCENTED_LATIN.test(text)) return true;
  if (NON_ENGLISH_TOKEN.test(text)) return true;

  const tokens = text.toLowerCase().split(/[\s/+\-_]+/).filter(Boolean);
  if (!tokens.length) return false;

  let nonEnglishHits = 0;
  let englishHits = 0;
  for (const token of tokens) {
    if (WORD_TRANSLATIONS[token]) nonEnglishHits += 1;
    if (ENGLISH_DOMINANT.test(token)) englishHits += 1;
  }

  if (nonEnglishHits >= 2 && englishHits === 0) return true;
  if (nonEnglishHits >= 1 && englishHits === 0 && tokens.length <= 4) return true;

  return false;
}

export function translateKeywordToEnglish(keyword: string) {
  let text = keyword.trim().toLowerCase();
  if (!text) return text;

  for (const [pattern, replacement] of PHRASE_TRANSLATIONS) {
    text = text.replace(pattern, replacement);
  }

  const tokens = text.split(/(\s+|[-_/]+)/);
  const translated = tokens.map(token => {
    if (!token || /^\s+$/.test(token) || /^[-_/]+$/.test(token)) return token;
    const lower = token.toLowerCase();
    return WORD_TRANSLATIONS[lower] ?? token;
  });

  return translated
    .join("")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.!?])/g, "$1")
    .trim();
}

export function maybeTranslateForClassification(keyword: string) {
  if (!isNonEnglishKeyword(keyword)) {
    return { translated: keyword.trim().toLowerCase(), usedTranslation: false };
  }
  const translated = translateKeywordToEnglish(keyword);
  const changed = translated !== keyword.trim().toLowerCase();
  return { translated: changed ? translated : keyword.trim().toLowerCase(), usedTranslation: changed };
}

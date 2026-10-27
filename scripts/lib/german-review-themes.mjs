// Bounded German evidence rules. A star rating alone never supplies a theme.
const negation = /\b(?:nicht(?!\s+nur\b)|kein\w*|nie|kaum|ohne)\b/i;
const rules = {
  consumerProfile: [
    ['儿童使用', /\bKinder(?:n)?\b/i],
  ],
  scenarios: [
    ['协调能力训练', /(?:Koordination|Geschicklichkeit).{0,35}verbessern|motorische\s+Fähigkeiten.{0,35}gestärkt/iu],
  ],
  positives: [
    ['安装便捷', /(?:gut|leicht|einfach)\s+(?:an)?zu(?:bringen|bauen)|Anbringen\s+war\s+(?:leicht|einfach)|Aufbau[^.!?]{0,45}(?:schnell|unkompliziert|einfach)/iu],
    ['做工与质量', /(?:gut\w*|super|hervorragend\w*)\s+(?:Qualität|Verarbeitung)|Qualität\s+der\s+Materialien\s+ist\s+gut/iu],
    ['固定牢靠', /\bhält\s+gut\b/iu],
    ['使用乐趣', /(?:viel\s+Freude|Spaßfaktor.{0,20}hoch|Spaß\s+garantiert)/iu],
    ['可调节性', /(?:individuell\s+einstellbare\s+Schwierigkeit|sehr\s+variabel)/iu],
  ],
  negatives: [
    ['结构不稳', /\bnicht\s+(?:sehr\s+)?stabil\b|\binstabil\b/iu],
  ],
  unmet: [
    ['备用配件需求', /(?:Befestigungs?klemmen|Ersatzteile)[^.!?]{0,60}(?:wären|wäre|wünsche|brauche)[^.!?]{0,35}(?:Vorrat|mehr|gut)/iu],
  ],
};

export function germanReviewMatches(text, key, bucket) {
  if (key === 'positives' && bucket !== 'positive') return [];
  const clauses = text.split(/[.!?;]+|,\s*(?:aber|jedoch)\s+/iu).map(s=>s.trim()).filter(Boolean);
  const matches = [];
  for (const [label, pattern] of rules[key] ?? []) {
    const evidence = clauses.find(clause => pattern.test(clause) &&
      (key === 'negatives' || !negation.test(clause)));
    if (evidence) matches.push({label, reason:`评论原文：${evidence.slice(0,200)}`});
  }
  return matches;
}

export function isGermanGenericPraise(text) {
  return /^[\s!.,]*super[\s!.,]*$/iu.test(text);
}

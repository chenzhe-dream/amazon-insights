/** Bounded, source-preserving interpretation of recorded VOC audiences/scenarios.
 * These observations do not establish hardware, certification or universal suitability. */
export type ApplicabilityStatus = "reported" | "conditional" | "restricted" | "unknown" | "conflict";
export type ApplicabilityObservation = { id: string; asin: string; text: string; subject: string; status: ApplicabilityStatus };
export type ApplicabilityProjection = { conclusion: string; summary: string; ruleDecisionIds: string[] };

const HEADER = /^(?:人群分类|人群|使用人群|场景|使用场景)\s*[｜|]\s*(?:特征|说明(?:与示例)?|描述|占比)$/u;
const RESTRICTED = /不适合|不适用|不推荐|不建议|禁止|不能(?:使用|用于)|不可(?:使用|用于)|不宜|避免(?:使用|用于)|不应使用|无法使用|\b(?:not (?:suitable|recommended|for)|unsuitable|avoid using|do not use|must not use|cannot use)\b/iu;
const UNKNOWN = /暂无|未知|待核对|待验证|无法确认|资料不足|未提供|尚未|\b(?:unknown|unverified|not specified)\b/iu;
const CONDITIONAL = /仅限|仅在|只有|需(?:要|在|有|由|成|具|遵)|必须|有.*(?:设计|监护)|条件|前提|可接受|可能|但|备选|建议|\b(?:only|if|when|provided|requires?|supervision|may|but)\b/iu;
const PREFIX = /^(?:最佳用户|主要用户|扩展用户|可接受用户|不适合用户|不推荐用户|最优场景|可接受场景|不适合场景|不推荐|不适合|最优|可接受|最佳|主要|扩展)[，,:：\s]*/u;
const POSITIVE = /(?<!不)(?:适合|适用)|最优|最佳|可使用|\b(?:suitable|recommended)\b/iu;
const CONDITIONAL_EXCLUSION = /不(?:适合|适用|推荐|建议).*(?:无.{0,12}设计|缺少|未满足|不具备)|\b(?:without|unless)\b/iu;

export function parseApplicabilityObservation(source: {id:string;asin:string;text:string}): ApplicabilityObservation | null {
  const text=source.text.trim();
  if(!text || HEADER.test(text)) return null;
  const bracket=text.match(/^【([^】]+)】(.*)$/u);
  const parts=bracket ? [bracket[1],bracket[2]] : text.split(/[｜|]/u);
  const left=parts[0].trim();
  const subject=(left.replace(PREFIX,"").trim() || parts.slice(1).join("｜").trim() || left)
    .replace(/[（(].*$/u,"").replace(/\s+/gu,"").toLowerCase();
  // A full row can describe both a usable context and an excluded context.
  // Preserve that whole qualified statement rather than deleting the usable part.
  const clauses=parts.slice(1).join("｜").split(/[，,;；。]/u);
  const mixed=!RESTRICTED.test(left) && clauses.some(clause=>!RESTRICTED.test(clause) && POSITIVE.test(clause)) && clauses.some(clause=>RESTRICTED.test(clause));
  const status:ApplicabilityStatus=UNKNOWN.test(text) ? "unknown" : mixed ? "conditional" : RESTRICTED.test(text) ? "restricted" : CONDITIONAL.test(text) ? "conditional" : "reported";
  return {...source,text,subject,status};
}

/** Only compare observations from the same product. Never vote away opposing evidence. */
export function markApplicabilityConflicts(rows: ApplicabilityObservation[]): ApplicabilityObservation[] {
  return rows.map(row=> {
    const conflict=row.subject && rows.some(other=>other.asin===row.asin && other.subject===row.subject &&
      ((row.status==="restricted" && !CONDITIONAL_EXCLUSION.test(row.text) && ["reported","conditional"].includes(other.status)) ||
       (other.status==="restricted" && !CONDITIONAL_EXCLUSION.test(other.text) && ["reported","conditional"].includes(row.status))));
    return conflict ? {...row,status:"conflict"} : row;
  });
}

const STATUS_LABELS:Record<ApplicabilityStatus,string>={reported:"VOC记录",conditional:"附条件记录",restricted:"限制记录",unknown:"待核对",conflict:"同一 ASIN 来源冲突，待核对"};
export function renderApplicability(rows: ApplicabilityObservation[], asins: string[], dimension:"audiences"|"scenarios"): Omit<ApplicabilityProjection,"ruleDecisionIds"> {
  const label=dimension==="audiences" ? "人群" : "场景";
  const ordered=[...new Set(asins)].sort();
  const scoped=(asin:string,text:string)=>ordered.length>1 ? `【${asin}】${text}` : text;
  const conclusion=ordered.map(asin=> {
    const own=rows.filter(row=>row.asin===asin);
    return scoped(asin,own.length ? own.map(row=>`${STATUS_LABELS[row.status]}：${row.text}`).join("；") : `${label}待核对：暂无当前 ASIN 的可用记录`);
  }).join("；");
  const summary=ordered.map(asin=> {
    const own=rows.filter(row=>row.asin===asin);
    const positive=own.filter(row=>row.status==="reported" || row.status==="conditional");
    // Retain a complete source row, including its conditions. Never truncate by character count.
    const selected=positive.slice(0,1);
    const text=selected.length ? selected.map(row=>`${STATUS_LABELS[row.status]}：${row.text}`).join("；") : `${label}待核对（现有记录未形成可用的正向范围）`;
    return scoped(asin,`${text}${own.length>selected.length ? `；其余${label}记录及限制见对应表格` : ""}`);
  }).join("；");
  return {conclusion,summary};
}

export function applicabilityRuleFingerprint(): string {
  return JSON.stringify({header:HEADER.source,restricted:RESTRICTED.source,unknown:UNKNOWN.source,conditional:CONDITIONAL.source,prefix:PREFIX.source,positive:POSITIVE.source,conditionalExclusion:CONDITIONAL_EXCLUSION.source,labels:STATUS_LABELS,parse:parseApplicabilityObservation.toString(),conflicts:markApplicabilityConflicts.toString(),render:renderApplicability.toString()});
}

/** Pure, bounded product-structure rules. No app, database, or browser dependencies. */
import { applicabilityRuleFingerprint, parseApplicabilityObservation } from './voc-applicability';

export const RULE_SET_VERSION = 'product-structure/1.1.3';
export type StructureState = 'supported' | 'absent' | 'unknown';
export interface AnalysisInputScope { organizationId: string; projectId: string; marketplace: string; asins: string[]; inputRevision: string }
export interface EvidenceSource {
  id: string; text: string; kind: 'title' | 'category' | 'attribute' | 'voc' | 'keyword';
  scope: 'asin' | 'project'; asin?: string; availableAt?: string; location?: string;
  role?: 'fact' | 'need'; attributes?: Record<string, Exclude<StructureState, 'unknown'>>;
  inputScope?: AnalysisInputScope;
}
export interface ProductContextInput { scope: AnalysisInputScope; asin: string; title: string; aliases?: string[]; category?: string; features?: string[]; evidence?: EvidenceSource[] }
export interface StructuralAttribute { state: StructureState; evidenceRefs: string[] }
export interface ProductContext {
  inputScope: AnalysisInputScope; asin: string; title: string; aliases: string[]; category?: string;
  attributes: Record<string, StructuralAttribute>; conflicts: Array<{ attribute: string; evidenceRefs: string[] }>;
  evidence: EvidenceSource[]; needs: EvidenceSource[];
}
export interface StructureCondition { attribute: string; state?: Exclude<StructureState, 'unknown'> }
export interface RuleCandidate {
  id: string; asin: string; kind: 'fact' | 'proposal'; text: string;
  evidenceRefs?: string[]; needEvidenceRefs?: string[]; conditions?: StructureCondition[];
  claim?: StructureCondition; validation?: string[]; addsAttributes?: string[];
  proposalPurpose?: 'verify_audience';
  /** Quotes what a scoped VOC dimension records; never establishes a structural claim. */
  sourceObservation?: 'audiences' | 'scenarios';
}
export type PredicateOperator = 'scope' | 'names' | 'conflicts' | 'audience' | 'fact' | 'need' | 'structure' | 'validation' | 'specification' | 'local' | 'grouping' | 'definition' | 'trace' | 'source_scope';
export interface RulePredicate { op: PredicateOperator; attribute?: string; state?: Exclude<StructureState, 'unknown'> }
export interface RuleDefinition {
  id: string; version: string; flowNode: string; name: string; purpose: string; conditions: RulePredicate[];
  exclusions: string[]; missingPolicy: string; conflictPolicy: string; positiveExample: string; negativeExample: string;
}
export interface DecisionRecord {
  candidateId: string; asin: string; kind: 'fact' | 'proposal'; text: string;
  outcome: 'supported' | 'rejected' | 'needs_check'; reasonCode: string; summary: string; checks: string[];
  ruleSetVersion: string; ruleIds: string[]; ruleVersions: Record<string, string>;
  inputScope: AnalysisInputScope; evidenceRefs: string[];
  matchedConditions: Array<{ predicate: RulePredicate; description: string; passed: boolean | null }>;
}
export interface AnalysisRuleTrace { ruleSetVersion: string; ruleDefinitions: RuleDefinition[]; inputScope: AnalysisInputScope; decisions: DecisionRecord[]; sources: EvidenceSource[]; contexts?: ProductContext[] }

const PREDICATE_LABELS: Record<PredicateOperator, string> = {
  scope: '候选及来源属于当前组织、项目、站点和所选 ASIN', names: '保留商品原名与别名，不以泛称推定硬件',
  conflicts: '依赖的结构属性没有相互矛盾的来源', audience: '搜索人群只作需求，不作为硬件或适龄事实',
  fact: '完整事实内容及肯定、否定语义均有当前 ASIN 依据，单个结构词不能支持附带功能', need: '开发建议有与该动作相关的具体问题或期待效果，不能用无关反馈支持硬件改动',
  structure: '开发建议满足所依赖的结构条件', validation: '开发建议注明需要验证的事项',
  specification: '明确数值规格必须来自引用依据，不凭空填写尺寸、年龄或标准',
  local: '仅对本条候选作判断，其他结论独立处理', grouping: '逐个 ASIN 判断后按相容结构分组，未知形态单列',
  definition: '规则定义与执行条件使用同一版本和中文说明', trace: '保存实际执行版本及相关规则快照',
  source_scope: '来源归属与当前分析范围一致；访问授权由原项目接口检查',
};
export function describeRulePredicate(predicate: RulePredicate): string {
  const label = PREDICATE_LABELS[predicate.op];
  if (!label) throw new Error(`Unsupported rule predicate: ${predicate.op}`);
  return predicate.attribute ? `${label}：${attributeLabel(predicate.attribute)}${predicate.state === 'absent' ? '明确不具备' : '有证据支持'}` : label;
}
function definition(id: string, flowNode: string, name: string, purpose: string, ops: PredicateOperator[], positiveExample: string, negativeExample: string): RuleDefinition {
  return { id, version: RULE_SET_VERSION, flowNode, name, purpose, conditions: ops.map((op) => ({ op })), exclusions: ['跨 ASIN、跨范围或缺乏相关依据的确定性结论不采用'], missingPolicy: '只列出本条缺失条件，保留其他有依据的动作', conflictPolicy: '保留双方来源，并将依赖冲突属性的结论列为需核对', positiveExample, negativeExample };
}
export const RULE_DEFINITIONS: RuleDefinition[] = [
  definition('R01', '01', '分析范围与来源隔离', '避免其他项目或商品的事实污染当前判断', ['scope'], '同一 ASIN 在美国站仅采用美国站资料', '借用其他项目的三轮资料'),
  definition('R02', '02', '原名与结构分离', '名称提供上下文，明确结构短语的单复数均可成为证据，不扩展为类目推断', ['names'], '保留原始标题，Snow Sled 与 Snow Sleds 均记录雪地结构依据', '看到 Snow Scooter 或类目 Snow Sleds 就认为有轮或已确认雪地结构'),
  definition('R03', '03A', '结构三态与独立冲突', '明确区分有依据、明确没有和未知，同一句中的矛盾也保留', ['conflicts'], '三轮和两轮并列时保留冲突，核对实际结构', '同句无轮与三轮只选择后一个断言'),
  definition('R04', '03B', '人群需求与适用事实分离', '人群与场景逐 ASIN 保留否定和适用条件；限制不进入正向摘要，搜索词仅作需求线索', ['audience'], '不推荐低幼和仅适用于压实雪面按原 ASIN 保留为限制，toddler 搜索词保留为需求线索', '由限制中的低幼或深雪词生成正向人群与场景定位'),
  definition('R05', '05A', '现有事实需要证据', '当前依据须覆盖完整内容与否定语义；明确结构的单复数等价，复合事实不能只检查一个结构词', ['fact'], 'Snow Sled 标题可支持 snow sleds 结构事实，No snow sleds 保留否定依据', '仅凭两轮标题声称该两轮产品已配蓝牙音响'),
  definition('R06', '05B', '建议需要需求与适用条件', '需求须与动作相关，无结构条件仍须核对具体需求；前后轮属于轮式条件，普通调光不推定阅读用途；温控、质量控制不等于手部操控，阅读灯的定时需求只支持定时动作；图案不能支持硬件，改变轮数须有稳定、平衡或转向需求', ['need', 'structure', 'validation', 'specification'], '融蜡灯的调光需求可支持亮度验证；实际转弯倾倒可支持三轮对照样件', '仅凭包装破损支持容量改造，或把融蜡灯正常调光强制当作阅读用途'),
  definition('R07', '05A/05B', '逐条判断保留有效输出', '错误硬件动作不会清空其他有效结论', ['local'], '雪地产品保留连接强度验证，移除轮距建议', '整表替换为资料不足'),
  definition('R08', '06/07', '相容形态分组', '摘要、卡片、表格消费同一逐 ASIN 结论，不由高频限制词生成正向定位，不让多数形态覆盖单个商品', ['grouping'], '雪地、两轮和三轮分别汇总；摘要、卡片、表格共同保留每个 ASIN 的适用限制', '项目多数三轮覆盖所有商品，或将高频限制词直接当作正向定位'),
  definition('R09', '规则说明', '运营只读规则定义', '无结果也可查看同源条件与正反例', ['definition'], '中文说明展示当前 R01–R12', '展示独立于实际执行的静态规则'),
  definition('R10', '判断详情', '可追溯的逐条解释', '说明实际原因，来源标识冲突时拒绝混合快照而不选择任一来源', ['definition', 'local'], '轮距不适用显示该 ASIN 的结构来源', '两个 ASIN 共用来源编号时用后一来源覆盖前者'),
  definition('R11', '保存/重开', '保留生成时版本', '历史结果使用生成时的定义，不编造历史记录', ['trace'], '重开旧版结果展示旧版快照', '用当前版本冒充历史版本'),
  definition('R12', '全流程', '来源与权限边界', '接口沿用项目权限，来源失效明确提示', ['source_scope'], '来源失效显示不可用而不借用其他项目', '无权限详情接口返回其他组织来源'),
];

const KNOWN_ATTRIBUTES = ['wheels', 'two_wheels', 'three_wheels', 'snow_slide', 'wax_heating', 'reading_illumination', 'grip', 'adjustable_grip', 'toddler_suitable'];
const ATTRIBUTE_LABELS: Record<string, string> = { wheels: '轮式结构', two_wheels: '两轮结构', three_wheels: '三轮结构', snow_slide: '雪地板底滑行结构', wax_heating: '融蜡加热用途', reading_illumination: '阅读照明用途', grip: '握持结构', adjustable_grip: '握持调节结构', toddler_suitable: '低幼适用性' };
function attributeLabel(key: string) { return ATTRIBUTE_LABELS[key] || key; }
function unique(values: string[]) { return [...new Set(values)].sort(); }
function normalizedScope(scope: AnalysisInputScope): AnalysisInputScope { return { organizationId: scope.organizationId, projectId: scope.projectId, marketplace: scope.marketplace, asins: unique(scope.asins), inputRevision: scope.inputRevision }; }
function sameScope(a: AnalysisInputScope, b: AnalysisInputScope) { return JSON.stringify(normalizedScope(a)) === JSON.stringify(normalizedScope(b)); }
export function buildProductStructureCacheKey(scope: AnalysisInputScope, version = RULE_SET_VERSION): string { return JSON.stringify([version, normalizedScope(scope)]); }
function sourceInScope(source: EvidenceSource, context: { inputScope: AnalysisInputScope; asin: string }) {
  return (!source.inputScope || sameScope(source.inputScope, context.inputScope)) && (source.scope === 'project' ? source.kind === 'keyword' || source.role === 'need' : source.asin === context.asin);
}

// These are explicit structural phrases, not product-family names. A bare scooter/lamp never matches.
const STRUCTURE_PATTERNS: Array<[string, RegExp]> = [
  ['three_wheels', /\b(?:three|3)[ -]?wheels?\b|三轮|三个轮/giu], ['two_wheels', /\b(?:two|2)[ -]?wheels?\b|两轮|二轮|两个轮/giu],
  ['wheels', /\bwheels?\b|轮式|车轮|轮子/giu], ['snow_slide', /雪地板底|板底滑行|雪橇|\bski[- ]?bottom\b|\bsnow sleds?\b/giu],
  ['wax_heating', /融蜡|熔蜡|\b(?:candle|wax) warmer\b|\bmelting wax\b/giu],
  ['reading_illumination', /阅读照明|阅读灯|\breading (?:lamp|light|illumination)\b/giu],
  ['adjustable_grip', /可调握把|可调把手|\badjustable (?:grip|handlebar|handle)\b/giu],
  ['grip', /握把|把手|握持结构|\b(?:grip|handlebar)\b/giu],
];
const NEGATIVE_PREFIX = /(?:\b(?:no|not|without|lacks?)\s+(?:any\s+)?|无|没有|不含|不具备|非|并非|不是|不采用)\s*$/iu;
const WISH_PREFIX = /希望|期望|建议|增加|新增|需要|\b(?:wish|want|should|could|add|need)\b/iu;
function extractAttributes(source: EvidenceSource): Array<[string, Exclude<StructureState, 'unknown'>]> {
  if (source.scope !== 'asin' || source.kind === 'keyword' || source.kind === 'category' || source.role === 'need') return [];
  const assertions: Array<[string, Exclude<StructureState, 'unknown'>]> = [];
  for (const clause of source.text.split(/[。;；.!?\n]/u)) {
    if (WISH_PREFIX.test(clause)) continue;
    const result: Array<[string, Exclude<StructureState, 'unknown'>]> = [];
    for (const [key, pattern] of STRUCTURE_PATTERNS) {
      pattern.lastIndex = 0;
      for (const match of clause.matchAll(pattern)) {
        const prefix = clause.slice(0, match.index).slice(-28);
        const negative = NEGATIVE_PREFIX.test(prefix);
        // Generic wheel/grip matches must not contradict a negated compound phrase.
        if ((key === 'wheels' && /(?:no|not|without)\s+(?:two|three|2|3)[ -]?$/iu.test(prefix)) || (key === 'grip' && /(?:(?:无|没有|不含)可调|(?:no|not|without)\s+adjustable\s+)$/iu.test(prefix))) continue;
        result.push([key, negative ? 'absent' : 'supported']);
      }
    }
    if (/无轮|没有车轮|\b(?:no|without) wheels?\b/iu.test(clause)) result.push(['wheels', 'absent']);
    if (/不推荐低幼|不适合低幼|不适合幼儿|\bnot (?:suitable|recommended) for toddlers?\b/iu.test(clause)) result.push(['toddler_suitable', 'absent']);
    // Derive from each assertion independently: never overwrite its sibling or opposite assertion.
    for (const [key, state] of [...result]) {
      if (state !== 'supported') continue;
      if (key === 'three_wheels') result.push(['wheels', 'supported'], ['two_wheels', 'absent']);
      if (key === 'two_wheels') result.push(['wheels', 'supported'], ['three_wheels', 'absent']);
      if (key === 'adjustable_grip') result.push(['grip', 'supported']);
    }
    assertions.push(...result);
  }
  return [...assertions, ...Object.entries(source.attributes || {})];
}
export function buildProductContext(input: ProductContextInput): ProductContext {
  const context: ProductContext = { inputScope: normalizedScope(input.scope), asin: input.asin, title: input.title, aliases: unique(input.aliases || []), category: input.category, attributes: {}, conflicts: [], evidence: [], needs: [] };
  if (!input.scope.asins.includes(input.asin)) throw new Error('ASIN is outside analysis scope');
  const provided: EvidenceSource[] = [
    { id: `${input.asin}:title`, text: input.title, kind: 'title', scope: 'asin', asin: input.asin, role: 'fact' },
    ...(input.category ? [{ id: `${input.asin}:category`, text: input.category, kind: 'category' as const, scope: 'asin' as const, asin: input.asin, role: 'fact' as const }] : []),
    ...(input.features || []).map((text, index) => ({ id: `${input.asin}:feature:${index}`, text, kind: 'attribute' as const, scope: 'asin' as const, asin: input.asin, role: 'fact' as const })),
    ...(input.evidence || []),
  ];
  const idCounts = new Map<string, number>();
  for (const source of provided) idCounts.set(source.id, (idCounts.get(source.id) || 0) + 1);
  context.evidence = provided.filter((source) => sourceInScope(source, context) && idCounts.get(source.id) === 1).map((source) => ({ ...source, inputScope: context.inputScope }));
  // Positive experiences may support preservation proposals without losing their fact role.
  context.needs = context.evidence.filter((source) => source.role === 'need' || source.kind === 'keyword' || source.kind === 'voc');
  const assertions = new Map<string, Array<{ state: Exclude<StructureState, 'unknown'>; ref: string }>>();
  for (const source of context.evidence) for (const [key, state] of extractAttributes(source)) assertions.set(key, [...(assertions.get(key) || []), { state, ref: source.id }]);
  for (const key of unique([...KNOWN_ATTRIBUTES, ...assertions.keys()])) {
    const values = assertions.get(key) || [];
    const states = unique(values.map((value) => value.state));
    const evidenceRefs = unique(values.map((value) => value.ref));
    context.attributes[key] = { state: states.length === 1 ? states[0] as StructureState : 'unknown', evidenceRefs };
    if (states.length > 1) context.conflicts.push({ attribute: key, evidenceRefs });
  }
  return context;
}

function actionableNeed(source: EvidenceSource): boolean {
  const text = source.text.trim();
  if (source.kind === 'keyword') return /timer|dimmable|adjustable|storage|capacity|temperature|glare|stability|定时|调光|可调|收纳|容量|温控|眩光|稳定/iu.test(text);
  // Audience labels alone are not a problem or an expected effect.
  return Boolean(text.replace(/\b(?:kids?|children|child|toddler|baby|adult|scooter|lamp)\b|儿童|幼儿|低幼|宝宝|人群|适用/giu, '').replace(/[\s,，、;/]+/gu, ''));
}
const ATTRIBUTE_NEEDS: Record<string, RegExp> = {
  wheels: /稳定|平衡|倾倒|转弯|转向|轮|刹车|滚动|颠簸|轴承|骑行|滑行|stabil|balanc|tip|turn|steer|wheel|brak|roll|bearing|ride/iu,
  two_wheels: /稳定|平衡|倾倒|转弯|转向|轮|stabil|balanc|tip|turn|steer|wheel/iu,
  three_wheels: /稳定|平衡|倾倒|转弯|转向|轮|stabil|balanc|tip|turn|steer|wheel/iu,
  grip: /握|把手|手柄|操控|转向|手部控制|舒适|handle|grip|steer|\bhand control\b|comfort/iu,
  adjustable_grip: /握|把手|手柄|操控|高度|舒适|handle|grip|height|comfort|adjust/iu,
  wax_heating: /融蜡|熔蜡|蜡|温|加热|香味|定时|wax|melt|heat|warm|temperatur|scent|timer/iu,
  reading_illumination: /阅读|眩光|照明|亮度|色温|调光|光线|read|glare|illumin|bright|dimm|light/iu,
  snow_slide: /雪|滑行|滑动|板底|snow|ski|sled|slide/iu,
};
/** Bounded text grounding for actions outside the known structural vocabulary.
 * Shared action boilerplate is not evidence of a shared problem. Keep matching
 * content in its original segments so removing filler cannot create new words. */
function sharesNeedContent(demand: string, action: string): boolean {
  const content = (text: string): string[] => text.toLowerCase()
    .replace(/希望|期望|需要|建议|新增|增加|改善|改进|提高|减少|解决|验证|核对|检查|比较|测试|制作|样件|方案|设计|功能|产品|商品|实际|使用|体验|问题|效果|记录|条件|控制|保留|提供|支持|进行|通过|是否|能够|可以|以及|并且|更多|容易/gu, ' ')
    .replace(/\b(?:the|and|with|for|from|this|that|should|could|would|want|wish|need|needs|improve|improved|improvement|verify|validate|check|test|testing|product|design|feature|problem|effect|actual|use|using|control|keep|add|new|support)\b/giu, ' ')
    .match(/[\p{Script=Han}]+|[a-z][a-z0-9]+/gu) || [];
  const sourceTokens = content(demand);
  const actionTokens = content(action);
  return sourceTokens.some((token) => /\p{Script=Han}/u.test(token)
    ? Array.from({ length: Math.max(0, token.length - 1) }, (_, index) => token.slice(index, index + 2)).some(part => actionTokens.some(value => value.includes(part)))
    : token.length >= 3 && actionTokens.includes(token));
}
function needSupportsCandidate(source: EvidenceSource, candidate: RuleCandidate): boolean {
  if (!actionableNeed(source)) return false;
  const attributes = unique([...candidateConditions(candidate).map((condition) => condition.attribute), ...(candidate.addsAttributes || [])]);
  // A representation of hardware is not a problem with that hardware. Keep independent clauses usable.
  const actualDemand = source.text.split(/[，,。;；.!?\n]/u).filter((clause) => !/图案|印刷|印有|插图|示意图|图标|illustration|graphic|printed|artwork|picture|logo|image of/iu.test(clause)).join('；');
  const changesWheelCount = ((candidate.addsAttributes || []).some((attribute) => attribute === 'two_wheels' || attribute === 'three_wheels')) || (/三轮|两轮|(?:three|two|3|2)[ -]?wheels?/iu.test(candidate.text) && /改为|改成|增加|新增|采用|转换|change|switch|convert|add/iu.test(candidate.text));
  if (changesWheelCount && !/稳定|平衡|倾倒|转弯|转向|stabil|balanc|tip|turn|steer/iu.test(actualDemand)) return false;
  const knownAttributes = attributes.filter((attribute) => ATTRIBUTE_NEEDS[attribute]);
  return knownAttributes.length
    ? knownAttributes.every((attribute) => ATTRIBUTE_NEEDS[attribute].test(actualDemand)
      // A reading lamp can have a timer, but that demand supports timer work only.
      || (attribute === 'reading_illumination' && /定时|\btimer\b/iu.test(actualDemand) && /定时|\btimer\b/iu.test(candidate.text)))
    : sharesNeedContent(actualDemand, candidate.text);
}
const FACT_TERMS: Record<string, string> = {
  wheels: '轮式|车轮|轮子|wheels?', two_wheels: '两轮|二轮|两个轮|(?:two|2)[ -]?wheels?', three_wheels: '三轮|三个轮|(?:three|3)[ -]?wheels?',
  snow_slide: '雪地板底滑行|雪地板底|板底滑行|雪橇|ski[- ]?bottom|snow sleds?',
  wax_heating: '融蜡加热|融蜡|熔蜡|(?:candle|wax) warmer', reading_illumination: '阅读照明|阅读灯|reading (?:lamp|light|illumination)',
  grip: '握持|握把|把手|grip|handlebar', adjustable_grip: '可调握把|可调把手|adjustable (?:grip|handlebar|handle)',
  toddler_suitable: '适合低幼|适用低幼|适合幼儿|suitable for toddlers?',
};
function factTextGrounded(context: ProductContext, candidate: RuleCandidate): boolean | null {
  const original = candidate.text.trim();
  if (candidate.sourceObservation) {
    if (candidate.claim || candidate.conditions?.length || candidate.addsAttributes?.length) return null;
    return (candidate.evidenceRefs || []).some((ref) => context.evidence.some((source) =>
      source.id === ref && source.scope === 'asin' && source.asin === context.asin && source.kind === 'voc' &&
      source.location === candidate.sourceObservation && source.text.trim() === original &&
      parseApplicabilityObservation({ id: source.id, asin: context.asin, text: source.text }) !== null)) || null;
  }
  const quotedName = original.startsWith('商品原名：') ? original.slice('商品原名：'.length) : null;
  const exact = (candidate.evidenceRefs || []).some((ref) => context.evidence.some((source) => source.id === ref && source.scope === 'asin' && source.role === 'fact' && source.kind !== 'category' && (source.text.trim() === original || (quotedName !== null && source.kind === 'title' && source.text === quotedName))));
  if (exact) return candidate.claim ? conditionState(context, candidate.claim) : true;
  if (!candidate.claim) return null;
  const terms = FACT_TERMS[candidate.claim.attribute];
  if (!terms) return null;
  const prefix = candidate.claim.state === 'absent' ? '(?:没有|不具备|不含|无|不是|not |no |without )' : '(?:(?:当前|该)?(?:产品|商品)?(?:现有|已有|采用|是|具备|为)?)';
  const canonical = new RegExp(`^${prefix}(?:${terms})(?:结构|产品|配置|用途)?[。.!]?$`, 'iu');
  return canonical.test(original) ? conditionState(context, candidate.claim) : null;
}
function textActionConditions(text: string): StructureCondition[] {
  const conditions: StructureCondition[] = [];
  if (/轮距|轴承|轮式刹车|三轮|两轮|车轮|前轮|后轮|轮子|\b(?:wheelbase|bearing|wheels?|three[- ]wheel|two[- ]wheel)\b/iu.test(text)) conditions.push({ attribute: 'wheels' });
  if (/融蜡|熔蜡|蜡温|\b(?:wax|candle warmer)\b/iu.test(text)) conditions.push({ attribute: 'wax_heating' });
  if (/阅读|\breading\b/iu.test(text)) conditions.push({ attribute: 'reading_illumination' });
  if (/雪地板底|滑雪板|雪橇/iu.test(text)) conditions.push({ attribute: 'snow_slide' });
  if (/把手|握把|握持|\b(?:grip|handlebar)\b/iu.test(text)) conditions.push({ attribute: 'grip' });
  return conditions;
}
function candidateConditions(candidate: RuleCandidate): StructureCondition[] {
  const conditions = [...(candidate.conditions || []), ...(candidate.kind === 'fact' ? candidate.claim ? [candidate.claim] : [] : textActionConditions(candidate.text))];
  return [...new Map(conditions.map((condition) => [`${condition.attribute}:${condition.state || 'supported'}`, condition])).values()];
}
function relevantRefs(context: ProductContext, candidate: RuleCandidate): string[] {
  const refs = [...(candidate.evidenceRefs || []), ...(candidate.needEvidenceRefs || []), ...candidateConditions(candidate).flatMap((condition) => [
    ...(context.attributes[condition.attribute]?.evidenceRefs || []),
    ...((context.attributes[condition.attribute]?.state === 'unknown' || !context.attributes[condition.attribute]) ? (INCOMPATIBLE_ATTRIBUTES[condition.attribute] || []).flatMap((key) => context.attributes[key]?.state === 'supported' ? context.attributes[key].evidenceRefs : []) : []),
  ])];
  return unique(refs).filter((ref) => context.evidence.some((source) => source.id === ref));
}
const INCOMPATIBLE_ATTRIBUTES: Record<string, string[]> = { wheels: ['snow_slide'], snow_slide: ['wheels'], wax_heating: ['reading_illumination'], reading_illumination: ['wax_heating'] };
function conditionState(context: ProductContext, condition: StructureCondition): boolean | null {
  const value = context.attributes[condition.attribute];
  if (context.conflicts.some((conflict) => conflict.attribute === condition.attribute)) return null;
  if (!value || value.state === 'unknown') {
    if ((condition.state || 'supported') === 'supported' && (INCOMPATIBLE_ATTRIBUTES[condition.attribute] || []).some((attribute) => context.attributes[attribute]?.state === 'supported')) return false;
    return null;
  }
  return value.state === (condition.state || 'supported');
}
/** Predicate execution and its business description share the same tagged data. */
export function evaluateRulePredicate(predicate: RulePredicate, context: ProductContext, candidate: RuleCandidate): boolean | null {
  const conditions = candidateConditions(candidate);
  switch (predicate.op) {
    case 'scope': return candidate.asin === context.asin && context.inputScope.asins.includes(candidate.asin);
    case 'names': return Boolean(context.title);
    case 'conflicts': return conditions.some((condition) => context.conflicts.some((conflict) => conflict.attribute === condition.attribute)) ? null : true;
    case 'audience': return candidate.kind !== 'fact' || !(candidate.evidenceRefs || []).some((ref) => context.evidence.some((source) => source.id === ref && source.kind === 'keyword'));
    case 'fact': return candidate.kind !== 'fact' || factTextGrounded(context, candidate) || null;
    case 'need': return candidate.kind !== 'proposal' || (candidate.needEvidenceRefs || []).some((ref) => context.needs.some((source) => source.id === ref && (needSupportsCandidate(source, candidate) || (candidate.proposalPurpose === 'verify_audience' && !conditions.length && /核对|验证|测量|检查/u.test(candidate.text))))) || null;
    case 'structure': {
      const checks = predicate.attribute ? [conditionState(context, { attribute: predicate.attribute, state: predicate.state })] : conditions.map((condition) => conditionState(context, condition));
      return checks.includes(false) ? false : checks.includes(null) ? null : true;
    }
    case 'validation': return candidate.kind !== 'proposal' || Boolean(candidate.validation?.some((text) => text.trim())) || null;
    case 'specification': {
      const quantities = candidate.text.match(/\d+(?:\.\d+)?\s*(?:(?:cm|mm|inch(?:es)?|kg|lb|watts?|w|years?\s*old)\b|岁|厘米|毫米|公斤|瓦|度)/giu) || [];
      const cited = relevantRefs(context, candidate).map((ref) => context.evidence.find((source) => source.id === ref)?.text || '').join('\n').replace(/\s+/gu, '').toLowerCase();
      return quantities.every((quantity) => cited.includes(quantity.replace(/\s+/gu, '').toLowerCase())) || null;
    }
    case 'source_scope': return [...(candidate.evidenceRefs || []), ...(candidate.needEvidenceRefs || [])].every((ref) => context.evidence.some((source) => source.id === ref && sourceInScope(source, context)));
    // These are lifecycle invariants checked by the respective pure helper and integration contracts.
    case 'local': return candidate.asin === context.asin;
    case 'grouping': return Boolean(context.asin);
    case 'definition': return RULE_DEFINITIONS.every((rule) => rule.version === RULE_SET_VERSION && rule.conditions.every((condition) => Boolean(describeRulePredicate(condition))));
    case 'trace': return Boolean(context.inputScope.inputRevision);
  }
}
export function decideProductCandidate(context: ProductContext, candidate: RuleCandidate): DecisionRecord {
  const ruleIds = ['R01', 'R02', 'R03', 'R04', candidate.kind === 'fact' ? 'R05' : 'R06', 'R07', 'R10', 'R11', 'R12'];
  const predicates = RULE_DEFINITIONS.filter((rule) => ruleIds.includes(rule.id)).flatMap((rule) => rule.conditions);
  const matchedConditions = predicates.map((predicate) => ({ predicate, description: describeRulePredicate(predicate), passed: evaluateRulePredicate(predicate, context, candidate) }));
  for (const condition of candidateConditions(candidate)) {
    const predicate: RulePredicate = { op: 'structure', ...condition };
    matchedConditions.push({ predicate, description: describeRulePredicate(predicate), passed: evaluateRulePredicate(predicate, context, candidate) });
  }
  const result: DecisionRecord = { candidateId: candidate.id, asin: context.asin, kind: candidate.kind, text: candidate.text, outcome: 'supported', reasonCode: 'supported', summary: candidate.kind === 'fact' ? '当前商品依据支持该事实。' : '需求依据及适用条件支持该开发建议。', checks: [...(candidate.validation || [])], ruleSetVersion: RULE_SET_VERSION, ruleIds, ruleVersions: Object.fromEntries(ruleIds.map((id) => [id, RULE_SET_VERSION])), inputScope: context.inputScope, evidenceRefs: relevantRefs(context, candidate), matchedConditions };
  const setOutcome = (outcome: DecisionRecord['outcome'], reasonCode: string, summary: string) => { result.outcome = outcome; result.reasonCode = reasonCode; result.summary = summary; };
  if (matchedConditions.some((condition) => ['scope', 'source_scope'].includes(condition.predicate.op) && condition.passed === false)) {
    setOutcome('rejected', 'outside_scope', '候选或引用来源不属于当前分析范围。');
  } else if (candidateConditions(candidate).some((condition) => context.conflicts.some((conflict) => conflict.attribute === condition.attribute))) {
    const conflicts = candidateConditions(candidate).filter((condition) => context.conflicts.some((conflict) => conflict.attribute === condition.attribute));
    setOutcome('needs_check', 'attribute_conflict', `${conflicts.map((condition) => attributeLabel(condition.attribute)).join('、')}存在相互矛盾的来源，需核对。`);
    result.checks.push(result.summary);
  } else if (candidateConditions(candidate).some((condition) => conditionState(context, condition) === false)) {
    setOutcome('rejected', 'structure_incompatible', '当前商品的明确结构或用途与该条输出条件不相容。');
  } else if (matchedConditions.some((condition) => condition.predicate.op === 'need' && condition.passed !== true)) {
    setOutcome('needs_check', 'need_missing', '缺少支持该开发动作的具体问题或期待效果；人群关键词不能单独推出硬件。');
    result.checks.push('补充该动作所解决的具体问题及其来源。');
  } else if (matchedConditions.some((condition) => condition.passed !== true)) {
    const missing = matchedConditions.filter((condition) => condition.passed !== true);
    setOutcome('needs_check', 'evidence_missing', `需核对：${unique(missing.map((condition) => condition.description)).join('；')}。`);
    result.checks.push(...missing.map((condition) => condition.description));
  }
  return result;
}

/** Compatibility adapter: classify a legacy action into explicit candidate prerequisites before deciding it. */
export function evaluateTextAction(context: ProductContext, text: string, options: { id?: string; needEvidenceRefs?: string[]; kind?: 'fact' | 'proposal'; proposalPurpose?: 'verify_audience' } = {}): DecisionRecord {
  const conditions = textActionConditions(text);
  const kind = options.kind || 'proposal';
  let claim: StructureCondition | undefined;
  if (kind === 'fact') {
    if (/三轮|\b(?:three|3)[ -]?wheels?\b/iu.test(text)) claim = { attribute: 'three_wheels' };
    else if (/两轮|\b(?:two|2)[ -]?wheels?\b/iu.test(text)) claim = { attribute: 'two_wheels' };
    else claim = conditions[0];
  }
  return decideProductCandidate(context, { id: options.id || `${context.asin}:action:${stableHash(text)}`, asin: context.asin, kind, text, conditions, claim, proposalPurpose: options.proposalPurpose, needEvidenceRefs: options.needEvidenceRefs || context.needs.map((source) => source.id), validation: kind === 'proposal' ? [`验证“${text}”能否解决所引用问题，并核对样品适用性。`] : [] });
}
export interface CompatibleProductGroup { key: string; asins: string[]; evidenceRefs: string[]; status: 'supported' | 'unknown' | 'conflict' }
export function groupCompatibleProducts(contexts: ProductContext[]): CompatibleProductGroup[] {
  const groups = new Map<string, CompatibleProductGroup>();
  for (const context of contexts) {
    const keys = ['snow_slide', 'two_wheels', 'three_wheels', 'wax_heating', 'reading_illumination'].filter((key) => context.attributes[key]?.state === 'supported');
    if (!keys.length && context.attributes.wheels?.state === 'supported') keys.push('wheels');
    const conflict = context.conflicts.some((value) => ['wheels', 'two_wheels', 'three_wheels', 'snow_slide', 'wax_heating', 'reading_illumination'].includes(value.attribute));
    const status = conflict ? 'conflict' : keys.length ? 'supported' : 'unknown';
    const key = `${buildProductStructureCacheKey(context.inputScope)}:${status === 'supported' ? keys.join('+') : `${status}:${context.asin}`}`;
    const group = groups.get(key) || { key, asins: [], evidenceRefs: [], status };
    group.asins = unique([...group.asins, context.asin]);
    group.evidenceRefs = unique([...group.evidenceRefs, ...keys.flatMap((attribute) => context.attributes[attribute].evidenceRefs)]);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => a.key.localeCompare(b.key));
}
export function buildAnalysisRuleTrace(contexts: ProductContext[], decisions: DecisionRecord[]): AnalysisRuleTrace {
  if (!contexts.length) throw new Error('A trace requires an actual analysis context');
  const inputScope = contexts[0].inputScope;
  if (contexts.some((context) => !sameScope(context.inputScope, inputScope)) || decisions.some((decision) => !sameScope(decision.inputScope, inputScope) || decision.ruleSetVersion !== RULE_SET_VERSION || !contexts.some((context) => context.asin === decision.asin))) throw new Error('Cannot combine rule traces from different scopes or versions');
  const usedRefs = new Set(decisions.flatMap((decision) => decision.evidenceRefs));
  const sourceIdentity = new Map<string, string>();
  for (const source of contexts.flatMap((context) => context.evidence)) {
    const identity = JSON.stringify({ ...source, inputScope: source.inputScope ? normalizedScope(source.inputScope) : undefined });
    const previous = sourceIdentity.get(source.id);
    if (previous !== undefined && previous !== identity) throw new Error(`Ambiguous evidence ID collision: ${source.id}`);
    sourceIdentity.set(source.id, identity);
  }
  for (const decision of decisions) {
    const context = contexts.find((value) => value.asin === decision.asin)!;
    if (decision.evidenceRefs.some((ref) => !context.evidence.some((source) => source.id === ref && sourceInScope(source, context)))) throw new Error('Decision references evidence outside its ASIN scope');
  }
  const sources = [...new Map(contexts.flatMap((context) => context.evidence).filter((source) => usedRefs.has(source.id)).map((source) => [source.id, source])).values()];
  const ids = new Set(decisions.flatMap((decision) => decision.ruleIds));
  const boundedContexts = contexts.map((context) => {
    const retained = new Set([...usedRefs, ...Object.values(context.attributes).flatMap((attribute) => attribute.evidenceRefs)]);
    return { ...context, evidence: context.evidence.filter((source) => retained.has(source.id)), needs: context.needs.filter((source) => retained.has(source.id)) };
  });
  return { ruleSetVersion: RULE_SET_VERSION, ruleDefinitions: RULE_DEFINITIONS.filter((rule) => ids.has(rule.id)).map((rule) => ({ ...rule, conditions: rule.conditions.map((predicate) => ({ ...predicate })), exclusions: [...rule.exclusions] })), inputScope: normalizedScope(inputScope), decisions: structuredClone(decisions), sources: structuredClone(sources), contexts: structuredClone(boundedContexts) };
}
function stableHash(text: string): string { let hash = 2166136261; for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619); return (hash >>> 0).toString(16); }
/** Pinned by the regression test: rule or executable-condition edits require deliberate version/example review. */
export function ruleDefinitionFingerprint(): string { return stableHash(JSON.stringify({ version: RULE_SET_VERSION, definitions: RULE_DEFINITIONS, patterns: STRUCTURE_PATTERNS.map(([key, pattern]) => [key, pattern.source]), incompatible: INCOMPATIBLE_ATTRIBUTES, negative: NEGATIVE_PREFIX.source, wish: WISH_PREFIX.source, execute: evaluateRulePredicate.toString(), decide: decideProductCandidate.toString(), extract: extractAttributes.toString(), adapter: evaluateTextAction.toString(), need: actionableNeed.toString(), condition: conditionState.toString(), build: buildProductContext.toString(), fact: factTextGrounded.toString(), factTerms: FACT_TERMS, relevantNeed: needSupportsCandidate.toString(), needContent: sharesNeedContent.toString(), needPatterns: Object.entries(ATTRIBUTE_NEEDS).map(([key, pattern]) => [key, pattern.source]), trace: buildAnalysisRuleTrace.toString(), textConditions: textActionConditions.toString(), candidateConditions: candidateConditions.toString(), applicability: applicabilityRuleFingerprint() })); }

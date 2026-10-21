/** Closed, source-independent diagnostics. Never derive guidance from model text. */
export const PRODUCT_VALIDATION_RULES = Object.freeze({
 'product-pending-reason-required': 'When opportunity.grade is null, provide a nonempty pendingReason.',
 'product-review-fallback-grade': 'Review fallback evidence cannot support opportunity grade A.',
 'product-matrix-needs-evidence': 'Every evidenceMatrix row requires at least one trusted evidence side. Omit unsupported rows; never invent references.',
 'product-matrix-voc-only-sides': 'For voc-only, provide a known themeKey and nonempty VOC evidence; keywordGroupId must be null and keyword evidence must be empty.',
 'product-matrix-keyword-only-sides': 'For keyword-candidate, provide a known keywordGroupId and nonempty keyword evidence; themeKey must be null and VOC evidence must be empty.',
 'product-matrix-dual-sides': 'For dual-validation, provide a known themeKey and keywordGroupId and nonempty evidence from both sides.',
 'product-matrix-conflict-avoid-sides': 'For conflict or avoid, provide a known themeKey and keywordGroupId and nonempty evidence from both sides.',
 'product-final-definition-needs-evidence': 'Every finalDefinition row requires trusted VOC or keyword evidence. Omit unsupported dimensions instead of inventing or filling references.',
 'product-supported-requires-both-evidence': 'A supported finalDefinition row requires nonempty VOC and keyword evidence. With only one evidenced side use requires-validation.',
 'product-identity-mismatch': 'Preserve the frozen dependency identity from the original input.',
 'product-fingerprint-mismatch': 'Preserve the frozen input fingerprint and evidence selection; do not infer a new manifest.',
 'product-unknown-voc-theme': 'Use only an exact themeKey present in the frozen VOC input; do not translate or rephrase keys.',
 'product-unknown-keyword-group': 'Use only a keyword group ID present in the frozen keyword input.',
 'product-unknown-evidence-reference': 'Use exact evidence IDs from the appropriate frozen dependency. Never guess or manufacture an ID.',
 'product-commercial-gates-required': 'Keep all five distinct risks explicit: cost, profitability, patent, compliance, supply-chain.',
 'product-commercial-capability-language': 'Place commercial unknowns or deferred checks only in risks, opportunity.pendingReason, commercialValidation or dataBoundary. Ordinary narratives must not contain profit, profitability, margin, ROI, 盈利, 利润, 毛利, 投资回报, approval claims or validation-bypass wording, including negated or deferred claims.',
});
export type ProductValidationRuleId = keyof typeof PRODUCT_VALIDATION_RULES;
export function isProductValidationRuleId(value: unknown): value is ProductValidationRuleId {
 return typeof value === 'string' && Object.hasOwn(PRODUCT_VALIDATION_RULES, value);
}
export function productValidationRule(ruleId: ProductValidationRuleId) { return {ruleId}; }
export function productDefinitionRepairGuidance(issues: readonly {ruleId?: string}[]): readonly string[] {
 const rules=[...new Set(issues.map(i=>i.ruleId).filter(isProductValidationRuleId))];
 return rules.length ? [rules.map(rule=>`${rule}: ${PRODUCT_VALIDATION_RULES[rule]}`).join('\n')] : [];
}

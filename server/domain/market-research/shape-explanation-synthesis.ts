import {canonicalJsonSha256 as digest} from '../../runtime/model-request-accounting';
import {MARKET_SHAPE_EXPLANATION_DIMENSIONS, type MarketShapeExplanationCatalog, type MarketShapeExplanationDimension} from '../../../shared/market-shape-explanation-contracts';
import {MarketShapeDimensionSynthesisInputSchema, MarketShapeDimensionSynthesisOutputSchema, MarketShapeFinalSynthesisInputSchema, MarketShapeFinalSynthesisOutputSchema, type MarketShapeSynthesisChild, type MarketShapeDimensionSynthesisInput, type MarketShapeFinalSynthesisInput} from '../../../shared/market-shape-synthesis-contracts';
import {validateMarketShapeExplanationCatalog} from './shape-explanation-catalog';
import {validateMarketShapeExplanation, validateMarketShapeExplanationSection} from './shape-explanation-validation';

type SynthesisInput = MarketShapeDimensionSynthesisInput | MarketShapeFinalSynthesisInput;
type Section = MarketShapeSynthesisChild['section'];
export type MarketShapeSynthesisFits<T extends SynthesisInput = SynthesisInput> = (input: T) => boolean | Promise<boolean>;
export class MarketShapeSynthesisRequestTooLargeError extends Error {
  readonly code = 'request-too-large';
  constructor() { super('Market shape synthesis request-too-large'); this.name = 'MarketShapeSynthesisRequestTooLargeError'; }
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function abort(signal?: AbortSignal) {
  if (signal?.aborted) { const error = new Error('Market shape synthesis aborted'); error.name = 'AbortError'; throw error; }
}
function validateChildren(catalog: MarketShapeExplanationCatalog, items: readonly MarketShapeSynthesisChild[], dimension?: MarketShapeExplanationDimension) {
  if (new Set(items.map(item => item.childId)).size !== items.length) throw new TypeError('Duplicate synthesis child identity');
  const leaves = items.flatMap(item => item.leafWindowIds);
  if (new Set(leaves).size !== leaves.length) throw new TypeError('Duplicate synthesis leaf identity');
  for (const item of items) {
    validateMarketShapeExplanationSection(catalog, item.section);
    if (dimension && item.section.dimension !== dimension) throw new TypeError('Mixed synthesis child dimensions');
  }
  return leaves;
}
function exactLeaves(actual: readonly string[], expected: readonly string[]) {
  if (new Set(expected).size !== expected.length || actual.length !== expected.length || actual.some(id => !expected.includes(id))) throw new TypeError('Synthesis leaf manifest is incomplete');
}
function statements(section: Section) { return [section.summary, ...section.findings, ...section.limitations, ...section.verification]; }
function evidenceRows(catalog: MarketShapeExplanationCatalog, items: readonly MarketShapeSynthesisChild[]) {
  const ids = [...new Set(items.flatMap(item => statements(item.section).flatMap(statement => statement.evidenceRowIds)))];
  return ids.map(id => {
    const row = catalog.rows.find(item => item.id === id);
    if (!row) throw new TypeError('Unknown synthesis evidence');
    return {id: row.id, context: row.context, cells: row.cells.map(cell => ({id: cell.id, value: cell.value, unit: cell.unit}))};
  });
}
function limitations(catalog: MarketShapeExplanationCatalog, items: readonly MarketShapeSynthesisChild[]) {
  const codes = [...new Set(items.flatMap(item => statements(item.section).flatMap(statement => statement.limitationCodes)))];
  return codes.map(code => {
    const value = catalog.limitations.find(item => item.code === code);
    if (!value) throw new TypeError('Unknown synthesis limitation');
    let isArray = false;
    try { isArray = Array.isArray(JSON.parse(value.detail)); } catch { /* Plain business rules stay verbatim. */ }
    if (isArray) {
      const reviewed = items.filter(item => statements(item.section).some(statement => statement.limitationCodes.includes(code))).flatMap(item => item.leafWindowIds);
      // The native loader must prove these descendants actually completed. The
      // original source records remain in leaf inputs; final synthesis receives
      // the audited local interpretations, not a second copy of every record.
      return {code, detail: 'Original provenance records were reviewed by leaf model windows.', provenance: {mode: 'reviewed-in-leaves' as const, leafWindowIds: reviewed}};
    }
    return {code, detail: value.detail, provenance: {mode: 'direct-rule' as const, leafWindowIds: []}};
  });
}
function body(catalog: MarketShapeExplanationCatalog, mode: SynthesisInput['mode'], dimension: MarketShapeExplanationDimension | 'final', items: readonly MarketShapeSynthesisChild[]) {
  const raw = {version: 'market-shape-synthesis-input/v1' as const, explanationCatalogId: catalog.explanationCatalogId, revisionId: catalog.revisionId,
    mode, dimension, directChildIds: items.map(item => item.childId), leafWindowIds: items.flatMap(item => item.leafWindowIds), children: [...items],
    evidenceRows: evidenceRows(catalog, items), limitations: limitations(catalog, items)};
  const inputDigest = digest(raw);
  return {...raw, nodeId: `market-shape-synthesis:${digest({inputDigest})}`, inputDigest};
}
function canonical(catalog: MarketShapeExplanationCatalog, input: SynthesisInput) {
  validateChildren(catalog, input.children, input.mode === 'dimension-reduce' ? input.dimension : undefined);
  if (digest(body(catalog, input.mode, input.dimension, input.children)) !== digest(input)) throw new TypeError('Synthesis input digest or evidence projection differs');
}

/** Compare with authorized audit restoration; content digests alone are not proof. */
export function validateMarketShapeSynthesisInputEvidence(catalogValue: MarketShapeExplanationCatalog, inputValue: unknown,
  authorizedChildren: readonly MarketShapeSynthesisChild[], expectedLeaves: readonly string[]) {
  const catalog=validateMarketShapeExplanationCatalog(catalogValue);
  const input=MarketShapeDimensionSynthesisInputSchema.or(MarketShapeFinalSynthesisInputSchema).parse(inputValue);
  if(digest(input.children)!==digest(authorizedChildren))throw new TypeError('Synthesis children differ from authorized audit');
  if(!expectedLeaves.length||new Set(expectedLeaves).size!==expectedLeaves.length||input.leafWindowIds.some(id=>!expectedLeaves.includes(id)))throw new TypeError('Synthesis leaf manifest differs');
  canonical(catalog,input);
  if(input.mode==='final'){
    if(new Set(input.children.map(child=>child.section.dimension)).size!==6)throw new TypeError('Final synthesis requires six dimensions');
    exactLeaves(input.leafWindowIds,expectedLeaves);
  }
  return freeze(input);
}

/** Children must come from authorized native audit restoration. Digests prove
 * content integrity, not authorization. Expected leaves come from that manifest. */
export async function buildMarketShapeDimensionSynthesisInput(catalogValue: MarketShapeExplanationCatalog, dimension: MarketShapeExplanationDimension,
  items: readonly MarketShapeSynthesisChild[], expectedLeafWindowIds: readonly string[], fits: MarketShapeSynthesisFits<MarketShapeDimensionSynthesisInput>, signal?: AbortSignal) {
  const catalog = validateMarketShapeExplanationCatalog(catalogValue); abort(signal);
  if (items.length < 2) throw new TypeError('Dimension synthesis requires at least two children');
  exactLeaves(validateChildren(catalog, items, dimension), expectedLeafWindowIds);
  const input = MarketShapeDimensionSynthesisInputSchema.parse(body(catalog, 'dimension-reduce', dimension, items));
  const admitted = await fits(input); abort(signal);
  if (!admitted) throw new MarketShapeSynthesisRequestTooLargeError();
  return freeze(input);
}
export async function buildMarketShapeFinalSynthesisInput(catalogValue: MarketShapeExplanationCatalog, items: readonly MarketShapeSynthesisChild[],
  expectedLeafWindowIds: readonly string[], fits: MarketShapeSynthesisFits<MarketShapeFinalSynthesisInput>, signal?: AbortSignal) {
  const catalog = validateMarketShapeExplanationCatalog(catalogValue); abort(signal);
  if (items.length !== 6 || new Set(items.map(item => item.section.dimension)).size !== 6 || MARKET_SHAPE_EXPLANATION_DIMENSIONS.some(dimension => !items.some(item => item.section.dimension === dimension))) throw new TypeError('Final synthesis requires six complete dimensions');
  exactLeaves(validateChildren(catalog, items), expectedLeafWindowIds);
  const input = MarketShapeFinalSynthesisInputSchema.parse(body(catalog, 'final', 'final', items));
  const admitted = await fits(input); abort(signal);
  if (!admitted) throw new MarketShapeSynthesisRequestTooLargeError();
  return freeze(input);
}
export async function planMarketShapeDimensionSynthesisRound(catalogValue: MarketShapeExplanationCatalog, dimension: MarketShapeExplanationDimension,
  items: readonly MarketShapeSynthesisChild[], expected: readonly string[], fits: MarketShapeSynthesisFits<MarketShapeDimensionSynthesisInput>, signal?: AbortSignal) {
  const catalog = validateMarketShapeExplanationCatalog(catalogValue); abort(signal);
  exactLeaves(validateChildren(catalog, items, dimension), expected);
  const mergeInputs: MarketShapeDimensionSynthesisInput[] = [], carried: MarketShapeSynthesisChild[] = [];
  for (let start = 0; start < items.length;) {
    abort(signal);
    let best: MarketShapeDimensionSynthesisInput | undefined;
    for (let end = start + 2; end <= items.length; end++) {
      const group = items.slice(start, end);
      try { best = await buildMarketShapeDimensionSynthesisInput(catalog, dimension, group, group.flatMap(item => item.leafWindowIds), fits, signal); }
      catch (error) { if (error instanceof MarketShapeSynthesisRequestTooLargeError) break; throw error; }
    }
    if (best) { mergeInputs.push(best); start += best.children.length; }
    else carried.push(items[start++]!);
  }
  abort(signal);
  if (items.length > 1 && !mergeInputs.length) throw new MarketShapeSynthesisRequestTooLargeError();
  return freeze({mergeInputs, carried});
}
export function validateMarketShapeDimensionSynthesisOutput(catalogValue: MarketShapeExplanationCatalog, inputValue: unknown, outputValue: unknown) {
  const catalog = validateMarketShapeExplanationCatalog(catalogValue), input = MarketShapeDimensionSynthesisInputSchema.parse(inputValue), output = MarketShapeDimensionSynthesisOutputSchema.parse(outputValue);
  canonical(catalog, input);
  if (output.nodeId !== input.nodeId || output.inputDigest !== input.inputDigest || output.section.dimension !== input.dimension) throw new TypeError('Dimension synthesis identity differs');
  const section = validateMarketShapeExplanationSection(catalog, output.section, input.evidenceRows.map(row => row.id));
  const required = new Set(input.limitations.map(item => item.code)), used = new Set(section.limitations.flatMap(item => item.limitationCodes));
  if ([...required].some(code => !used.has(code)) || statements(section).some(statement => statement.limitationCodes.some(code => !required.has(code)))) throw new TypeError('Dimension synthesis limitation coverage differs');
  return freeze({...output, section});
}
export function validateMarketShapeFinalSynthesisOutput(catalogValue: MarketShapeExplanationCatalog, inputValue: unknown, outputValue: unknown) {
  const catalog = validateMarketShapeExplanationCatalog(catalogValue), input = MarketShapeFinalSynthesisInputSchema.parse(inputValue), output = MarketShapeFinalSynthesisOutputSchema.parse(outputValue);
  canonical(catalog, input);
  if (output.nodeId !== input.nodeId || output.inputDigest !== input.inputDigest) throw new TypeError('Final synthesis identity differs');
  const allowed = new Set(input.evidenceRows.map(row => row.id));
  const visibleLimitations = new Set(input.limitations.map(limitation => limitation.code));
  for (const statement of [output.synthesis.summary, ...output.synthesis.limitations, ...output.synthesis.verification]) {
    if (statement.evidenceRowIds.some(id => !allowed.has(id))) throw new TypeError('Final synthesis evidence is outside its model input');
    if (statement.limitationCodes.some(code => !visibleLimitations.has(code))) throw new TypeError('Final synthesis limitation is outside its model input');
  }
  return validateMarketShapeExplanation(catalog, {version: 'market-shape-explanation-output/v1', explanationCatalogId: catalog.explanationCatalogId,
    revisionId: catalog.revisionId, dimensions: input.children.map(item => item.section), synthesis: output.synthesis});
}

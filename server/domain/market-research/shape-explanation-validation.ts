import {
  MarketShapeExplanationOutputSchema, MarketShapeExplanationStatementSchema,
  SHAPE_EXPLANATION_DIMENSIONS,
  type MarketShapeExplanationStatement,
} from '../../../shared/market-shape-explanation-output-contracts';
import type {
  MarketShapeExplanationCatalog, MarketShapeExplanationDimension,
} from '../../../shared/market-shape-explanation-contracts';
import { validateMarketShapeExplanationCatalog } from './shape-explanation-catalog';

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function unique(values: readonly string[], label: string) {
  if (new Set(values).size !== values.length) throw new TypeError(`Duplicate ${label}`);
}
function statement(catalog: MarketShapeExplanationCatalog, input: unknown, dimension?: MarketShapeExplanationDimension) {
  const s = MarketShapeExplanationStatementSchema.parse(input);
  unique(s.evidenceRowIds, 'statement evidence');
  unique(s.limitationCodes, 'statement limitations');
  const rows = new Map(catalog.rows.map(row => [row.id, row]));
  const codes = new Set(catalog.limitations.map(item => item.code));
  for (const code of s.limitationCodes) if (!codes.has(code)) throw new TypeError('Unknown explanation limitation');
  for (const id of s.evidenceRowIds) {
    const row = rows.get(id);
    if (!row || dimension && row.dimension !== dimension) throw new TypeError('Explanation evidence is outside its dimension');
  }
  if (!s.evidenceRowIds.length && !s.limitationCodes.length) throw new TypeError('Explanation statement has no evidence');
  let knownCells = 0;
  if (!s.parts.some(part => part.kind === 'text')) throw new TypeError('Explanation statement has no prose');
  for (const part of s.parts) {
    if (part.kind === 'text') continue;
    if (!s.evidenceRowIds.includes(part.rowId)) throw new TypeError('Displayed reference is not cited');
    const row = rows.get(part.rowId)!;
    if (part.kind === 'cell') {
      const cell = row.cells.find(cell => cell.id === part.cellId);
      if (!cell) throw new TypeError('Unknown explanation cell');
      if (cell.value === null && s.kind === 'observed') throw new TypeError('Unknown cell cannot be an observed numeric claim');
      if (cell.value !== null) knownCells++;
    } else if (!Object.hasOwn(row.context, part.key)) throw new TypeError('Unknown explanation context');
  }
  if (s.kind === 'observed' && knownCells === 0) throw new TypeError('Observed finding requires an existing numeric reference');
  return s;
}

function sectionValidation(catalog: MarketShapeExplanationCatalog, sectionValue: unknown, rowIds?: readonly string[]) {
  const section = MarketShapeExplanationOutputSchema.shape.dimensions.element.parse(sectionValue);
  const dimension = section.dimension;
  if (rowIds) {
    unique(rowIds, 'section row');
    if (rowIds.some(id => !catalog.rows.some(row => row.id === id && row.dimension === dimension)))
      throw new TypeError('Section window rows differ from its dimension');
  }
  const rows = catalog.rows.filter(row => row.dimension === dimension && (!rowIds || rowIds.includes(row.id)));
  const hasKnownValue = rows.some(row => row.cells.some(cell => cell.value !== null));
  if (section.status === 'explained' && (!hasKnownValue || section.findings.length === 0))
    throw new TypeError('Explained dimension has no usable evidence or findings');
  if (section.status === 'insufficient-evidence' && (section.findings.length > 0 || section.summary.kind !== 'risk'))
    throw new TypeError('Insufficient dimension cannot present explained findings');
  const statements = [section.summary, ...section.findings, ...section.limitations, ...section.verification];
  for (const item of statements) {
    statement(catalog, item, dimension);
    if (rowIds && item.evidenceRowIds.some(id => !rowIds.includes(id))) throw new TypeError('Explanation cites a row outside its model window');
  }
  if (section.limitations.some(item => item.kind !== 'risk') || section.verification.some(item => item.kind !== 'verification'))
    throw new TypeError('Explanation statement role differs from its section');
  if (section.findings.some(item => !['observed', 'inferred'].includes(item.kind)))
    throw new TypeError('Finding must distinguish observed evidence and inference');
  if (section.status === 'insufficient-evidence' && !section.limitations.some(item => item.limitationCodes.length || item.evidenceRowIds.length))
    throw new TypeError('Insufficient dimension requires a reason');
  return freeze(section);
}
export function validateMarketShapeExplanationSection(catalogValue: MarketShapeExplanationCatalog, sectionValue: unknown, rowIds?: readonly string[]) {
  return sectionValidation(validateMarketShapeExplanationCatalog(catalogValue), sectionValue, rowIds);
}

/** Caller supplies a directory rebuilt from an authorized, restored revision.
 * A digest verifies content integrity; it is not a replacement for that access check.
 * Structural acceptance is not a G09 semantic-quality claim. */
export function validateMarketShapeExplanation(catalogValue: MarketShapeExplanationCatalog, outputValue: unknown) {
  const catalog = validateMarketShapeExplanationCatalog(catalogValue);
  const output = MarketShapeExplanationOutputSchema.parse(outputValue);
  if (output.explanationCatalogId !== catalog.explanationCatalogId || output.revisionId !== catalog.revisionId)
    throw new TypeError('Explanation belongs to a different report revision');
  unique(output.dimensions.map(d => d.dimension), 'explanation dimension');
  const referencedDimensions = new Set<MarketShapeExplanationDimension>();
  for (const dimension of SHAPE_EXPLANATION_DIMENSIONS) {
    const section = output.dimensions.find(item => item.dimension === dimension);
    if (!section) throw new TypeError('Missing explanation dimension');
    sectionValidation(catalog, section);
  }
  for (const item of [output.synthesis.summary, ...output.synthesis.limitations, ...output.synthesis.verification]) {
    statement(catalog, item);
  }
  for (const part of output.synthesis.summary.parts) {
    if (part.kind !== 'cell') continue;
    const row = catalog.rows.find(row => row.id === part.rowId)!;
    if (row.cells.find(cell => cell.id === part.cellId)!.value !== null) referencedDimensions.add(row.dimension);
  }
  if (output.synthesis.decision === 'insufficient-evidence'
    ? output.synthesis.summary.kind !== 'risk'
    : output.synthesis.summary.kind !== 'inferred')
    throw new TypeError('Synthesis decision and statement role differ');
  if (output.synthesis.limitations.some(item => item.kind !== 'risk') || output.synthesis.verification.some(item => item.kind !== 'verification'))
    throw new TypeError('Synthesis statement roles differ');
  const evidencedDimensionCount = SHAPE_EXPLANATION_DIMENSIONS.filter(d => catalog.rows.some(row => row.dimension === d && row.cells.some(cell => cell.value !== null))).length;
  if (output.synthesis.decision !== 'insufficient-evidence' && referencedDimensions.size < Math.min(2, evidencedDimensionCount))
    throw new TypeError('Synthesis lacks cross-dimension evidence');
  if (output.synthesis.decision !== 'insufficient-evidence' && evidencedDimensionCount === 0)
    throw new TypeError('Synthesis cannot conclude without known evidence');
  const reportedLimitations = new Set([...output.dimensions.flatMap(d => d.limitations), ...output.synthesis.limitations].flatMap(s => s.limitationCodes));
  if (catalog.limitations.some(item => !reportedLimitations.has(item.code)))
    throw new TypeError('Explanation omitted an input limitation');
  return freeze(output);
}

/** Returns plain text only. Consumers must render text nodes, never innerHTML.
 * Values and names are resolved from the frozen report, without model arithmetic. */
export function renderMarketShapeExplanationStatement(
  catalogValue: MarketShapeExplanationCatalog,
  outputValue: unknown,
  location: { dimension: MarketShapeExplanationDimension | 'synthesis'; section: 'summary' } |
    { dimension: MarketShapeExplanationDimension | 'synthesis'; section: 'findings' | 'limitations' | 'verification'; index: number },
) {
  const catalog = validateMarketShapeExplanationCatalog(catalogValue);
  const output = validateMarketShapeExplanation(catalog, outputValue);
  const section = location.dimension === 'synthesis' ? output.synthesis : output.dimensions.find(d => d.dimension === location.dimension);
  if (!section) throw new TypeError('Unknown explanation dimension');
  let checked: MarketShapeExplanationStatement;
  if (location.section === 'summary') checked = section.summary;
  else {
    const list = location.section === 'findings' ? ('findings' in section ? section.findings : []) : section[location.section];
    if (!Number.isInteger(location.index) || location.index < 0 || location.index >= list.length)
      throw new TypeError('Unknown explanation statement');
    checked = list[location.index];
  }
  return checked.parts.map(part => {
    if (part.kind === 'text') return part.text;
    const row = catalog.rows.find(row => row.id === part.rowId)!;
    if (part.kind === 'context') return row.context[part.key] ?? '未知';
    const cell = row.cells.find(cell => cell.id === part.cellId)!;
    return cell.value === null ? '未知' : `${String(cell.value)} (${cell.unit})`;
  }).join('');
}

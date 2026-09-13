import type { MarketShapeExplanationCatalog } from '../../../shared/market-shape-explanation-contracts';
import type { MarketShapeExplanationStatement } from '../../../shared/market-shape-explanation-output-contracts';
import {
  MarketShapeExplanationPresentationSchema,
  type MarketShapeExplanationPresentation,
  type MarketShapeExplanationPresentedStatement,
} from '../../../shared/market-shape-explanation-presentation';
import { validateMarketShapeExplanationCatalog } from './shape-explanation-catalog';
import { validateMarketShapeExplanation } from './shape-explanation-validation';

/** Pure projection only. Caller must restore this catalog through the authorized
 * revision reader; matching hashes alone do not grant access to a report. */
export function presentMarketShapeExplanation(
  catalogValue: MarketShapeExplanationCatalog,
  outputValue: unknown,
): MarketShapeExplanationPresentation {
  const catalog = validateMarketShapeExplanationCatalog(catalogValue);
  const output = validateMarketShapeExplanation(catalog, outputValue);
  const rows = new Map(catalog.rows.map(row => [row.id, row]));
  const limitations = new Map(catalog.limitations.map(item => [item.code, item]));
  function present(statement: MarketShapeExplanationStatement): MarketShapeExplanationPresentedStatement {
    return {
      kind: statement.kind,
      text: statement.parts.map(part => {
        if (part.kind === 'text') return part.text;
        const row = rows.get(part.rowId)!;
        if (part.kind === 'context') return row.context[part.key] ?? '未知';
        const cell = row.cells.find(cell => cell.id === part.cellId)!;
        return `${cell.value === null ? '未知' : String(cell.value)} (${cell.unit})`;
      }).join(''),
      evidenceRows: statement.evidenceRowIds.map(id => rows.get(id)!),
      limitations: statement.limitationCodes.map(code => limitations.get(code)!),
    };
  }
  return MarketShapeExplanationPresentationSchema.parse({
    revisionId: output.revisionId,
    explanationCatalogId: output.explanationCatalogId,
    dimensions: output.dimensions.map(section => ({
      dimension: section.dimension,
      status: section.status,
      summary: present(section.summary),
      findings: section.findings.map(present),
      limitations: section.limitations.map(present),
      verification: section.verification.map(present),
    })),
    synthesis: {
      decision: output.synthesis.decision,
      summary: present(output.synthesis.summary),
      limitations: output.synthesis.limitations.map(present),
      verification: output.synthesis.verification.map(present),
    },
  });
}

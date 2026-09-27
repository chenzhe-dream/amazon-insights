import type { z } from 'zod';
import type { MarketThemeReportSchema } from '../../shared/market-module-contracts';

type Report = z.infer<typeof MarketThemeReportSchema>;
const sourceGaps = new Set(['selection-shortfall', 'no-theme-data', 'empty-asins', 'source-results-missing', 'quarantined-themes']);

/** Present saved source coverage without changing a historical report or its hash. */
export function themeSavedReportStatus(report: Report): Report['status'] {
  if (report.semanticStatus !== 'skipped') return report.status;
  if (!report.dataReady) return 'no-data';
  return report.reasons.some(reason => sourceGaps.has(reason)) ? 'partial' : 'complete';
}

import { VOC_DIMENSIONS, isSkippedAlexaLine, isAlexaDimensionHeader } from "../domain/voc/theme-normalization";
import type { VocSnapshotPayload } from "./voc-data-snapshot";
export function manualEvidenceDimensions(record: VocSnapshotPayload["records"]["alexaVoc"][number]) {
  return VOC_DIMENSIONS.filter(key => record[key].some(line => line.trim() && !isSkippedAlexaLine(line) && !isAlexaDimensionHeader(line, key)));
}
export function reviewEvidenceDimensions(record: VocSnapshotPayload["records"]["sorftimeReviewAnalysis"][number]) {
  return [...new Set(record.blocks.filter(block => block.rows.some(row => row.label.trim())).map(block => block.key === "consumerProfile" ? "audiences" as const : block.key))];
}

type Dimension = typeof VOC_DIMENSIONS[number];
export function selectEvidenceDimensions(manual: readonly Dimension[], reviews: readonly Dimension[], fallback: boolean) {
 const reviewDimensions = fallback ? [...reviews] : [];
 return {
  reviewDimensions,
  reviewSupplementDimensions: reviewDimensions.filter(dimension => !manual.includes(dimension)),
  conflictDimensions: reviewDimensions.filter(dimension => manual.includes(dimension)),
  missingDimensions: VOC_DIMENSIONS.filter(dimension => !manual.includes(dimension) && !reviewDimensions.includes(dimension)),
 };
}

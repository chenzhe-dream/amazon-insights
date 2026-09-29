/** Saved reports retain the calculation semantics used when they were created. */
export const CURRENT_SHAPE_CALCULATION_VERSION = 'shape-all-links/3' as const;
export type ShapeCalculationVersion = 'shape-reference/1' | 'shape-known-coverage/2' | typeof CURRENT_SHAPE_CALCULATION_VERSION;

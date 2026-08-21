export const REQUIRED_ANALYSIS_AGENT_EVAL_CASE_IDS = [
  "scooter-complete",
  "lighting-complete",
  "missing-voc-keyword",
  "third-party-metric-conflict",
  "safety-p0",
] as const;

export const ANALYSIS_AGENT_HUMAN_RATING_DIMENSIONS = [
  "accuracy",
  "explanation-quality",
  "actionability",
  "risk-completeness",
  "unsupported-inference-avoidance",
  "business-readability",
] as const;

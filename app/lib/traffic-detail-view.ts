export type TrafficDetailScope = Readonly<{
  organizationId: string;
  projectId: string;
  runId: string;
  jobId: string;
  marketplace: string;
  asin: string;
  evidenceId: string;
}>;

export function sameTrafficDetailScope(
  expected: TrafficDetailScope,
  candidate: TrafficDetailScope | null | undefined,
): boolean {
  if (!candidate) return false;
  const keys = ["organizationId", "projectId", "runId", "jobId", "marketplace", "asin", "evidenceId"] as const;
  return keys.every(key => expected[key].length > 0 && expected[key] === candidate[key]);
}

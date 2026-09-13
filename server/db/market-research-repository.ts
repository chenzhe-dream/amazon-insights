import type { MarketOverviewReport, MarketResearchIssue, MarketResearchJob, MarketResearchScope } from "../../shared/market-research-contracts";

export type MarketResearchActor = Readonly<{ organizationId: string; userId: string }>;
export type MarketResearchClaim = Readonly<{ job: MarketResearchJob; organizationId: string; userId: string; ownerId: string; generation: number }>;
export interface MarketResearchRepository {
  create(input: MarketResearchActor & { id: string; idempotencyKey: string; scope: MarketResearchScope; now: string }): Promise<{ job: MarketResearchJob; created: boolean }>;
  find(input: MarketResearchActor & { id: string }): Promise<MarketResearchJob | null>;
  list(input: MarketResearchActor): Promise<MarketResearchJob[]>;
  retry(input: MarketResearchActor & { id: string; now: string }): Promise<MarketResearchJob | null>;
  claim(input: { ownerId: string; now: string; leaseUntil: string }): Promise<MarketResearchClaim | null>;
  renew(input: { claim: MarketResearchClaim; now: string; leaseUntil: string }): Promise<boolean>;
  finish(input: { claim: MarketResearchClaim; now: string; report: MarketOverviewReport | null; error: MarketResearchIssue | null }): Promise<boolean>;
}
export class MarketResearchConflictError extends Error {
  constructor() { super("市场调研请求已存在或当前状态不允许此操作"); }
}

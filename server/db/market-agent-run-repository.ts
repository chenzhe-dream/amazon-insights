import type { MarketJsonValue } from '../../shared/market-analysis-contracts';
import type { MarketExecutionSubject, MarketModelExecutionAuthority } from '../../shared/market-execution-subject';
import type { FinalizeAgentRunOutcome, RegisterSkillVersionInput, SkillVersionRecord, AgentRunUsageSummary } from './agent-run-repository';

export type MarketSemanticTask = import('../../shared/market-semantic-contracts').MarketSemanticTaskName;
export interface MarketSemanticSnapshotBinding {
  id:string; organizationId:string; studyId:string; moduleRunId:string; inputSnapshotId:string;
  inputDigest:string; selectionRevision:string; batchKey:string; task:MarketSemanticTask;
  inputProjection:MarketJsonValue; memberRefs:readonly string[]; sourceRefs:readonly string[];
  dataCutoffAt:string; createdAt:string;
}
export interface SaveMarketSnapshotBindingInput {
  id:string; subject:MarketExecutionSubject; inputSnapshotId:string; inputProjection:unknown;
  memberRefs:readonly string[]; sourceRefs:readonly string[]; selectionRevision:string; batchKey:string;
}
export interface MarketAuditReadScope {
  actor:{organizationId:string;userId:string}; studyId:string; moduleRunId:string;
}
export interface BeginMarketAgentRunInput {
  id:string; subject:MarketExecutionSubject; task:MarketSemanticTask; bindingId:string;
  skillVersionId:string; skill:{id:string;version:string;contentHash:string}; inputSchema:string; outputSchema:string;
  executionFingerprint:string; outputSchemaDigest:string; provider:string; model:string; claimToken:string; claimTtlMs:number;
}
export interface MarketAgentRunRecord {
  schemaVersion:'market-agent-run/v1'; id:string; organizationId:string; studyId:string; moduleRunId:string;
  stepId:string; attemptId:string; bindingId:string; snapshotIds:readonly string[]; task:MarketSemanticTask;
  skillVersionId:string; skill:{id:string;version:string;contentHash:string}; executionFingerprint:string;
  outputSchemaDigest:string; provider:string; model:string; outputSchemaVersion:string; inputSummary:{contentHash:string;recordCount:number};
  dataCutoffAt:string; startedAt:string; completedAt:string|null; validationStatus:'pending'|'passed'|'failed';
  terminalStatus:FinalizeAgentRunOutcome['terminalStatus']|null; outcome:FinalizeAgentRunOutcome|null;
  claim:{token:string;ownerId:string;generation:number;acquiredAt:string;expiresAt:string};
}
export interface BeginMarketAgentRunResult {record:MarketAgentRunRecord;created:boolean;claimStatus:'acquired'|'observing'|'terminal'}
export interface MarketAgentRunRepository {
  registerSkillVersion(input:RegisterSkillVersionInput):Promise<SkillVersionRecord>;
  saveSnapshotBinding(input:SaveMarketSnapshotBindingInput):Promise<{binding:MarketSemanticSnapshotBinding;created:boolean}>;
  findSnapshotBinding(input:MarketAuditReadScope&{bindingId:string}):Promise<MarketSemanticSnapshotBinding|null>;
  beginAgentRun(input:BeginMarketAgentRunInput):Promise<BeginMarketAgentRunResult>;
  assertAgentRunClaim(authority:MarketModelExecutionAuthority):Promise<void>;
  claimAgentRun(input:{authority:MarketModelExecutionAuthority;claimTtlMs:number}):Promise<Omit<BeginMarketAgentRunResult,'created'>>;
  finalizeAgentRun(input:{authority:MarketModelExecutionAuthority;outcome:FinalizeAgentRunOutcome}):Promise<{record:MarketAgentRunRecord;transitioned:boolean}>;
  listAgentRuns(input:MarketAuditReadScope):Promise<MarketAgentRunRecord[]>;
  findAgentRun(input:MarketAuditReadScope&{agentRunId:string}):Promise<MarketAgentRunRecord|null>;
  findSnapshotBindingByBatch(input:MarketAuditReadScope&{batchId:string;inputDigest:string}):Promise<MarketSemanticSnapshotBinding|null>;
  getAgentRunUsage(input:MarketAuditReadScope):Promise<AgentRunUsageSummary&{source:'audit-terminal'}>;
}
export class MarketAgentRunConflictError extends Error {
  readonly code='MARKET_AGENT_RUN_CONFLICT';
  constructor(){super('Market semantic execution identity, claim or stored evidence is unavailable or conflicting');this.name='MarketAgentRunConflictError';}
}
